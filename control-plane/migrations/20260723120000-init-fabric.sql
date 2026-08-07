-- Mesh control-plane schema (single migration — pre-production; no incremental chain).
-- FK target: ablv_tenants(tenant_id) — existing SaaS table (do not CREATE/ALTER that table here).
-- Apply via Sequelize CLI or psql once Access API DB creds are wired.
-- Local compose mirror: deploy/local/postgres/init.sql (keep columns in sync).
--
-- Allowed agent.state: NotInstalled, Installing, Bootstrapping, PendingApproval,
--   Connecting, Connected, Degraded, Disconnected, Reconnecting, Retired
-- Allowed registration.state: Requested, Validating, Provisioning, Active,
--   Updating, Deleting, Deleted, Failed
-- Allowed connectivity_type: SERVICE | RESOURCE
-- Allowed destination_kind: PLATFORM_SERVICE | PLATFORM_RESOURCE |
--   CUSTOMER_SERVICE | CUSTOMER_RESOURCE

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
  -- L3-EVID-01: pluggable workload-evidence strategy (Part 4a)
  workload_evidence_strategy TEXT NOT NULL DEFAULT 'none',
  workload_evidence_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  bootstrap_token_hash BYTEA,
  bootstrap_expires_at TIMESTAMPTZ,
  -- L3-CTL-01a / G-CRED-1: scoped Agent API bearer (hash + prior overlap)
  agent_api_token_hash BYTEA,
  agent_api_token_expires_at TIMESTAMPTZ,
  prior_agent_api_token_hash BYTEA,
  prior_agent_api_token_valid_until TIMESTAMPTZ,
  revoked_cert_fingerprints JSONB NOT NULL DEFAULT '[]'::JSONB,
  revoked_cert_causes JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  CONSTRAINT ablv_tenant_connect_quotas_positive CHECK (
    max_tunnels > 0
    AND max_concurrent_streams > 0
    AND max_stream_open_per_sec > 0
  ),
  CONSTRAINT ablv_tenant_connect_suspended_cause_chk CHECK (
    suspended_cause IS NULL OR suspended_cause IN ('billing', 'security')
  ),
  CONSTRAINT ablv_tenant_connect_evidence_strategy_chk CHECK (
    workload_evidence_strategy IN ('none', 'kubernetes_oidc', 'ecs_task_identity')
  )
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
  updated_by TEXT NOT NULL,
  CONSTRAINT ablv_registrations_connectivity_type_chk CHECK (
    connectivity_type IN ('SERVICE', 'RESOURCE')
  ),
  CONSTRAINT ablv_registrations_destination_kind_chk CHECK (
    destination_kind IN (
      'PLATFORM_SERVICE',
      'PLATFORM_RESOURCE',
      'CUSTOMER_SERVICE',
      'CUSTOMER_RESOURCE'
    )
  ),
  CONSTRAINT ablv_registrations_state_chk CHECK (
    state IN (
      'Requested',
      'Validating',
      'Provisioning',
      'Active',
      'Updating',
      'Deleting',
      'Deleted',
      'Failed'
    )
  ),
  CONSTRAINT ablv_registrations_port_chk CHECK (
    port IS NULL OR (port > 0 AND port <= 65535)
  ),
  CONSTRAINT ablv_registrations_generation_chk CHECK (generation >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS ablv_registrations_tenant_display_active
  ON ablv_registrations (tenant_id, display_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ablv_registrations_tenant_state
  ON ablv_registrations (tenant_id, state);

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
  -- L3-PKI-01a: prior leaf during rotate overlap
  prior_cert_fingerprint_sha256 TEXT,
  prior_cert_valid_until TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  tunnel_state TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  CONSTRAINT ablv_agents_state_chk CHECK (
    state IN (
      'NotInstalled',
      'Installing',
      'Bootstrapping',
      'PendingApproval',
      'Connecting',
      'Connected',
      'Degraded',
      'Disconnected',
      'Reconnecting',
      'Retired'
    )
  )
);

CREATE INDEX IF NOT EXISTS ablv_agents_tenant_state
  ON ablv_agents (tenant_id, state);

CREATE UNIQUE INDEX IF NOT EXISTS ablv_agents_tenant_cert_live
  ON ablv_agents (tenant_id, cert_fingerprint_sha256)
  WHERE cert_fingerprint_sha256 IS NOT NULL
    AND deleted_at IS NULL
    AND state <> 'Retired';
