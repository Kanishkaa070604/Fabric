-- Mesh Secure Pack schema (pre-production; no incremental chain).
-- FK target: ablv_tenants(tenant_id) — existing SaaS table (do not CREATE/ALTER it here).
-- Local compose mirror: deploy/local/postgres/init.sql (keep columns in sync).
--
-- A "lineage" is either the shared DEFAULT bundle (tenant_id IS NULL) or a
-- specific tenant's own (tenant_id set). Content is stored ONCE per lineage.
-- The DEK is NOT stored here — only dek_secret_ref, the key under which the DEK
-- lives in unified-access (PackKeyProtector, spec §5.3).
--
-- Allowed state: staged, active, retired

CREATE TABLE IF NOT EXISTS ablv_security_pack_versions (
  id UUID PRIMARY KEY,                       -- the pack_version_id used in AAD + leases + DEK key
  tenant_id UUID REFERENCES ablv_tenants(tenant_id),  -- NULL = default lineage
  pack_id TEXT NOT NULL,
  version BIGINT NOT NULL,                    -- monotonic within (pack_id, tenant_id) lineage
  state TEXT NOT NULL,
  content_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  compression_alg TEXT NOT NULL,
  encryption_alg TEXT NOT NULL,
  nonce BYTEA NOT NULL,                        -- 24-byte XChaCha nonce
  ciphertext BYTEA NOT NULL,                   -- v1: control-plane-served ciphertext (spec §9.5)
  uncompressed_size BIGINT NOT NULL,
  compressed_size BIGINT NOT NULL,
  ciphertext_size BIGINT NOT NULL,
  ciphertext_sha256 TEXT NOT NULL,             -- hex
  dek_secret_ref TEXT NOT NULL,                -- key under which the DEK lives in unified-access; NOT the DEK
  min_agent_version TEXT NOT NULL DEFAULT '',
  policy_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  CONSTRAINT ablv_security_pack_versions_state_chk CHECK (
    state IN ('staged', 'active', 'retired')
  ),
  CONSTRAINT ablv_security_pack_versions_version_chk CHECK (version >= 1),
  CONSTRAINT ablv_security_pack_versions_sizes_chk CHECK (
    uncompressed_size >= 0 AND compressed_size >= 0 AND ciphertext_size >= 0
  )
);

-- The NULL trap: UNIQUE(pack_id, version, tenant_id) permits unlimited duplicate
-- default rows because SQL treats NULLs as distinct. Two partial indexes give
-- the intended per-lineage uniqueness portably (spec §7.3).
CREATE UNIQUE INDEX IF NOT EXISTS ablv_security_pack_versions_default
  ON ablv_security_pack_versions (pack_id, version)
  WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ablv_security_pack_versions_tenant
  ON ablv_security_pack_versions (pack_id, version, tenant_id)
  WHERE tenant_id IS NOT NULL;

-- resolveForLease reads the active row for a lineage on every lease request.
-- At most one row per lineage may be active at a time (enforced in the txn, and
-- guarded by these partial-unique indexes on state='active').
CREATE UNIQUE INDEX IF NOT EXISTS ablv_security_pack_versions_active_default
  ON ablv_security_pack_versions (pack_id)
  WHERE tenant_id IS NULL AND state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS ablv_security_pack_versions_active_tenant
  ON ablv_security_pack_versions (pack_id, tenant_id)
  WHERE tenant_id IS NOT NULL AND state = 'active';

-- Explicit tenant→version pins (overrides tenant-own-active → default fallback).
CREATE TABLE IF NOT EXISTS ablv_security_pack_assignments (
  tenant_id UUID NOT NULL REFERENCES ablv_tenants(tenant_id),
  pack_id TEXT NOT NULL,
  pack_version_id UUID NOT NULL REFERENCES ablv_security_pack_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, pack_id)
);
