import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { X509Certificate } from "node:crypto";
import {
  AGENT_LEAF_PROFILE,
  OpensslCAIssuer,
  issueLeafFromCsr,
  loadAgentCA,
} from "../src/pki/issueLeaf";

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

// The CertificateIssuer seam (L3-PKI-02) exists so the CA-key holder can be
// swapped for a managed signer later without touching handlers. These tests pin
// the guarantee that matters regardless of who signs: every issued Agent leaf is
// the fixed, constrained Agent profile — never something wider the CSR or a
// caller asked for. If a future signer implementation is added, it must pass
// these same assertions.
describe("CertificateIssuer constrains every leaf to the Agent profile", () => {
  it("issues a non-CA clientAuth leaf, ignoring what the CSR requests", () => {
    const ca = mintTempCA();
    try {
      // A CSR that *asks* to be a CA with serverAuth — the issuer must not honor it.
      const keyPath = path.join(ca.dir, "greedy.key");
      const csrPath = path.join(ca.dir, "greedy.csr");
      const cnfPath = path.join(ca.dir, "greedy.cnf");
      writeFileSync(
        cnfPath,
        [
          "[req]",
          "distinguished_name=dn",
          "req_extensions=v3_req",
          "[dn]",
          "[v3_req]",
          "basicConstraints=critical,CA:TRUE",
          "keyUsage=critical,keyCertSign,cRLSign",
          "extendedKeyUsage=serverAuth",
          "subjectAltName=DNS:evil.example.com",
          "",
        ].join("\n")
      );
      execFileSync(
        "openssl",
        [
          "req", "-new", "-newkey", "rsa:2048", "-nodes",
          "-keyout", keyPath, "-out", csrPath,
          "-subj", "/CN=greedy-agent",
          "-config", cnfPath, "-reqexts", "v3_req",
        ],
        { stdio: "ignore" }
      );
      const csr = readFileSync(csrPath, "utf8");

      const issuer = new OpensslCAIssuer(ca);
      const leaf = issuer.issueAgentLeaf(csr, {
        sanUri: "spiffe://fabric.abluva.io/tenant/t1/agent",
      });
      const x = new X509Certificate(leaf.certificatePem);

      // Not a CA, despite the CSR asking.
      assert.equal(x.ca, false, "issued leaf must not be a CA");
      // The SPIFFE SAN we asked for is present; the CSR's DNS SAN is not.
      assert.match(x.subjectAltName ?? "", /spiffe:\/\/fabric\.abluva\.io\/tenant\/t1\/agent/);
      assert.doesNotMatch(x.subjectAltName ?? "", /evil\.example\.com/);
      assert.ok(AGENT_LEAF_PROFILE.extendedKeyUsage.includes("clientAuth"));
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });

  it("clamps requested validity to the 30-day ceiling", () => {
    const ca = mintTempCA();
    try {
      const csr = mintCSR(ca.dir);
      const leaf = issueLeafFromCsr(csr, ca, { days: 3650 }); // asked for 10 years
      const days =
        (new Date(leaf.notAfter).getTime() - Date.now()) / (24 * 3600 * 1000);
      assert.ok(days <= 31, `validity should be clamped to ~30d, got ${days.toFixed(1)}d`);
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-SPIFFE SAN rather than smuggling it into the cert", () => {
    const ca = mintTempCA();
    try {
      const csr = mintCSR(ca.dir);
      assert.throws(
        () => issueLeafFromCsr(csr, ca, { sanUri: "https://evil.example.com" }),
        /invalid_san_uri/
      );
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed CSR", () => {
    const ca = mintTempCA();
    try {
      assert.throws(() => issueLeafFromCsr("not a csr", ca), /invalid_csr_pem/);
    } finally {
      rmSync(ca.dir, { recursive: true, force: true });
    }
  });
});
