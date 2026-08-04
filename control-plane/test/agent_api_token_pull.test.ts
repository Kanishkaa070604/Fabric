import assert from "node:assert/strict";
import { createPrivateKey, createSign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/http/server";
import { issueLeafFromCsr } from "../src/pki/issueLeaf";
import { MemoryStore } from "../src/store/memory";

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
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-cred-ca-"));
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
      "/CN=fabric-cred-ca",
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

describe("L3-CRED-01 / G-CRED-1 leaf-auth api-token pull", () => {
  const store = new MemoryStore();
  const writer = "writer-secret";
  let server: http.Server;
  let port: number;
  let caDir: string;
  const tenant = "33333333-3333-3333-3333-333333333333";
  let agentId = "";
  let leafPem = "";
  let keyPem = "";

  before(async () => {
    const ca = mintTempCA();
    caDir = ca.dir;
    const { keyPem: k, csrPem } = mintKeyAndCSR(ca.dir, "a1");
    keyPem = k;
    const leaf = issueLeafFromCsr(csrPem, {
      certPem: ca.certPem,
      keyPem: ca.keyPem,
    });
    leafPem = leaf.certificatePem;
    await store.ensureTenant(tenant, "test");
    const boot = await store.issueBootstrapToken(tenant, "test");
    const agent = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      cert_fingerprint_sha256: leaf.fingerprintSha256,
      cert_not_after: leaf.notAfter,
      actor: "test",
    });
    agentId = agent.id;
    // Seed an old bearer so overlap can be exercised.
    await store.issueAgentApiToken(tenant, "test");

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

  it("reuses presented bearer when still fresh (D1 no mint-every-pull)", async () => {
    const prior = await store.issueAgentApiToken(tenant, "test");
    const signedAt = Math.floor(Date.now() / 1000);
    const pulled = await req(
      port,
      "POST",
      `/v1/agents/${agentId}/api-token/current`,
      {
        body: {
          certificate_pem: leafPem,
          signed_at: signedAt,
          signature_b64: signPop(agentId, keyPem, signedAt),
          current_agent_api_token: prior,
        },
      }
    );
    assert.equal(pulled.status, 200, JSON.stringify(pulled.json));
    assert.equal(pulled.json.reused, true);
    assert.equal(pulled.json.agent_api_token, prior);
  });

  it("force_renew mints; overlap keeps prior token valid", async () => {
    const prior = await store.issueAgentApiToken(tenant, "test");
    const signedAt = Math.floor(Date.now() / 1000);
    const pulled = await req(
      port,
      "POST",
      `/v1/agents/${agentId}/api-token/current`,
      {
        body: {
          certificate_pem: leafPem,
          signed_at: signedAt,
          signature_b64: signPop(agentId, keyPem, signedAt),
          current_agent_api_token: prior,
          force_renew: true,
          overlap_seconds: 600,
        },
      }
    );
    assert.equal(pulled.status, 200, JSON.stringify(pulled.json));
    const next = String(pulled.json.agent_api_token || "");
    assert.ok(next.length > 20);
    assert.notEqual(next, prior);
    assert.equal(pulled.json.reused, false);

    const listPrior = await req(port, "GET", `/v1/tenants/${tenant}/registrations`, {
      token: prior,
    });
    assert.equal(listPrior.status, 200, "prior bearer valid during overlap");

    const listNext = await req(port, "GET", `/v1/tenants/${tenant}/registrations`, {
      token: next,
    });
    assert.equal(listNext.status, 200);

    const fp = new X509Certificate(leafPem);
    assert.ok(fp);
  });

  it("rejects bad signature", async () => {
    const signedAt = Math.floor(Date.now() / 1000);
    const bad = await req(port, "POST", `/v1/agents/${agentId}/api-token/current`, {
      body: {
        certificate_pem: leafPem,
        signed_at: signedAt,
        signature_b64: Buffer.from("nope").toString("base64"),
      },
    });
    assert.equal(bad.status, 403);
  });
});
