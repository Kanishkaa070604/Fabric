import assert from "node:assert/strict";
import { createPrivateKey, createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/http/server";
import { issueLeafFromCsr } from "../src/pki/issueLeaf";
import { MemoryStore } from "../src/store/memory";

// L3-PKI-01a: POST /v1/agents/:id/rotate must be bound to leaf PoP for
// agent-role bearers, not just tenant scope -- otherwise any sibling
// DaemonSet instance sharing the tenant's Agent API bearer could rotate
// (and thereby learn the new certificate_pem for) an agent_id it never
// held the private key for.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

async function req(
  port: number,
  method: string,
  p: string,
  opts?: { token?: string; body?: unknown }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = opts?.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = { "X-ABLV-Actor": "test" };
  if (body) headers["Content-Type"] = "application/json";
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function mintTempCA(): { certPem: string; keyPem: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-rotpop-ca-"));
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
      "/CN=fabric-rotpop-ca",
    ],
    { stdio: "ignore" }
  );
  return {
    dir,
    certPem: readFileSync(certPath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
}

function mintKeyAndCSR(dir: string, label: string): { keyPem: string; csrPem: string } {
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
  return {
    keyPem: readFileSync(keyPath, "utf8"),
    csrPem: readFileSync(csrPath, "utf8"),
  };
}

function signPop(agentId: string, keyPem: string, signedAt: number): string {
  const key = createPrivateKey(keyPem);
  const sign = createSign("SHA256");
  sign.update(`${agentId}\n${signedAt}`);
  sign.end();
  return sign.sign(key).toString("base64");
}

describe("L3-PKI-01a rotate is bound to leaf PoP for agent-role bearers", () => {
  const store = new MemoryStore();
  const writer = "writer-secret";
  let server: http.Server;
  let port: number;
  let caDir: string;
  const tenant = "55555555-5555-5555-5555-555555555555";
  let agentAId = "";
  let agentAKeyPem = "";
  let agentALeafPem = "";
  let agentBId = "";
  let agentBKeyPem = "";
  let agentBLeafPem = "";
  let tenantBearer = "";

  before(async () => {
    const ca = mintTempCA();
    caDir = ca.dir;
    await store.ensureTenant(tenant, "test");

    const a = mintKeyAndCSR(ca.dir, "agent-a");
    agentAKeyPem = a.keyPem;
    const leafA = issueLeafFromCsr(a.csrPem, { certPem: ca.certPem, keyPem: ca.keyPem });
    agentALeafPem = leafA.certificatePem;
    const bootA = await store.issueBootstrapToken(tenant, "test");
    const agentA = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: bootA,
      substrate: "kubernetes",
      cert_fingerprint_sha256: leafA.fingerprintSha256,
      cert_not_after: leafA.notAfter,
      actor: "test",
    });
    agentAId = agentA.id;

    const b = mintKeyAndCSR(ca.dir, "agent-b");
    agentBKeyPem = b.keyPem;
    const leafB = issueLeafFromCsr(b.csrPem, { certPem: ca.certPem, keyPem: ca.keyPem });
    agentBLeafPem = leafB.certificatePem;
    const bootB = await store.issueBootstrapToken(tenant, "test");
    const agentB = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: bootB,
      substrate: "kubernetes",
      cert_fingerprint_sha256: leafB.fingerprintSha256,
      cert_not_after: leafB.notAfter,
      actor: "test",
    });
    agentBId = agentB.id;

    // Single tenant-scoped Agent API bearer, shared by both agents --
    // this is the real DaemonSet posture (L3-CTL-01a).
    tenantBearer = await store.issueAgentApiToken(tenant, "test");

    server = createServer(store, {
      authToken: writer,
      agentCA: { certPem: ca.certPem, keyPem: ca.keyPem },
    });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(caDir, { recursive: true, force: true });
  });

  function mintCSR(label: string): string {
    return mintKeyAndCSR(caDir, label).csrPem;
  }

  it("rejects agent B rotating agent A's cert with the shared tenant bearer and no PoP", async () => {
    const res = await req(port, "POST", `/v1/agents/${agentAId}/rotate`, {
      token: tenantBearer,
      body: { csr_pem: mintCSR("a-rotate-1") },
    });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.error, "pop_fields_required");
  });

  it("rejects agent B presenting agent B's own valid PoP against agent A's id", async () => {
    const signedAt = Math.floor(Date.now() / 1000);
    const res = await req(port, "POST", `/v1/agents/${agentAId}/rotate`, {
      token: tenantBearer,
      body: {
        csr_pem: mintCSR("a-rotate-2"),
        certificate_pem: agentBLeafPem,
        signed_at: signedAt,
        // Signed over agentAId (the path), but with agent B's key -- the
        // signature check itself succeeds (message includes agentId), so
        // this must be caught by the cert-not-bound-to-agentId check.
        signature_b64: signPop(agentAId, agentBKeyPem, signedAt),
      },
    });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.error, "cert_not_bound_to_agent");
  });

  it("accepts agent A rotating its own cert with valid PoP", async () => {
    const signedAt = Math.floor(Date.now() / 1000);
    const res = await req(port, "POST", `/v1/agents/${agentAId}/rotate`, {
      token: tenantBearer,
      body: {
        csr_pem: mintCSR("a-rotate-3"),
        certificate_pem: agentALeafPem,
        signed_at: signedAt,
        signature_b64: signPop(agentAId, agentAKeyPem, signedAt),
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, agentAId);
    assert.ok(typeof res.json.certificate_pem === "string" && res.json.certificate_pem.length > 0);
  });

  it("writer bearer (break-glass / operator tooling) is not required to present PoP", async () => {
    const res = await req(port, "POST", `/v1/agents/${agentBId}/rotate`, {
      token: writer,
      body: { csr_pem: mintCSR("b-rotate-1") },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, agentBId);
  });

  it("accepts rotate with valid PoP and NO bearer at all (regression: certlife.RotateLeaf must work even when PullCurrent hasn't succeeded yet)", async () => {
    const signedAt = Math.floor(Date.now() / 1000);
    const res = await req(port, "POST", `/v1/agents/${agentAId}/rotate`, {
      // No token at all -- this is the FABRIC_AGENT_ROTATE=1 emergency path
      // when the Agent API bearer pull soft-failed and no bearer is on
      // disk. certlife.requestRotatedCert still sends a valid PoP
      // signature regardless, and that alone must be sufficient.
      body: {
        csr_pem: mintCSR("a-rotate-nobearer"),
        certificate_pem: agentALeafPem,
        signed_at: signedAt,
        signature_b64: signPop(agentAId, agentAKeyPem, signedAt),
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, agentAId);
  });

  it("rejects rotate with an expired/garbage bearer unless PoP also verifies", async () => {
    const res = await req(port, "POST", `/v1/agents/${agentAId}/rotate`, {
      token: "not-a-real-token",
      body: { csr_pem: mintCSR("a-rotate-badtoken") },
    });
    // Falls through to anonymous (bad bearer), then PoP fields are missing.
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.error, "pop_fields_required");
  });
});
