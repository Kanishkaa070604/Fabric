import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { issueLeafFromCsr } from "../src/pki/issueLeaf";
import { MemoryStore } from "../src/store/memory";

function mintTempCA(): { certPem: string; keyPem: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-rot-ca-"));
  const keyPath = path.join(dir, "ca.key");
  const certPath = path.join(dir, "ca.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=fabric-test-ca",
    ],
    { stdio: "ignore" }
  );
  return {
    dir,
    certPem: readFileSync(certPath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
}

function mintCSR(dir: string, label: string): string {
  const keyPath = path.join(dir, `${label}.key`);
  const csrPath = path.join(dir, `${label}.csr`);
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=connect-agent-${label}`,
    ],
    { stdio: "ignore" }
  );
  return readFileSync(csrPath, "utf8");
}

describe("L3-PKI-01a rotateAgentCert", () => {
  it("keeps agent_id, rebinds FP, honors overlap then prior lookup", async () => {
    const ca = mintTempCA();
    try {
      const store = new MemoryStore();
      const tenant = "22222222-2222-2222-2222-222222222222";
      await store.ensureTenant(tenant, "test");
      const boot = await store.issueBootstrapToken(tenant, "test");
      const leaf1 = issueLeafFromCsr(mintCSR(ca.dir, "a1"), {
        certPem: ca.certPem,
        keyPem: ca.keyPem,
      });
      const agent = await store.enrollAgent({
        tenant_id: tenant,
        bootstrap_token: boot,
        substrate: "kubernetes",
        cert_fingerprint_sha256: leaf1.fingerprintSha256,
        cert_not_after: leaf1.notAfter,
        actor: "test",
      });
      const leaf2 = issueLeafFromCsr(mintCSR(ca.dir, "a2"), {
        certPem: ca.certPem,
        keyPem: ca.keyPem,
      });
      const { agent: rotated, previous_fingerprint } = await store.rotateAgentCert({
        agent_id: agent.id,
        cert_fingerprint_sha256: leaf2.fingerprintSha256,
        cert_not_after: leaf2.notAfter,
        actor: "test",
        overlap_seconds: 600,
      });
      assert.equal(rotated.id, agent.id);
      assert.equal(rotated.cert_fingerprint_sha256, leaf2.fingerprintSha256);
      assert.equal(previous_fingerprint, leaf1.fingerprintSha256);
      assert.ok(rotated.cert_not_after);
      const byNew = await store.findAgentByCertFingerprint(leaf2.fingerprintSha256);
      assert.equal(byNew?.id, agent.id);
      const byOld = await store.findAgentByCertFingerprint(leaf1.fingerprintSha256);
      assert.equal(byOld?.id, agent.id, "overlap should accept prior FP");
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });

  it("authzContext honors the prior fingerprint during overlap, same as findAgentByCertFingerprint", async () => {
    // Regression for the P0 gap: authzContext's cert_fingerprint branch
    // used to only match the CURRENT fingerprint, so a tunnel still
    // presenting its just-rotated (but not-yet-expired-overlap) cert
    // would pass Gateway's accept-time lookupAgentByCert (which goes
    // through findAgentByCertFingerprint, prior-FP-aware) but then fail
    // every StreamOpen authz check via authzContext, which didn't apply
    // the same prior-FP-within-overlap rule.
    const ca = mintTempCA();
    try {
      const store = new MemoryStore();
      const tenant = "44444444-4444-4444-4444-444444444444";
      await store.ensureTenant(tenant, "test");
      const boot = await store.issueBootstrapToken(tenant, "test");
      const leaf1 = issueLeafFromCsr(mintCSR(ca.dir, "c1"), {
        certPem: ca.certPem,
        keyPem: ca.keyPem,
      });
      const agent = await store.enrollAgent({
        tenant_id: tenant,
        bootstrap_token: boot,
        substrate: "kubernetes",
        cert_fingerprint_sha256: leaf1.fingerprintSha256,
        cert_not_after: leaf1.notAfter,
        actor: "test",
      });
      // Default auto_approve → Connecting
      await store.reportTunnel({
        tenant_id: tenant,
        agent_id: agent.id,
        event: "up",
        actor: "gateway",
      });
      const leaf2 = issueLeafFromCsr(mintCSR(ca.dir, "c2"), {
        certPem: ca.certPem,
        keyPem: ca.keyPem,
      });
      await store.rotateAgentCert({
        agent_id: agent.id,
        cert_fingerprint_sha256: leaf2.fingerprintSha256,
        cert_not_after: leaf2.notAfter,
        actor: "test",
        overlap_seconds: 600,
      });

      const ctxOld = await store.authzContext({
        tenant_id: tenant,
        cert_fingerprint: leaf1.fingerprintSha256,
      });
      assert.equal(
        ctxOld.agent_id,
        agent.id,
        "authzContext must still resolve the agent by its prior FP during overlap"
      );
      assert.equal(ctxOld.agent_approved, true);

      const ctxNew = await store.authzContext({
        tenant_id: tenant,
        cert_fingerprint: leaf2.fingerprintSha256,
      });
      assert.equal(ctxNew.agent_id, agent.id);
      assert.equal(ctxNew.agent_approved, true);
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });

  it("overlap_seconds=0 revokes previous fingerprint", async () => {
    const ca = mintTempCA();
    try {
      const store = new MemoryStore();
      const tenant = "33333333-3333-3333-3333-333333333333";
      await store.ensureTenant(tenant, "test");
      const boot = await store.issueBootstrapToken(tenant, "test");
      const leaf1 = issueLeafFromCsr(mintCSR(ca.dir, "b1"), {
        certPem: ca.certPem,
        keyPem: ca.keyPem,
      });
      const agent = await store.enrollAgent({
        tenant_id: tenant,
        bootstrap_token: boot,
        substrate: "kubernetes",
        cert_fingerprint_sha256: leaf1.fingerprintSha256,
        actor: "test",
      });
      const leaf2 = issueLeafFromCsr(mintCSR(ca.dir, "b2"), {
        certPem: ca.certPem,
        keyPem: ca.keyPem,
      });
      await store.rotateAgentCert({
        agent_id: agent.id,
        cert_fingerprint_sha256: leaf2.fingerprintSha256,
        actor: "test",
        overlap_seconds: 0,
      });
      const t = await store.getTenant(tenant);
      assert.ok(t?.revoked_cert_fingerprints.includes(leaf1.fingerprintSha256));
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });
});
