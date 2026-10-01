/**
 * Sequelize models for the Secure Pack subsystem — owned here, NOT in
 * src/db/models.ts, so the pack subsystem is self-contained and the core
 * FabricModels stays focused on tenants/agents/registrations.
 *
 * Matches control-plane/migrations/20260727120000-packs.sql. Table names use
 * cfg.tablePrefix (default ablv_).
 */

import type { Sequelize, Model, ModelStatic } from "sequelize";
import { DataTypes } from "sequelize";
import type { FabricConfig } from "../config";

export type PackModels = {
  SecurityPackVersion: ModelStatic<Model>;
  SecurityPackAssignment: ModelStatic<Model>;
};

export function definePackModels(sequelize: Sequelize, cfg: FabricConfig): PackModels {
  const prefix = cfg.tablePrefix;

  const SecurityPackVersion = sequelize.define(
    "SecurityPackVersion",
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      tenant_id: { type: DataTypes.UUID, allowNull: true },
      pack_id: { type: DataTypes.TEXT, allowNull: false },
      version: { type: DataTypes.BIGINT, allowNull: false },
      state: { type: DataTypes.TEXT, allowNull: false },
      content_type: { type: DataTypes.TEXT, allowNull: false },
      schema_version: { type: DataTypes.TEXT, allowNull: false },
      compression_alg: { type: DataTypes.TEXT, allowNull: false },
      encryption_alg: { type: DataTypes.TEXT, allowNull: false },
      nonce: { type: DataTypes.BLOB, allowNull: false },
      ciphertext: { type: DataTypes.BLOB, allowNull: false },
      uncompressed_size: { type: DataTypes.BIGINT, allowNull: false },
      compressed_size: { type: DataTypes.BIGINT, allowNull: false },
      ciphertext_size: { type: DataTypes.BIGINT, allowNull: false },
      ciphertext_sha256: { type: DataTypes.TEXT, allowNull: false },
      dek_secret_ref: { type: DataTypes.TEXT, allowNull: false },
      min_agent_version: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      policy_version: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 1 },
      created_at: { type: DataTypes.DATE, allowNull: false },
      created_by: { type: DataTypes.TEXT, allowNull: false },
      activated_at: { type: DataTypes.DATE },
      retired_at: { type: DataTypes.DATE },
    },
    {
      tableName: `${prefix}security_pack_versions`,
      schema: cfg.pgSchema,
      timestamps: false,
      underscored: true,
    },
  );

  const SecurityPackAssignment = sequelize.define(
    "SecurityPackAssignment",
    {
      tenant_id: { type: DataTypes.UUID, primaryKey: true },
      pack_id: { type: DataTypes.TEXT, primaryKey: true },
      pack_version_id: { type: DataTypes.UUID, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      created_by: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      tableName: `${prefix}security_pack_assignments`,
      schema: cfg.pgSchema,
      timestamps: false,
      underscored: true,
    },
  );

  return { SecurityPackVersion, SecurityPackAssignment };
}
