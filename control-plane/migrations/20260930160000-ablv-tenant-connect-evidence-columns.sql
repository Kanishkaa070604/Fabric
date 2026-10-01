-- Additive: ablv_tenant_connect workload-evidence columns (+ registrations).
-- Fresh installs already get these from 20260723120000-init-fabric.sql.
-- Existing Day-0 DBs from older DDL skip CREATE TABLE IF NOT EXISTS and were
-- missing workload_evidence_* (ensure/bootstrap → column does not exist).
-- Safe to re-run (IF NOT EXISTS).

SET search_path TO control;

ALTER TABLE ablv_tenant_connect
  ADD COLUMN IF NOT EXISTS workload_evidence_strategy TEXT NOT NULL DEFAULT 'none';
ALTER TABLE ablv_tenant_connect
  ADD COLUMN IF NOT EXISTS workload_evidence_config JSONB NOT NULL DEFAULT '{}'::JSONB;

DO $$
BEGIN
  ALTER TABLE ablv_tenant_connect
    ADD CONSTRAINT ablv_tenant_connect_evidence_strategy_chk
    CHECK (workload_evidence_strategy IN ('none', 'kubernetes_oidc', 'ecs_task_identity'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Registrations: attribution level (same class of older-DDL gap).
ALTER TABLE ablv_registrations
  ADD COLUMN IF NOT EXISTS workload_evidence_attribution_level TEXT NOT NULL DEFAULT 'standard';
