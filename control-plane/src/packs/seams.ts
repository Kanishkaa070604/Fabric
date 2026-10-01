/**
 * Secure Pack producer-side interface SEAMS.
 *
 * These are the two swap points where production key-management plugs in.
 * Phase 0 ships the interfaces plus local, in-memory dev implementations so the
 * whole producer path runs without external infra. The dev impls are marked
 * NOT-FOR-PRODUCTION and refuse to construct in a production-like environment.
 *
 *   PackKeyProtector — persists/retrieves the per-version DEK.
 *     v1 production: unified-access store-by-key (getSecret/createSecret),
 *       keyed by pack_version_id. Documented deferred swap: master-key-wrap so
 *       the DEK is never at rest in plaintext even inside the secret store.
 *     dev: an in-memory Map.
 *
 *   PackLeaseSigner — signs canonical PackLeaseSigningV1 bytes with ES256.
 *     v1 production: fetch the ES256 private key from unified-access, sign in
 *       the control plane (same app-tier-key class as L3-PKI-02). Documented
 *       deferred swap: Vault/KMS crypto-op (sign never exports the key).
 *     dev: a locally generated (or provided) ES256 key.
 *
 * Nothing here talks to the network in Phase 0; the production impls are thin
 * adapters over the existing AccessClient, left for the routing phase.
 *
 * Config is INJECTED, never read from process.env in-line — matching src/config.ts.
 * Callers pass an environment map (defaulting to process.env) so behavior is
 * deterministic and testable.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { signLease } from "./leaseSign";
import { DEK_BYTES } from "./seal";
import type { PackLeaseFields } from "./protocol";

/**
 * Returns true when the given environment looks production-like. Injected so
 * tests and callers control it explicitly rather than depending on ambient
 * process state. Recognizes NODE_ENV or FABRIC_ENV set to "production".
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.FABRIC_ENV === "production";
}

function assertNotProduction(what: string, env: NodeJS.ProcessEnv): void {
  if (isProductionEnv(env)) {
    throw new Error(
      `${what} is a development-only implementation and must not run in production. ` +
        `Wire a real PackKeyProtector/PackLeaseSigner backed by unified-access/KMS.`,
    );
  }
}

/** Shared options for the dev implementations. */
export type DevImplOptions = {
  /** Environment used for the production guard; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Escape hatch to allow a dev impl even in a production-like env. Only for
   * explicit, deliberate local overrides — never set this in real deployments.
   */
  allowInProduction?: boolean;
};

// ---------------------------------------------------------------------------
// PackKeyProtector
// ---------------------------------------------------------------------------

/**
 * Persists and retrieves the pack DEK by pack_version_id. The DEK is the raw
 * 32-byte XChaCha key; the protector owns how it is stored at rest.
 */
export interface PackKeyProtector {
  /** Store the DEK for a version. Idempotent per pack_version_id. */
  putDek(packVersionId: string, dek: Buffer): Promise<void>;
  /**
   * Retrieve the DEK for a version. Throws if unknown. The returned Buffer is
   * caller-owned request-local material and MAY be zeroed after use; protector
   * implementations must not return their backing/cache buffer directly.
   */
  getDek(packVersionId: string): Promise<Buffer>;
}

/**
 * In-memory dev PackKeyProtector. Loses everything on restart; never encrypts
 * the DEK at rest. Suitable only for local runs and tests.
 */
export class InMemoryPackKeyProtector implements PackKeyProtector {
  private readonly store = new Map<string, Buffer>();

  constructor(opts: DevImplOptions = {}) {
    if (!opts.allowInProduction) {
      assertNotProduction("InMemoryPackKeyProtector", opts.env ?? process.env);
    }
  }

  async putDek(packVersionId: string, dek: Buffer): Promise<void> {
    if (!packVersionId) {
      throw new Error("packVersionId is required");
    }
    if (dek.length !== DEK_BYTES) {
      throw new Error(`dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
    }
    this.store.set(packVersionId, Buffer.from(dek));
  }

  async getDek(packVersionId: string): Promise<Buffer> {
    const dek = this.store.get(packVersionId);
    if (!dek) {
      throw new Error(`no DEK stored for pack_version_id=${packVersionId}`);
    }
    return Buffer.from(dek);
  }
}

// ---------------------------------------------------------------------------
// PackLeaseSigner
// ---------------------------------------------------------------------------

/** Signs canonical lease bytes with ES256, returning DER signature + bytes. */
export interface PackLeaseSigner {
  signLease(fields: PackLeaseFields): Promise<{ signature: Buffer; signedBytes: Buffer }>;
  /** SPKI DER of the signing public key, for pinning on the consumer side. */
  publicKeySpkiDer(): Promise<Buffer>;
}

export type LocalKeyPackLeaseSignerOptions = DevImplOptions & {
  /** Optional fixed PKCS#8 PEM. If omitted, a fresh P-256 key is generated. */
  pkcs8Pem?: string;
};

/**
 * Dev PackLeaseSigner holding an ES256 key in process. Generates an ephemeral
 * P-256 key if none is provided. Never fetches from a KMS. Local runs/tests only.
 */
export class LocalKeyPackLeaseSigner implements PackLeaseSigner {
  private readonly privateKey: KeyObject;
  private readonly spkiDer: Buffer;

  constructor(opts: LocalKeyPackLeaseSignerOptions = {}) {
    if (!opts.allowInProduction) {
      assertNotProduction("LocalKeyPackLeaseSigner", opts.env ?? process.env);
    }
    this.privateKey = opts.pkcs8Pem
      ? createPrivateKey(opts.pkcs8Pem)
      : generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    // Derive the public key once at construction — it never changes.
    this.spkiDer = Buffer.from(
      createPublicKey(this.privateKey).export({ type: "spki", format: "der" }),
    );
  }

  async signLease(
    fields: PackLeaseFields,
  ): Promise<{ signature: Buffer; signedBytes: Buffer }> {
    return signLease(this.privateKey, fields);
  }

  async publicKeySpkiDer(): Promise<Buffer> {
    return Buffer.from(this.spkiDer);
  }
}
