/** Shared duration parsing for grace-window / job envs ("5s", "90s", "3m", "24h", "30d", "1500ms"). */
export function parseDurationMs(v: string | undefined, fallbackMs: number): number {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return fallbackMs;
  if (s === "0" || s === "off" || s === "disabled") return 0;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = m[2] || "s";
  if (unit === "ms") return Math.floor(n);
  if (unit === "m") return Math.floor(n * 60_000);
  if (unit === "h") return Math.floor(n * 3_600_000);
  if (unit === "d") return Math.floor(n * 86_400_000);
  return Math.floor(n * 1000);
}
