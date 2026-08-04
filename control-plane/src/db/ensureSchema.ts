import type { Sequelize } from "sequelize";
import { log } from "../logging";

/**
 * Idempotent column adds for local/prod DBs that were created before
 * L3-CTL-01a / L3-PKI-01a migrations. Safe to run on every boot.
 */
export async function ensureMeshSchema(sequelize: Sequelize): Promise<void> {
  const statements = [
    `ALTER TABLE ablv_tenant_connect ADD COLUMN IF NOT EXISTS agent_api_token_hash BYTEA`,
    `ALTER TABLE ablv_tenant_connect ADD COLUMN IF NOT EXISTS agent_api_token_expires_at TIMESTAMPTZ`,
    `ALTER TABLE ablv_tenant_connect ADD COLUMN IF NOT EXISTS prior_agent_api_token_hash BYTEA`,
    `ALTER TABLE ablv_tenant_connect ADD COLUMN IF NOT EXISTS prior_agent_api_token_valid_until TIMESTAMPTZ`,
    `ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS prior_cert_fingerprint_sha256 TEXT`,
    `ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS prior_cert_valid_until TIMESTAMPTZ`,
  ];
  for (const sql of statements) {
    await sequelize.query(sql);
  }
  log.info("schema_ensure_ok", {
    layer: "store",
    note: "agent_api_token + prior token/cert columns",
  });
}
