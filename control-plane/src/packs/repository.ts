/**
 * PackRepository — the persistence seam for encrypted pack versions and the
 * default-plus-per-tenant resolution rule (spec §7.1a).
 *
 * A "lineage" is either the shared DEFAULT bundle (tenant_id === null) or a
 * specific tenant's own (tenant_id set). Content is stored ONCE per lineage:
 * one ciphertext, one DEK ref, referenced by every lease of that version.
 *
 * Resolution for a lease (§7.1a): a tenant's explicit assignment → the tenant's
 * own current version → the default current version. The signed lease always
 * names the pack_version_id actually served, so the consumer verifies against
 * what it got, never what it asked for.
 *
 * The DEK itself is NOT stored here — the row carries only dek_secret_ref, the
 * key under which the DEK lives in the PackKeyProtector (§5.3). This keeps key
 * custody entirely in the protector seam.
 *
 * Phase-0 ships the interface + an in-memory dev impl. Production is a
 * Sequelize-backed impl over the security_pack_versions table; that is a
 * separate task and does not change this contract.
 */

import { isProductionEnv, type DevImplOptions } from "./seams";

export type PackVersionState = "staged" | "active" | "retired";

/**
 * One stored, encrypted pack version (a row in security_pack_versions). The
 * ciphertext + nonce are the stable bytes leased many times; the digests and
 * sizes feed the signed lease.
 */
export type PackVersionRecord = {
  packVersionId: string;
  /** null = default lineage; set = that tenant's private lineage. */
  tenantId: string | null;
  packId: string;
  version: number;
  state: PackVersionState;
  contentType: string;
  schemaVersion: string;
  compressionAlg: string;
  encryptionAlg: string;
  /** stable ciphertext for this version (Poly1305 tag appended). */
  ciphertext: Buffer;
  /** 24-byte XChaCha nonce used to encrypt this version. */
  nonce: Buffer;
  uncompressedSize: number;
  compressedSize: number;
  ciphertextSize: number;
  ciphertextSha256: string;
  /** key under which this version's DEK lives in the PackKeyProtector. */
  dekSecretRef: string;
  /** advisory rollout floor carried into the lease. */
  minAgentVersion: string;
  /** policy revision carried into the lease. */
  policyVersion: number;
  createdAt: Date;
  createdBy: string;
};

/** Input to stage a new (staged) version. `version` comes from reserveVersion. */
export type StageVersionInput = Omit<
  PackVersionRecord,
  "state" | "createdAt"
> & { createdAt?: Date };

export interface PackRepository {
  /**
   * Reserve the next monotonic version number for a (packId, lineage). Called
   * before encryption because the version is bound into the AAD and the lease,
   * so it must be fixed before the ciphertext is produced. The reserved number
   * must be the one passed to the subsequent stageVersion.
   */
  reserveVersion(tenantId: string | null, packId: string): Promise<number>;
  /** Persist a new version in `staged` state. Idempotent per packVersionId. */
  stageVersion(input: StageVersionInput): Promise<PackVersionRecord>;
  /**
   * Activate a staged version: it becomes the current `active` version for its
   * lineage, and any previously-active version in the same lineage is retired.
   */
  activateVersion(packVersionId: string): Promise<PackVersionRecord>;
  /** Fetch a version by id, or undefined. */
  getVersion(packVersionId: string): Promise<PackVersionRecord | undefined>;
  /**
   * Resolve the version to serve for a lease (§7.1a):
   *   tenant explicit assignment → tenant's own active → default active.
   * Returns undefined only when neither the tenant nor the default has an
   * active version for this pack (→ pack_not_found / no_assigned_version).
   */
  resolveForLease(
    tenantId: string,
    packId: string,
  ): Promise<PackVersionRecord | undefined>;
  /**
   * Pin a tenant to a specific version (explicit assignment), overriding the
   * "tenant own active → default" fallback. Passing null clears the pin.
   */
  setTenantAssignment(
    tenantId: string,
    packId: string,
    packVersionId: string | null,
  ): Promise<void>;
}

/**
 * In-memory dev PackRepository. No persistence, no encryption at rest. Local
 * runs and tests only; refuses to construct in a production-like env unless
 * explicitly overridden (mirrors the other pack dev impls).
 */
export class InMemoryPackRepository implements PackRepository {
  private readonly versions = new Map<string, PackVersionRecord>();
  /** (tenantId|"__default__") + "\u0000" + packId → active packVersionId. */
  private readonly activeByLineage = new Map<string, string>();
  /** tenantId + "\u0000" + packId → pinned packVersionId. */
  private readonly assignments = new Map<string, string>();

  constructor(opts: DevImplOptions = {}) {
    if (!opts.allowInProduction) {
      if (isProductionEnv(opts.env ?? process.env)) {
        throw new Error(
          "InMemoryPackRepository is a development-only implementation and must " +
            "not run in production. Wire a Sequelize-backed PackRepository.",
        );
      }
    }
  }

  private lineageKey(tenantId: string | null, packId: string): string {
    return `${tenantId ?? "__default__"}\u0000${packId}`;
  }

  private assignmentKey(tenantId: string, packId: string): string {
    return `${tenantId}\u0000${packId}`;
  }

  /**
   * (lineageKey) → highest version reserved so far. Tracks reservations even
   * before the row is persisted, so two reserves never collide. In-process and
   * single-threaded (Node), so this is atomic without a lock; the real
   * Sequelize impl uses a transaction / sequence per lineage.
   */
  private readonly reservedMax = new Map<string, number>();

  async reserveVersion(tenantId: string | null, packId: string): Promise<number> {
    const key = this.lineageKey(tenantId, packId);
    let max = this.reservedMax.get(key) ?? 0;
    for (const v of this.versions.values()) {
      if (v.packId === packId && v.tenantId === tenantId && v.version > max) {
        max = v.version;
      }
    }
    const next = max + 1;
    this.reservedMax.set(key, next);
    return next;
  }

  async stageVersion(input: StageVersionInput): Promise<PackVersionRecord> {
    if (!input.packVersionId) throw new Error("packVersionId is required");
    const rec: PackVersionRecord = {
      ...input,
      state: "staged",
      createdAt: input.createdAt ?? new Date(),
    };
    this.versions.set(rec.packVersionId, rec);
    return rec;
  }

  async activateVersion(packVersionId: string): Promise<PackVersionRecord> {
    const rec = this.versions.get(packVersionId);
    if (!rec) throw new Error(`unknown pack_version_id=${packVersionId}`);
    const key = this.lineageKey(rec.tenantId, rec.packId);
    // Retire the previously-active version in this lineage.
    const prevId = this.activeByLineage.get(key);
    if (prevId && prevId !== packVersionId) {
      const prev = this.versions.get(prevId);
      if (prev) prev.state = "retired";
    }
    rec.state = "active";
    this.activeByLineage.set(key, packVersionId);
    return rec;
  }

  async getVersion(packVersionId: string): Promise<PackVersionRecord | undefined> {
    return this.versions.get(packVersionId);
  }

  async resolveForLease(
    tenantId: string,
    packId: string,
  ): Promise<PackVersionRecord | undefined> {
    // 1) explicit tenant assignment.
    const pinned = this.assignments.get(this.assignmentKey(tenantId, packId));
    if (pinned) {
      const rec = this.versions.get(pinned);
      if (rec) return rec;
    }
    // 2) tenant's own active version.
    const tenantActive = this.activeByLineage.get(this.lineageKey(tenantId, packId));
    if (tenantActive) {
      const rec = this.versions.get(tenantActive);
      if (rec) return rec;
    }
    // 3) default active version.
    const defaultActive = this.activeByLineage.get(this.lineageKey(null, packId));
    if (defaultActive) {
      const rec = this.versions.get(defaultActive);
      if (rec) return rec;
    }
    return undefined;
  }

  async setTenantAssignment(
    tenantId: string,
    packId: string,
    packVersionId: string | null,
  ): Promise<void> {
    const key = this.assignmentKey(tenantId, packId);
    if (packVersionId === null) {
      this.assignments.delete(key);
    } else {
      this.assignments.set(key, packVersionId);
    }
  }
}
