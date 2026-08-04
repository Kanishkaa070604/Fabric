import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { issueLeafFromCsr, loadAgentCA } from "../src/pki/issueLeaf";

function mintTempCA(): { certPem: string; keyPem: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-ca-"));
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

function mintCSR(dir: string): string {
  const keyPath = path.join(dir, "agent.key");
  const csrPath = path.join(dir, "agent.csr");
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
      "/CN=connect-agent",
    ],
    { stdio: "ignore" }
  );
  return readFileSync(csrPath, "utf8");
}

describe("issueLeafFromCsr (L3-AGT-02)", () => {
  it("signs a CSR and returns a distinct fingerprint", () => {
    const ca = mintTempCA();
    try {
      const csr1 = mintCSR(ca.dir);
      writeFileSync(path.join(ca.dir, "dummy"), ""); // keep dir busy for second csr helper
      const csr2Dir = mkdtempSync(path.join(tmpdir(), "mesh-csr2-"));
      try {
        const csr2 = mintCSR(csr2Dir);
        const leaf1 = issueLeafFromCsr(csr1, ca);
        const leaf2 = issueLeafFromCsr(csr2, ca);
        assert.match(leaf1.certificatePem, /BEGIN CERTIFICATE/);
        assert.match(leaf1.fingerprintSha256, /^[0-9a-f]{64}$/);
        assert.notEqual(leaf1.fingerprintSha256, leaf2.fingerprintSha256);
      } finally {
        rmSync(csr2Dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });

  it("loadAgentCA reads file env", () => {
    const ca = mintTempCA();
    try {
      const loaded = loadAgentCA({
        FABRIC_AGENT_CA_CERT_FILE: path.join(ca.dir, "ca.crt"),
        FABRIC_AGENT_CA_KEY_FILE: path.join(ca.dir, "ca.key"),
      });
      assert.ok(loaded);
      assert.match(loaded!.certPem, /BEGIN CERTIFICATE/);
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });
});
