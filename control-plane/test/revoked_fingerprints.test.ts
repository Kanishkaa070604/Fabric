import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addRevokedFingerprint,
  MAX_REVOKED_CERT_FINGERPRINTS,
} from "../src/store/types";
import { MemoryStore } from "../src/store/memory";

const TENANT = "00000000-0000-0000-0000-0000000000bb";

describe("addRevokedFingerprint bounded retention", () => {
  it("appends new fingerprints and records their cause", () => {
    const { fingerprints, causes } = addRevokedFingerprint(
      ["fp-1"],
      { "fp-1": "security" },
      "fp-2",
      "decommission"
    );
    assert.deepEqual(fingerprints, ["fp-1", "fp-2"]);
    assert.deepEqual(causes, { "fp-1": "security", "fp-2": "decommission" });
  });

  it("moves an already-present fingerprint to the most-recent position and updates its cause", () => {
    const { fingerprints, causes } = addRevokedFingerprint(
      ["fp-1", "fp-2", "fp-3"],
      { "fp-1": "security", "fp-2": "security", "fp-3": "security" },
      "fp-1",
      "decommission"
    );
    assert.deepEqual(fingerprints, ["fp-2", "fp-3", "fp-1"]);
    assert.equal(causes["fp-1"], "decommission");
  });

  it("never grows past MAX_REVOKED_CERT_FINGERPRINTS, dropping the oldest first", () => {
    let fingerprints: string[] = [];
    let causes: Record<string, "security" | "decommission"> = {};
    const total = MAX_REVOKED_CERT_FINGERPRINTS + 50;
    for (let i = 0; i < total; i++) {
      const r = addRevokedFingerprint(fingerprints, causes, `fp-${i}`, "security");
      fingerprints = r.fingerprints;
      causes = r.causes;
    }
    assert.equal(fingerprints.length, MAX_REVOKED_CERT_FINGERPRINTS);
    // Oldest 50 were dropped; the list is exactly the most recent MAX entries, newest last.
    assert.equal(fingerprints[0], `fp-${total - MAX_REVOKED_CERT_FINGERPRINTS}`);
    assert.equal(fingerprints[fingerprints.length - 1], `fp-${total - 1}`);
    // Dropped fingerprints' causes must not linger forever (that's the actual leak being fixed).
    assert.equal(Object.keys(causes).length, MAX_REVOKED_CERT_FINGERPRINTS);
    assert.equal(causes["fp-0"], undefined);
  });

  it("MemoryStore.revokeCertFingerprint stays bounded across many rotations for one tenant", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const total = MAX_REVOKED_CERT_FINGERPRINTS + 10;
    for (let i = 0; i < total; i++) {
      await s.revokeCertFingerprint(TENANT, `fp-${i}`, "ops");
    }
    // The oldest fingerprint must no longer be considered revoked...
    const oldCtx = await s.authzContext({ tenant_id: TENANT, cert_fingerprint: "fp-0" });
    assert.equal(oldCtx.cert_revoked, false);
    // ...while a recent one still is.
    const newCtx = await s.authzContext({
      tenant_id: TENANT,
      cert_fingerprint: `fp-${total - 1}`,
    });
    assert.equal(newCtx.cert_revoked, true);
  });
});
