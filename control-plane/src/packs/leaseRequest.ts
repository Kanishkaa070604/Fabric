/**
 * Pack lease-request verification — the pack route's message builder.
 *
 * The Agent signs the canonical PackLeaseRequestSigningV1 bytes with its
 * existing RSA leaf private key (spec §4.2). This module reconstructs those
 * exact bytes and verifies the signature by COMPOSING the shared leaf verifier
 * primitives (verifyAgentCertificate + verifyLeafMessageSignature +
 * assertSignedAtFresh). It deliberately does NOT re-derive chain validation,
 * validity windows, or agent binding — DR-7 forbids a second verifier, and the
 * shared primitive is the single place "is this a genuine Fabric leaf?" is
 * answered.
 *
 * Binding the resulting fingerprint to an agent_id is the caller's job (store
 * state, not PKI), exactly as with the api-token/current and rotate routes.
 */

import {
  verifyAgentCertificate,
  verifyLeafMessageSignature,
  assertSignedAtFresh,
  type VerifiedAgentCertificate,
} from "../pki/verifyAgentLeaf";
import {
  encodePackLeaseRequestSigningV1,
  type PackLeaseRequestFields,
} from "./protocol";

export type VerifyLeaseRequestInput = {
  /** The canonical fields the Agent signed. runtimePublicKey must be 32 bytes. */
  fields: PackLeaseRequestFields;
  /** Agent leaf presented in the request. */
  certificatePem: string;
  /** Agent CA trust anchor. */
  caCertPem: string;
  /** base64 RSA-SHA256 signature over PackLeaseRequestSigningV1. */
  signatureB64: string;
  /** Overrides for tests / operator-tuned skew. */
  now?: Date;
  maxSkewSeconds?: number;
};

/**
 * Verify a pack lease request end to end, in the only safe order:
 * freshness → CA verification + validity window → request-signature over the
 * canonical bytes. Throws AgentCertificateError (with a stable reason code) on
 * any failure; returns the verified certificate + its fingerprint on success.
 *
 * The signed_at freshness check uses the SAME field the canonical encoding
 * covers (fields.signedAt), so a request cannot present one signed_at to the
 * skew check and a different one inside the signature.
 */
export function verifyPackLeaseRequest(
  input: VerifyLeaseRequestInput,
): { fingerprintSha256: string; certificate: VerifiedAgentCertificate } {
  // signedAt is a u64 in the canonical fields; the freshness primitive works in
  // seconds as a number. Values beyond 2^53 are not realistic unix seconds and
  // will simply fail the skew check.
  assertSignedAtFresh(Number(input.fields.signedAt), {
    now: input.now,
    maxSkewSeconds: input.maxSkewSeconds,
  });

  const certificate = verifyAgentCertificate({
    certificatePem: input.certificatePem,
    caCertPem: input.caCertPem,
    now: input.now,
  });

  // Reconstruct the exact bytes the Agent signed and verify over them. Any
  // divergence between what we rebuild and what was signed fails here — the
  // encoder is the single source of truth on both sides.
  const signingBytes = encodePackLeaseRequestSigningV1(input.fields);
  verifyLeafMessageSignature(certificate, signingBytes, input.signatureB64);

  return {
    fingerprintSha256: certificate.fingerprintSha256,
    certificate,
  };
}
