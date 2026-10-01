/**
 * PackProducer — the single entry point the control plane uses to turn pack
 * plaintext + metadata into everything a lease response needs.
 *
 * Without this, an integrator has to hand-wire the exact sequence the wire
 * contract demands: encode the AAD, seal the DEK, encrypt under that DEK with
 * that AAD, compute three separate SHA-256 digests over the RIGHT bytes, then
 * sign a lease whose fields must agree with all of the above. Getting any digest
 * or field wrong produces a lease the Go consumer silently rejects. This class
 * does that dance once, correctly, so the route layer never touches raw crypto.
 *
 * It is deliberately stateless per call and depends only on the two seams
 * (PackKeyProtector, PackLeaseSigner) plus libsodium — no DB, no HTTP, no env.
 * Wiring those dependencies is the caller's job, which keeps this testable and
 * swappable.
 */

import { createHash } from "node:crypto";
import { sodiumReady, sealDek, encryptPack, DEK_BYTES, XNONCE_BYTES, type Sodium } from "./seal";
import type { PackKeyProtector, PackLeaseSigner } from "./seams";
import type { PackAADFields, PackLeaseFields } from "./protocol";

function sha256(b: Uint8Array): Buffer {
  return createHash("sha256").update(b).digest();
}

/** Content identity + sizing the producer needs to build AAD and lease. */
export type PackContentMeta = {
  packVersionId: string;
  packId: string;
  packVersion: number | bigint;
  contentType: string;
  schemaVersion: string;
  compressionAlg: string;
  /** size of the plaintext BEFORE encryption (already-compressed bytes count). */
  uncompressedSize: number | bigint;
  /** size of the compressed payload the producer is handed as plaintext. */
  compressedSize: number | bigint;
};

/** Per-request binding: who asked, and the runtime key to seal the DEK to. */
export type LeaseBinding = {
  leaseId: string;
  requestId: string;
  tenantId: string;
  agentId: string;
  agentCertFingerprintSha256: string;
  /** exactly 32 raw X25519 bytes from the (verified) lease request. */
  runtimePublicKey: Buffer;
};

/** Lease lifetime + rollout knobs. All durations in seconds. */
export type LeaseTerms = {
  issuedAt: number | bigint;
  expiresAt: number | bigint;
  leaseTtlSeconds: number | bigint;
  renewAfterSeconds: number | bigint;
  minAgentVersion: string;
  policyVersion: number | bigint;
};

/** Everything the route needs to persist and/or return to the caller. */
export type ProducedPack = {
  /** AEAD ciphertext (Poly1305 tag appended). */
  ciphertext: Buffer;
  /** 24-byte XChaCha nonce (public; carried in the lease). */
  nonce: Buffer;
  /** anonymous sealed box of the DEK to the runtime public key. */
  sealedDek: Buffer;
  /** the fully-populated, self-consistent lease fields. */
  lease: PackLeaseFields;
  /** ES256 DER signature over the canonical lease encoding. */
  leaseSignature: Buffer;
  /** the exact canonical bytes that were signed (for audit/debug). */
  leaseSignedBytes: Buffer;
};

export type PackProducerDeps = {
  keyProtector: PackKeyProtector;
  leaseSigner: PackLeaseSigner;
  /** override for tests; defaults to the shared libsodium instance. */
  sodium?: Sodium;
  /** DEK generator override for tests; defaults to libsodium random. */
  generateDek?: (sodium: Sodium) => Uint8Array;
};

export class PackProducer {
  constructor(private readonly deps: PackProducerDeps) {}

  /**
   * Encrypt a version once: generate a fresh DEK, encrypt the plaintext under
   * it (binding the AAD), and store the DEK keyed by pack_version_id. No sealing
   * happens here — sealing is per-lease (per runtime key), done in issueLease.
   * Splitting the two lets a version be encrypted once and leased many times
   * (default-fallback and per-tenant leases reuse the same ciphertext + DEK).
   */
  async encryptVersion(
    plaintext: Uint8Array,
    aad: PackAADFields,
  ): Promise<{ ciphertext: Buffer; nonce: Buffer; dek: Buffer; ciphertextSha256: Buffer }> {
    const sodium = this.deps.sodium ?? (await sodiumReady());
    const dek = Buffer.from(
      this.deps.generateDek ? this.deps.generateDek(sodium) : sodium.randombytes_buf(DEK_BYTES),
    );
    if (dek.length !== DEK_BYTES) {
      throw new Error(`generated DEK must be ${DEK_BYTES} bytes, got ${dek.length}`);
    }
    const enc = encryptPack(sodium, plaintext, dek, aad);
    await this.deps.keyProtector.putDek(aad.packVersionId, dek);
    return {
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      dek,
      ciphertextSha256: sha256(enc.ciphertext),
    };
  }

  /**
   * Issue a signed lease for an already-encrypted version. Reconstructs the DEK
   * from the protector, seals it to the caller's runtime key, computes all three
   * signed digests, assembles the lease, and signs it.
   *
   * `nonce` and `ciphertext` are the ones produced by encryptVersion for this
   * pack_version_id (the caller persists and passes them back). This keeps the
   * ciphertext stable across many leases of the same version.
   */
  async issueLease(
    content: PackContentMeta,
    binding: LeaseBinding,
    terms: LeaseTerms,
    encrypted: { ciphertext: Buffer; nonce: Buffer },
  ): Promise<ProducedPack> {
    if (binding.runtimePublicKey.length !== 32) {
      throw new Error(
        `runtimePublicKey must be 32 bytes, got ${binding.runtimePublicKey.length}`,
      );
    }
    if (encrypted.nonce.length !== XNONCE_BYTES) {
      throw new Error(`nonce must be ${XNONCE_BYTES} bytes, got ${encrypted.nonce.length}`);
    }

    const sodium = this.deps.sodium ?? (await sodiumReady());
    const dek = await this.deps.keyProtector.getDek(content.packVersionId);

    try {
      const sealedDek = sealDek(sodium, dek, binding.runtimePublicKey);

      const lease: PackLeaseFields = {
        leaseId: binding.leaseId,
        requestId: binding.requestId,
        tenantId: binding.tenantId,
        agentId: binding.agentId,
        agentCertFingerprintSha256: binding.agentCertFingerprintSha256,
        packId: content.packId,
        packVersionId: content.packVersionId,
        packVersion: content.packVersion,
        contentType: content.contentType,
        schemaVersion: content.schemaVersion,
        compressionAlg: content.compressionAlg,
        encryptionAlg: "xchacha20poly1305-ietf",
        packNonce: encrypted.nonce,
        uncompressedSize: content.uncompressedSize,
        compressedSize: content.compressedSize,
        ciphertextSize: encrypted.ciphertext.length,
        ciphertextSha256: sha256(encrypted.ciphertext),
        runtimePublicKeySha256: sha256(binding.runtimePublicKey),
        sealedDekSha256: sha256(sealedDek),
        issuedAt: terms.issuedAt,
        expiresAt: terms.expiresAt,
        leaseTtlSeconds: terms.leaseTtlSeconds,
        renewAfterSeconds: terms.renewAfterSeconds,
        minAgentVersion: terms.minAgentVersion,
        policyVersion: terms.policyVersion,
      };
      const { signature, signedBytes } = await this.deps.leaseSigner.signLease(lease);

      return {
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        sealedDek,
        lease,
        leaseSignature: signature,
        leaseSignedBytes: signedBytes,
      };
    } finally {
      // getDek() returns a request-local copy. Keep plaintext key material in
      // the control-plane process only for the sealing/signing operation and
      // wipe that copy on both success and failure.
      dek.fill(0);
    }
  }
}
