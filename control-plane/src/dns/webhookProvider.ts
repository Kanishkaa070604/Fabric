import http from "http";
import https from "https";
import { URL } from "url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { log } from "../logging";
import type { DesiredRecord, DnsProvider } from "./provider";

/**
 * Diffs against the previously-applied desired set and POSTs one
 * upsert/delete call per changed record to a configurable webhook — the
 * same "bring your own backend" shape as `gatewayPush.ts`. Ops wire the
 * webhook to whatever DNS API they actually run (Route53, Cloud DNS,
 * internal IPAM, ...); this repo intentionally does not pick one, since
 * the architecture docs never name a specific provider.
 *
 * Best-effort per record: one failed call logs and continues, it does not
 * abort the rest of the tick. The next tick retries anything still wrong,
 * since `reconcile` is always called with the full desired set again.
 *
 * `applied` (the "what we believe is live" set the diff is computed
 * against) is persisted to `statePath` after every reconcile when one is
 * configured. Without this, a routine control-plane restart (deploy,
 * autoscale, crash-and-recover — all normal for this system) reset
 * `applied` to empty, and the delete-diff only ever fires for a name
 * present in `applied` but missing from `desired` — so any registration
 * deleted while the process happened to be down produced no `desired`
 * entry AND no `applied` entry, meaning no discrepancy was ever observed
 * and its stale DNS record was never cleaned up. Persisting `applied`
 * closes that gap; it does not require any new capability from the
 * webhook receiver itself (unlike fully verifying against the live
 * backend, which would need a `list` operation added to the contract).
 *
 * What `statePath` deliberately does NOT fix -- multi-replica (`L3-DNS-02`
 * covers this too, not just FileDnsProvider): each replica's `applied` is
 * still only *that replica's* belief. With a per-replica local `statePath`
 * (the common case -- e.g. ephemeral pod storage), replica B has no way to
 * learn that replica A already applied an upsert, so B can send its own
 * redundant upsert next tick, and if a record's target changed between
 * ticks, two replicas can race with genuinely different values (real, if
 * self-healing on the next tick from whichever replica notices the
 * mismatch first) -- milder than FileDnsProvider's failure mode since the
 * real DNS backend, not a local file, arbitrates the actual writes, but
 * not multi-replica-safe. Pointing multiple replicas at one *shared*
 * `statePath` does not fix this either -- it just relocates FileDnsProvider's
 * exact last-rename-wins race onto this state file instead. Until real
 * leader election exists, run exactly one control-plane replica with DNS
 * reconciliation enabled, same operational guidance as FileDnsProvider.
 */
type PostFn = (body: {
  op: "upsert" | "delete";
  name: string;
  target?: string;
}) => Promise<void>;

export class WebhookDnsProvider implements DnsProvider {
  private applied: Map<string, string>; // name -> target we believe is live
  private readonly postFn: PostFn;

  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly timeoutMs = 5000,
    /** Injectable for tests; defaults to a real HTTP POST. */
    postFn?: PostFn,
    /** Optional durable backing store for `applied`; unset = in-memory only (pre-existing behavior). */
    private readonly statePath?: string
  ) {
    this.postFn = postFn ?? ((body) => this.post(body));
    this.applied = new Map(this.loadState());
  }

  async reconcile(desired: DesiredRecord[]): Promise<void> {
    const desiredByName = new Map(desired.map((r) => [r.name, r.target]));

    const upserts: DesiredRecord[] = [];
    for (const [name, target] of desiredByName) {
      if (this.applied.get(name) !== target) upserts.push({ name, target });
    }
    const deletes: string[] = [];
    for (const name of this.applied.keys()) {
      if (!desiredByName.has(name)) deletes.push(name);
    }

    let changed = false;
    for (const rec of upserts) {
      try {
        await this.postFn({ op: "upsert", name: rec.name, target: rec.target });
        this.applied.set(rec.name, rec.target);
        changed = true;
      } catch (err) {
        log.warn("dns_webhook_upsert_failed", {
          layer: "control-plane.dns",
          name: rec.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const name of deletes) {
      try {
        await this.postFn({ op: "delete", name });
        this.applied.delete(name);
        changed = true;
      } catch (err) {
        log.warn("dns_webhook_delete_failed", {
          layer: "control-plane.dns",
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (changed) this.saveState();
  }

  private loadState(): [string, string][] {
    if (!this.statePath) return [];
    try {
      const raw = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      return Object.entries(parsed);
    } catch {
      // First run, file not created yet, or corrupt -- start from empty.
      // Worst case (corrupt/missing on a non-first run) is a one-time
      // re-upsert of everything on the next tick, not a correctness bug.
      return [];
    }
  }

  private saveState(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const body = JSON.stringify(Object.fromEntries(this.applied));
      const tmp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, this.statePath);
    } catch (err) {
      log.warn("dns_webhook_state_persist_failed", {
        layer: "control-plane.dns",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private post(body: {
    op: "upsert" | "delete";
    name: string;
    target?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(this.url);
      } catch (e) {
        reject(e);
        return;
      }
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      const transport = u.protocol === "https:" ? https : http;
      const req = transport.request(
        u,
        {
          method: "POST",
          timeout: this.timeoutMs,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payload.length,
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
        },
        (res) => {
          res.resume();
          if ((res.statusCode ?? 0) >= 300) {
            reject(new Error(`dns webhook status=${res.statusCode}`));
            return;
          }
          resolve();
        }
      );
      req.on("timeout", () => req.destroy(new Error("dns webhook timeout")));
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }
}
