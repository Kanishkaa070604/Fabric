import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicKey, createHash, createVerify } from "node:crypto";
import {
  PackProducer,
  InMemoryPackKeyProtector,
  LocalKeyPackLeaseSigner,
  sodiumReady,
  encodePackLeaseSigningV1,
  type PackAADFields,
} from "../src/packs";
import { CRYPTO_FIXTURE } from "./pack_crypto_fixture";

/**
 * Exercises the assembled PackProducer facade — the integration entry point —
 * and (when SECUREPACK_GEN_VECTORS=1) emits docs/securepack-vectors/producer.json
 * for the Go consumer to verify+open. This proves the one-call producer path
 * yields a lease the Go VerifyAndOpen accepts, with every digest self-consistent.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const producerVectorPath = join(
  __dirname,
  "..",
  "..",
  "docs",
  "securepack-vectors",
  "producer.json",
);

const aad: PackAADFields = CRYPTO_FIXTURE.aadFields;

const content = {
  packVersionId: aad.packVersionId,
  packId: aad.packId,
  packVersion: aad.packVersion,
  contentType: aad.contentType,
  schemaVersion: aad.schemaVersion,
  compressionAlg: aad.compressionAlg,
  uncompressedSize: aad.uncompressedSize,
  compressedSize: aad.compressedSize,
};

const binding = {
  leaseId: "66666666-6666-4666-8666-666666666666",
  requestId: "55555555-5555-4555-8555-555555555555",
  tenantId: "44444444-4444-4444-8444-444444444444",
  agentId: "33333333-3333-4333-8333-333333333333",
  agentCertFingerprintSha256:
    "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  runtimePublicKey: Buffer.from(CRYPTO_FIXTURE.runtimeX25519PublicKeyHex, "hex"),
};

const terms = {
  issuedAt: 1769500000,
  expiresAt: 1769503600,
  leaseTtlSeconds: 3600,
  renewAfterSeconds: 2700,
  minAgentVersion: "1.3.0",
  policyVersion: 42,
};

async function makeProducer(): Promise<PackProducer> {
  const sodium = await sodiumReady();
  return new PackProducer({
    keyProtector: new InMemoryPackKeyProtector(),
    leaseSigner: new LocalKeyPackLeaseSigner({ pkcs8Pem: CRYPTO_FIXTURE.es256PrivateKeyPem }),
    sodium,
    // Deterministic DEK so the emitted vector is stable across runs.
    generateDek: () => Buffer.from(CRYPTO_FIXTURE.dekHex, "hex"),
  });
}

describe("Secure Pack — assembled PackProducer facade", () => {
  it("encryptVersion stores the DEK and produces AAD-bound ciphertext", async () => {
    const producer = await makeProducer();
    const enc = await producer.encryptVersion(
      Buffer.from(CRYPTO_FIXTURE.plaintextUtf8, "utf8"),
      aad,
    );
    assert.equal(enc.dek.toString("hex"), CRYPTO_FIXTURE.dekHex);
    assert.equal(enc.nonce.length, 24);
    assert.equal(
      enc.ciphertextSha256.toString("hex"),
      createHash("sha256").update(enc.ciphertext).digest("hex"),
    );
  });

  it("issueLease wipes the request-local plaintext DEK after sealing", async () => {
    const sodium = await sodiumReady();
    const fetchedDek = Buffer.from(CRYPTO_FIXTURE.dekHex, "hex");
    const producer = new PackProducer({
      keyProtector: {
        async putDek() {},
        async getDek() {
          return fetchedDek;
        },
      },
      leaseSigner: new LocalKeyPackLeaseSigner({
        pkcs8Pem: CRYPTO_FIXTURE.es256PrivateKeyPem,
      }),
      sodium,
    });

    await producer.issueLease(content, binding, terms, {
      ciphertext: Buffer.from("ciphertext-for-zeroization-test"),
      nonce: Buffer.alloc(24, 7),
    });

    assert.equal(fetchedDek.equals(Buffer.alloc(fetchedDek.length)), true);
  });

  it("issueLease yields a self-consistent, correctly-signed lease", async () => {
    const producer = await makeProducer();
    const enc = await producer.encryptVersion(
      Buffer.from(CRYPTO_FIXTURE.plaintextUtf8, "utf8"),
      aad,
    );
    const out = await producer.issueLease(content, binding, terms, {
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
    });

    // Digests inside the lease bind the exact bytes the producer emitted.
    assert.equal(
      out.lease.ciphertextSha256.toString("hex"),
      createHash("sha256").update(out.ciphertext).digest("hex"),
    );
    assert.equal(
      out.lease.runtimePublicKeySha256.toString("hex"),
      createHash("sha256").update(binding.runtimePublicKey).digest("hex"),
    );
    assert.equal(
      out.lease.sealedDekSha256.toString("hex"),
      createHash("sha256").update(out.sealedDek).digest("hex"),
    );
    assert.equal(out.lease.ciphertextSize, out.ciphertext.length);

    // signedBytes are the canonical encoding of the assembled lease (no drift).
    assert.equal(
      out.leaseSignedBytes.toString("hex"),
      encodePackLeaseSigningV1(out.lease).toString("hex"),
    );

    if (process.env.SECUREPACK_GEN_VECTORS) {
      const signer = new LocalKeyPackLeaseSigner({
        pkcs8Pem: CRYPTO_FIXTURE.es256PrivateKeyPem,
      });
      const spki = await signer.publicKeySpkiDer();
      const vec = {
        note:
          "Frozen PackProducer output. TS assembled producer -> Go lease.VerifyAndOpen. " +
          "Proves the one-call facade yields a lease the consumer accepts.",
        es256_public_key_spki_der_hex: spki.toString("hex"),
        runtime_x25519_public_key_hex: CRYPTO_FIXTURE.runtimeX25519PublicKeyHex,
        runtime_x25519_private_key_hex: CRYPTO_FIXTURE.runtimeX25519PrivateKeyHex,
        request_id: binding.requestId,
        sealed_dek_hex: out.sealedDek.toString("hex"),
        ciphertext_hex: out.ciphertext.toString("hex"),
        pack_nonce_hex: out.nonce.toString("hex"),
        lease_signed_bytes_hex: out.leaseSignedBytes.toString("hex"),
        lease_signature_der_hex: out.leaseSignature.toString("hex"),
      };
      writeFileSync(producerVectorPath, JSON.stringify(vec, null, 2) + "\n");
    }

    // Local sanity: the emitted signature verifies with the fixed signer key.
    const spki = await new LocalKeyPackLeaseSigner({
      pkcs8Pem: CRYPTO_FIXTURE.es256PrivateKeyPem,
    }).publicKeySpkiDer();
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    const verifier = createVerify("SHA256");
    verifier.update(out.leaseSignedBytes);
    verifier.end();
    assert.equal(
      verifier.verify({ key: pub, dsaEncoding: "der" }, out.leaseSignature),
      true,
    );
  });
});
