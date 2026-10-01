/**
 * SequelizePackRepository — the production PackRepository over
 * ablv_security_pack_versions + ablv_security_pack_assignments.
 *
 * Same contract as InMemoryPackRepository; the difference is durability and
 * that the version reservation + activation are done in transactions so
 * concurrent control-plane replicas can't collide on a version number or leave
 * two active rows in one lineage.
 */

import { Op, type Sequelize, type Model, type Transaction } from "sequelize";
import type { PackModels } from "./models";
import type {
  PackRepository,
  PackVersionRecord,
  PackVersionState,
  StageVersionInput,
} from "./repository";

function asBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  // pg may return BYTEA as a Buffer already; guard for string/Uint8Array too.
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string") return Buffer.from(v, "binary");
  throw new Error("expected BYTEA column to be a Buffer");
}

function asRecord(row: Record<string, unknown>): PackVersionRecord {
  return {
    packVersionId: String(row.id),
    tenantId: row.tenant_id == null ? null : String(row.tenant_id),
    packId: String(row.pack_id),
    version: Number(row.version),
    state: String(row.state) as PackVersionState,
    contentType: String(row.content_type),
    schemaVersion: String(row.schema_version),
    compressionAlg: String(row.compression_alg),
    encryptionAlg: String(row.encryption_alg),
    nonce: asBuffer(row.nonce),
    ciphertext: asBuffer(row.ciphertext),
    uncompressedSize: Number(row.uncompressed_size),
    compressedSize: Number(row.compressed_size),
    ciphertextSize: Number(row.ciphertext_size),
    ciphertextSha256: String(row.ciphertext_sha256),
    dekSecretRef: String(row.dek_secret_ref),
    minAgentVersion: String(row.min_agent_version ?? ""),
    policyVersion: Number(row.policy_version ?? 1),
    createdAt: row.created_at as Date,
    createdBy: String(row.created_by),
  };
}

export class SequelizePackRepository implements PackRepository {
  constructor(
    private readonly sequelize: Sequelize,
    private readonly models: PackModels,
  ) {}

  private plain(m: Model): Record<string, unknown> {
    return m.get({ plain: true }) as Record<string, unknown>;
  }

  /**
   * Reserve the next monotonic version for a lineage inside a transaction, using
   * a row lock over the lineage's existing rows so two concurrent reservations
   * serialize rather than both reading the same max. The reserved number is
   * returned; the caller persists it via stageVersion.
   *
   * We take the max over the same lineage predicate the partial unique indexes
   * enforce, so a duplicate is impossible even if two stagers race: the loser's
   * later INSERT would violate the unique index and fail loudly.
   */
  async reserveVersion(tenantId: string | null, packId: string): Promise<number> {
    return this.sequelize.transaction(async (t: Transaction) => {
      const where =
        tenantId === null
          ? { pack_id: packId, tenant_id: { [Op.is]: null } }
          : { pack_id: packId, tenant_id: tenantId };
      const rows = (await this.models.SecurityPackVersion.findAll({
        where,
        attributes: ["version"],
        order: [["version", "DESC"]],
        limit: 1,
        transaction: t,
        lock: t.LOCK.UPDATE,
      })) as Model[];
      const max = rows.length ? Number(this.plain(rows[0]).version) : 0;
      return max + 1;
    });
  }

  async stageVersion(input: StageVersionInput): Promise<PackVersionRecord> {
    if (!input.packVersionId) throw new Error("packVersionId is required");
    const created = await this.models.SecurityPackVersion.create({
      id: input.packVersionId,
      tenant_id: input.tenantId,
      pack_id: input.packId,
      version: input.version,
      state: "staged",
      content_type: input.contentType,
      schema_version: input.schemaVersion,
      compression_alg: input.compressionAlg,
      encryption_alg: input.encryptionAlg,
      nonce: input.nonce,
      ciphertext: input.ciphertext,
      uncompressed_size: input.uncompressedSize,
      compressed_size: input.compressedSize,
      ciphertext_size: input.ciphertextSize,
      ciphertext_sha256: input.ciphertextSha256,
      dek_secret_ref: input.dekSecretRef,
      min_agent_version: input.minAgentVersion,
      policy_version: input.policyVersion,
      created_at: input.createdAt ?? new Date(),
      created_by: input.createdBy,
    });
    return asRecord(this.plain(created));
  }

  /**
   * Activate a staged version and retire the previously-active one in the same
   * lineage, atomically. The partial-unique active indexes guarantee at most one
   * active row per lineage; doing the retire+activate in one transaction keeps
   * the invariant even under concurrent activates.
   */
  async activateVersion(packVersionId: string): Promise<PackVersionRecord> {
    return this.sequelize.transaction(async (t: Transaction) => {
      const target = (await this.models.SecurityPackVersion.findByPk(packVersionId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      })) as Model | null;
      if (!target) throw new Error(`unknown pack_version_id=${packVersionId}`);
      const row = this.plain(target);
      const tenantId = row.tenant_id == null ? null : String(row.tenant_id);
      const packId = String(row.pack_id);

      // Retire the current active version in this lineage (if any and different).
      const lineageWhere =
        tenantId === null
          ? { pack_id: packId, tenant_id: { [Op.is]: null }, state: "active" }
          : { pack_id: packId, tenant_id: tenantId, state: "active" };
      await this.models.SecurityPackVersion.update(
        { state: "retired", retired_at: new Date() },
        {
          where: { ...lineageWhere, id: { [Op.ne]: packVersionId } },
          transaction: t,
        },
      );

      await this.models.SecurityPackVersion.update(
        { state: "active", activated_at: new Date() },
        { where: { id: packVersionId }, transaction: t },
      );

      const refreshed = (await this.models.SecurityPackVersion.findByPk(packVersionId, {
        transaction: t,
      })) as Model;
      return asRecord(this.plain(refreshed));
    });
  }

  async getVersion(packVersionId: string): Promise<PackVersionRecord | undefined> {
    const row = (await this.models.SecurityPackVersion.findByPk(packVersionId)) as Model | null;
    return row ? asRecord(this.plain(row)) : undefined;
  }

  async resolveForLease(
    tenantId: string,
    packId: string,
  ): Promise<PackVersionRecord | undefined> {
    // 1) explicit tenant assignment (composite PK → findOne, not findByPk).
    const pin = (await this.models.SecurityPackAssignment.findOne({
      where: { tenant_id: tenantId, pack_id: packId },
    })) as Model | null;
    if (pin) {
      const pvid = String(this.plain(pin).pack_version_id);
      const rec = await this.getVersion(pvid);
      if (rec) return rec;
    }

    // 2) tenant's own active version.
    const tenantActive = (await this.models.SecurityPackVersion.findOne({
      where: { pack_id: packId, tenant_id: tenantId, state: "active" },
    })) as Model | null;
    if (tenantActive) return asRecord(this.plain(tenantActive));

    // 3) default active version.
    const defaultActive = (await this.models.SecurityPackVersion.findOne({
      where: { pack_id: packId, tenant_id: { [Op.is]: null }, state: "active" },
    })) as Model | null;
    if (defaultActive) return asRecord(this.plain(defaultActive));

    return undefined;
  }

  async setTenantAssignment(
    tenantId: string,
    packId: string,
    packVersionId: string | null,
  ): Promise<void> {
    if (packVersionId === null) {
      await this.models.SecurityPackAssignment.destroy({
        where: { tenant_id: tenantId, pack_id: packId },
      });
      return;
    }
    await this.models.SecurityPackAssignment.upsert({
      tenant_id: tenantId,
      pack_id: packId,
      pack_version_id: packVersionId,
      created_at: new Date(),
      created_by: "system",
    });
  }
}
