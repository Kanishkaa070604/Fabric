import dns from "dns";
import http from "http";
import https from "https";
import { URL } from "url";
import { log } from "./logging";

/**
 * L2 §D.3 revocation transport: "the Certificate Controller ... pushes a
 * revoke notice on the Gateway control/config channel". This is the push
 * half; Gateway's own poll loop (ReconcileSecurity) remains the reliable
 * fallback if a push is dropped or a Gateway replica is mid-restart —
 * push only shortens the exposure window, it is not the sole mechanism.
 *
 * Deliberately best-effort and fire-and-forget: a slow/unreachable Gateway
 * replica must never block or fail the control-plane mutation that
 * triggered the notice (suspend/revoke already committed to the store).
 *
 * `urls` (`FABRIC_GATEWAY_PUSH_URLS`) is a static list -- correct for a
 * fixed/small Gateway fleet, but it goes silently stale across a rolling
 * restart or scale event of a larger fleet: pushes keep going to pod IPs
 * that may no longer exist, and new pods get none until the list is
 * updated by hand. `dnsNames` (`FABRIC_GATEWAY_PUSH_DNS_NAMES`) is an
 * additive, opt-in alternative for that case: each name is resolved fresh
 * at every push (e.g. a Kubernetes headless Service's DNS name resolves
 * to the current set of pod IPs), so the fleet's membership is always
 * current with no manual list maintenance. Both can be combined; either
 * can be empty.
 */
export type GatewayPushConfig = {
  urls: string[];
  /** Names re-resolved (via dns.lookup, all addresses) on every push. */
  dnsNames: string[];
  dnsPort: number;
  dnsScheme: "http" | "https";
  token?: string;
  timeoutMs?: number;
};

export function loadGatewayPushConfig(
  env: NodeJS.ProcessEnv = process.env
): GatewayPushConfig {
  const raw = env.FABRIC_GATEWAY_PUSH_URLS || "";
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const dnsRaw = env.FABRIC_GATEWAY_PUSH_DNS_NAMES || "";
  const dnsNames = dnsRaw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return {
    urls,
    dnsNames,
    // Revoke push listens on FABRIC_REVOKE_PUSH_LISTEN (default :9090), not Ghostunnel :8443.
    dnsPort: Number(env.FABRIC_GATEWAY_PUSH_DNS_PORT || 9090),
    dnsScheme: env.FABRIC_GATEWAY_PUSH_DNS_SCHEME === "https" ? "https" : "http",
    token: env.FABRIC_GATEWAY_PUSH_TOKEN || undefined,
    timeoutMs: Number(env.FABRIC_GATEWAY_PUSH_TIMEOUT_MS || 2000),
  };
}

export type RevokePushBody = {
  tenant_id: string;
  cert_fingerprint?: string;
  cause: "security" | "billing" | "decommission";
  kind: "tenant_suspend" | "cert_revoke";
};

export function pushRevoke(cfg: GatewayPushConfig, body: RevokePushBody): void {
  if (cfg.urls.length === 0 && cfg.dnsNames.length === 0) return;
  void resolveTargets(cfg).then((targets) => {
    if (targets.length === 0) return;
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    for (const base of targets) {
      void postOnce(base, payload, cfg).catch((err) => {
        log.warn("gateway_push_failed", {
          layer: "control-plane.push",
          url: base,
          error: err instanceof Error ? err.message : String(err),
          note: "non-fatal; Gateway ReconcileSecurity poll remains the fallback",
        });
      });
    }
  });
}

/** Static urls + fresh DNS-resolved targets, deduped. Never throws (a
 * resolve failure for one name just logs and yields fewer targets, it
 * must not block pushing to whatever's already known-good). Exported for
 * direct unit testing (pushRevoke itself is fire-and-forget and hard to
 * assert on without a network layer to fake). */
export async function resolveTargets(cfg: GatewayPushConfig): Promise<string[]> {
  const targets = new Set(cfg.urls);
  for (const name of cfg.dnsNames) {
    try {
      const addrs = await dns.promises.lookup(name, { all: true });
      for (const a of addrs) {
        const host = a.family === 6 ? `[${a.address}]` : a.address;
        targets.add(`${cfg.dnsScheme}://${host}:${cfg.dnsPort}`);
      }
    } catch (err) {
      log.warn("gateway_push_dns_resolve_failed", {
        layer: "control-plane.push",
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return [...targets];
}

function postOnce(
  base: string,
  payload: Buffer,
  cfg: GatewayPushConfig
): Promise<void> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL("/internal/revoke", base);
    } catch (e) {
      reject(e);
      return;
    }
    const transport = u.protocol === "https:" ? https : http;
    const req = transport.request(
      u,
      {
        method: "POST",
        timeout: cfg.timeoutMs ?? 2000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
      },
      (res) => {
        res.resume();
        if ((res.statusCode ?? 0) >= 300) {
          reject(new Error(`gateway push status=${res.statusCode}`));
          return;
        }
        resolve();
      }
    );
    req.on("timeout", () => req.destroy(new Error("gateway push timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
