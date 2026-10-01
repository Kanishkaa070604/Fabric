/**
 * Secure Pack producer-side crypto — the sealing half of the one-directional
 * boundary (TS produces, Go consumes; never the reverse).
 *
 * Two operations, both using libsodium primitives that have exact
 * counterparts in Go's golang.org/x/crypto:
 *
 *   1. sealDek  — anonymous X25519 seal (crypto_box_seal) of a 32-byte DEK to
 *      the runtime's X25519 public key. Only the holder of the runtime private
 *      key can open it. Go opens with nacl/box.OpenAnonymous.
 *
 *   2. encryptPack — XChaCha20-Poly1305-ietf AEAD of the pack bytes under the
 *      DEK, binding the canonical PackAADV1 as associated data. Go opens with
 *      chacha20poly1305.NewX + Open, passing the same AAD.
 *
 * There is deliberately no open/decrypt here: the producer never consumes.
 */

import _sodium from "libsodium-wrappers";
import { encodePackAADV1, type PackAADFields } from "./protocol";

export type Sodium = typeof _sodium;

let readyPromise: Promise<Sodium> | null = null;

/**
 * Resolve the initialized libsodium instance. Idempotent and concurrency-safe:
 * concurrent callers share one init promise. If init rejects, the cached
 * promise is cleared so a later call can retry rather than being stuck with a
 * permanently-rejected promise.
 */
export async function sodiumReady(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = _sodium.ready
      .then(() => _sodium)
      .catch((err) => {
        readyPromise = null; // allow retry on next call
        throw err;
      });
  }
  return readyPromise;
}

export const DEK_BYTES = 32; // XChaCha20-Poly1305 key length
export const XNONCE_BYTES = 24; // XChaCha20-Poly1305-ietf nonce length

/**
 * Seal a raw 32-byte DEK to the runtime's X25519 public key using an anonymous
 * sealed box. Output layout is libsodium's: ephemeral_pk(32) ‖ box, which is
 * exactly what Go's box.SealAnonymous produces and box.OpenAnonymous expects.
 */
export function sealDek(
  sodium: Sodium,
  dek: Uint8Array,
  runtimeX25519PublicKey: Uint8Array,
): Buffer {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  if (runtimeX25519PublicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error(
      `runtime public key must be ${sodium.crypto_box_PUBLICKEYBYTES} bytes, got ${runtimeX25519PublicKey.length}`,
    );
  }
  const sealed = sodium.crypto_box_seal(dek, runtimeX25519PublicKey);
  return Buffer.from(sealed);
}

export type EncryptedPack = {
  /** XChaCha20-Poly1305-ietf ciphertext, Poly1305 tag appended (libsodium layout). */
  ciphertext: Buffer;
  /** 24-byte nonce used for this encryption; public, carried in the lease. */
  nonce: Buffer;
  /** The exact AAD bytes bound into the AEAD (canonical PackAADV1). */
  aad: Buffer;
};

/**
 * Encrypt pack bytes with XChaCha20-Poly1305-ietf under `dek`, binding the
 * canonical PackAADV1 as associated data. If `nonce` is omitted a random one is
 * generated; a fixed nonce is accepted so tests can pin a vector.
 */
export function encryptPack(
  sodium: Sodium,
  plaintext: Uint8Array,
  dek: Uint8Array,
  aadFields: PackAADFields,
  nonce?: Uint8Array,
): EncryptedPack {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`dek must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  const n = nonce ?? sodium.randombytes_buf(XNONCE_BYTES);
  if (n.length !== XNONCE_BYTES) {
    throw new Error(`nonce must be ${XNONCE_BYTES} bytes, got ${n.length}`);
  }
  const aad = encodePackAADV1(aadFields);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null, // no secret nonce
    n,
    dek,
  );
  return {
    ciphertext: Buffer.from(ciphertext),
    nonce: Buffer.from(n),
    aad: Buffer.from(aad),
  };
}
