-- Additive: ablv_agents API-token + prior-cert columns.
-- Fresh installs already get these from 20260723120000-init-fabric.sql.
-- Existing Day-0 DBs created from an older agents DDL skip CREATE TABLE IF NOT
-- EXISTS and were missing these columns (heartbeat_watchdog: api_token_hash).
-- Safe to re-run (IF NOT EXISTS).

SET search_path TO control;

ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS prior_cert_fingerprint_sha256 TEXT;
ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS prior_cert_valid_until TIMESTAMPTZ;
ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS api_token_hash BYTEA;
ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS api_token_expires_at TIMESTAMPTZ;
ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS prior_api_token_hash BYTEA;
ALTER TABLE ablv_agents ADD COLUMN IF NOT EXISTS prior_api_token_valid_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ablv_agents_api_token_hash
  ON ablv_agents (api_token_hash)
  WHERE api_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS ablv_agents_prior_api_token_hash
  ON ablv_agents (prior_api_token_hash)
  WHERE prior_api_token_hash IS NOT NULL;
