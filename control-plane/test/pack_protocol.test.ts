import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  encodePackAADV1,
  encodePackLeaseRequestSigningV1,
  encodePackLeaseSigningV1,
  type PackAADFields,
  type PackLeaseRequestFields,
  type PackLeaseFields,
} from "../src/packs/protocol";

/**
 * Cross-language interop guarantee. This suite reads the SAME frozen vector
 * file the Go suite asserts against (docs/securepack-vectors/encoders.json),
 * builds byte-for-byte identical fixtures, and checks the TS encoders produce
 * exactly the committed hex. If Go and TS ever diverge, one side fails here.
 *
 * The fixtures below MUST mirror securepack-lease/protocol/vectors_test.go
 * exactly. Any change is a wire-contract change: update both sides + regen.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorPath = join(
  __dirname,
  "..",
  "..",
  "docs",
  "securepack-vectors",
  "encoders.json",
);

type VectorFile = {
  note: string;
  pack_aad_v1: string;
  pack_lease_request_signing_v1: string;
  pack_lease_signing_v1: string;
};

// --- Shared deterministic fixtures (mirror of the Go fixtures) --------------

const repeatByte = (b: number, n: number): Buffer => Buffer.alloc(n, b);
const rampBytes = (n: number): Buffer =>
  Buffer.from(Array.from({ length: n }, (_, i) => i & 0xff));

const fxRuntimePublicKey = rampBytes(32); // 0x00..0x1f
const fxPackNonce = repeatByte(0xa0, 24);
const fxCiphertextSha256 = repeatByte(0xc0, 32);
const fxRuntimePublicKeySha256 = repeatByte(0xd0, 32);
const fxSealedDekSha256 = repeatByte(0xe0, 32);

const sampleAAD: PackAADFields = {
  packVersionId: "11111111-1111-4111-8111-111111111111",
  packId: "22222222-2222-4222-8222-222222222222",
  packVersion: 7,
  contentType: "application/vnd.fabric.pack.rules+yaml",
  schemaVersion: "fabric.rules/v1",
  compressionAlg: "zstd",
  uncompressedSize: 8192,
  compressedSize: 2048,
};

const sampleRequest: PackLeaseRequestFields = {
  agentId: "33333333-3333-4333-8333-333333333333",
  tenantId: "44444444-4444-4444-8444-444444444444",
  requestId: "55555555-5555-4555-8555-555555555555",
  packId: "22222222-2222-4222-8222-222222222222",
  agentVersion: "1.4.0",
  signedAt: 1769500000,
  runtimePublicKey: fxRuntimePublicKey,
};

const sampleLease: PackLeaseFields = {
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
  packNonce: fxPackNonce,
  uncompressedSize: 8192,
  compressedSize: 2048,
  ciphertextSize: 2064,
  ciphertextSha256: fxCiphertextSha256,
  runtimePublicKeySha256: fxRuntimePublicKeySha256,
  sealedDekSha256: fxSealedDekSha256,
  issuedAt: 1769500000,
  expiresAt: 1769503600,
  leaseTtlSeconds: 3600,
  renewAfterSeconds: 2700,
  minAgentVersion: "1.3.0",
  policyVersion: 42,
};

describe("Secure Pack canonical encoders — cross-language interop", () => {
  const vectors: VectorFile = JSON.parse(readFileSync(vectorPath, "utf8"));

  it("PackAADV1 matches the frozen vector (Go ↔ TS)", () => {
    assert.ok(vectors.pack_aad_v1, "vector missing — regenerate from Go");
    assert.equal(
      encodePackAADV1(sampleAAD).toString("hex"),
      vectors.pack_aad_v1,
    );
  });

  it("PackLeaseRequestSigningV1 matches the frozen vector (Go ↔ TS)", () => {
    assert.ok(vectors.pack_lease_request_signing_v1, "vector missing — regenerate from Go");
    assert.equal(
      encodePackLeaseRequestSigningV1(sampleRequest).toString("hex"),
      vectors.pack_lease_request_signing_v1,
    );
  });

  it("PackLeaseSigningV1 matches the frozen vector (Go ↔ TS)", () => {
    assert.ok(vectors.pack_lease_signing_v1, "vector missing — regenerate from Go");
    assert.equal(
      encodePackLeaseSigningV1(sampleLease).toString("hex"),
      vectors.pack_lease_signing_v1,
    );
  });
});
