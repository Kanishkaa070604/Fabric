import type { PackAADFields, PackLeaseFields } from "../src/packs/protocol";

/**
 * Shared, frozen inputs for the cross-language CRYPTO interop vectors (task #6).
 *
 * Unlike the encoder fixtures (which use synthetic 0x00.. ramps), the crypto
 * path needs REAL keys so sealing/opening and signing/verifying actually round
 * trip. These values are fixed forever: the committed docs/securepack-vectors/
 * crypto.json is generated from them, and the Go cryptobox suite pins to it.
 *
 * The X25519 keypair and the ES256 PEM below are throwaway test keys generated
 * once for this vector — never used for anything real. They live in the repo on
 * purpose so the interop test is reproducible without a keygen step.
 */

// Fixed ephemeral runtime X25519 keypair (the consumer's per-request pair).
export const RUNTIME_X25519_PUBLIC_KEY_HEX =
  "5fa4cc1c0aac267e44b3d5f5e75c9c406246f6e7f45e54768abda7f932c28211";
export const RUNTIME_X25519_PRIVATE_KEY_HEX =
  "074befba70b2999046b9f589bd0839c1ead403367811dce0abc645bc9341f66e";

// Fixed DEK (32 bytes) and XChaCha nonce (24 bytes) for the pack AEAD.
export const DEK_HEX =
  "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f";
export const PACK_NONCE_HEX = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";

// Fixed pack plaintext (stands in for compressed YAML rules).
export const PLAINTEXT_UTF8 =
  "rules:\n  - id: allow-egress-443\n    action: allow\n    port: 443\n";

// Throwaway ES256 (P-256) private key, PKCS#8 PEM. Test-only.
export const ES256_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwtBF+b+g2vYDIbWs
x64jJbsvWdfDOxaSDgafVAlu0HShRANCAATRimBpNXXHhOyNXpb3OymIOSc9cIQx
/hn3ZbUG2sxkWSSpevAk679qukpcBIlw+cYWOgymS2MUv6GeYyWhx3x8
-----END PRIVATE KEY-----
`;

// AAD fields mirror the encoder fixtures (same content identity).
export const AAD_FIELDS: PackAADFields = {
  packVersionId: "11111111-1111-4111-8111-111111111111",
  packId: "22222222-2222-4222-8222-222222222222",
  packVersion: 7,
  contentType: "application/vnd.fabric.pack.rules+yaml",
  schemaVersion: "fabric.rules/v1",
  compressionAlg: "zstd",
  uncompressedSize: 8192,
  compressedSize: 2048,
};

// Lease fields mirror the encoder fixtures.
export const LEASE_FIELDS: PackLeaseFields = {
  leaseId: "66666666-6666-4666-8666-666666666666",
  requestId: "55555555-5555-4555-8555-555555555555",
  tenantId: "44444444-4444-4444-8444-444444444444",
  agentId: "33333333-3333-4333-8333-333333333333",
  agentCertFingerprintSha256:
    "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  packId: "22222222-2222-4222-8222-222222222222",
  packVersionId: "11111111-1111-4111-8111-111111111111",
  packVersion: 7,
  contentType: "application/vnd.fabric.pack.rules+yaml",
  schemaVersion: "fabric.rules/v1",
  compressionAlg: "zstd",
  encryptionAlg: "xchacha20poly1305-ietf",
  packNonce: Buffer.from(PACK_NONCE_HEX, "hex"),
  uncompressedSize: 8192,
  compressedSize: 2048,
  ciphertextSize: 2064,
  ciphertextSha256: Buffer.alloc(32, 0xc0),
  runtimePublicKeySha256: Buffer.alloc(32, 0xd0),
  sealedDekSha256: Buffer.alloc(32, 0xe0),
  issuedAt: 1769500000,
  expiresAt: 1769503600,
  leaseTtlSeconds: 3600,
  renewAfterSeconds: 2700,
  minAgentVersion: "1.3.0",
  policyVersion: 42,
};

export const CRYPTO_FIXTURE = {
  runtimeX25519PublicKeyHex: RUNTIME_X25519_PUBLIC_KEY_HEX,
  runtimeX25519PrivateKeyHex: RUNTIME_X25519_PRIVATE_KEY_HEX,
  dekHex: DEK_HEX,
  packNonceHex: PACK_NONCE_HEX,
  plaintextUtf8: PLAINTEXT_UTF8,
  es256PrivateKeyPem: ES256_PRIVATE_KEY_PEM,
  aadFields: AAD_FIELDS,
  leaseFields: LEASE_FIELDS,
};
