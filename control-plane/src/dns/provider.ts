/**
 * G-A3-1 prod DNS automation (Architecture-Resolutions.md; Operational-Runbook.md
 * Step 2's "per-registration DNS names are created later by Controllers when
 * registrations become Active"). This is that Controller-equivalent logic.
 *
 * Scope, deliberately: every CUSTOMER_SERVICE/CUSTOMER_RESOURCE registration in
 * state Active gets exactly one record, `<reg>.<tenant>.<domainSuffix>`, pointed
 * at the shared Gateway inbound endpoint (there is one Gateway inbound TLS
 * listener total — SNI, not the DNS record, is what multiplexes tenants/regs
 * onto it; see `gateway/internal/pinbound`). Records for registrations that
 * leave Active (Deleted/Failed/etc.) are removed. Nothing else about Spec A3/B4
 * hop order changes — this only decides how the Gateway hop gets dialed.
 */
export type DesiredRecord = {
  /** e.g. "reg-abc123.tenant-1.connect.fabric" */
  name: string;
  /** Shared Gateway inbound hostname/IP; same for every record today. */
  target: string;
};

export interface DnsProvider {
  /**
   * Called once per reconcile tick with the full desired set (not a diff).
   * Implementations decide for themselves whether to diff against
   * previously-applied state or rewrite everything idempotently.
   */
  reconcile(desired: DesiredRecord[]): Promise<void>;
}
