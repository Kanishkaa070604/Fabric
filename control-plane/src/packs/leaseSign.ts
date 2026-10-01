/**
 * Secure Pack producer-side ES256 lease signing.
 *
 * The control plane signs the canonical PackLeaseSigningV1 bytes with an
 * ECDSA P-256 key (ES256). The Go consumer verifies with the pinned vendor
 * public key via ecdsa.VerifyASN1. Node's crypto.sign for an EC key emits an
 * ASN.1 DER signature by default (dsaEncoding "der"), which is exactly what
 * VerifyASN1 expects — no IEEE-P1363 conversion needed on either side.
 *
 * SHA-256 is the digest (the "256" in ES256). We hash the canonical bytes and
 * sign; Go re-derives the same canonical bytes and verifies over their SHA-256.
 */

import { createSign, type KeyObject } from "node:crypto";
import { encodePackLeaseSigningV1, type PackLeaseFields } from "./protocol";

/**
 * Sign a lease. Returns the ASN.1 DER ECDSA signature over SHA-256 of the
 * canonical PackLeaseSigningV1 encoding, plus the exact signed bytes (useful
 * for tests and for pinning what was covered).
 */
export function signLease(
  privateKey: KeyObject,
  fields: PackLeaseFields,
): { signature: Buffer; signedBytes: Buffer } {
  const signedBytes = encodePackLeaseSigningV1(fields);
  const signer = createSign("SHA256");
  signer.update(signedBytes);
  signer.end();
  // dsaEncoding "der" is the default for EC keys but we set it explicitly so a
  // future Node default change can't silently switch us to P1363 and break Go.
  const signature = signer.sign({ key: privateKey, dsaEncoding: "der" });
  return { signature, signedBytes };
}
