import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/http/server";
import { MemoryStore } from "../src/store/memory";

// GET /v1/ca-bundle: closes the gap the k3s appliance installer already
// assumed (--ca-url=.../v1/ca-bundle) but no endpoint ever implemented.
// Public, unauthenticated by design -- a CA certificate is trust-anchor
// material meant to be widely distributed, not a secret.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

function mintTempCA(): { certPem: string; keyPem: string; dir: string } {
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
      "/CN=fabric-ca-bundle-test-ca",
    ],
    { stdio: "ignore" }
  );
  return {
    dir,
    certPem: readFileSync(certPath, "utf8"),
    keyPem: readFileSync(keyPath, "utf8"),
  };
}

describe("GET /v1/ca-bundle", () => {
  let server: http.Server;
  let port: number;
  let caDir: string;
  let caCertPem: string;

  before(async () => {
    const ca = mintTempCA();
    caDir = ca.dir;
    caCertPem = ca.certPem;
    const store = new MemoryStore();
    server = createServer(store, {
      authToken: "writer-secret", // auth configured -- ca-bundle must still be public
      agentCA: { certPem: ca.certPem, keyPem: ca.keyPem },
    });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(caDir, { recursive: true, force: true });
  });

  it("returns the CA certificate with no Authorization header required", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/ca-bundle`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-pem-file");
    const body = await res.text();
    assert.equal(body, caCertPem);
  });

  it("never returns the private key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/ca-bundle`);
    const body = await res.text();
    assert.ok(!body.includes("PRIVATE KEY"), "response must not contain key material");
  });
});

describe("GET /v1/ca-bundle without a configured CA", () => {
  it("returns 404 rather than crashing", async () => {
    const store = new MemoryStore();
    const server = createServer(store, {
      authToken: "writer-secret",
      agentCA: null, // explicitly unconfigured
    });
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/ca-bundle`);
      assert.equal(res.status, 404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
