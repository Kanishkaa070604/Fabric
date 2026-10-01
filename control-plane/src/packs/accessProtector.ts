/**
 * Production PackKeyProtector + PackLeaseSigner backed by the Access API
 * (unified-access), spec §5.3 / §5.5.
 *
 *   AccessApiPackKeyProtector — stores/retrieves the DEK as a base64 secret
 *   keyed by pack_version_id. unified-access is a get/put-by-key store; it does
 *   no crypto ops, so v1 stores the raw DEK there (protected by the store's own
 *   at-rest encryption). Documented deferred swap (§5.3): master-key-wrap so the
 *   DEK is wrapped before it ever reaches the store — that changes only this
 *   class, never the PackKeyProtector contract.
 *
 *   AccessApiPackLeaseSigner — fetches the ES256 signing key (PKCS#8 PEM) from
 *   unified-access once, caches it, and signs in-process. Documented deferred
 *   swap (§5.5): a Vault/KMS crypto-op where signing never exports the key.
 *
 * Both take the AccessClient + the platform headers, mirroring how the DB creds
 * are fetched elsewhere. Neither reads process.env.
 */

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { AccessClient, AccessHeaders } from "../access/client";
import { signLease } from "./leaseSign";
import { DEK_BYTES } from "./seal";
import type { PackKeyProtector, PackLeaseSigner } from "./seams";
import type { PackLeaseFields } from "./protocol";

/** Options shared by the Access-backed impls. */
export type AccessPackDeps = {
  access: AccessClient;
  headers: AccessHeaders;
  /**
   * Secret-name prefix so pack DEKs don't collide with other secrets in the
   * store. Full name = `${dekPrefix}${packVersionId}`.
   */
  dekPrefix?: string;
  /** Scope passed to createSecret (store-specific grouping); default "fabric-pack". */
  scope?: string;
};

export class AccessApiPackKeyProtector implements PackKeyProtector {
  private readonly dekPrefix: string;
  private readonly scope: string;

  constructor(private readonly deps: AccessPackDeps) {
    this.dekPrefix = deps.dekPrefix ?? "fabric-pack-dek/";
    this.scope = deps.scope ?? "fabric-pack";
  }

  private nameFor(packVersionId: string): string {
    return `${this.dekPrefix}${packVersionId}`;
  }

  async putDek(packVersionId: string, dek: Buffer): Promise<void> {
    if (!packVersionId) throw new Error("packVersionId is required");
    if (dek.length !== DEK_BYTES) {
      throw new Error(`dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
    }
    // Store as base64. createSecret is create-or-fail in some stores, so fall
    // back to update on conflict to keep putDek idempotent per version.
    const name = this.nameFor(packVersionId);
    const value = dek.toString("base64");
    try {
      await this.deps.access.createSecret(this.deps.headers, name, value, this.scope);
    } catch {
      await this.deps.access.updateSecret(this.deps.headers, name, value);
    }
  }

  async getDek(packVersionId: string): Promise<Buffer> {
    const value = await this.deps.access.getSecret(
      this.deps.headers,
      this.nameFor(packVersionId),
    );
    const dek = Buffer.from(value, "base64");
    if (dek.length !== DEK_BYTES) {
      throw new Error(
        `stored DEK for ${packVersionId} is ${dek.length} bytes, expected ${DEK_BYTES}`,
      );
    }
    return dek;
  }
}

export type AccessPackLeaseSignerDeps = AccessPackDeps & {
  /** Secret name holding the ES256 signing key as a PKCS#8 PEM. */
  signingKeySecretName?: string;
};

export class AccessApiPackLeaseSigner implements PackLeaseSigner {
  private readonly secretName: string;
  private privateKey: KeyObject | null = null;
  private spkiDer: Buffer | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly deps: AccessPackLeaseSignerDeps) {
    this.secretName = deps.signingKeySecretName ?? "fabric-pack-lease-signing-key";
  }

  /**
   * Fetch + cache the signing key. Concurrency-safe: concurrent callers share
   * one in-flight load; a failed load clears the cache so a later call retries.
   */
  private async ensureKey(): Promise<void> {
    if (this.privateKey) return;
    if (!this.loading) {
      this.loading = (async () => {
        const pem = await this.deps.access.getSecret(this.deps.headers, this.secretName);
        const key = createPrivateKey(pem);
        this.privateKey = key;
        this.spkiDer = Buffer.from(
          createPublicKey(key).export({ type: "spki", format: "der" }),
        );
      })().catch((err) => {
        this.loading = null;
        throw err;
      });
    }
    await this.loading;
  }

  async signLease(
    fields: PackLeaseFields,
  ): Promise<{ signature: Buffer; signedBytes: Buffer }> {
    await this.ensureKey();
    return signLease(this.privateKey!, fields);
  }

  async publicKeySpkiDer(): Promise<Buffer> {
    await this.ensureKey();
    return Buffer.from(this.spkiDer!);
  }
}
