import assert from "node:assert/strict";
import { createPrivateKey, createSign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  AgentCertificateError,
  agentPopMessage,
  assertSignedAtFresh,
  popSkewSecondsFromEnv,
  verifyAgentCertificate,
  verifyAgentLeafPop,
  verifyLeafMessageSignature,
} from "../src/pki/verifyAgentLeaf";
import { issueLeafFromCsr } from "../src/pki/issueLeaf";
import { createServer } from "../src/http/server";
import { MemoryStore } from "../src/store/memory";

// The Agent CA relationship must be proven cryptographically, not inferred
// from issuer/subject naming. `X509Certificate.checkIssued()` is documented
// as a metadata/pruning check, so on its own it accepts a certificate that
// merely *claims* the right issuer. These tests pin the real gate --
// `leaf.verify(ca.publicKey)` -- plus the validity-window checks, and they
// must never be deleted: without them, possession of a self-minted leaf
// reaches proof-of-possession and looks like a genuine Fabric identity.

const CA_SUBJECT = "/CN=fabric-agent-ca";

function mintCA(dir: string, label: string, subject: string) {
  const keyPath = path.join(dir, `${label}.key`);
  const certPath = path.join(dir, `${label}.crt`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "2", "-subj", subject,
    ],
    { stdio: "ignore" }
  );
  return {
    certPem: readFileSync(certPath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
}

/** Subject Key Identifier of a CA cert, as the `AA:BB:..` hex openssl prints. */
function subjectKeyIdentifier(dir: string, certPem: string): string {
  const p = path.join(dir, `ski-${Math.random().toString(36).slice(2)}.crt`);
  writeFileSync(p, certPem);
  const out = execFileSync(
    "openssl",
    ["x509", "-in", p, "-noout", "-ext", "subjectKeyIdentifier"],
    { encoding: "utf8" }
  );
  const hex = out.trim().split("\n").pop()!.trim();
  assert.match(hex, /^([0-9A-Fa-f]{2}:){19}[0-9A-Fa-f]{2}$/, `unexpected SKI: ${out}`);
  return hex;
}

/**
 * Mint the forgery a real attacker would build: a leaf signed by a CA the
 * platform does not trust, but carrying the trusted CA's subject DN *and*
 * an Authority Key Identifier copied from the trusted CA's SKI.
 *
 * Both of those are attacker-controlled values -- they are claims printed
 * into the certificate, not proofs -- which is exactly why matching them is
 * not evidence of issuance. This is the input that makes `checkIssued()`
 * return true while `verify()` returns false.
 */
function mintForgedLeaf(
  dir: string,
  label: string,
  signingCA: { certPem: string; keyPem: string },
  impersonatedCACertPem: string
): { certPem: string; keyPem: string } {
  const { keyPem, csrPem } = mintKeyAndCSR(dir, label);
  const ski = subjectKeyIdentifier(dir, impersonatedCACertPem);
  const csrPath = path.join(dir, `${label}.forge.csr`);
  const caCertPath = path.join(dir, `${label}.forge-ca.crt`);
  const caKeyPath = path.join(dir, `${label}.forge-ca.key`);
  const extPath = path.join(dir, `${label}.forge.ext`);
  const outPath = path.join(dir, `${label}.forge.crt`);
  writeFileSync(csrPath, csrPem);
  writeFileSync(caCertPath, signingCA.certPem);
  writeFileSync(caKeyPath, signingCA.keyPem, { mode: 0o600 });
  writeFileSync(
    extPath,
    [
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth",
      // DER for SEQUENCE { [0] keyIdentifier OCTET STRING (20 bytes) }.
      `authorityKeyIdentifier=DER:30:16:80:14:${ski}`,
      "",
    ].join("\n")
  );
  execFileSync(
    "openssl",
    [
      "x509", "-req", "-in", csrPath,
      "-CA", caCertPath, "-CAkey", caKeyPath, "-CAcreateserial",
      "-out", outPath, "-days", "2", "-sha256", "-extfile", extPath,
    ],
    { stdio: "ignore" }
  );
  return { certPem: readFileSync(outPath, "utf8"), keyPem };
}

function mintKeyAndCSR(dir: string, label: string) {
  const keyPath = path.join(dir, `${label}.key`);
  const csrPath = path.join(dir, `${label}.csr`);
  execFileSync(
    "openssl",
    [
      "req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", csrPath,
      "-subj", `/CN=connect-agent-${label}`,
    ],
    { stdio: "ignore" }
  );
  return {
    keyPem: readFileSync(keyPath, "utf8"),
    csrPem: readFileSync(csrPath, "utf8"),
  };
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(
      e instanceof AgentCertificateError,
      `expected AgentCertificateError, got ${String(e)}`
    );
    return (e as AgentCertificateError).reason;
  }
  throw new Error("expected a rejection, got success");
}

describe("verifyAgentCertificate proves the Agent CA actually signed the leaf", () => {
  let dir = "";
  // The real Agent CA the control plane is configured with.
  let realCA = { certPem: "", keyPem: "" };
  // An unrelated CA that deliberately uses the IDENTICAL subject DN, i.e.
  // the cheapest forgery available to anyone who has seen one real leaf.
  let impostorCA = { certPem: "", keyPem: "" };
  let genuineLeafPem = "";
  let genuineLeafKeyPem = "";
  let forgedLeafPem = "";
  let forgedLeafKeyPem = "";

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fabric-verifyleaf-"));
    realCA = mintCA(dir, "real-ca", CA_SUBJECT);
    impostorCA = mintCA(dir, "impostor-ca", CA_SUBJECT);

    const genuine = mintKeyAndCSR(dir, "genuine");
    genuineLeafKeyPem = genuine.keyPem;
    genuineLeafPem = issueLeafFromCsr(genuine.csrPem, realCA).certificatePem;

    // Same issuer DN and a forged AKI pointing at the real CA's SKI, but
    // signed by a key the platform has never trusted.
    const forged = mintForgedLeaf(dir, "forged", impostorCA, realCA.certPem);
    forgedLeafPem = forged.certPem;
    forgedLeafKeyPem = forged.keyPem;
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a leaf genuinely signed by the configured Agent CA", () => {
    const v = verifyAgentCertificate({
      certificatePem: genuineLeafPem,
      caCertPem: realCA.certPem,
    });
    assert.match(v.fingerprintSha256, /^[0-9a-f]{64}$/);
    assert.ok(v.validTo.getTime() > Date.now());
  });

  it("checkIssued() alone would ACCEPT the forged leaf -- this is the gap being closed", () => {
    // Documents precisely why the metadata check is insufficient. If this
    // assertion ever starts failing, Node changed checkIssued semantics and
    // the comment above verifyAgentCertificate needs revisiting -- but the
    // signature check below must keep rejecting either way.
    const leaf = new X509Certificate(forgedLeafPem);
    const ca = new X509Certificate(realCA.certPem);
    assert.equal(
      leaf.checkIssued(ca),
      true,
      "expected identical issuer DNs to satisfy the metadata-only check"
    );
    assert.equal(leaf.verify(ca.publicKey), false);
  });

  it("rejects a forged leaf whose issuer metadata matches but signature does not", () => {
    assert.equal(
      reasonOf(() =>
        verifyAgentCertificate({
          certificatePem: forgedLeafPem,
          caCertPem: realCA.certPem,
        })
      ),
      "leaf_signature_invalid"
    );
  });

  it("rejects a self-signed cert that copied only the CA subject name", () => {
    // A lazier forgery: right subject DN, but its AKI still points at its
    // own key, so the cheaper metadata check catches it first. Rejected
    // either way -- this documents which check fires, so a change in error
    // code is visible rather than silent.
    assert.equal(
      reasonOf(() =>
        verifyAgentCertificate({
          certificatePem: impostorCA.certPem,
          caCertPem: realCA.certPem,
        })
      ),
      "leaf_issuer_metadata_mismatch"
    );
  });

  it("rejects a genuine leaf checked against an unrelated CA name", () => {
    const otherCA = mintCA(dir, "other-name-ca", "/CN=some-other-ca");
    assert.equal(
      reasonOf(() =>
        verifyAgentCertificate({
          certificatePem: genuineLeafPem,
          caCertPem: otherCA.certPem,
        })
      ),
      "leaf_issuer_metadata_mismatch"
    );
  });

  it("rejects a leaf presented before its not-before instant", () => {
    const leaf = new X509Certificate(genuineLeafPem);
    const wellBefore = new Date(new Date(leaf.validFrom).getTime() - 3600_000);
    assert.equal(
      reasonOf(() =>
        verifyAgentCertificate({
          certificatePem: genuineLeafPem,
          caCertPem: realCA.certPem,
          now: wellBefore,
        })
      ),
      "leaf_not_yet_valid"
    );
  });

  it("tolerates small negative clock skew on not-before (multi-replica CP)", () => {
    // A leaf minted on replica A and presented to replica B whose clock is
    // a few seconds behind must NOT be rejected -- that would break the
    // enroll -> first-call path intermittently.
    const leaf = new X509Certificate(genuineLeafPem);
    const slightlyBefore = new Date(new Date(leaf.validFrom).getTime() - 5_000);
    const v = verifyAgentCertificate({
      certificatePem: genuineLeafPem,
      caCertPem: realCA.certPem,
      now: slightlyBefore,
    });
    assert.match(v.fingerprintSha256, /^[0-9a-f]{64}$/);
  });

  it("rejects an expired leaf", () => {
    const leaf = new X509Certificate(genuineLeafPem);
    const afterExpiry = new Date(new Date(leaf.validTo).getTime() + 3600_000);
    assert.equal(
      reasonOf(() =>
        verifyAgentCertificate({
          certificatePem: genuineLeafPem,
          caCertPem: realCA.certPem,
          now: afterExpiry,
        })
      ),
      "leaf_expired"
    );
  });

  it("rejects unparseable PEM distinctly for leaf and CA", () => {
    assert.equal(
      reasonOf(() =>
        verifyAgentCertificate({
          certificatePem: "not a certificate",
          caCertPem: realCA.certPem,
        })
      ),
      "invalid_certificate_pem"
    );
    assert.equal(
      reasonOf(() =>
        verifyAgentCertificate({
          certificatePem: genuineLeafPem,
          caCertPem: "not a certificate",
        })
      ),
      "invalid_ca_pem"
    );
  });

  describe("message signature is checked against the verified certificate", () => {
    function signPop(agentId: string, keyPem: string, signedAt: number): string {
      const sign = createSign("SHA256");
      sign.update(agentPopMessage(agentId, signedAt));
      sign.end();
      return sign.sign(createPrivateKey(keyPem)).toString("base64");
    }

    it("accepts a signature made by the genuine leaf's private key", () => {
      const signedAt = Math.floor(Date.now() / 1000);
      const res = verifyAgentLeafPop({
        certificatePem: genuineLeafPem,
        caCertPem: realCA.certPem,
        agentId: "agent-1",
        signedAt,
        signatureB64: signPop("agent-1", genuineLeafKeyPem, signedAt),
      });
      assert.match(res.fingerprintSha256, /^[0-9a-f]{64}$/);
    });

    it("rejects a valid self-consistent PoP made with a forged leaf", () => {
      // The forged holder genuinely possesses its own private key, so the
      // signature verifies against the presented certificate. Only the CA
      // check stands between this and a trusted identity.
      const signedAt = Math.floor(Date.now() / 1000);
      assert.equal(
        reasonOf(() =>
          verifyAgentLeafPop({
            certificatePem: forgedLeafPem,
            caCertPem: realCA.certPem,
            agentId: "agent-1",
            signedAt,
            signatureB64: signPop("agent-1", forgedLeafKeyPem, signedAt),
          })
        ),
        "leaf_signature_invalid"
      );
    });

    it("rejects a signature over a different agent_id", () => {
      const signedAt = Math.floor(Date.now() / 1000);
      assert.equal(
        reasonOf(() =>
          verifyAgentLeafPop({
            certificatePem: genuineLeafPem,
            caCertPem: realCA.certPem,
            agentId: "agent-1",
            signedAt,
            signatureB64: signPop("agent-2", genuineLeafKeyPem, signedAt),
          })
        ),
        "pop_signature_invalid"
      );
    });

    it("rejects an empty or non-base64 signature", () => {
      const cert = verifyAgentCertificate({
        certificatePem: genuineLeafPem,
        caCertPem: realCA.certPem,
      });
      assert.equal(
        reasonOf(() => verifyLeafMessageSignature(cert, "msg", "")),
        "invalid_signature_b64"
      );
    });
  });

  describe("signed_at freshness uses server time as the reference", () => {
    it("accepts a claim inside the skew window", () => {
      assertSignedAtFresh(Math.floor(Date.now() / 1000) - 10);
    });

    it("rejects an ancient claim", () => {
      assert.equal(
        reasonOf(() =>
          assertSignedAtFresh(Math.floor(Date.now() / 1000) - 4000)
        ),
        "pop_signed_at_skew"
      );
    });

    it("rejects a claim far in the future", () => {
      assert.equal(
        reasonOf(() =>
          assertSignedAtFresh(Math.floor(Date.now() / 1000) + 4000)
        ),
        "pop_signed_at_skew"
      );
    });

    it("rejects a non-finite claim", () => {
      assert.equal(
        reasonOf(() => assertSignedAtFresh(Number.NaN)),
        "pop_signed_at_skew"
      );
    });

    it("honors an explicit wider skew (operator override path)", () => {
      // 10 minutes old, rejected at the 300s default...
      const tenMinOld = Math.floor(Date.now() / 1000) - 600;
      assert.equal(
        reasonOf(() => assertSignedAtFresh(tenMinOld)),
        "pop_signed_at_skew"
      );
      // ...accepted when the operator widens the window (e.g. a fleet with
      // known clock drift). No throw = accepted.
      assertSignedAtFresh(tenMinOld, { maxSkewSeconds: 900 });
    });

    it("popSkewSecondsFromEnv reads FABRIC_POP_SKEW_SECONDS, falling back on junk", () => {
      assert.equal(popSkewSecondsFromEnv({ FABRIC_POP_SKEW_SECONDS: "600" }), 600);
      assert.equal(popSkewSecondsFromEnv({ FABRIC_POP_SKEW_SECONDS: "0" }), 300);
      assert.equal(popSkewSecondsFromEnv({ FABRIC_POP_SKEW_SECONDS: "-5" }), 300);
      assert.equal(popSkewSecondsFromEnv({ FABRIC_POP_SKEW_SECONDS: "abc" }), 300);
      assert.equal(popSkewSecondsFromEnv({}), 300);
    });
  });
});

// The primitive being correct only matters if the routes actually use it.
// These exercise the two PoP-authenticated endpoints over HTTP with a
// forged leaf, so a future refactor that reintroduces a local
// checkIssued-only check on either route fails here.
describe("PoP routes reject a forged Agent leaf end to end", () => {
  let dir = "";
  let realCA = { certPem: "", keyPem: "" };
  let impostorCA = { certPem: "", keyPem: "" };
  let server: http.Server;
  let port = 0;
  const store = new MemoryStore();
  const tenant = "77777777-7777-7777-7777-777777777777";
  let agentId = "";
  let forgedLeafPem = "";
  let forgedLeafKeyPem = "";
  let genuineLeafPem = "";
  let genuineLeafKeyPem = "";

  function listen(s: http.Server): Promise<number> {
    return new Promise((resolve) => {
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (!addr || typeof addr === "string") throw new Error("no port");
        resolve(addr.port);
      });
    });
  }

  async function post(p: string, body: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ABLV-Actor": "test" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  function signPop(id: string, keyPem: string, signedAt: number): string {
    const sign = createSign("SHA256");
    sign.update(agentPopMessage(id, signedAt));
    sign.end();
    return sign.sign(createPrivateKey(keyPem)).toString("base64");
  }

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fabric-poproute-"));
    realCA = mintCA(dir, "real-ca", CA_SUBJECT);
    impostorCA = mintCA(dir, "impostor-ca", CA_SUBJECT);

    const genuine = mintKeyAndCSR(dir, "genuine");
    genuineLeafKeyPem = genuine.keyPem;
    const issued = issueLeafFromCsr(genuine.csrPem, realCA);
    genuineLeafPem = issued.certificatePem;

    const forged = mintForgedLeaf(dir, "forged", impostorCA, realCA.certPem);
    forgedLeafPem = forged.certPem;
    forgedLeafKeyPem = forged.keyPem;

    await store.ensureTenant(tenant, "test");
    const boot = await store.issueBootstrapToken(tenant, "test");
    const agent = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      cert_fingerprint_sha256: issued.fingerprintSha256,
      cert_not_after: issued.notAfter,
      actor: "test",
    });
    agentId = agent.id;

    // authToken MUST be configured: with it unset the server treats every
    // caller as writer, and rotate's PoP gate is deliberately skipped for
    // writers (break-glass). These requests send no bearer, so they arrive
    // as "anonymous" on the PoP-fallback routes and the leaf proof is the
    // only thing authorizing them -- which is what we want to test.
    server = createServer(store, { authToken: "writer-secret", agentCA: realCA });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("api-token/current rejects a forged leaf with leaf_signature_invalid", async () => {
    const signedAt = Math.floor(Date.now() / 1000);
    const res = await post(`/v1/agents/${agentId}/api-token/current`, {
      certificate_pem: forgedLeafPem,
      signed_at: signedAt,
      signature_b64: signPop(agentId, forgedLeafKeyPem, signedAt),
    });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.error, "leaf_signature_invalid");
  });

  it("rotate rejects a forged leaf with leaf_signature_invalid", async () => {
    const signedAt = Math.floor(Date.now() / 1000);
    const { csrPem } = mintKeyAndCSR(dir, "rotate-csr");
    const res = await post(`/v1/agents/${agentId}/rotate`, {
      csr_pem: csrPem,
      certificate_pem: forgedLeafPem,
      signed_at: signedAt,
      signature_b64: signPop(agentId, forgedLeafKeyPem, signedAt),
    });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.error, "leaf_signature_invalid");
  });

  it("api-token/current rejects a stale signed_at as an authentication failure", async () => {
    const stale = Math.floor(Date.now() / 1000) - 4000;
    const res = await post(`/v1/agents/${agentId}/api-token/current`, {
      certificate_pem: genuineLeafPem,
      signed_at: stale,
      signature_b64: signPop(agentId, genuineLeafKeyPem, stale),
    });
    // 403, not the outer handler's generic 400.
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.error, "pop_signed_at_skew");
  });

  it("api-token/current still accepts the genuine leaf", async () => {
    const signedAt = Math.floor(Date.now() / 1000);
    const res = await post(`/v1/agents/${agentId}/api-token/current`, {
      certificate_pem: genuineLeafPem,
      signed_at: signedAt,
      signature_b64: signPop(agentId, genuineLeafKeyPem, signedAt),
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(
      typeof res.json.agent_api_token === "string" &&
        (res.json.agent_api_token as string).length > 0
    );
  });
});
