import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { log } from "../logging";
import type { DesiredRecord, DnsProvider } from "./provider";

/**
 * Writes the full desired record set to a JSON file, atomically (write to a
 * temp path in the same directory, then rename). Intended for the same shape
 * of setup as `deploy/local/k3d/ambient`'s CoreDNS, generalized from a static
 * wildcard to real per-registration records: an external sync sidecar (or a
 * CoreDNS `file`/hosts plugin reload hook) watches this path and republishes
 * it. No network calls, no cloud DNS API opinion baked in here — that's
 * exactly why this is the right default for local/dev and for on-prem
 * clusters that don't want the control-plane calling out to a DNS API
 * directly (see `webhookProvider.ts` for that case).
 *
 * Multi-replica caveat (`L3-DNS-02`): the rename itself is atomic *within
 * one write* (a reader never sees a half-written file), but there is no
 * coordination *across* processes. If multiple control-plane replicas
 * point at the same shared path, each independently reads the DB, computes
 * its own full desired state, and renames over the file with no ordering
 * guarantee -- an older/slower replica's read can still rename *after* a
 * newer/faster replica's, silently reverting the file to stale data.
 *
 * `generated_at` below is a cheap, real mitigation for the specific harmful
 * case -- "stale data overwrites data known to be fresher" -- NOT a fix for
 * the race itself: before writing, this replica checks whether the file
 * already on disk was generated later than its own read, and skips the
 * write if so. Two replicas reading at nearly the same instant can still
 * both "win" a tie and either can end up on disk -- that's fine, both had
 * correct data as of their own read. What this closes is only the
 * asymmetric case where a demonstrably staler write would otherwise clobber
 * a demonstrably fresher one. It also assumes replica clocks aren't
 * meaningfully skewed (typical in an NTP-synced fleet; worth checking if
 * that assumption doesn't hold in your deployment). A real fix (single
 * writer via leader election/lock) is still open -- see `L3-DNS-02`; the
 * simplest fix available today, requiring no code, is running exactly one
 * replica with `FABRIC_DNS_PROVIDER=file` enabled.
 */
export class FileDnsProvider implements DnsProvider {
  constructor(private readonly path: string) {}

  async reconcile(desired: DesiredRecord[]): Promise<void> {
    const generatedAt = new Date();
    const sorted = [...desired].sort((a, b) => a.name.localeCompare(b.name));
    const body = JSON.stringify(
      {
        generated_at: generatedAt.toISOString(),
        records: sorted,
      },
      null,
      2
    );
    mkdirSync(dirname(this.path), { recursive: true });

    const onDiskGeneratedAt = this.readExistingGeneratedAt();
    if (onDiskGeneratedAt && onDiskGeneratedAt.getTime() > generatedAt.getTime()) {
      log.warn("dns_file_write_skipped_stale", {
        layer: "control-plane.dns",
        reason:
          "on-disk file's generated_at is newer than this tick's -- another replica already wrote fresher state; see L3-DNS-02",
      });
      return;
    }

    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, this.path);
  }

  private readExistingGeneratedAt(): Date | null {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as { generated_at?: string };
      if (!parsed.generated_at) return null;
      const d = new Date(parsed.generated_at);
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      // Missing (first run) or corrupt -- nothing to compare against, so
      // don't block the write.
      return null;
    }
  }
}
