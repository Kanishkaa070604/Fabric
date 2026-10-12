import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/http/server";
import { MemoryStore } from "../src/store/memory";

// GET /v1/ca-bundle: public trust PEM for Agents verifying the Gateway
// server cert (UI "Fetch CA" → install ca.crt). Prefers Gateway cert over
// Agent CA.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

function mintTempCA(cn: string): { certPem: string; keyPem: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-ca-bundle-"));
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
      `/CN=${cn}`,
    ],
    { stdio: "ignore" }
  );
  return {
    dir,
    certPem: readFileSync(certPath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
}

describe("GET /v1/ca-bundle with Gateway trust", () => {
  let server: http.Server;
  let port: number;
  let dirs: string[] = [];
  let gatewayPem: string;
  let agentPem: string;

  before(async () => {
    const gateway = mintTempCA("fabric-gateway-test");
    const agent = mintTempCA("fabric-agent-ca-test");
    dirs = [gateway.dir, agent.dir];
    gatewayPem = gateway.certPem;
    agentPem = agent.certPem;
    const store = new MemoryStore();
    server = createServer(store, {
      authToken: "writer-secret",
      agentCA: { certPem: agent.certPem, keyPem: agent.keyPem },
      gatewayTrustPem: gateway.certPem,
    });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("returns the Gateway cert (not Agent CA) with no Authorization", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/ca-bundle`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-pem-file");
    const body = await res.text();
    assert.equal(body, gatewayPem);
    assert.notEqual(body, agentPem);
  });

  it("never returns the private key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/ca-bundle`);
    const body = await res.text();
    assert.ok(!body.includes("PRIVATE KEY"), "response must not contain key material");
  });
});

describe("GET /v1/ca-bundle falls back to Agent CA", () => {
  let server: http.Server;
  let port: number;
  let caDir: string;
  let caCertPem: string;

  before(async () => {
    const ca = mintTempCA("fabric-ca-bundle-test-ca");
    caDir = ca.dir;
    caCertPem = ca.certPem;
    const store = new MemoryStore();
    server = createServer(store, {
      authToken: "writer-secret",
      agentCA: { certPem: ca.certPem, keyPem: ca.keyPem },
      gatewayTrustPem: null,
    });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(caDir, { recursive: true, force: true });
  });

  it("returns Agent CA when Gateway trust is unset", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/ca-bundle`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), caCertPem);
  });
});

describe("GET /v1/ca-bundle without trust material", () => {
  it("returns 404 rather than crashing", async () => {
    const store = new MemoryStore();
    const server = createServer(store, {
      authToken: "writer-secret",
      agentCA: null,
      gatewayTrustPem: null,
    });
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/ca-bundle`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "gateway_trust_not_configured");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
