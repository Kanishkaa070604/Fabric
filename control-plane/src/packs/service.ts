/**
 * PackService — orchestrates the secure-pack lease flow (spec §9.1) and version
 * staging, with NO HTTP concerns. It returns a typed result union; the route
 * layer maps codes to status. This keeps the security-critical validation order
 * in one testable place, independent of transport.
 *
 * Dependencies are injected (store, repository, producer, entitlement, CA,
 * clock), so the service is trivially unit-testable and every backing piece is
 * swappable. Nothing here reads process.env directly.
 */

import type { FabricStore } from "../store/types";
import type { PackProducer } from "./producer";
import type { PackRepository, PackVersionRecord } from "./repository";
import { verifyPackLeaseRequest } from "./leaseRequest";
import { AgentCertificateError } from "../pki/verifyAgentLeaf";
import { newId } from "../store/types";
import type { PackLeaseRequestFields } from "./protocol";

/** Stable machine-readable outcome codes (mirror spec §9.1 recommended errors). */
export type PackLeaseErrorCode =
  | "pack_request_invalid"
  | "pack_pop_invalid"
  | "agent_not_approved"
  | "tenant_suspended"
  | "tenant_mismatch"
  | "pack_not_entitled"
  | "agent_version_too_old"
  | "pack_not_found"
  | "no_assigned_version"
  | "pack_key_service_unavailable";

export type PackLeaseResult =
  | { ok: true; produced: Awaited<ReturnType<PackProducer["issueLease"]>> }
  | { ok: false; code: PackLeaseErrorCode; detail?: Record<string, unknown> };

/** Agent states permitted to consume packs: post-approval operational states. */
const PACK_ELIGIBLE_STATES = new Set([
  "Connecting",
  "Connected",
  "Degraded",
  "Disconnected",
]);

/**
 * Decides whether a tenant+agent is entitled to a pack. A seam so entitlement
 * can move to billing/licensing later without touching the route. The default
 * dev impl grants everything.
 */
export interface PackEntitlementProvider {
  isEntitled(input: {
    tenantId: string;
    agentId: string;
    packId: string;
  }): Promise<boolean>;
}

/** Dev entitlement: everyone is entitled. Replace with billing-backed impl. */
export class AllowAllEntitlementProvider implements PackEntitlementProvider {
  async isEntitled(): Promise<boolean> {
    return true;
  }
}

/** Lease lifetime policy. Defaults match spec §11 (30m TTL, 20m renew). */
export type PackLeasePolicy = {
  leaseTtlSeconds: number;
  renewAfterSeconds: number;
};

export const DEFAULT_LEASE_POLICY: PackLeasePolicy = {
  leaseTtlSeconds: 1800,
  renewAfterSeconds: 1200,
};

export type PackServiceDeps = {
  store: FabricStore;
  repository: PackRepository;
  producer: PackProducer;
  entitlement: PackEntitlementProvider;
  /** Agent CA trust anchor (same material the other PoP routes use). */
  caCertPem: string;
  /** clock override for tests; defaults to () => new Date(). */
  now?: () => Date;
  /** PoP skew override; falls through to verifier default (FABRIC_POP_SKEW_SECONDS). */
  maxSkewSeconds?: number;
  /** lease policy override; defaults to DEFAULT_LEASE_POLICY. */
  policy?: PackLeasePolicy;
};

/** The already-parsed, validated-shape lease request the route hands the service. */
export type LeaseRequestInput = {
  agentId: string;
  packId: string;
  tenantIdClaim: string;
  requestId: string;
  agentVersion: string;
  signedAt: number;
  /** raw 32 X25519 bytes (route decoded + length-checked before calling). */
  runtimePublicKey: Buffer;
  certificatePem: string;
  signatureB64: string;
  /** server-derived agent id from an Agent bearer, when one was presented. */
  bearerAgentId?: string;
};

const UUIDV4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PackService {
  private readonly now: () => Date;
  private readonly policy: PackLeasePolicy;

  constructor(private readonly deps: PackServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.policy = deps.policy ?? DEFAULT_LEASE_POLICY;
  }

  /**
   * Issue a lease. Runs the spec §9.1 validation order (rate limiting is the
   * route/edge's concern and precedes this call). Returns a typed result; never
   * throws for expected rejections.
   */
  async issueLease(input: LeaseRequestInput): Promise<PackLeaseResult> {
    // (3) freshness is enforced inside verifyPackLeaseRequest below, but we also
    // validate request_id shape early (11) since it is cheap and pre-crypto.
    if (!UUIDV4_RE.test(input.requestId)) {
      return { ok: false, code: "pack_request_invalid", detail: { field: "request_id" } };
    }
    // (12) runtime key length + not-all-zero.
    if (input.runtimePublicKey.length !== 32) {
      return { ok: false, code: "pack_request_invalid", detail: { field: "runtime_public_key" } };
    }
    if (input.runtimePublicKey.every((b) => b === 0)) {
      return { ok: false, code: "pack_request_invalid", detail: { field: "runtime_public_key_zero" } };
    }

    // (4) agent lookup.
    const agent = await this.deps.store.getAgent(input.agentId);
    if (!agent || agent.deleted_at) {
      return { ok: false, code: "pack_not_found", detail: { what: "agent" } };
    }

    // (5) derive tenant from the DB record; request tenant is a consistency
    // claim only, never authority. When an Agent bearer is present it must match
    // the path agent (spec §4.3).
    const tenantId = agent.tenant_id;
    if (input.tenantIdClaim && input.tenantIdClaim !== tenantId) {
      return { ok: false, code: "tenant_mismatch", detail: { claim: input.tenantIdClaim } };
    }
    if (input.bearerAgentId && input.bearerAgentId !== input.agentId) {
      return { ok: false, code: "pack_pop_invalid", detail: { reason: "bearer_agent_mismatch" } };
    }

    // (6) agent must be approved / in a pack-eligible operational state.
    if (!PACK_ELIGIBLE_STATES.has(agent.state)) {
      return { ok: false, code: "agent_not_approved", detail: { state: agent.state } };
    }

    // (7) tenant not suspended.
    const tenant = await this.deps.store.getTenant(tenantId);
    if (!tenant) {
      return { ok: false, code: "pack_not_found", detail: { what: "tenant" } };
    }
    if (tenant.suspended) {
      return { ok: false, code: "tenant_suspended", detail: { cause: tenant.suspended_cause } };
    }

    // (3,8,10) freshness + CA verify + validity window + request-signature over
    // the canonical PackLeaseRequestSigningV1 bytes. Reuses the shared verifier.
    const fields: PackLeaseRequestFields = {
      agentId: input.agentId,
      tenantId: input.tenantIdClaim || tenantId,
      requestId: input.requestId,
      packId: input.packId,
      agentVersion: input.agentVersion,
      signedAt: input.signedAt,
      runtimePublicKey: input.runtimePublicKey,
    };
    let fingerprintSha256: string;
    try {
      const verified = verifyPackLeaseRequest({
        fields,
        certificatePem: input.certificatePem,
        caCertPem: this.deps.caCertPem,
        signatureB64: input.signatureB64,
        now: this.now(),
        maxSkewSeconds: this.deps.maxSkewSeconds,
      });
      fingerprintSha256 = verified.fingerprintSha256;
    } catch (e) {
      const reason = e instanceof AgentCertificateError ? e.reason : "pack_pop_invalid";
      return { ok: false, code: "pack_pop_invalid", detail: { reason } };
    }

    // (9) certificate fingerprint must be bound to THIS agent (current or, within
    // the existing overlap window, prior). Store state, not PKI.
    const boundCurrent = agent.cert_fingerprint_sha256 === fingerprintSha256;
    const boundPrior =
      agent.prior_cert_fingerprint_sha256 === fingerprintSha256 &&
      (!agent.prior_cert_valid_until || agent.prior_cert_valid_until.getTime() >= this.now().getTime());
    if (!boundCurrent && !boundPrior) {
      return { ok: false, code: "pack_pop_invalid", detail: { reason: "cert_not_bound_to_agent" } };
    }

    // (13) entitlement.
    if (!(await this.deps.entitlement.isEntitled({ tenantId, agentId: input.agentId, packId: input.packId }))) {
      return { ok: false, code: "pack_not_entitled" };
    }

    // (14) resolve the version to serve (assignment → tenant own → default).
    const version = await this.deps.repository.resolveForLease(tenantId, input.packId);
    if (!version) {
      return { ok: false, code: "pack_not_found", detail: { what: "pack_version" } };
    }

    // (15) rollout floor. Rollout control, not a security gate; malformed fails closed.
    if (!agentVersionSatisfies(input.agentVersion, version.minAgentVersion)) {
      return {
        ok: false,
        code: "agent_version_too_old",
        detail: { agent_version: input.agentVersion, min: version.minAgentVersion },
      };
    }

    // (16–20) produce the lease. The producer fetches the DEK from the key
    // protector, seals it, computes digests, and signs.
    let produced;
    try {
      produced = await this.deps.producer.issueLease(
        {
          packVersionId: version.packVersionId,
          packId: version.packId,
          packVersion: version.version,
          contentType: version.contentType,
          schemaVersion: version.schemaVersion,
          compressionAlg: version.compressionAlg,
          uncompressedSize: version.uncompressedSize,
          compressedSize: version.compressedSize,
        },
        {
          leaseId: newId(),
          requestId: input.requestId,
          tenantId,
          agentId: input.agentId,
          agentCertFingerprintSha256: fingerprintSha256,
          runtimePublicKey: input.runtimePublicKey,
        },
        {
          issuedAt: Math.floor(this.now().getTime() / 1000),
          expiresAt: Math.floor(this.now().getTime() / 1000) + this.policy.leaseTtlSeconds,
          leaseTtlSeconds: this.policy.leaseTtlSeconds,
          renewAfterSeconds: this.policy.renewAfterSeconds,
          minAgentVersion: version.minAgentVersion,
          policyVersion: version.policyVersion,
        },
        { ciphertext: version.ciphertext, nonce: version.nonce },
      );
    } catch (e) {
      // A missing DEK or protector failure is a service-availability problem,
      // not a client error.
      return {
        ok: false,
        code: "pack_key_service_unavailable",
        detail: { error: e instanceof Error ? e.message : String(e) },
      };
    }

    return { ok: true, produced };
  }
}

/**
 * Minimal, shared semantic-version comparison for the rollout floor. Parses
 * MAJOR.MINOR.PATCH (ignoring any pre-release/build suffix); a malformed
 * agentVersion fails closed (returns false). An empty min means "no floor".
 */
export function agentVersionSatisfies(agentVersion: string, minAgentVersion: string): boolean {
  if (!minAgentVersion) return true;
  const a = parseSemver(agentVersion);
  const m = parseSemver(minAgentVersion);
  if (!a || !m) return false; // fail closed on malformed
  for (let i = 0; i < 3; i++) {
    if (a[i] > m[i]) return true;
    if (a[i] < m[i]) return false;
  }
  return true; // equal
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
