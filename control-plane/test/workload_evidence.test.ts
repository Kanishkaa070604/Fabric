/**
 * Workload-evidence strategy API (L3-EVID-01).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory";
import { publicWorkloadEvidence } from "../src/store/types";

describe("workload evidence strategy", () => {
  it("defaults to none and exposes evidence_trust on authz", async () => {
    const store = new MemoryStore();
    const t = await store.ensureTenant("11111111-1111-1111-1111-111111111111", "test");
    assert.equal(t.workload_evidence_strategy, "none");
    const ctx = await store.authzContext({
      tenant_id: t.tenant_id,
    });
    assert.equal(ctx.evidence_trust.strategy, "none");
    assert.equal(ctx.evidence_trust.oidc_enabled, false);
  });

  it("setWorkloadEvidence arms kubernetes_oidc fields", async () => {
    const store = new MemoryStore();
    const tid = "22222222-2222-2222-2222-222222222222";
    await store.ensureTenant(tid, "test");
    const t = await store.setWorkloadEvidence(
      tid,
      {
        strategy: "kubernetes_oidc",
        oidc_issuer_url: "https://oidc.example/k8s",
        oidc_jwks_uri: "https://oidc.example/k8s/openid/v1/jwks",
        oidc_enabled: true,
        oidc_last_discovery_ok_at: new Date(),
        oidc_last_discovery_error: null,
      },
      "admin"
    );
    assert.equal(t.workload_evidence_strategy, "kubernetes_oidc");
    assert.equal(t.oidc_enabled, true);
    const pub = publicWorkloadEvidence(t);
    assert.equal(pub.evidence_trust.jwks_uri, t.oidc_jwks_uri);
    assert.equal(pub.strategy, "kubernetes_oidc");
  });

  it("rejects unknown strategy", async () => {
    const store = new MemoryStore();
    const tid = "33333333-3333-3333-3333-333333333333";
    await store.ensureTenant(tid, "test");
    await assert.rejects(
      () =>
        store.setWorkloadEvidence(
          tid,
          { strategy: "nope" as "none" },
          "admin"
        ),
      /workload_evidence_strategy_invalid/
    );
  });

  it("rejects ecs_task_identity until Gateway implementation ships (L3-POC-ECS)", async () => {
    const store = new MemoryStore();
    const tid = "44444444-4444-4444-4444-444444444444";
    await store.ensureTenant(tid, "test");
    await assert.rejects(
      () =>
        store.setWorkloadEvidence(
          tid,
          { strategy: "ecs_task_identity" },
          "admin"
        ),
      /workload_evidence_strategy_invalid/
    );
  });
});
