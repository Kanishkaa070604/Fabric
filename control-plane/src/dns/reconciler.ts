import { log } from "../logging";
import type { FabricStore } from "../store/types";
import { inboundHostname, inboundHostnameByName, isInboundDestination } from "../store/types";
import { FileDnsProvider } from "./fileProvider";
import {
  createInClusterLeaseLock,
  defaultLeaseIdentity,
  defaultLeaseNamespace,
  inCluster,
  type LeaseLock,
} from "./leaseLock";
import type { DnsProvider } from "./provider";
import { WebhookDnsProvider } from "./webhookProvider";

export type DnsReconcilerConfig = {
  enabled: boolean;
  provider: "file" | "webhook";
  domainSuffix: string;
  /** Shared Gateway inbound hostname/IP every desired record points at. */
  target: string;
  intervalMs: number;
  filePath?: string;
  webhookUrl?: string;
  webhookToken?: string;
  /** Durable backing store for WebhookDnsProvider's applied-set (see its
   * doc comment for why this matters across restarts). Unset = in-memory
   * only, matching the provider's pre-fix behavior. */
  webhookStatePath?: string;
  /**
   * L3-DNS-02: when true, compete for a Kubernetes Lease before running
   * ticks. Default false — existing "FABRIC_DNS_RECONCILE_ENABLED=1 on
   * exactly one replica" deployments are completely unchanged. When true,
   * every replica may set FABRIC_DNS_RECONCILE_ENABLED=1; only the lease
   * holder runs reconcile. Requires in-cluster SA + lease RBAC; if
   * election is requested but in-cluster creds are missing, the
   * reconciler refuses to start (fail closed — never become an
   * uncoordinated second writer).
   */
  leaderElection?: boolean;
  leaseName?: string;
  leaseNamespace?: string;
  leaseDurationSeconds?: number;
  leaseRenewIntervalMs?: number;
  /** Injected by tests; production builds the in-cluster lock itself. */
  leaseLockForTest?: LeaseLock;
};

export type DnsReconcilerHandle = {
  stop: () => void;
};

/**
 * Resolve whether Lease election should run.
 *
 * Production-fit default (no operator decision required):
 *   - FABRIC_DNS_RECONCILE_ENABLED off → election off (nothing to coordinate).
 *   - reconcile on + in-cluster + FABRIC_DNS_LEADER_ELECTION unset → election ON
 *     (matches deploy/control-plane/deployment.yaml).
 *   - reconcile on + not in-cluster + unset → election OFF (local compose /
 *     file-provider smoke; no API server to elect against).
 * Explicit FABRIC_DNS_LEADER_ELECTION=0|1 always wins (escape hatch:
 * deployment-split-reconciler.yaml sets 0).
 */
export function resolveLeaderElection(
  enabled: boolean,
  electionEnv: string | undefined,
  cluster: boolean = inCluster()
): boolean {
  if (electionEnv !== undefined && electionEnv !== "") {
    return /^(1|true)$/i.test(electionEnv);
  }
  return enabled && cluster;
}

export function loadDnsReconcilerConfig(
  env: NodeJS.ProcessEnv = process.env
): DnsReconcilerConfig {
  const enabled = /^(1|true)$/i.test(env.FABRIC_DNS_RECONCILE_ENABLED || "");
  const leaderElection = resolveLeaderElection(
    enabled,
    env.FABRIC_DNS_LEADER_ELECTION
  );
  const provider = (env.FABRIC_DNS_PROVIDER || "file").toLowerCase() as
    | "file"
    | "webhook";
  return {
    enabled,
    provider: provider === "webhook" ? "webhook" : "file",
    domainSuffix: env.FABRIC_GATEWAY_INBOUND_DOMAIN || "connect.fabric",
    target: env.FABRIC_DNS_TARGET || "",
    intervalMs: Number(env.FABRIC_DNS_RECONCILE_INTERVAL_MS || 30_000),
    filePath: env.FABRIC_DNS_FILE_PATH || "/var/run/fabric/dns-records.json",
    webhookUrl: env.FABRIC_DNS_WEBHOOK_URL,
    webhookToken: env.FABRIC_DNS_WEBHOOK_TOKEN,
    webhookStatePath:
      env.FABRIC_DNS_WEBHOOK_STATE_PATH || "/var/run/fabric/dns-webhook-state.json",
    leaderElection,
    leaseName: env.FABRIC_DNS_LEASE_NAME || "fabric-dns-reconciler",
    leaseNamespace: env.FABRIC_DNS_LEASE_NAMESPACE || defaultLeaseNamespace(),
    leaseDurationSeconds: Number(env.FABRIC_DNS_LEASE_DURATION_SECONDS || 15),
    leaseRenewIntervalMs: Number(env.FABRIC_DNS_LEASE_RENEW_INTERVAL_MS || 10_000),
  };
}

function buildProvider(cfg: DnsReconcilerConfig): DnsProvider | null {
  if (cfg.provider === "webhook") {
    if (!cfg.webhookUrl) {
      log.warn("dns_reconciler_disabled", {
        layer: "control-plane.dns",
        reason: "FABRIC_DNS_PROVIDER=webhook requires FABRIC_DNS_WEBHOOK_URL",
      });
      return null;
    }
    return new WebhookDnsProvider(
      cfg.webhookUrl,
      cfg.webhookToken,
      undefined,
      undefined,
      cfg.webhookStatePath
    );
  }
  if (!cfg.filePath) return null;
  return new FileDnsProvider(cfg.filePath);
}

/**
 * G-A3-1 prod DNS automation: the previously-open item ("prod Controller DNS
 * still Ops" in Architecture-Resolutions.md / Level-3-Tickets.md). Polls all
 * tenants' registrations, computes the desired inbound-record set (Active
 * CUSTOMER_SERVICE/CUSTOMER_RESOURCE only, per `inboundHostname`), and hands
 * it to a pluggable `DnsProvider`. Runs inside control-plane rather than a
 * separate `controllers/` binary — this repo already folds Controller-shaped
 * responsibilities (enroll/approve/revoke) into control-plane for v1; see
 * `docs/README.md`.
 */
export function startDnsReconciler(
  store: FabricStore,
  cfg: DnsReconcilerConfig
): DnsReconcilerHandle | null {
  if (!cfg.enabled) {
    log.info("dns_reconciler_disabled", { layer: "control-plane.dns" });
    return null;
  }
  if (!cfg.target) {
    log.warn("dns_reconciler_disabled", {
      layer: "control-plane.dns",
      reason: "FABRIC_DNS_TARGET is required when FABRIC_DNS_RECONCILE_ENABLED=1",
    });
    return null;
  }
  const provider = buildProvider(cfg);
  if (!provider) return null;

  const instanceId = defaultLeaseIdentity();
  let lease: LeaseLock | null = null;
  const leaderElection = !!cfg.leaderElection;

  if (leaderElection) {
    if (cfg.leaseLockForTest) {
      lease = cfg.leaseLockForTest;
    } else if (!inCluster()) {
      // Fail closed: operator asked for election but we have no cluster
      // API — running as an uncoordinated writer would re-introduce the
      // exact multi-replica race L3-DNS-02 is about.
      log.warn("dns_reconciler_disabled", {
        layer: "control-plane.dns",
        reason:
          "FABRIC_DNS_LEADER_ELECTION=1 requires in-cluster ServiceAccount credentials; refusing to start an uncoordinated reconciler",
        instance_id: instanceId,
      });
      return null;
    } else {
      lease = createInClusterLeaseLock({
        name: cfg.leaseName || "fabric-dns-reconciler",
        namespace: cfg.leaseNamespace || defaultLeaseNamespace(),
        identity: instanceId,
        leaseDurationSeconds: cfg.leaseDurationSeconds ?? 15,
        renewIntervalMs: cfg.leaseRenewIntervalMs ?? 10_000,
      });
    }
  }

  log.warn("dns_reconciler_started", {
    layer: "control-plane.dns",
    provider: cfg.provider,
    domain_suffix: cfg.domainSuffix,
    interval_ms: cfg.intervalMs,
    instance_id: instanceId,
    leader_election: !!lease,
    note: lease
      ? "production default: Lease election on — only the holder runs reconcile ticks; standbys serve API (L3-DNS-02 / deployment.yaml)"
      : "leader election off — exactly ONE process may have FABRIC_DNS_RECONCILE_ENABLED=1 (escape hatch: deployment-split-reconciler.yaml sets FABRIC_DNS_LEADER_ELECTION=0)",
  });

  // setInterval fires on a wall-clock schedule regardless of whether the
  // previous tick's async work (DB scan across every tenant + a provider
  // round trip) has finished. Under DB slowness or a large/growing tenant
  // count, a tick can run long enough that the next timer fires while it's
  // still in flight; without a guard, that overlap self-inflicts extra DB
  // load and, for FileDnsProvider specifically, its rename-based "atomic"
  // write has no cross-call ordering guarantee -- an older, slower tick
  // can finish (and rename) after a newer, faster one, silently reverting
  // the DNS file to stale data. tickRunning makes ticks strictly
  // sequential: a tick that's still running when the timer fires is
  // skipped (not queued), so a stuck provider/DB self-heals on the very
  // next successful tick instead of ticks piling up.
  let tickRunning = false;
  const tick = async () => {
    if (lease && !lease.isLeader()) {
      return;
    }
    if (tickRunning) {
      log.warn("dns_reconcile_tick_skipped", {
        layer: "control-plane.dns",
        reason: "previous tick still in flight",
      });
      return;
    }
    tickRunning = true;
    try {
      // Re-check leadership after acquiring the tick lock: we may have
      // lost the lease while waiting, and must not write in that case.
      if (lease && !lease.isLeader()) {
        return;
      }
      const desired = await computeDesiredRecords(store, cfg);
      if (lease && !lease.isLeader()) {
        return;
      }
      await provider.reconcile(desired);
      log.info("dns_reconcile_tick", {
        layer: "control-plane.dns",
        record_count: desired.length,
      });
    } catch (err) {
      log.warn("dns_reconcile_tick_failed", {
        layer: "control-plane.dns",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tickRunning = false;
    }
  };

  const abort = new AbortController();
  if (lease) {
    void lease.run(abort.signal);
  }

  void tick();
  const interval = setInterval(() => void tick(), cfg.intervalMs);
  return {
    stop: () => {
      clearInterval(interval);
      abort.abort();
    },
  };
}

/** Exported for tests; also usable by a one-shot CLI/cron invocation instead of the interval loop. */
export async function computeDesiredRecords(
  store: FabricStore,
  cfg: Pick<DnsReconcilerConfig, "domainSuffix" | "target">
): Promise<{ name: string; target: string }[]> {
  const tenantIds = await store.listAllTenantIds();
  const out: { name: string; target: string }[] = [];
  for (const tenantId of tenantIds) {
    const regs = await store.listRegistrations(tenantId);
    for (const r of regs) {
      if (r.state !== "Active") continue;
      if (r.deleted_at) continue;
      if (!isInboundDestination(r.destination_kind)) continue;
      out.push({
        name: inboundHostname(r.id, r.tenant_id, cfg.domainSuffix),
        target: cfg.target,
      });
      // Convention-driven friendly name: <display_name_slug>.<tenant_id>.<suffix>
      // so SaaS services can construct the hostname at runtime without
      // per-tenant config or API lookups. Both names resolve to the same
      // target (Gateway inbound VIP). The canonical (UUID) path is stable
      // even after rename; the friendly path is what makes Fabric
      // transparent to multi-tenant Platform services.
      out.push({
        name: inboundHostnameByName(r.display_name, r.tenant_id, cfg.domainSuffix),
        target: cfg.target,
      });
    }
  }
  return out;
}
