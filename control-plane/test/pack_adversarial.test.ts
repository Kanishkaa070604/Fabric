import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildPackEnv,
  stageAndActivate,
  leaseBody,
  leaseUrl,
  req,
  listen,
  mintTempCA,
  mintKeyAndCSR,
  signLeaseRequest,
  noopLog,
  type PackEnv,
} from "./helpers/packHarness";
import { MemoryStore } from "../src/store/memory";
import { issueLeafFromCsr } from "../src/pki/issueLeaf";
import { createServer } from "../src/http/server";
import { buildDevPackContext } from "../src/packs";
import { sodiumReady } from "../src/packs/seal";

function readCAcert(dir: string): { certPem: string; keyPem: string } {
  return {
    certPem: readFileSync(path.join(dir, "ca.crt"), "utf8"),
    keyPem: readFileSync(path.join(dir, "ca.key"), "utf8"),
  };
}

/**
 * SP-* / FAB-* adversarial suite at the HTTP lease route — the control-plane
 * boundary. Maps each rejection to the spec §9.1 error code + HTTP status.
 * Every case must fail closed; a valid request is the positive control.
 */

describe("Secure Pack — HTTP route adversarial suite (SP-*/FAB-*)", () => {
  let env: PackEnv;

  before(async () => {
    env = await buildPackEnv();
    await stageAndActivate(env);
  });
  after(async () => {
    await env.close();
  });

  // SP-POP-001: valid leaf-signed request → 200 (positive control).
  it("SP-HAPPY-001: valid request issues a lease", async () => {
    const r = await req(env.port, "POST", leaseUrl(env), { body: leaseBody(env) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  // SP-POP-002: a bad request signature → 403 pack_pop_invalid.
  it("SP-POP-002: bad signature → 403 pack_pop_invalid", async () => {
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, { signature_b64: Buffer.from("nope").toString("base64") }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "pack_pop_invalid");
  });

  // SP-TIME-003: stale signed_at (outside skew) → 403 pack_pop_invalid.
  it("SP-TIME-003: stale signed_at → 403 pack_pop_invalid", async () => {
    const stale = Math.floor(Date.now() / 1000) - 100000;
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, {}, { signedAt: stale }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "pack_pop_invalid");
  });

  // SP-TIME-004: future signed_at (outside skew) → 403 pack_pop_invalid.
  it("SP-TIME-004: far-future signed_at → 403 pack_pop_invalid", async () => {
    const future = Math.floor(Date.now() / 1000) + 100000;
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, {}, { signedAt: future }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "pack_pop_invalid");
  });

  // SP-REQ-001: malformed request_id → 400 pack_request_invalid.
  it("SP-REQ-001: malformed request_id → 400 pack_request_invalid", async () => {
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, { request_id: "not-a-uuid" }, { requestId: "not-a-uuid" }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "pack_request_invalid");
  });

  // SP-KEY-001: non-32-byte runtime key in the body → 400 pack_request_invalid.
  // The route rejects on length before signature verification, so we send a
  // valid (32-byte-signed) request but override the wire key to 16 bytes.
  it("SP-KEY-001: short runtime key → 400 pack_request_invalid", async () => {
    const shortKey = Buffer.alloc(16, 7).toString("base64");
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, { runtime_public_key_b64: shortKey }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "pack_request_invalid");
  });

  // SP-KEY-002: all-zero runtime key → 400 pack_request_invalid.
  it("SP-KEY-002: all-zero runtime key → 400 pack_request_invalid", async () => {
    const zeroKey = Buffer.alloc(32, 0).toString("base64");
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, { runtime_public_key_b64: zeroKey }, { runtimePubB64: zeroKey }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "pack_request_invalid");
  });

  // FAB-TEN-001: a tenant_id claim that disagrees with the agent's real tenant
  // → 403 tenant_mismatch (claim is consistency-only, never authority).
  it("FAB-TEN-001: mismatched tenant_id claim → 403 tenant_mismatch", async () => {
    const wrong = "99999999-9999-4999-8999-999999999999";
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, { tenant_id: wrong }, { tenantId: wrong }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "tenant_mismatch");
  });

  // SP-CERT-001: a genuine leaf from a DIFFERENT agent (correctly signs its own
  // request) is not bound to the path agent → 403 pack_pop_invalid.
  it("SP-CERT-001: foreign leaf not bound to agent → 403 pack_pop_invalid", async () => {
    // Mint a second leaf under the SAME CA but never enrolled as this agent.
    const { keyPem: otherKey, csrPem } = mintKeyAndCSR(env.caDir, "foreign");
    const caCert = readCAcert(env.caDir);
    const foreign = issueLeafFromCsr(csrPem, { certPem: caCert.certPem, keyPem: caCert.keyPem });
    const signedAt = Math.floor(Date.now() / 1000);
    const requestId = "55555555-5555-4555-8555-555555555555";
    const runtimePublicKey = Buffer.from(env.runtimePubB64, "base64");
    const fields = {
      agentId: env.agentId,
      tenantId: env.tenant,
      requestId,
      packId: env.packId,
      agentVersion: "1.8.3",
      signedAt,
      runtimePublicKey,
    };
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: {
        tenant_id: env.tenant,
        request_id: requestId,
        agent_version: "1.8.3",
        signed_at: signedAt,
        runtime_public_key_b64: env.runtimePubB64,
        certificate_pem: foreign.certificatePem,
        signature_b64: signLeaseRequest(otherKey, fields),
      },
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "pack_pop_invalid");
  });

  // SP-WRITER-001: stage without writer auth → 401/403.
  it("SP-WRITER-001: stage without writer auth is rejected", async () => {
    const r = await req(env.port, "POST", `/v1/tenants/default/security-packs/${env.packId}/versions`, {
      rawBody: Buffer.from("x", "utf8"),
    });
    assert.ok(r.status === 401 || r.status === 403, `got ${r.status}`);
  });
});

// --- FAB-TEN lineage isolation: separate env so state is clean ---------------

describe("Secure Pack — tenant lineage isolation (FAB-TEN)", () => {
  // FAB-TEN-002: a tenant with NO own version falls back to the DEFAULT bundle
  // and gets a valid lease (shared-default succeeds).
  it("FAB-TEN-002: default fallback serves a lease when tenant has no own version", async () => {
    const env = await buildPackEnv();
    try {
      await stageAndActivate(env); // default lineage only
      const r = await req(env.port, "POST", leaseUrl(env), { body: leaseBody(env) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const lease = r.json.lease as Record<string, unknown>;
      // The served version is the default's; the lease names the version it served.
      assert.equal(typeof lease.pack_version_id, "string");
    } finally {
      await env.close();
    }
  });

  // FAB-TEN-003: with NO default and NO tenant version, a lease is 404
  // pack_not_found (no lineage to serve).
  it("FAB-TEN-003: no active version anywhere → 404 pack_not_found", async () => {
    const env = await buildPackEnv();
    try {
      // Do NOT stage/activate anything.
      const r = await req(env.port, "POST", leaseUrl(env), { body: leaseBody(env) });
      assert.equal(r.status, 404, JSON.stringify(r.json));
      assert.equal(r.json.error, "pack_not_found");
    } finally {
      await env.close();
    }
  });
});

// --- FAB agent-state gates: suspended / unapproved ---------------------------

describe("Secure Pack — agent/tenant state gates (FAB)", () => {
  async function envWithAgentState(makeReady: boolean): Promise<PackEnv> {
    const sodium = await sodiumReady();
    const tenant = "44444444-4444-4444-4444-444444444444";
    const packId = "security-default";
    const writer = "writer-secret";
    const ca = mintTempCA();
    const { keyPem, csrPem } = mintKeyAndCSR(ca.dir, "agent");
    const leaf = issueLeafFromCsr(csrPem, { certPem: ca.certPem, keyPem: ca.keyPem });
    const store = new MemoryStore();
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
    if (makeReady) {
      await store.approveAgent(agent.id, "test");
      await store.reportTunnel({ tenant_id: tenant, agent_id: agent.id, event: "up", actor: "test" });
    }
    const { context } = await buildDevPackContext({ store, caCertPem: ca.certPem, log: noopLog });
    const server = createServer(store, {
      authToken: writer,
      agentCA: { certPem: ca.certPem, keyPem: ca.keyPem },
      packs: context,
    });
    const port = await listen(server);
    const runtimePubB64 = Buffer.from(sodium.crypto_box_keypair().publicKey).toString("base64");
    return {
      store, server, port, caDir: ca.dir, writer, tenant, packId,
      agentId: agent.id, leafPem: leaf.certificatePem, keyPem, runtimePubB64,
      close: async () => {
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(ca.dir, { recursive: true, force: true });
      },
    };
  }

  // FAB-STATE-001: an unapproved agent (PendingApproval) → 403 agent_not_approved.
  it("FAB-STATE-001: unapproved agent → 403 agent_not_approved", async () => {
    const env = await envWithAgentState(false);
    try {
      await stageAndActivate(env);
      const r = await req(env.port, "POST", leaseUrl(env), { body: leaseBody(env) });
      assert.equal(r.status, 403, JSON.stringify(r.json));
      assert.equal(r.json.error, "agent_not_approved");
    } finally {
      await env.close();
    }
  });

  // FAB-STATE-002: a suspended tenant → 403 tenant_suspended.
  it("FAB-STATE-002: suspended tenant → 403 tenant_suspended", async () => {
    const env = await envWithAgentState(true);
    try {
      await stageAndActivate(env);
      await env.store.setSuspended(env.tenant, true, "test", "security");
      const r = await req(env.port, "POST", leaseUrl(env), { body: leaseBody(env) });
      assert.equal(r.status, 403, JSON.stringify(r.json));
      assert.equal(r.json.error, "tenant_suspended");
    } finally {
      await env.close();
    }
  });
});
