/**
 * Shared test harness for the Secure Pack HTTP routes. Extracted so the
 * happy-path route tests and the SP-* adversarial suite build the same server,
 * CA, leaf, and signed requests without duplicating the openssl/HTTP plumbing.
 */

import { createPrivateKey, createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../../src/http/server";
import { issueLeafFromCsr } from "../../src/pki/issueLeaf";
import { MemoryStore } from "../../src/store/memory";
import { buildDevPackContext, encodePackLeaseRequestSigningV1 } from "../../src/packs";
import { sodiumReady } from "../../src/packs/seal";

export function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

export type Resp = { status: number; json: Record<string, unknown> };

export async function req(
  port: number,
  method: string,
  p: string,
  opts?: { token?: string; body?: unknown; rawBody?: Buffer; headers?: Record<string, string> },
): Promise<Resp> {
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

export function mintTempCA(): { certPem: string; keyPem: string; dir: string } {
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

export function mintKeyAndCSR(dir: string, label: string): { keyPem: string; csrPem: string } {
  const keyPath = path.join(dir, `${label}.key`);
  const csrPath = path.join(dir, `${label}.csr`);
  execFileSync(
    "openssl",
    ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", `/CN=connect-agent-${label}`],
    { stdio: "ignore" },
  );
  return { keyPem: readFileSync(keyPath, "utf8"), csrPem: readFileSync(csrPath, "utf8") };
}

/** Sign PackLeaseRequestSigningV1 with a leaf RSA key (RSA-SHA256). */
export function signLeaseRequest(
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

export const noopLog = { info: () => {}, warn: () => {} };

/** A fully-wired pack test environment: server + CA + one enrolled+approved agent. */
export type PackEnv = {
  store: MemoryStore;
  server: http.Server;
  port: number;
  caDir: string;
  writer: string;
  tenant: string;
  packId: string;
  agentId: string;
  leafPem: string;
  keyPem: string;
  runtimePubB64: string;
  close: () => Promise<void>;
};

/**
 * Build a ready-to-drive pack environment: memory store, dev pack context,
 * server with writer auth + Agent CA, and one enrolled+approved+Connected agent
 * whose leaf we hold. The caller stages/activates versions and drives requests.
 */
export async function buildPackEnv(opts?: {
  tenant?: string;
  packId?: string;
  writer?: string;
}): Promise<PackEnv> {
  const sodium = await sodiumReady();
  const tenant = opts?.tenant ?? "44444444-4444-4444-4444-444444444444";
  const packId = opts?.packId ?? "security-default";
  const writer = opts?.writer ?? "writer-secret";

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
  await store.approveAgent(agent.id, "test");
  await store.reportTunnel({ tenant_id: tenant, agent_id: agent.id, event: "up", actor: "test" });

  const { context } = await buildDevPackContext({ store, caCertPem: ca.certPem, log: noopLog });
  const server = createServer(store, {
    authToken: writer,
    agentCA: { certPem: ca.certPem, keyPem: ca.keyPem },
    packs: context,
  });
  const port = await listen(server);
  const runtimePubB64 = Buffer.from(sodium.crypto_box_keypair().publicKey).toString("base64");

  return {
    store,
    server,
    port,
    caDir: ca.dir,
    writer,
    tenant,
    packId,
    agentId: agent.id,
    leafPem: leaf.certificatePem,
    keyPem,
    runtimePubB64,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(ca.dir, { recursive: true, force: true });
    },
  };
}

/** Stage + activate a default-lineage version; returns the pack_version_id. */
export async function stageAndActivate(env: PackEnv, plaintext = "rules:\n  - id: x\n"): Promise<string> {
  const staged = await req(env.port, "POST", `/v1/tenants/default/security-packs/${env.packId}/versions`, {
    token: env.writer,
    rawBody: Buffer.from(plaintext, "utf8"),
    headers: { "X-Fabric-Pack-Content-Type": "application/yaml", "X-Fabric-Pack-Schema-Version": "7" },
  });
  if (staged.status !== 201) throw new Error(`stage failed: ${JSON.stringify(staged.json)}`);
  const pvid = String(staged.json.pack_version_id);
  const activated = await req(
    env.port,
    "POST",
    `/v1/tenants/default/security-packs/${env.packId}/versions/1/activate`,
    { token: env.writer, body: { pack_version_id: pvid } },
  );
  if (activated.status !== 200) throw new Error(`activate failed: ${JSON.stringify(activated.json)}`);
  return pvid;
}

/** Build a valid lease request body, with optional field overrides. */
export function leaseBody(
  env: PackEnv,
  over?: Partial<Record<string, unknown>>,
  signOver?: { signedAt?: number; requestId?: string; runtimePubB64?: string; keyPem?: string; tenantId?: string; agentVersion?: string },
): Record<string, unknown> {
  const signedAt = signOver?.signedAt ?? Math.floor(Date.now() / 1000);
  const requestId = signOver?.requestId ?? "55555555-5555-4555-8555-555555555555";
  const runtimePubB64 = signOver?.runtimePubB64 ?? env.runtimePubB64;
  const runtimePublicKey = Buffer.from(runtimePubB64, "base64");
  const fields = {
    agentId: env.agentId,
    tenantId: signOver?.tenantId ?? env.tenant,
    requestId,
    packId: env.packId,
    agentVersion: signOver?.agentVersion ?? "1.8.3",
    signedAt,
    runtimePublicKey,
  };
  return {
    protocol_version: 1,
    tenant_id: signOver?.tenantId ?? env.tenant,
    request_id: requestId,
    agent_version: signOver?.agentVersion ?? "1.8.3",
    signed_at: signedAt,
    runtime_public_key_b64: runtimePubB64,
    certificate_pem: env.leafPem,
    signature_b64: signLeaseRequest(signOver?.keyPem ?? env.keyPem, fields),
    ...over,
  };
}

export function leaseUrl(env: PackEnv): string {
  return `/v1/agents/${env.agentId}/security-packs/${env.packId}/lease`;
}
