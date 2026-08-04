import type { Sequelize, Model, ModelStatic } from "sequelize";
import { DataTypes } from "sequelize";
import type { FabricConfig } from "../config";

/**
 * Sequelize models matching control-plane/migrations/20260723120000-init-fabric.sql
 * Table names use cfg.tablePrefix (default ablv_).
 */

export type FabricModels = {
  TenantConnect: ModelStatic<Model>;
  Registration: ModelStatic<Model>;
  Agent: ModelStatic<Model>;
};

export function defineFabricModels(sequelize: Sequelize, cfg: FabricConfig): FabricModels {
  const prefix = cfg.tablePrefix;

  const TenantConnect = sequelize.define(
    "TenantConnect",
    {
      tenant_id: { type: DataTypes.UUID, primaryKey: true },
      auto_approve_agents: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      max_tunnels: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50 },
      max_concurrent_streams: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2000 },
      max_stream_open_per_sec: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
      suspended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      suspended_cause: { type: DataTypes.TEXT },
      strict_substrate_binding: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      expected_substrate_fingerprint: { type: DataTypes.TEXT },
      oidc_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      oidc_issuer_url: { type: DataTypes.TEXT },
      oidc_jwks_uri: { type: DataTypes.TEXT },
      oidc_audience: { type: DataTypes.TEXT, defaultValue: "abluva-connect" },
      oidc_allowed_algs: { type: DataTypes.ARRAY(DataTypes.TEXT) },
      oidc_ca_bundle_pem: { type: DataTypes.TEXT },
      oidc_last_discovery_ok_at: { type: DataTypes.DATE },
      oidc_last_discovery_error: { type: DataTypes.TEXT },
      bootstrap_token_hash: { type: DataTypes.BLOB },
      bootstrap_expires_at: { type: DataTypes.DATE },
      agent_api_token_hash: { type: DataTypes.BLOB },
      agent_api_token_expires_at: { type: DataTypes.DATE },
      prior_agent_api_token_hash: { type: DataTypes.BLOB },
      prior_agent_api_token_valid_until: { type: DataTypes.DATE },
      revoked_cert_fingerprints: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      revoked_cert_causes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: DataTypes.DATE, allowNull: false },
      created_by: { type: DataTypes.TEXT, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      updated_by: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      tableName: `${prefix}tenant_connect`,
      schema: cfg.pgSchema,
      timestamps: false,
      underscored: true,
    }
  );

  const Registration = sequelize.define(
    "Registration",
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      generation: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 1 },
      connectivity_type: { type: DataTypes.TEXT, allowNull: false },
      source_kind: { type: DataTypes.TEXT },
      destination_kind: { type: DataTypes.TEXT, allowNull: false },
      display_name: { type: DataTypes.TEXT, allowNull: false },
      resource_type: { type: DataTypes.TEXT },
      host: { type: DataTypes.TEXT },
      port: { type: DataTypes.INTEGER },
      tls_mode: { type: DataTypes.TEXT, allowNull: false, defaultValue: "in-band" },
      workload_evidence_attribution_level: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: "standard",
      },
      intended_consumers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      state: { type: DataTypes.TEXT, allowNull: false },
      failure_reason: { type: DataTypes.TEXT },
      observed: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      deleted_at: { type: DataTypes.DATE },
      created_at: { type: DataTypes.DATE, allowNull: false },
      created_by: { type: DataTypes.TEXT, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      updated_by: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      tableName: `${prefix}registrations`,
      schema: cfg.pgSchema,
      timestamps: false,
      underscored: true,
    }
  );

  const Agent = sequelize.define(
    "Agent",
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      state: { type: DataTypes.TEXT, allowNull: false },
      substrate: { type: DataTypes.TEXT, allowNull: false },
      substrate_fingerprint: { type: DataTypes.TEXT },
      enrollment_approved_at: { type: DataTypes.DATE },
      enrollment_approved_by: { type: DataTypes.TEXT },
      cert_fingerprint_sha256: { type: DataTypes.TEXT },
      cert_not_after: { type: DataTypes.DATE },
      cert_serial: { type: DataTypes.TEXT },
      prior_cert_fingerprint_sha256: { type: DataTypes.TEXT },
      prior_cert_valid_until: { type: DataTypes.DATE },
      last_heartbeat_at: { type: DataTypes.DATE },
      tunnel_state: { type: DataTypes.TEXT },
      deleted_at: { type: DataTypes.DATE },
      created_at: { type: DataTypes.DATE, allowNull: false },
      created_by: { type: DataTypes.TEXT, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      updated_by: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      tableName: `${prefix}agents`,
      schema: cfg.pgSchema,
      timestamps: false,
      underscored: true,
    }
  );

  return { TenantConnect, Registration, Agent };
}
