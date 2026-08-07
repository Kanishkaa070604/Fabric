-- Local compose only: stub SaaS tenants table so Fabric FKs work.
CREATE TABLE IF NOT EXISTS ablv_tenants (
  tenant_id UUID PRIMARY KEY
);

-- Fabric schema — keep in sync with the single migration
-- control-plane/migrations/20260723120000-init-fabric.sql (pre-prod: no incremental chain).
CREATE TABLE IF NOT EXISTS ablv_tenant_connect (
  tenant_id UUID PRIMARY KEY REFERENCES ablv_tenants(tenant_id),
  auto_approve_agents BOOLEAN NOT NULL DEFAULT TRUE,
  max_tunnels INTEGER NOT NULL DEFAULT 50,
  max_concurrent_streams INTEGER NOT NULL DEFAULT 2000,
  max_stream_open_per_sec INTEGER NOT NULL DEFAULT 100,
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_cause TEXT,
  strict_substrate_binding BOOLEAN NOT NULL DEFAULT FALSE,
  expected_substrate_fingerprint TEXT,
  oidc_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  oidc_issuer_url TEXT,
  oidc_jwks_uri TEXT,
  oidc_audience TEXT NOT NULL DEFAULT 'abluva-connect',
  oidc_allowed_algs TEXT[] NOT NULL DEFAULT ARRAY['RS256']::TEXT[],
  oidc_ca_bundle_pem TEXT,
  oidc_last_discovery_ok_at TIMESTAMPTZ,
  oidc_last_discovery_error TEXT,
  workload_evidence_strategy TEXT NOT NULL DEFAULT 'none',
  workload_evidence_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  bootstrap_token_hash BYTEA,
  bootstrap_expires_at TIMESTAMPTZ,
  agent_api_token_hash BYTEA,
  agent_api_token_expires_at TIMESTAMPTZ,
  prior_agent_api_token_hash BYTEA,
  prior_agent_api_token_valid_until TIMESTAMPTZ,
  revoked_cert_fingerprints JSONB NOT NULL DEFAULT '[]'::JSONB,
  revoked_cert_causes JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ablv_registrations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES ablv_tenants(tenant_id),
  generation BIGINT NOT NULL DEFAULT 1,
  connectivity_type TEXT NOT NULL,
  source_kind TEXT,
  destination_kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  resource_type TEXT,
  host TEXT,
  port INTEGER,
  tls_mode TEXT NOT NULL DEFAULT 'in-band',
  workload_evidence_attribution_level TEXT NOT NULL DEFAULT 'standard',
  intended_consumers JSONB NOT NULL DEFAULT '[]'::JSONB,
  state TEXT NOT NULL,
  failure_reason TEXT,
  observed JSONB NOT NULL DEFAULT '{}'::JSONB,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ablv_registrations_tenant_display_active
  ON ablv_registrations (tenant_id, display_name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ablv_agents (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES ablv_tenants(tenant_id),
  state TEXT NOT NULL,
  substrate TEXT NOT NULL,
  substrate_fingerprint TEXT,
  enrollment_approved_at TIMESTAMPTZ,
  enrollment_approved_by TEXT,
  cert_fingerprint_sha256 TEXT,
  cert_not_after TIMESTAMPTZ,
  cert_serial TEXT,
  prior_cert_fingerprint_sha256 TEXT,
  prior_cert_valid_until TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  tunnel_state TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ablv_agents_tenant_cert_live
  ON ablv_agents (tenant_id, cert_fingerprint_sha256)
  WHERE cert_fingerprint_sha256 IS NOT NULL
    AND deleted_at IS NULL
    AND state <> 'Retired';
