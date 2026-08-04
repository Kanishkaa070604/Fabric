import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectExpiringAgents } from "../src/jobs/certExpiryScan";
import { MemoryStore } from "../src/store/memory";

describe("L3-PKI-01 cert expiry scan", () => {
  it("flags agents inside the warn window; skips retired and far-future", async () => {
    const store = new MemoryStore();
    const tenant = "44444444-4444-4444-4444-444444444444";
    await store.ensureTenant(tenant, "test");
    // Memory store keeps bootstrap multi-redeem until expiry (same as prod window).
    const boot = await store.issueBootstrapToken(tenant, "test");
    const now = new Date("2026-07-26T00:00:00.000Z");
    const soon = new Date(now.getTime() + 5 * 86_400_000); // 5d
    const later = new Date(now.getTime() + 60 * 86_400_000); // 60d

    const a1 = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "aa".repeat(32),
      cert_not_after: soon,
      actor: "test",
    });
    await store.approveAgent(a1.id, "test");

    const a2 = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "bb".repeat(32),
      cert_not_after: later,
      actor: "test",
    });
    await store.approveAgent(a2.id, "test");

    const a3 = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "cc".repeat(32),
      cert_not_after: soon,
      actor: "test",
    });
    await store.retireAgent(a3.id, "test");

    const warnWithinMs = 30 * 86_400_000;
    const found = await collectExpiringAgents(store, warnWithinMs, now);
    assert.equal(found.length, 1);
    assert.equal(found[0].agent_id, a1.id);
    assert.equal(found[0].days_remaining, 5);
  });
});
