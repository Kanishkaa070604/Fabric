import { createHash, createVerify, KeyObject, X509Certificate } from "crypto";

/**
 * Stable, distinct failure codes for Agent leaf verification.
 *
 * Every check gets its own code on purpose. These strings reach the HTTP
 * error body and the structured log line, so a 403 in production says
 * *which* check rejected the caller without needing a debugger. Do not
 * collapse them into a generic "unauthorized" -- telling
 * `leaf_signature_invalid` (someone presented a cert this CA did not sign)
 * apart from `cert_not_bound_to_agent` (a real Agent leaf pointed at the
 * wrong agent_id) apart from `leaf_not_yet_valid` (clock skew between CP
 * replicas) is the difference between a five-minute and a five-hour
 * diagnosis.
 */
export type AgentCertFailure =
  | "invalid_certificate_pem"
  | "invalid_ca_pem"
  | "leaf_issuer_metadata_mismatch"
  | "leaf_signature_invalid"
  | "leaf_not_yet_valid"
  | "leaf_expired";

export type AgentPopFailure =
  | "pop_signed_at_skew"
  | "invalid_signature_b64"
  | "pop_signature_invalid";

/**
 * Thrown by every verification step below. `reason` is the machine-readable
 * code; `message` is set to the same string so existing callers that only
 * surface `err.message` keep working, and `detail` carries non-secret
 * context worth logging (never key material).
 */
export class AgentCertificateError extends Error {
  readonly reason: AgentCertFailure | AgentPopFailure;
  readonly detail: Record<string, unknown>;

  constructor(
    reason: AgentCertFailure | AgentPopFailure,
    detail: Record<string, unknown> = {}
  ) {
    super(reason);
    this.name = "AgentCertificateError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * A leaf that has passed *cryptographic* verification against the Agent CA
 * plus its validity window. Holding one of these is the only way to reach
 * the message-signature step -- callers cannot skip ahead, because
 * `verifyLeafMessageSignature` takes this type rather than a raw PEM.
 *
 * Agent *binding* (does this fingerprint belong to this agent_id?) is
 * deliberately NOT part of this type: binding is store state, not PKI, and
 * lives with the caller that knows which agent_id it expects.
 */
export type VerifiedAgentCertificate = {
  publicKey: KeyObject;
  fingerprintSha256: string;
  subject: string;
  validFrom: Date;
  validTo: Date;
};

/**
 * Freshly-issued leaves carry `notBefore = issuing replica's clock`
 * (issueLeaf shells out to `openssl x509 -req`, which has no backdating
 * option). Production runs 2+ CP replicas, so a leaf minted on replica A
 * can be presented to replica B a few hundred milliseconds later with B's
 * clock marginally behind A's. A zero-tolerance not-before check turns that
 * ordinary NTP jitter into a spurious `leaf_not_yet_valid` rejection on the
 * enroll->first-call path. 60s absorbs realistic fleet skew while still
 * rejecting a cert genuinely dated into the future.
 *
 * Applied to not-before only. notAfter stays strict -- leniency there would
 * silently extend expired certificates, which is the opposite of the intent.
 */
const DEFAULT_NOT_BEFORE_TOLERANCE_SECONDS = 60;

/**
 * Default clock skew allowed on a PoP `signed_at` claim, in seconds.
 *
 * This bounds "how stale a signed request may be", not a lease lifetime: the
 * Agent stamps `signed_at` immediately before each send and re-stamps on every
 * retry, so transient network/CP instability does not consume the window — only
 * a genuinely mis-synced Agent clock (>5 min off server time) trips it.
 *
 * Overridable via `FABRIC_POP_SKEW_SECONDS` so an operator can widen it for a
 * fleet with known clock drift without a code change. Values <=0 or unparseable
 * fall back to this default. Keep it as small as your worst realistic NTP skew:
 * a wider window is a longer replay-acceptance window (§5.6 of the pack spec).
 */
const DEFAULT_POP_SKEW_SECONDS = 300;

export function popSkewSecondsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.FABRIC_POP_SKEW_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POP_SKEW_SECONDS;
}

/**
 * Verify that the Agent CA actually signed this leaf, and that the leaf is
 * inside its validity window.
 *
 * `checkIssued()` alone is NOT sufficient and never was: Node documents it
 * as a metadata/pruning check (issuer and subject naming, AKI/SKI), which
 * means a self-signed certificate carrying a copied issuer DN passes it.
 * `verify(ca.publicKey)` is the check that actually proves this CA's key
 * signed these bytes. Both run here -- `checkIssued` first because it gives
 * the more specific error when an operator has simply configured the wrong
 * CA PEM, then `verify` as the real gate.
 *
 * This is the single place in the control plane where "is this a genuine
 * Fabric Agent leaf?" is answered. Every PoP-authenticated route composes
 * it rather than re-deriving it; adding a second copy is how the
 * `checkIssued`-only gap survived as long as it did.
 */
export function verifyAgentCertificate(input: {
  certificatePem: string;
  caCertPem: string;
  now?: Date;
  notBeforeToleranceSeconds?: number;
}): VerifiedAgentCertificate {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(input.certificatePem);
  } catch {
    throw new AgentCertificateError("invalid_certificate_pem");
  }
  let ca: X509Certificate;
  try {
    ca = new X509Certificate(input.caCertPem);
  } catch {
    throw new AgentCertificateError("invalid_ca_pem");
  }

  if (!leaf.checkIssued(ca)) {
    throw new AgentCertificateError("leaf_issuer_metadata_mismatch", {
      leaf_issuer: leaf.issuer,
      ca_subject: ca.subject,
    });
  }
  if (!leaf.verify(ca.publicKey)) {
    // Issuer metadata matched but the signature does not: either a forged
    // leaf shaped to pass checkIssued, or a CA that has been re-keyed
    // without re-issuing leaves.
    throw new AgentCertificateError("leaf_signature_invalid", {
      leaf_subject: leaf.subject,
      leaf_issuer: leaf.issuer,
    });
  }

  const validFrom = new Date(leaf.validFrom);
  const validTo = new Date(leaf.validTo);
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
    throw new AgentCertificateError("invalid_certificate_pem", {
      valid_from_raw: leaf.validFrom,
      valid_to_raw: leaf.validTo,
    });
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const toleranceMs =
    (input.notBeforeToleranceSeconds ?? DEFAULT_NOT_BEFORE_TOLERANCE_SECONDS) *
    1000;
  if (nowMs + toleranceMs < validFrom.getTime()) {
    throw new AgentCertificateError("leaf_not_yet_valid", {
      valid_from: validFrom.toISOString(),
      tolerance_seconds: toleranceMs / 1000,
    });
  }
  if (nowMs > validTo.getTime()) {
    throw new AgentCertificateError("leaf_expired", {
      valid_to: validTo.toISOString(),
    });
  }

  return {
    publicKey: leaf.publicKey,
    fingerprintSha256: createHash("sha256").update(leaf.raw).digest("hex"),
    subject: leaf.subject,
    validFrom,
    validTo,
  };
}

/**
 * The PoP message for api-token/current and cert rotation.
 *
 * Kept as a named function rather than inlined at the call sites because
 * connect-agent's `cptoken.SignPoP` must produce these exact bytes
 * (`agentID\nsignedAt`). Two languages cannot share one constant, so the
 * next best thing is one definition per side that is easy to diff.
 */
export function agentPopMessage(agentId: string, signedAt: number): string {
  return `${agentId}\n${signedAt}`;
}

/**
 * Verify an RSA-SHA256 / PKCS#1 v1.5 signature made by a leaf whose CA
 * relationship has already been established.
 *
 * Takes a `VerifiedAgentCertificate` rather than a PEM so it is not
 * possible to check a signature against a certificate nobody validated --
 * that ordering mistake is precisely what made possession-of-key look like
 * proof-of-identity in the original single-function implementation.
 */
export function verifyLeafMessageSignature(
  cert: VerifiedAgentCertificate,
  message: string | Buffer,
  signatureB64: string
): void {
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
  } catch {
    throw new AgentCertificateError("invalid_signature_b64");
  }
  if (sig.length === 0) {
    throw new AgentCertificateError("invalid_signature_b64");
  }
  const verify = createVerify("SHA256");
  // A string message is the api-token/current / rotate PoP (`agentID\nsignedAt`);
  // a Buffer message is a canonical signing encoding (e.g. the pack lease
  // request's PackLeaseRequestSigningV1 bytes). createVerify.update handles both
  // the same way — this is the one place both PoP flavors verify a leaf
  // signature, so the pack route reuses it rather than adding a second verifier.
  verify.update(message);
  verify.end();
  if (!verify.verify(cert.publicKey, sig)) {
    throw new AgentCertificateError("pop_signature_invalid", {
      cert_fp: cert.fingerprintSha256,
    });
  }
}

/**
 * Reject a `signed_at` claim that is too far from server time.
 *
 * The client's clock is not trusted as an authority; this only bounds how
 * long a captured signed request stays acceptable to the real control
 * plane, using *server* time as the reference.
 */
export function assertSignedAtFresh(
  signedAt: number,
  opts?: { now?: Date; maxSkewSeconds?: number }
): void {
  const skew = opts?.maxSkewSeconds ?? popSkewSecondsFromEnv();
  const nowSec = Math.floor((opts?.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(signedAt) || Math.abs(nowSec - signedAt) > skew) {
    throw new AgentCertificateError("pop_signed_at_skew", {
      signed_at: signedAt,
      server_now: nowSec,
      max_skew_seconds: skew,
    });
  }
}

export type AgentPopInput = {
  certificatePem: string;
  caCertPem: string;
  agentId: string;
  signedAt: number;
  signatureB64: string;
  /** Max clock skew for signed_at (default 300s). */
  maxSkewSeconds?: number;
  now?: Date;
};

/**
 * G-CRED-1 / L3-CRED-01: prove possession of an Agent leaf without CP mTLS.
 *
 * Composition of the primitives above, in the only safe order:
 * freshness -> CA verification -> validity window -> message signature.
 * Returns the verified certificate as well as its fingerprint so callers
 * can log or bind without re-parsing the PEM.
 */
export function verifyAgentLeafPop(input: AgentPopInput): {
  fingerprintSha256: string;
  certificate: VerifiedAgentCertificate;
} {
  assertSignedAtFresh(input.signedAt, {
    now: input.now,
    maxSkewSeconds: input.maxSkewSeconds,
  });
  const certificate = verifyAgentCertificate({
    certificatePem: input.certificatePem,
    caCertPem: input.caCertPem,
    now: input.now,
  });
  verifyLeafMessageSignature(
    certificate,
    agentPopMessage(input.agentId, input.signedAt),
    input.signatureB64
  );
  return { fingerprintSha256: certificate.fingerprintSha256, certificate };
}
