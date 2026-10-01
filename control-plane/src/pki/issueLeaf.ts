import { execFileSync } from "child_process";
import { createHash, X509Certificate } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export type AgentCA = {
  certPem: string;
  keyPem: string;
};

/**
 * Signing material for CSR-in-enroll (L3-AGT-02 Phase B).
 *
 * Prefer file paths in production (Intermediate from Vault/Access). Inline
 * PEM env vars are accepted for local/dev only.
 *
 * NOTE (L3-PKI-02): this loads the Agent CA *private key* into the control-plane
 * process. That is the single dangerous piece of trust material in the app tier
 * — see `CertificateIssuer` below and Architecture-Resolutions DR-9 for the plan
 * to move signing to a managed/external signer. Only `OpensslCAIssuer` should
 * ever call this.
 */
export function loadAgentCA(env: NodeJS.ProcessEnv = process.env): AgentCA | null {
  let certPem = (env.FABRIC_AGENT_CA_CERT || "").trim();
  let keyPem = (env.FABRIC_AGENT_CA_KEY || "").trim();
  if (!certPem && env.FABRIC_AGENT_CA_CERT_FILE) {
    certPem = fs.readFileSync(env.FABRIC_AGENT_CA_CERT_FILE, "utf8").trim();
  }
  if (!keyPem && env.FABRIC_AGENT_CA_KEY_FILE) {
    keyPem = fs.readFileSync(env.FABRIC_AGENT_CA_KEY_FILE, "utf8").trim();
  }
  if (!certPem || !keyPem) return null;
  return { certPem, keyPem };
}

export type IssuedLeaf = {
  certificatePem: string;
  fingerprintSha256: string;
  notAfter: Date;
};

/**
 * The Agent certificate profile — the ONLY shape any issuer may produce.
 *
 * This is the "constrained signer" guarantee (Architecture-Resolutions DR-9): an
 * Agent leaf is always a non-CA clientAuth certificate with a single SPIFFE URI
 * SAN and a bounded validity. Whoever signs — today's in-process openssl, a
 * future OCI Certificates / Vault PKI signer — signs only this. Relocating the
 * CA key later must not turn issuance into "sign any CSR"; keeping the profile
 * here, applied by the issuer rather than taken from the CSR, is what prevents
 * that.
 */
export const AGENT_LEAF_PROFILE = {
  basicConstraints: "CA:FALSE",
  keyUsage: "digitalSignature,keyEncipherment",
  extendedKeyUsage: "clientAuth",
} as const;

/**
 * Default leaf TTL: 7 days. Override via FABRIC_AGENT_CERT_DAYS env (control plane).
 * Industry pattern (Teleport/SPIRE/Vault): short-lived certs (hours to days)
 * that auto-rotate at ~50% of life, making revocation a safety net rather than
 * a critical control. Plan: 7d now → 24h after auto-rotation proves stable.
 */
const DEFAULT_LEAF_DAYS = parseInt(process.env.FABRIC_AGENT_CERT_DAYS || "7", 10) || 7;

/**
 * Hard ceiling on issued validity, independent of the requested `days`. A caller
 * (or a future signer profile) asking for a longer-lived Agent cert is a bug or
 * an abuse; clamp rather than honour it. 30 days is generous headroom over the
 * 7-day default without approaching "long-lived credential" territory.
 */
const MAX_LEAF_DAYS = 30;

export type IssueLeafOptions = {
  days?: number;
  /** Single SPIFFE URI SAN, e.g. spiffe://fabric.abluva.io/tenant/<tid>/agent. */
  sanUri?: string;
};

/**
 * Issues Agent leaf certificates from a CSR under the fixed Agent profile.
 *
 * This is the seam that isolates "who holds the signing authority". Today the
 * only implementation is `OpensslCAIssuer`, which holds the CA key in-process
 * (L3-PKI-02). A managed signer (OCI Certificates / Vault PKI) becomes a second
 * implementation of THIS interface and a one-line swap in index.ts — no handler,
 * store, or profile change. Callers depend on the interface, never on openssl.
 */
export interface CertificateIssuer {
  issueAgentLeaf(csrPem: string, opts?: IssueLeafOptions): IssuedLeaf;
}

/** Reject a CSR that is not a well-formed PKCS#10 request before signing. */
function assertValidCsr(csrPem: string): string {
  const trimmed = csrPem.trim();
  if (!trimmed.includes("BEGIN CERTIFICATE REQUEST")) {
    throw new Error("invalid_csr_pem");
  }
  return trimmed;
}

/** Clamp requested validity to [1, MAX_LEAF_DAYS]. */
function resolveDays(requested?: number): number {
  const d = requested ?? DEFAULT_LEAF_DAYS;
  if (!Number.isFinite(d) || d < 1) return DEFAULT_LEAF_DAYS;
  return Math.min(d, MAX_LEAF_DAYS);
}

/**
 * In-process openssl signer — holds the Agent CA private key in the CP pod.
 *
 * This is the implementation L3-PKI-02 exists to replace. It is kept behind
 * `CertificateIssuer` precisely so that replacing it is a localized change: the
 * dangerous key handling (temp `ca.key` file, openssl subprocess) lives only
 * here, and the profile it applies is `AGENT_LEAF_PROFILE`, not anything the
 * CSR asks for — openssl `x509 -req` ignores CSR extensions and uses the extfile
 * we write, so a CSR carrying `CA:TRUE` or extra SANs cannot widen the result.
 */
export class OpensslCAIssuer implements CertificateIssuer {
  constructor(private readonly ca: AgentCA) {}

  issueAgentLeaf(csrPem: string, opts?: IssueLeafOptions): IssuedLeaf {
    const trimmed = assertValidCsr(csrPem);
    const days = resolveDays(opts?.days);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-issue-"));
    try {
      const csrPath = path.join(dir, "req.csr");
      const caCertPath = path.join(dir, "ca.crt");
      const caKeyPath = path.join(dir, "ca.key");
      const outPath = path.join(dir, "leaf.crt");
      const extPath = path.join(dir, "leaf.ext");
      fs.writeFileSync(csrPath, trimmed + "\n");
      fs.writeFileSync(caCertPath, this.ca.certPem + "\n");
      fs.writeFileSync(caKeyPath, this.ca.keyPem + "\n", { mode: 0o600 });
      fs.writeFileSync(extPath, buildAgentExtFile(opts?.sanUri));
      try {
        execFileSync(
          "openssl",
          [
            "x509",
            "-req",
            "-in",
            csrPath,
            "-CA",
            caCertPath,
            "-CAkey",
            caKeyPath,
            "-CAcreateserial",
            "-out",
            outPath,
            "-days",
            String(days),
            "-sha256",
            "-extfile",
            extPath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`csr_sign_failed: ${msg}`);
      }
      const certificatePem = fs.readFileSync(outPath, "utf8").trim() + "\n";
      const x509 = new X509Certificate(certificatePem);
      return {
        certificatePem,
        fingerprintSha256: createHash("sha256").update(x509.raw).digest("hex"),
        notAfter: new Date(x509.validTo),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The openssl extfile encoding AGENT_LEAF_PROFILE + at most one SPIFFE SAN. */
function buildAgentExtFile(sanUri?: string): string {
  const lines = [
    `basicConstraints=${AGENT_LEAF_PROFILE.basicConstraints}`,
    `keyUsage=${AGENT_LEAF_PROFILE.keyUsage}`,
    `extendedKeyUsage=${AGENT_LEAF_PROFILE.extendedKeyUsage}`,
  ];
  if (sanUri) {
    if (!sanUri.startsWith("spiffe://")) {
      // The profile allows exactly one SPIFFE URI SAN. Anything else is a
      // caller bug and must not be smuggled into the cert.
      throw new Error("invalid_san_uri");
    }
    lines.push("subjectAltName=URI:" + sanUri);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Backwards-compatible free function. Prefer constructing a `CertificateIssuer`
 * (`new OpensslCAIssuer(ca)`) and calling `issueAgentLeaf`; this wrapper keeps
 * existing call sites terse and routes through the same profile-constrained path.
 */
export function issueLeafFromCsr(
  csrPem: string,
  ca: AgentCA,
  opts?: IssueLeafOptions
): IssuedLeaf {
  return new OpensslCAIssuer(ca).issueAgentLeaf(csrPem, opts);
}
