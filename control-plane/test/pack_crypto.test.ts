import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPrivateKey, createPublicKey, createVerify } from "node:crypto";
import { sodiumReady, sealDek, encryptPack } from "../src/packs/seal";
import { signLease } from "../src/packs/leaseSign";
import { encodePackLeaseSigningV1 } from "../src/packs/protocol";
import { CRYPTO_FIXTURE } from "./pack_crypto_fixture";

/**
 * Producer-side assertions against the frozen crypto vectors. The Go cryptobox
 * suite proves the CONSUMER opens/verifies these; this proves the PRODUCER is
 * self-consistent and still emits what the committed vectors describe.
 *
 * These are normal tests (not the generator) — they run in the default suite.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const cryptoVectorPath = join(
  __dirname,
  "..",
  "..",
  "docs",
  "securepack-vectors",
  "crypto.json",
);

type CryptoVectors = {
  dek_hex: string;
  runtime_x25519_public_key_hex: string;
  runtime_x25519_private_key_hex: string;
  sealed_dek_hex: string;
  pack_nonce_hex: string;
  plaintext_utf8: string;
  aad_hex: string;
  ciphertext_hex: string;
  es256_public_key_spki_der_hex: string;
  lease_signed_bytes_hex: string;
  lease_signature_der_hex: string;
};

describe("Secure Pack crypto — producer self-consistency", () => {
  const v: CryptoVectors = JSON.parse(readFileSync(cryptoVectorPath, "utf8"));

  it("re-encrypting the fixture reproduces the frozen ciphertext and AAD", async () => {
    const sodium = await sodiumReady();
    const enc = encryptPack(
      sodium,
      Buffer.from(v.plaintext_utf8, "utf8"),
      Buffer.from(v.dek_hex, "hex"),
      CRYPTO_FIXTURE.aadFields,
      Buffer.from(v.pack_nonce_hex, "hex"),
    );
    // AEAD with a fixed nonce + key + AAD is deterministic.
    assert.equal(enc.aad.toString("hex"), v.aad_hex);
    assert.equal(enc.ciphertext.toString("hex"), v.ciphertext_hex);
  });

  it("sealed DEK round-trips: our seal opens to the same DEK (via crypto_box_seal_open)", async () => {
    const sodium = await sodiumReady();
    // Re-seal (random ephemeral => new bytes) then open with the fixed priv key.
    const resealed = sealDek(
      sodium,
      Buffer.from(v.dek_hex, "hex"),
      Buffer.from(v.runtime_x25519_public_key_hex, "hex"),
    );
    const opened = sodium.crypto_box_seal_open(
      resealed,
      Buffer.from(v.runtime_x25519_public_key_hex, "hex"),
      Buffer.from(v.runtime_x25519_private_key_hex, "hex"),
    );
    assert.equal(Buffer.from(opened).toString("hex"), v.dek_hex);
    // Also confirm the committed sealed blob opens to the DEK.
    const openedCommitted = sodium.crypto_box_seal_open(
      Buffer.from(v.sealed_dek_hex, "hex"),
      Buffer.from(v.runtime_x25519_public_key_hex, "hex"),
      Buffer.from(v.runtime_x25519_private_key_hex, "hex"),
    );
    assert.equal(Buffer.from(openedCommitted).toString("hex"), v.dek_hex);
  });

  it("signed lease bytes equal the canonical encoder output (crypto ↔ encoder vector consistency)", () => {
    const signedBytes = encodePackLeaseSigningV1(CRYPTO_FIXTURE.leaseFields);
    assert.equal(signedBytes.toString("hex"), v.lease_signed_bytes_hex);
  });

  it("the committed ES256 signature verifies with the committed public key", () => {
    const ecPriv = createPrivateKey(CRYPTO_FIXTURE.es256PrivateKeyPem);
    const derivedPub = createPublicKey(ecPriv).export({ type: "spki", format: "der" });
    // The PEM's public half matches the committed SPKI vector.
    assert.equal(Buffer.from(derivedPub).toString("hex"), v.es256_public_key_spki_der_hex);

    const pubKey = createPublicKey({
      key: Buffer.from(v.es256_public_key_spki_der_hex, "hex"),
      format: "der",
      type: "spki",
    });
    const verifier = createVerify("SHA256");
    verifier.update(Buffer.from(v.lease_signed_bytes_hex, "hex"));
    verifier.end();
    const ok = verifier.verify(
      { key: pubKey, dsaEncoding: "der" },
      Buffer.from(v.lease_signature_der_hex, "hex"),
    );
    assert.equal(ok, true);
  });

  it("re-signing produces a signature that also verifies (ECDSA is randomized)", () => {
    const ecPriv = createPrivateKey(CRYPTO_FIXTURE.es256PrivateKeyPem);
    const { signature, signedBytes } = signLease(ecPriv, CRYPTO_FIXTURE.leaseFields);
    const pubKey = createPublicKey(ecPriv);
    const verifier = createVerify("SHA256");
    verifier.update(signedBytes);
    verifier.end();
    assert.equal(verifier.verify({ key: pubKey, dsaEncoding: "der" }, signature), true);
  });
});
