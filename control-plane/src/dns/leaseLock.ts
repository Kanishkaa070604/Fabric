/**
 * Minimal in-cluster Kubernetes Lease client for DNS reconciler leader
 * election (L3-DNS-02). Hand-rolled against the coordination.k8s.io REST
 * API — same rationale as connect-agent's k8ssvc: one narrow operation,
 * no @kubernetes/client-node dependency tree.
 *
 * Opt-in only (`FABRIC_DNS_LEADER_ELECTION=1`). When unset, the existing
 * "exactly one replica with FABRIC_DNS_RECONCILE_ENABLED=1" convention is
 * unchanged — this module is never loaded into the hot path.
 */

import * as fs from "fs";
import * as https from "https";
import { log } from "../logging";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export type LeaseLockConfig = {
  name: string;
  namespace: string;
  /** Pod name / HOSTNAME — must be unique per competing replica. */
  identity: string;
  /** How long a holder is considered alive without renewing. */
  leaseDurationSeconds: number;
  /** How often the holder renews / a standby tries to acquire. */
  renewIntervalMs: number;
};

export type LeaseLock = {
  /** True iff this process currently holds the lease. */
  isLeader: () => boolean;
  /** Start acquire/renew loop; resolves when ctx is aborted. */
  run: (signal: AbortSignal) => Promise<void>;
};

type LeaseObject = {
  metadata?: { resourceVersion?: string; name?: string; namespace?: string };
  spec?: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    acquireTime?: string;
    renewTime?: string;
  };
};

function readToken(): string {
  return fs.readFileSync(`${SA_DIR}/token`, "utf8").trim();
}

function readNamespace(): string {
  try {
    return fs.readFileSync(`${SA_DIR}/namespace`, "utf8").trim();
  } catch {
    return "";
  }
}

/** True when the standard in-cluster ServiceAccount mount is present. */
export function inCluster(): boolean {
  return (
    !!process.env.KUBERNETES_SERVICE_HOST &&
    fs.existsSync(`${SA_DIR}/token`) &&
    fs.existsSync(`${SA_DIR}/ca.crt`)
  );
}

export function defaultLeaseIdentity(): string {
  return (
    process.env.HOSTNAME ||
    process.env.FABRIC_INSTANCE_ID ||
    `pid-${process.pid}`
  );
}

export function defaultLeaseNamespace(): string {
  return (
    process.env.FABRIC_DNS_LEASE_NAMESPACE ||
    readNamespace() ||
    "3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c"
  );
}

function microTime(d: Date): string {
  // Kubernetes MicroTime: RFC3339 with fractional seconds.
  return d.toISOString().replace(/Z$/, "000Z");
}

function parseMicroTime(s: string | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Build a LeaseLock that talks to the in-cluster API server. Throws if
 * not in-cluster — callers must check `inCluster()` first and fail closed
 * (do not run the reconciler without a lock when election was requested).
 */
export function createInClusterLeaseLock(cfg: LeaseLockConfig): LeaseLock {
  const host = process.env.KUBERNETES_SERVICE_HOST!;
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  const ca = fs.readFileSync(`${SA_DIR}/ca.crt`);
  const agent = new https.Agent({ ca, rejectUnauthorized: true });
  let leading = false;

  const basePath = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(
    cfg.namespace
  )}/leases`;

  async function api(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: LeaseObject | null; raw: string }> {
    const token = readToken();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: host,
          port,
          path,
          method,
          agent,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json: LeaseObject | null = null;
            if (raw) {
              try {
                json = JSON.parse(raw) as LeaseObject;
              } catch {
                json = null;
              }
            }
            resolve({ status: res.statusCode || 0, json, raw });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function leaseExpired(lease: LeaseObject, now: number): boolean {
    const renew = parseMicroTime(lease.spec?.renewTime);
    const durationMs =
      (lease.spec?.leaseDurationSeconds ?? cfg.leaseDurationSeconds) * 1000;
    return now - renew >= durationMs;
  }

  async function tryOnce(now: Date): Promise<boolean> {
    const get = await api("GET", `${basePath}/${encodeURIComponent(cfg.name)}`);
    if (get.status === 404) {
      const created = await api("POST", basePath, {
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: { name: cfg.name, namespace: cfg.namespace },
        spec: {
          holderIdentity: cfg.identity,
          leaseDurationSeconds: cfg.leaseDurationSeconds,
          acquireTime: microTime(now),
          renewTime: microTime(now),
        },
      });
      // 409 = another replica created it first — not leader this round.
      return created.status === 200 || created.status === 201;
    }
    if (get.status !== 200 || !get.json) {
      throw new Error(`lease get status=${get.status} body=${get.raw.slice(0, 200)}`);
    }
    const lease = get.json;
    const holder = lease.spec?.holderIdentity || "";
    const mine = holder === cfg.identity;
    const expired = leaseExpired(lease, now.getTime());
    if (!mine && !expired) {
      return false;
    }
    const acquireTime =
      mine && lease.spec?.acquireTime
        ? lease.spec.acquireTime
        : microTime(now);
    const updated = await api(
      "PUT",
      `${basePath}/${encodeURIComponent(cfg.name)}`,
      {
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: {
          name: cfg.name,
          namespace: cfg.namespace,
          resourceVersion: lease.metadata?.resourceVersion,
        },
        spec: {
          holderIdentity: cfg.identity,
          leaseDurationSeconds: cfg.leaseDurationSeconds,
          acquireTime,
          renewTime: microTime(now),
        },
      }
    );
    // 409 = lost the race on resourceVersion — not leader this round.
    return updated.status === 200 || updated.status === 201;
  }

  return {
    isLeader: () => leading,
    run: async (signal) => {
      while (!signal.aborted) {
        try {
          const won = await tryOnce(new Date());
          if (won && !leading) {
            leading = true;
            log.warn("dns_reconciler_acquired_lease", {
              layer: "control-plane.dns",
              lease: cfg.name,
              namespace: cfg.namespace,
              identity: cfg.identity,
            });
          } else if (!won && leading) {
            leading = false;
            log.warn("dns_reconciler_lost_lease", {
              layer: "control-plane.dns",
              lease: cfg.name,
              namespace: cfg.namespace,
              identity: cfg.identity,
            });
          }
        } catch (err) {
          // Fail closed on API errors: drop leadership so we never write
          // DNS while unsure we still hold the lease.
          if (leading) {
            leading = false;
            log.warn("dns_reconciler_lease_error_released", {
              layer: "control-plane.dns",
              error: err instanceof Error ? err.message : String(err),
              identity: cfg.identity,
            });
          } else {
            log.warn("dns_reconciler_lease_error", {
              layer: "control-plane.dns",
              error: err instanceof Error ? err.message : String(err),
              identity: cfg.identity,
            });
          }
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, cfg.renewIntervalMs);
          const onAbort = () => {
            clearTimeout(t);
            resolve();
          };
          if (signal.aborted) {
            clearTimeout(t);
            resolve();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      leading = false;
    },
  };
}

/** Test-only lock: leadership flips based on an injectable predicate. */
export function createTestLeaseLock(opts: {
  identity: string;
  shouldLead: () => boolean;
}): LeaseLock & { setLeading: (v: boolean) => void } {
  let leading = opts.shouldLead();
  return {
    isLeader: () => leading,
    setLeading: (v: boolean) => {
      leading = v;
    },
    run: async (signal) => {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 20);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        });
      }
      leading = false;
    },
  };
}
