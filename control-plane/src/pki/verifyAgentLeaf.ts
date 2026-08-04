import { createHash, createVerify, X509Certificate } from "crypto";

export type AgentPopInput = {
  certificatePem: string;
  caCertPem: string;
  agentId: string;
  signedAt: number;
  signatureB64: string;
  /** Max clock skew for signed_at (default 300s). */
  maxSkewSeconds?: number;
};

/**
 * G-CRED-1 / L3-CRED-01: prove possession of an Agent leaf without CP mTLS.
 * Message is `${agentId}\n${signedAt}` (unix seconds), RSA-SHA256, PKCS#1 v1.5.
 */
export function verifyAgentLeafPop(input: AgentPopInput): {
  fingerprintSha256: string;
} {
  const skew = input.maxSkewSeconds ?? 300;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(input.signedAt) || Math.abs(now - input.signedAt) > skew) {
    throw new Error("pop_signed_at_skew");
  }
  let leaf: X509Certificate;
  let ca: X509Certificate;
  try {
    leaf = new X509Certificate(input.certificatePem);
    ca = new X509Certificate(input.caCertPem);
  } catch {
    throw new Error("invalid_certificate_pem");
  }
  if (!leaf.checkIssued(ca)) {
    throw new Error("leaf_not_issued_by_agent_ca");
  }
  const notAfter = new Date(leaf.validTo).getTime();
  if (notAfter < Date.now()) {
    throw new Error("leaf_expired");
  }
  const msg = `${input.agentId}\n${input.signedAt}`;
  const verify = createVerify("SHA256");
  verify.update(msg);
  verify.end();
  let sig: Buffer;
  try {
    sig = Buffer.from(input.signatureB64, "base64");
  } catch {
    throw new Error("invalid_signature_b64");
  }
  if (!verify.verify(leaf.publicKey, sig)) {
    throw new Error("pop_signature_invalid");
  }
  const fingerprintSha256 = createHash("sha256").update(leaf.raw).digest("hex");
  return { fingerprintSha256 };
}
