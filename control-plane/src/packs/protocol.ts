/**
 * Canonical encoders for the Secure Pack protocol — producer (TypeScript) side.
 *
 * These MUST produce byte-identical output to the Go consumer's encoders
 * (`securepack-lease/protocol`). The wire contract is
 * `docs/Fabric_Secure_Pack_Canonical_Encoding_v1.md`; shared test vectors in
 * `docs/securepack-vectors/` pin both languages to the same hex.
 *
 * Framing (see the doc for the full rationale):
 *   - length-prefixed, big-endian, no delimiters, domain-separated;
 *   - string: uint32BE(len) ‖ utf8;  bytes: uint32BE(len) ‖ raw;  u64: 8 bytes BE, no prefix;
 *   - fields emitted in a fixed order; no JSON, no map, no sorting.
 *
 * These are write-only inputs to a hash-then-sign / hash-then-AEAD step. There
 * is deliberately no decoder — nothing ever parses these bytes back.
 */

const MAX_FIELD_LEN = 0xffffffff;

/** Accumulates canonical bytes. One instance per encoding. */
class CanonicalWriter {
  private readonly chunks: Buffer[] = [];

  string(s: string): this {
    const b = Buffer.from(s, "utf8");
    return this.lengthPrefixed(b);
  }

  bytes(b: Buffer): this {
    return this.lengthPrefixed(b);
  }

  /** Fixed-width 8-byte big-endian unsigned. No length prefix (width is constant). */
  u64(n: number | bigint): this {
    const v = typeof n === "bigint" ? n : BigInt(n);
    if (v < 0n || v > 0xffffffffffffffffn) {
      throw new Error(`u64 out of range: ${v}`);
    }
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(v);
    this.chunks.push(buf);
    return this;
  }

  private lengthPrefixed(b: Buffer): this {
    if (b.length > MAX_FIELD_LEN) {
      throw new Error(`field too long to encode: ${b.length} bytes`);
    }
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    this.chunks.push(len, b);
    return this;
  }

  done(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// Domain-separation tags. Distinct first field makes the three encodings
// mutually unambiguous. Do not reuse or edit — a change is a new version.
const TAG_AAD = "fabric.pack.aad.v1";
const TAG_LEASE_REQUEST = "fabric.pack.lease.request.v1";
const TAG_LEASE = "fabric.pack.lease.v1";

/** Assert a buffer is exactly `n` bytes (runtime keys, nonces, digests). */
function assertLen(name: string, b: Buffer, n: number): Buffer {
  if (b.length !== n) {
    throw new Error(`${name} must be exactly ${n} bytes, got ${b.length}`);
  }
  return b;
}

// ---------------------------------------------------------------------------
// PackAADV1 (§2 of the encoding doc)
// ---------------------------------------------------------------------------

export type PackAADFields = {
  packVersionId: string;
  packId: string;
  packVersion: number | bigint;
  contentType: string;
  schemaVersion: string;
  compressionAlg: string;
  uncompressedSize: number | bigint;
  compressedSize: number | bigint;
};

export function encodePackAADV1(f: PackAADFields): Buffer {
  return new CanonicalWriter()
    .string(TAG_AAD)
    .string(f.packVersionId)
    .string(f.packId)
    .u64(f.packVersion)
    .string(f.contentType)
    .string(f.schemaVersion)
    .string(f.compressionAlg)
    .u64(f.uncompressedSize)
    .u64(f.compressedSize)
    .done();
}

// ---------------------------------------------------------------------------
// PackLeaseRequestSigningV1 (§3)
// ---------------------------------------------------------------------------

export type PackLeaseRequestFields = {
  agentId: string;
  tenantId: string;
  requestId: string;
  packId: string;
  agentVersion: string;
  signedAt: number | bigint;
  /** exactly 32 raw X25519 bytes (not base64) */
  runtimePublicKey: Buffer;
};

export function encodePackLeaseRequestSigningV1(f: PackLeaseRequestFields): Buffer {
  return new CanonicalWriter()
    .string(TAG_LEASE_REQUEST)
    .string(f.agentId)
    .string(f.tenantId)
    .string(f.requestId)
    .string(f.packId)
    .string(f.agentVersion)
    .u64(f.signedAt)
    .bytes(assertLen("runtime_public_key", f.runtimePublicKey, 32))
    .done();
}

// ---------------------------------------------------------------------------
// PackLeaseSigningV1 (§4)
// ---------------------------------------------------------------------------

export type PackLeaseFields = {
  leaseId: string;
  requestId: string;
  tenantId: string;
  agentId: string;
  /** hex string, signed as-is (see doc §4 note) */
  agentCertFingerprintSha256: string;
  packId: string;
  packVersionId: string;
  packVersion: number | bigint;
  contentType: string;
  schemaVersion: string;
  compressionAlg: string;
  encryptionAlg: string;
  /** 24 raw XChaCha nonce bytes */
  packNonce: Buffer;
  uncompressedSize: number | bigint;
  compressedSize: number | bigint;
  ciphertextSize: number | bigint;
  /** 32 raw digest bytes */
  ciphertextSha256: Buffer;
  /** 32 raw digest bytes */
  runtimePublicKeySha256: Buffer;
  /** 32 raw digest bytes */
  sealedDekSha256: Buffer;
  issuedAt: number | bigint;
  expiresAt: number | bigint;
  leaseTtlSeconds: number | bigint;
  renewAfterSeconds: number | bigint;
  minAgentVersion: string;
  policyVersion: number | bigint;
};

export function encodePackLeaseSigningV1(f: PackLeaseFields): Buffer {
  return new CanonicalWriter()
    .string(TAG_LEASE)
    .string(f.leaseId)
    .string(f.requestId)
    .string(f.tenantId)
    .string(f.agentId)
    .string(f.agentCertFingerprintSha256)
    .string(f.packId)
    .string(f.packVersionId)
    .u64(f.packVersion)
    .string(f.contentType)
    .string(f.schemaVersion)
    .string(f.compressionAlg)
    .string(f.encryptionAlg)
    .bytes(assertLen("pack_nonce", f.packNonce, 24))
    .u64(f.uncompressedSize)
    .u64(f.compressedSize)
    .u64(f.ciphertextSize)
    .bytes(assertLen("ciphertext_sha256", f.ciphertextSha256, 32))
    .bytes(assertLen("runtime_public_key_sha256", f.runtimePublicKeySha256, 32))
    .bytes(assertLen("sealed_dek_sha256", f.sealedDekSha256, 32))
    .u64(f.issuedAt)
    .u64(f.expiresAt)
    .u64(f.leaseTtlSeconds)
    .u64(f.renewAfterSeconds)
    .string(f.minAgentVersion)
    .u64(f.policyVersion)
    .done();
}
