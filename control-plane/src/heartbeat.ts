import { log } from "./logging";
import { parseDurationMs } from "./duration";
import type { FabricStore } from "./store/types";

/**
 * Marks Connected agents Degraded when last_heartbeat_at is older than
 * FABRIC_HEARTBEAT_DEGRADED_AFTER (default 90s). Heartbeat/up recovers to Connected.
 */
export function startHeartbeatWatchdog(store: FabricStore): NodeJS.Timeout | null {
  const staleMs = parseDurationMs(process.env.FABRIC_HEARTBEAT_DEGRADED_AFTER, 90_000);
  if (staleMs <= 0) {
    log.info("heartbeat_watchdog_disabled", { layer: "control-plane.watchdog" });
    return null;
  }
  const intervalMs = Math.min(Math.max(Math.floor(staleMs / 3), 1000), 15_000);
  log.info("heartbeat_watchdog_started", {
    layer: "control-plane.watchdog",
    stale_after_ms: staleMs,
    interval_ms: intervalMs,
  });
  return setInterval(() => {
    void store
      .degradeStaleAgents(staleMs)
      .then((n) => {
        if (n > 0) {
          log.info("agents_degraded_stale_heartbeat", {
            layer: "control-plane.watchdog",
            count: n,
            stale_after_ms: staleMs,
          });
        }
      })
      .catch((e) => {
        log.warn("heartbeat_watchdog_error", {
          layer: "control-plane.watchdog",
          error: e instanceof Error ? e.message : String(e),
        });
      });
  }, intervalMs);
}
