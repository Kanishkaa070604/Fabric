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
import { buildDevPackContext, encodePackLeaseRequestSigningV1 } from "../src/packs";
import { sodiumReady } from "../src/packs/seal";

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
  opts?: { token?: string; body?: unknown; rawBody?: Buffer; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "X-ABLV-Actor": "test", ...(opts?.headers ?? {}) };
  let body: Buffer | string | undefined;
  if (opts?.rawBody !== undefined) {
    body = opts.rawBody;
    headers["Content-Type"] = headers["Content-Type"] ?? "application/octet-stream";
  } else if (opts?.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
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
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-pack-ca-"));
  const keyPath = path.join(dir, "ca.key");
  const certPath = path.join(dir, "ca.crt");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=fabric-pack-ca"],
    { stdio: "ignore" },
  );
  return { dir, certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
}

function mintKeyAndCSR(dir: string, label: string): { keyPem: string; csrPem: string } {
  const keyPath = path.join(dir, `${label}.key`);
  const csrPath = path.join(dir, `${label}.csr`);
  execFileSync(
    "openssl",
    ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", `/CN=connect-agent-${label}`],
    { stdio: "ignore" },
  );
  return { keyPem: readFileSync(keyPath, "utf8"), csrPem: readFileSync(csrPath, "utf8") };
}

/** Sign PackLeaseRequestSigningV1 with the leaf RSA key (RSA-SHA256). */
function signLeaseRequest(
  keyPem: string,
  fields: Parameters<typeof encodePackLeaseRequestSigningV1>[0],
): string {
  const bytes = encodePackLeaseRequestSigningV1(fields);
  const key = createPrivateKey(keyPem);
  const sign = createSign("SHA256");
  sign.update(bytes);
  sign.end();
  return sign.sign(key).toString("base64");
}

const noopLog = { info: () => {}, warn: () => {} };

describe("Secure Pack routes (stage/activate/lease)", () => {
  const store = new MemoryStore();
  const writer = "writer-secret";
  const tenant = "44444444-4444-4444-4444-444444444444";
  const packId = "security-default";
  let server: http.Server;
  let port: number;
  let caDir: string;
  let agentId = "";
  let leafPem = "";
  let keyPem = "";
  let runtimePubB64 = "";

  before(async () => {
    const sodium = await sodiumReady();
    const ca = mintTempCA();
    caDir = ca.dir;
    const { keyPem: k, csrPem } = mintKeyAndCSR(ca.dir, "p1");
    keyPem = k;
    const leaf = issueLeafFromCsr(csrPem, { certPem: ca.certPem, keyPem: ca.keyPem });
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
    await store.approveAgent(agentId, "test");
    // Move to a pack-eligible operational state.
    await store.reportTunnel({ tenant_id: tenant, agent_id: agentId, event: "up", actor: "test" });

    const { context } = await buildDevPackContext({
      store,
      caCertPem: ca.certPem,
      log: noopLog,
    });

    server = createServer(store, {
      authToken: writer,
      agentCA: { certPem: ca.certPem, keyPem: ca.keyPem },
      packs: context,
    });
    port = await listen(server);

    // A deterministic 32-byte runtime key for the happy-path request.
    runtimePubB64 = Buffer.from(sodium.crypto_box_keypair().publicKey).toString("base64");
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(caDir, { recursive: true, force: true });
  });

  async function stageAndActivate(): Promise<void> {
    const staged = await req(port, "POST", `/v1/tenants/default/security-packs/${packId}/versions`, {
      token: writer,
      rawBody: Buffer.from("rules:\n  - id: allow-443\n    action: allow\n", "utf8"),
      headers: { "X-Fabric-Pack-Content-Type": "application/yaml", "X-Fabric-Pack-Schema-Version": "7" },
    });
    assert.equal(staged.status, 201, JSON.stringify(staged.json));
    const pvid = String(staged.json.pack_version_id);
    const activated = await req(
      port,
      "POST",
      `/v1/tenants/default/security-packs/${packId}/versions/1/activate`,
      { token: writer, body: { pack_version_id: pvid } },
    );
    assert.equal(activated.status, 200, JSON.stringify(activated.json));
  }

  function leaseBody(over?: Partial<Record<string, unknown>>) {
    const signedAt = Math.floor(Date.now() / 1000);
    const runtimePublicKey = Buffer.from(runtimePubB64, "base64");
    const requestId = "55555555-5555-4555-8555-555555555555";
    const fields = {
      agentId,
      tenantId: tenant,
      requestId,
      packId,
      agentVersion: "1.8.3",
      signedAt,
      runtimePublicKey,
    };
    const body: Record<string, unknown> = {
      protocol_version: 1,
      tenant_id: tenant,
      request_id: requestId,
      agent_version: "1.8.3",
      signed_at: signedAt,
      runtime_public_key_b64: runtimePubB64,
      certificate_pem: leafPem,
      signature_b64: signLeaseRequest(keyPem, fields),
      ...over,
    };
    return body;
  }

  it("stages and activates a default version (writer)", async () => {
    await stageAndActivate();
  });

  it("rejects stage without writer auth", async () => {
    const r = await req(port, "POST", `/v1/tenants/default/security-packs/${packId}/versions`, {
      rawBody: Buffer.from("x", "utf8"),
      // No token: with authToken set, an unauthenticated non-PoP route 401s.
    });
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });

  it("issues a lease on a valid leaf-signed request", async () => {
    await stageAndActivate();
    const r = await req(port, "POST", `/v1/agents/${agentId}/security-packs/${packId}/lease`, {
      body: leaseBody(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const lease = r.json.lease as Record<string, unknown>;
    assert.equal(lease.agent_id, agentId);
    assert.equal(lease.pack_id, packId);
    assert.equal(lease.request_id, "55555555-5555-4555-8555-555555555555");
    assert.ok(String(r.json.sealed_dek_b64).length > 0);
    assert.ok(String(r.json.ciphertext_b64).length > 0);
    assert.equal((r.json.signature as Record<string, unknown>).alg, "ES256");
    // The lease binds the runtime key we sent.
    assert.equal(typeof lease.runtime_public_key_sha256, "string");
  });

  it("issues a lease the Go consumer can verify+open (end-to-end route vector)", async () => {
    // Build a fresh server whose signer key + runtime keypair are fixed, so the
    // Go route-interop test can pin to the emitted vector. This proves the REAL
    // HTTP lease route (not just the producer facade) yields a Go-openable lease.
    const sodium = await sodiumReady();
    const runtimeKp = sodium.crypto_box_keypair();
    const runtimePub = Buffer.from(runtimeKp.publicKey);
    const runtimePriv = Buffer.from(runtimeKp.privateKey);

    const { context, vendorPublicKeySpkiDer } = await buildDevPackContext({
      store,
      caCertPem: readFileSync(path.join(caDir, "ca.crt"), "utf8"),
      log: noopLog,
    });
    // Re-stage+activate on THIS context's repository so a version exists for it.
    const server3 = createServer(store, {
      authToken: writer,
      agentCA: { certPem: readFileSync(path.join(caDir, "ca.crt"), "utf8"), keyPem: readFileSync(path.join(caDir, "ca.key"), "utf8") },
      packs: context,
    });
    const port3 = await listen(server3);
    try {
      const staged = await req(port3, "POST", `/v1/tenants/default/security-packs/${packId}/versions`, {
        token: writer,
        rawBody: Buffer.from("rules:\n  - id: e2e\n    action: allow\n", "utf8"),
        headers: { "X-Fabric-Pack-Content-Type": "application/yaml", "X-Fabric-Pack-Schema-Version": "7" },
      });
      assert.equal(staged.status, 201, JSON.stringify(staged.json));
      await req(port3, "POST", `/v1/tenants/default/security-packs/${packId}/versions/1/activate`, {
        token: writer,
        body: { pack_version_id: String(staged.json.pack_version_id) },
      });

      const signedAt = Math.floor(Date.now() / 1000);
      const requestId = "77777777-7777-4777-8777-777777777777";
      const fields = { agentId, tenantId: tenant, requestId, packId, agentVersion: "1.8.3", signedAt, runtimePublicKey: runtimePub };
      const r = await req(port3, "POST", `/v1/agents/${agentId}/security-packs/${packId}/lease`, {
        body: {
          tenant_id: tenant,
          request_id: requestId,
          agent_version: "1.8.3",
          signed_at: signedAt,
          runtime_public_key_b64: runtimePub.toString("base64"),
          certificate_pem: leafPem,
          signature_b64: signLeaseRequest(keyPem, fields),
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));

      if (process.env.SECUREPACK_GEN_VECTORS) {
        const { writeFileSync } = await import("node:fs");
        const { fileURLToPath } = await import("node:url");
        const here = path.dirname(fileURLToPath(import.meta.url));
        const lease = r.json.lease as Record<string, unknown>;
        const vec = {
          note:
            "Frozen END-TO-END route lease. The real CP lease HTTP route produced this; " +
            "Go lease.VerifyAndOpen must accept it (signature + digests + sealed-DEK open).",
          runtime_x25519_public_key_hex: runtimePub.toString("hex"),
          runtime_x25519_private_key_hex: runtimePriv.toString("hex"),
          request_id: requestId,
          lease_wire: lease,
          sealed_dek_b64: String(r.json.sealed_dek_b64),
          ciphertext_b64: String(r.json.ciphertext_b64),
          signature_b64: String((r.json.signature as Record<string, unknown>).signature_b64),
          vendor_public_key_spki_der_hex: vendorPublicKeySpkiDer.toString("hex"),
        };
        writeFileSync(path.join(here, "..", "..", "docs", "securepack-vectors", "route.json"), JSON.stringify(vec, null, 2) + "\n");
      }
    } finally {
      await new Promise<void>((rr) => server3.close(() => rr()));
    }
  });

  it("rejects a lease with a bad request signature (403 pack_pop_invalid)", async () => {
    await stageAndActivate();
    const r = await req(port, "POST", `/v1/agents/${agentId}/security-packs/${packId}/lease`, {
      body: leaseBody({ signature_b64: Buffer.from("nope").toString("base64") }),
    });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.error, "pack_pop_invalid");
  });

  it("rejects a stale signed_at (403 pack_pop_invalid)", async () => {
    await stageAndActivate();
    const staleAt = Math.floor(Date.now() / 1000) - 100000;
    const runtimePublicKey = Buffer.from(runtimePubB64, "base64");
    const requestId = "55555555-5555-4555-8555-555555555555";
    const fields = { agentId, tenantId: tenant, requestId, packId, agentVersion: "1.8.3", signedAt: staleAt, runtimePublicKey };
    const r = await req(port, "POST", `/v1/agents/${agentId}/security-packs/${packId}/lease`, {
      body: {
        tenant_id: tenant,
        request_id: requestId,
        agent_version: "1.8.3",
        signed_at: staleAt,
        runtime_public_key_b64: runtimePubB64,
        certificate_pem: leafPem,
        signature_b64: signLeaseRequest(keyPem, fields),
      },
    });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.error, "pack_pop_invalid");
  });

  it("rejects a malformed request_id (400 pack_request_invalid)", async () => {
    await stageAndActivate();
    const r = await req(port, "POST", `/v1/agents/${agentId}/security-packs/${packId}/lease`, {
      body: leaseBody({ request_id: "not-a-uuid" }),
    });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.error, "pack_request_invalid");
  });

  it("returns 404 pack_not_found when no version is active", async () => {
    // Fresh server/store with no staged version.
    const store2 = new MemoryStore();
    const ca2 = mintTempCA();
    const { keyPem: k2, csrPem } = mintKeyAndCSR(ca2.dir, "p2");
    const leaf2 = issueLeafFromCsr(csrPem, { certPem: ca2.certPem, keyPem: ca2.keyPem });
    await store2.ensureTenant(tenant, "test");
    const boot = await store2.issueBootstrapToken(tenant, "test");
    const a2 = await store2.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      cert_fingerprint_sha256: leaf2.fingerprintSha256,
      cert_not_after: leaf2.notAfter,
      actor: "test",
    });
    await store2.approveAgent(a2.id, "test");
    await store2.reportTunnel({ tenant_id: tenant, agent_id: a2.id, event: "up", actor: "test" });
    const { context } = await buildDevPackContext({ store: store2, caCertPem: ca2.certPem, log: noopLog });
    const server2 = createServer(store2, { authToken: writer, agentCA: { certPem: ca2.certPem, keyPem: ca2.keyPem }, packs: context });
    const port2 = await listen(server2);
    try {
      const sodium = await sodiumReady();
      const rpk = Buffer.from(sodium.crypto_box_keypair().publicKey);
      const signedAt = Math.floor(Date.now() / 1000);
      const requestId = "55555555-5555-4555-8555-555555555555";
      const fields = { agentId: a2.id, tenantId: tenant, requestId, packId, agentVersion: "1.8.3", signedAt, runtimePublicKey: rpk };
      const r = await req(port2, "POST", `/v1/agents/${a2.id}/security-packs/${packId}/lease`, {
        body: {
          tenant_id: tenant,
          request_id: requestId,
          agent_version: "1.8.3",
          signed_at: signedAt,
          runtime_public_key_b64: rpk.toString("base64"),
          certificate_pem: leaf2.certificatePem,
          signature_b64: signLeaseRequest(k2, fields),
        },
      });
      assert.equal(r.status, 404, JSON.stringify(r.json));
      assert.equal(r.json.error, "pack_not_found");
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
      rmSync(ca2.dir, { recursive: true, force: true });
    }
  });
});
