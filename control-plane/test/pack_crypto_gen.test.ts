import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { sodiumReady, sealDek, encryptPack } from "../src/packs/seal";
import { signLease } from "../src/packs/leaseSign";
import { CRYPTO_FIXTURE } from "./pack_crypto_fixture";

/**
 * One-shot generator for the cross-language CRYPTO vectors (task #6). Run with
 *
 *   SECUREPACK_GEN_VECTORS=1 npx tsx --test test/pack_crypto_gen.test.ts
 *
 * It writes docs/securepack-vectors/crypto.json — the frozen artifact the Go
 * cryptobox suite opens/decrypts/verifies against. This proves the actual
 * primitives interoperate (libsodium seal/AEAD + Node ES256 → x/crypto), not
 * just the byte framing.
 *
 * The producer is the source of truth here: TS seals and signs, Go only opens
 * and verifies (the boundary is one-directional). Skipped unless the env var is
 * set — regenerating changes the frozen contract.
 *
 * Note: crypto_box_seal uses a random ephemeral key, so the sealed-DEK bytes
 * differ every run; that's fine — Go asserts the sealed bytes OPEN to the fixed
 * DEK, not that they equal a fixed blob.
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

describe("Secure Pack crypto vectors — generator", () => {
  it("writes crypto.json (skipped unless SECUREPACK_GEN_VECTORS=1)", async () => {
    if (!process.env.SECUREPACK_GEN_VECTORS) {
      return; // skip: generation only on demand
    }
    const sodium = await sodiumReady();

    const dek = Buffer.from(CRYPTO_FIXTURE.dekHex, "hex");
    const runtimePub = Buffer.from(CRYPTO_FIXTURE.runtimeX25519PublicKeyHex, "hex");
    const nonce = Buffer.from(CRYPTO_FIXTURE.packNonceHex, "hex");
    const plaintext = Buffer.from(CRYPTO_FIXTURE.plaintextUtf8, "utf8");

    const sealed = sealDek(sodium, dek, runtimePub);
    const enc = encryptPack(sodium, plaintext, dek, CRYPTO_FIXTURE.aadFields, nonce);

    const ecPriv = createPrivateKey(CRYPTO_FIXTURE.es256PrivateKeyPem);
    const ecPubSpki = createPublicKey(ecPriv)
      .export({ type: "spki", format: "der" });
    const { signature, signedBytes } = signLease(ecPriv, CRYPTO_FIXTURE.leaseFields);

    const out = {
      note:
        "Frozen cross-language CRYPTO vectors. TS producer sealed/encrypted/" +
        "signed; Go consumer (securepack-lease/cryptobox) opens/decrypts/verifies. " +
        "sealed_dek_hex is non-deterministic (random ephemeral) — Go asserts it " +
        "OPENS to dek_hex, not equality. See docs/Fabric_Secure_Pack_Canonical_Encoding_v1.md.",
      dek_hex: CRYPTO_FIXTURE.dekHex,
      runtime_x25519_public_key_hex: CRYPTO_FIXTURE.runtimeX25519PublicKeyHex,
      runtime_x25519_private_key_hex: CRYPTO_FIXTURE.runtimeX25519PrivateKeyHex,
      sealed_dek_hex: sealed.toString("hex"),
      pack_nonce_hex: nonce.toString("hex"),
      plaintext_utf8: CRYPTO_FIXTURE.plaintextUtf8,
      aad_hex: enc.aad.toString("hex"),
      ciphertext_hex: enc.ciphertext.toString("hex"),
      es256_public_key_spki_der_hex: Buffer.from(ecPubSpki).toString("hex"),
      lease_signed_bytes_hex: signedBytes.toString("hex"),
      lease_signature_der_hex: signature.toString("hex"),
    };

    writeFileSync(cryptoVectorPath, JSON.stringify(out, null, 2) + "\n");
    assert.ok(sealed.length > 32, "sealed DEK should be ephemeral_pk + box");
  });
});
