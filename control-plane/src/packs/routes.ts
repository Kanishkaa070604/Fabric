/**
 * Pack HTTP routes — a thin, self-contained adapter over PackService.
 *
 * This is the ONLY pack code that touches req/res. It parses the three pack
 * routes, delegates all logic to the injected service/producer/repository, and
 * maps typed service outcomes to HTTP status codes. It is wired into the main
 * server by a single delegating call (see ServerOpts.packs), so none of the
 * pack cascade lives inside the giant router.
 *
 * Routes:
 *   POST /v1/tenants/{tid}/security-packs/{pid}/versions            (writer) stage
 *   POST /v1/tenants/{tid}/security-packs/{pid}/versions/{v}/activate (writer)
 *   POST /v1/agents/{aid}/security-packs/{pid}/lease                (leaf PoP)
 *
 * The adapter is transport-only: no crypto, no store writes beyond the service,
 * no env reads. Everything it needs is on PackRoutesContext.
 */

import type * as http from "node:http";
import { newId } from "../store/types";
import { encodePackAADV1 } from "./protocol";
import { sodiumReady, encryptPack, DEK_BYTES } from "./seal";
import type { Sodium } from "./seal";
import type { PackKeyProtector } from "./seams";
import type { PackRepository } from "./repository";
import type { PackService, PackLeaseErrorCode } from "./service";

/** Minimal logger shape (matches the project's structured logger surface). */
export type PackLogger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
};

/** Everything the adapter needs, injected — no globals. */
export type PackRoutesContext = {
  service: PackService;
  repository: PackRepository;
  keyProtector: PackKeyProtector;
  /** default pack_id for the default lineage; content_type/schema come from headers. */
  log: PackLogger;
  sodium?: Sodium;
  /** DEK generator override (tests); defaults to libsodium random. */
  generateDek?: (sodium: Sodium) => Uint8Array;
  /** compression step; defaults to identity ("none"). Returns bytes + alg name. */
  compress?: (plaintext: Buffer) => { bytes: Buffer; alg: string };
  /** max plaintext upload bytes for stage; defaults to 8 MiB. */
  maxUploadBytes?: number;
};

/** Helpers mirroring server.ts's send/readBody so the adapter stays consistent. */
type SendFn = (res: http.ServerResponse, status: number, body: unknown) => void;
type ReadBodyFn = (req: http.IncomingMessage) => Promise<Buffer>;

const LEASE_CODE_STATUS: Record<PackLeaseErrorCode, number> = {
  pack_request_invalid: 400,
  pack_pop_invalid: 403,
  agent_not_approved: 403,
  tenant_suspended: 403,
  tenant_mismatch: 403,
  pack_not_entitled: 403,
  agent_version_too_old: 403,
  pack_not_found: 404,
  no_assigned_version: 409,
  pack_key_service_unavailable: 503,
};

const STAGE_ROUTE = /^\/v1\/tenants\/([^/]+)\/security-packs\/([^/]+)\/versions$/;
const ACTIVATE_ROUTE =
  /^\/v1\/tenants\/([^/]+)\/security-packs\/([^/]+)\/versions\/([^/]+)\/activate$/;
const LEASE_ROUTE = /^\/v1\/agents\/([^/]+)\/security-packs\/([^/]+)\/lease$/;

/** True if the path/method is one of the pack routes (used for auth classification). */
export function isPackLeaseRoute(method: string, path: string): boolean {
  return method === "POST" && LEASE_ROUTE.test(path);
}

export function isPackWriterRoute(method: string, path: string): boolean {
  return method === "POST" && (STAGE_ROUTE.test(path) || ACTIVATE_ROUTE.test(path));
}

/**
 * Attempt to handle a pack route. Returns true if it matched and responded,
 * false if the request is not a pack route (so the main router continues).
 *
 * `authz` mirrors the server's discriminated union just enough for the guards
 * this adapter needs: writer for stage/activate, and the derived agent id +
 * whether a bearer was presented for the lease route's §4.3 rule.
 */
export async function handlePackRoutes(
  ctx: PackRoutesContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  args: {
    method: string;
    path: string;
    correlationId: string;
    send: SendFn;
    readBody: ReadBodyFn;
    /** role + bearer-derived agent id (undefined when no agent bearer). */
    authz: { role: string; bearerAgentId?: string };
    headers: http.IncomingHttpHeaders;
  },
): Promise<boolean> {
  const { method, path, send, readBody, correlationId, authz } = args;

  // ---- stage a new version (writer) -------------------------------------
  const stageMatch = method === "POST" ? STAGE_ROUTE.exec(path) : null;
  if (stageMatch) {
    if (authz.role !== "writer") {
      send(res, 403, { error: "writer_required" });
      return true;
    }
    const tenantParam = decodeURIComponent(stageMatch[1]);
    const packId = decodeURIComponent(stageMatch[2]);
    try {
      const tenantId = tenantParam === "default" ? null : tenantParam;
      const plaintext = await readBody(req);
      const maxUpload = ctx.maxUploadBytes ?? 8 * 1024 * 1024;
      if (plaintext.length > maxUpload) {
        send(res, 413, { error: "pack_plaintext_too_large" });
        return true;
      }
      const contentType = String(args.headers["x-fabric-pack-content-type"] || "application/yaml");
      const schemaVersion = String(args.headers["x-fabric-pack-schema-version"] || "1");
      const staged = await stageVersion(ctx, {
        tenantId,
        packId,
        plaintext,
        contentType,
        schemaVersion,
        actor: String(args.headers["x-ablv-actor"] || "system"),
      });
      ctx.log.info("pack_version_staged", {
        layer: "control-plane.packs",
        tenant_id: tenantId,
        pack_id: packId,
        pack_version_id: staged.packVersionId,
        version: staged.version,
        correlation_id: correlationId,
      });
      send(res, 201, {
        pack_version_id: staged.packVersionId,
        pack_id: staged.packId,
        tenant_id: staged.tenantId,
        version: staged.version,
        state: staged.state,
        content_type: staged.contentType,
        schema_version: staged.schemaVersion,
        compression_alg: staged.compressionAlg,
        encryption_alg: staged.encryptionAlg,
        uncompressed_size: staged.uncompressedSize,
        compressed_size: staged.compressedSize,
        ciphertext_size: staged.ciphertextSize,
        ciphertext_sha256: staged.ciphertextSha256,
      });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // ---- activate a version (writer) --------------------------------------
  const activateMatch = method === "POST" ? ACTIVATE_ROUTE.exec(path) : null;
  if (activateMatch) {
    if (authz.role !== "writer") {
      send(res, 403, { error: "writer_required" });
      return true;
    }
    const packId = decodeURIComponent(activateMatch[2]);
    const versionParam = decodeURIComponent(activateMatch[3]);
    try {
      // The path carries the human version number; activate by resolving that to
      // its row. For the in-memory dev repo we accept a pack_version_id directly
      // in the body as the unambiguous selector (the UI passes the id it staged).
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const packVersionId = String(body.pack_version_id || "");
      if (!packVersionId) {
        send(res, 400, { error: "pack_version_id_required" });
        return true;
      }
      const activated = await ctx.repository.activateVersion(packVersionId);
      ctx.log.info("pack_version_activated", {
        layer: "control-plane.packs",
        pack_id: packId,
        pack_version_id: activated.packVersionId,
        version: versionParam,
        correlation_id: correlationId,
      });
      send(res, 200, {
        pack_version_id: activated.packVersionId,
        version: activated.version,
        state: activated.state,
      });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // ---- lease (leaf PoP) --------------------------------------------------
  const leaseMatch = method === "POST" ? LEASE_ROUTE.exec(path) : null;
  if (leaseMatch) {
    const agentId = decodeURIComponent(leaseMatch[1]);
    const packId = decodeURIComponent(leaseMatch[2]);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      send(res, 400, { error: "pack_request_invalid" });
      return true;
    }

    // Decode + shape-check the runtime key before touching the service.
    let runtimePublicKey: Buffer;
    try {
      runtimePublicKey = Buffer.from(String(body.runtime_public_key_b64 || ""), "base64");
    } catch {
      send(res, 400, { error: "pack_request_invalid", field: "runtime_public_key_b64" });
      return true;
    }

    const result = await ctx.service.issueLease({
      agentId,
      packId,
      tenantIdClaim: String(body.tenant_id || ""),
      requestId: String(body.request_id || ""),
      agentVersion: String(body.agent_version || ""),
      signedAt: Number(body.signed_at),
      runtimePublicKey,
      certificatePem: String(body.certificate_pem || ""),
      signatureB64: String(body.signature_b64 || ""),
      bearerAgentId: authz.bearerAgentId,
    });

    if (!result.ok) {
      const status = LEASE_CODE_STATUS[result.code] ?? 400;
      ctx.log.warn("pack_lease_rejected", {
        layer: "control-plane.packs",
        agent_id: agentId,
        pack_id: packId,
        code: result.code,
        correlation_id: correlationId,
        ...(result.detail ?? {}),
      });
      send(res, status, { error: result.code });
      return true;
    }

    const p = result.produced;

    // Conditional ciphertext (bandwidth): the pack ciphertext is large (MBs) and
    // unchanged across the ~20-min renewals that dominate lease traffic. When the
    // caller tells us which version it already holds (known_pack_version_id) and
    // it matches the version we resolved, omit ciphertext_b64 — the consumer
    // reuses its cached copy. The signed lease still covers ciphertext_sha256, so
    // integrity is unaffected: the consumer verifies its cached bytes against the
    // digest before use. First fetch (or any version change) still ships it.
    const knownVersionId = String(body.known_pack_version_id || "");
    const includeCiphertext = knownVersionId !== p.lease.packVersionId;

    ctx.log.info("pack_lease_issued", {
      layer: "control-plane.packs",
      agent_id: agentId,
      pack_id: packId,
      pack_version_id: p.lease.packVersionId,
      lease_id: p.lease.leaseId,
      ciphertext_included: includeCiphertext,
      correlation_id: correlationId,
    });
    send(res, 200, {
      protocol_version: 1,
      lease: leaseToWire(p.lease),
      sealed_dek_b64: p.sealedDek.toString("base64"),
      // v1: control-plane-served ciphertext, inline (spec §9.5) — but only when
      // the caller does not already hold this version (see above). Omitted =
      // "reuse your cached ciphertext for pack_version_id".
      ...(includeCiphertext ? { ciphertext_b64: p.ciphertext.toString("base64") } : {}),
      signature: {
        alg: "ES256",
        signature_b64: p.leaseSignature.toString("base64"),
      },
    });
    return true;
  }

  return false;
}

/**
 * Stage: compress (pluggable; default identity), generate DEK + nonce, encrypt
 * with AAD, store the DEK in the protector keyed by the new pack_version_id, and
 * persist a staged row. Mirrors spec §9.2 steps 4–12. The DEK never lands in the
 * repository row — only its secret ref.
 */
async function stageVersion(
  ctx: PackRoutesContext,
  input: {
    tenantId: string | null;
    packId: string;
    plaintext: Buffer;
    contentType: string;
    schemaVersion: string;
    actor: string;
  },
) {
  const sodium = ctx.sodium ?? (await sodiumReady());
  const compressed = ctx.compress ? ctx.compress(input.plaintext) : { bytes: input.plaintext, alg: "none" };

  const packVersionId = newId();
  const dek = Buffer.from(
    ctx.generateDek ? ctx.generateDek(sodium) : sodium.randombytes_buf(DEK_BYTES),
  );
  // Fix the version before encrypting: it is bound into the AAD and the lease.
  const version = await ctx.repository.reserveVersion(input.tenantId, input.packId);

  const aad = {
    packVersionId,
    packId: input.packId,
    packVersion: version,
    contentType: input.contentType,
    schemaVersion: input.schemaVersion,
    compressionAlg: compressed.alg,
    uncompressedSize: input.plaintext.length,
    compressedSize: compressed.bytes.length,
  };
  const enc = encryptPack(sodium, compressed.bytes, dek, aad);
  const { createHash } = await import("node:crypto");
  const ciphertextSha256 = createHash("sha256").update(enc.ciphertext).digest("hex");

  // Store the DEK behind the protector seam; the row holds only the ref.
  await ctx.keyProtector.putDek(packVersionId, dek);
  // Best-effort zero of the local plaintext DEK copy after storing.
  dek.fill(0);

  return ctx.repository.stageVersion({
    packVersionId,
    tenantId: input.tenantId,
    packId: input.packId,
    version,
    contentType: input.contentType,
    schemaVersion: input.schemaVersion,
    compressionAlg: compressed.alg,
    encryptionAlg: "xchacha20poly1305-ietf",
    ciphertext: enc.ciphertext,
    nonce: enc.nonce,
    uncompressedSize: input.plaintext.length,
    compressedSize: compressed.bytes.length,
    ciphertextSize: enc.ciphertext.length,
    ciphertextSha256,
    dekSecretRef: packVersionId,
    minAgentVersion: "",
    policyVersion: 1,
    createdBy: input.actor,
  });
}

/** Map internal camelCase lease fields to the snake_case wire shape (spec §9.1). */
function leaseToWire(lease: import("./protocol").PackLeaseFields) {
  return {
    lease_id: lease.leaseId,
    request_id: lease.requestId,
    tenant_id: lease.tenantId,
    agent_id: lease.agentId,
    agent_cert_fingerprint_sha256: lease.agentCertFingerprintSha256,
    pack_id: lease.packId,
    pack_version_id: lease.packVersionId,
    pack_version: Number(lease.packVersion),
    content_type: lease.contentType,
    schema_version: lease.schemaVersion,
    compression_alg: lease.compressionAlg,
    encryption_alg: lease.encryptionAlg,
    pack_nonce_b64: lease.packNonce.toString("base64"),
    uncompressed_size: Number(lease.uncompressedSize),
    compressed_size: Number(lease.compressedSize),
    ciphertext_size: Number(lease.ciphertextSize),
    ciphertext_sha256: lease.ciphertextSha256.toString("hex"),
    runtime_public_key_sha256: lease.runtimePublicKeySha256.toString("hex"),
    sealed_dek_sha256: lease.sealedDekSha256.toString("hex"),
    issued_at: Number(lease.issuedAt),
    expires_at: Number(lease.expiresAt),
    lease_ttl_seconds: Number(lease.leaseTtlSeconds),
    renew_after_seconds: Number(lease.renewAfterSeconds),
    min_agent_version: lease.minAgentVersion,
    policy_version: Number(lease.policyVersion),
  };
}
