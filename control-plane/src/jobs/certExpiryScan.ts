import { log } from "../logging";
import { parseDurationMs } from "../duration";
import type { Agent, FabricStore } from "../store/types";

export type ExpiringAgent = {
  tenant_id: string;
  agent_id: string;
  state: string;
  cert_fingerprint_sha256: string | null;
  cert_not_after: Date;
  days_remaining: number;
};

/**
 * L3-PKI-01 remainder: scan Agent leaves nearing `cert_not_after` and emit
 * structured alerts. Does not itself rotate anything -- with D3-AUTO,
 * every Agent auto-rotates its own leaf at ~50% of TTL (day 3.5 of the
 * default 7-day cert), so under normal operation this job should almost
 * never find a candidate. Finding one means auto-rotation has been
 * failing for a while (see certlife's `cert_auto_rotate_failed` log) --
 * this is the safety-net page, not the primary rotation mechanism.
 *
 * Defaults are sized against the 7-day default TTL, not the old 825-day
 * one: a 30-day warn window would fire on every cert immediately upon
 * issuance (7d < 30d always) and page on nothing meaningful. `warnWithin`
 * defaults to 48h -- inside that window, auto-rotation (which fires at
 * day 3.5, leaving 3.5 days of runway) has already had 1.5+ days to
 * succeed on its own hourly retries; still being unrotated is a genuine
 * signal, not noise. If you raise FABRIC_AGENT_CERT_DAYS (e.g. toward the
 * documented 24h target), lower both these defaults to match.
 *
 * Env:
 *   FABRIC_CERT_EXPIRY_SCAN_INTERVAL — default `6h`; `0`/`off` disables
 *   FABRIC_CERT_EXPIRY_WARN_WITHIN — default `48h`
 *   FABRIC_CERT_EXPIRY_WEBHOOK_URL — optional POST JSON alert sink
 */
export function startCertExpiryScanJob(store: FabricStore): void {
  const intervalMs = parseDurationMs(
    process.env.FABRIC_CERT_EXPIRY_SCAN_INTERVAL,
    6 * 3_600_000
  );
  if (intervalMs <= 0) {
    log.info("cert_expiry_scan_disabled", { layer: "control-plane.jobs" });
    return;
  }
  const warnWithinMs = parseDurationMs(
    process.env.FABRIC_CERT_EXPIRY_WARN_WITHIN,
    48 * 3_600_000
  );
  const webhook = (process.env.FABRIC_CERT_EXPIRY_WEBHOOK_URL || "").trim();
  log.info("cert_expiry_scan_started", {
    layer: "control-plane.jobs",
    interval_ms: intervalMs,
    warn_within_ms: warnWithinMs,
    webhook: !!webhook,
  });
  const tick = async () => {
    try {
      const expiring = await collectExpiringAgents(store, warnWithinMs);
      for (const row of expiring) {
        log.warn("agent_cert_expiry_warning", {
          layer: "control-plane.pki",
          ...row,
          cert_not_after: row.cert_not_after.toISOString(),
          note: "auto-rotation (certlife.StartLoop) should have rotated this well before now -- check the Agent's own logs for cert_auto_rotate_failed; manual fallback: POST /v1/agents/:id/rotate or FABRIC_AGENT_ROTATE=1",
        });
      }
      if (webhook && expiring.length > 0) {
        await postWebhook(webhook, {
          kind: "agent_cert_expiry",
          count: expiring.length,
          agents: expiring.map((e) => ({
            ...e,
            cert_not_after: e.cert_not_after.toISOString(),
          })),
        });
      }
    } catch (e) {
      log.error("cert_expiry_scan_failed", {
        layer: "control-plane.jobs",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}

/** Exported for unit tests. */
export async function collectExpiringAgents(
  store: FabricStore,
  warnWithinMs: number,
  now = new Date()
): Promise<ExpiringAgent[]> {
  const horizon = new Date(now.getTime() + warnWithinMs);
  const out: ExpiringAgent[] = [];
  const tenantIds = await store.listAllTenantIds();
  for (const tenantId of tenantIds) {
    const agents = await store.listAgents(tenantId);
    for (const a of agents) {
      if (!isScanCandidate(a)) continue;
      const notAfter = a.cert_not_after!;
      if (notAfter.getTime() > horizon.getTime()) continue;
      const daysRemaining = Math.floor(
        (notAfter.getTime() - now.getTime()) / 86_400_000
      );
      out.push({
        tenant_id: a.tenant_id,
        agent_id: a.id,
        state: a.state,
        cert_fingerprint_sha256: a.cert_fingerprint_sha256,
        cert_not_after: notAfter,
        days_remaining: daysRemaining,
      });
    }
  }
  out.sort((x, y) => x.cert_not_after.getTime() - y.cert_not_after.getTime());
  return out;
}

function isScanCandidate(a: Agent): boolean {
  if (a.deleted_at) return false;
  if (a.state === "Retired") return false;
  if (!a.cert_not_after) return false;
  return true;
}

async function postWebhook(url: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn("cert_expiry_webhook_failed", {
        layer: "control-plane.jobs",
        status: res.status,
      });
    }
  } catch (e) {
    log.warn("cert_expiry_webhook_failed", {
      layer: "control-plane.jobs",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
