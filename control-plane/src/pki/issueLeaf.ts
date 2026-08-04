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
 * Sign an Agent CSR with the Platform Agent CA / Intermediate.
 * Uses openssl (available in local control-plane image and typical ops hosts).
 */
/**
 * Default leaf TTL: 7 days. Override via FABRIC_AGENT_CERT_DAYS env (control plane).
 * Industry pattern (Teleport/SPIRE/Vault): short-lived certs (hours to days)
 * that auto-rotate at ~50% of life, making revocation a safety net rather than
 * a critical control. Plan: 7d now → 24h after auto-rotation proves stable.
 */
const DEFAULT_LEAF_DAYS = parseInt(process.env.FABRIC_AGENT_CERT_DAYS || "7", 10) || 7;

export function issueLeafFromCsr(
  csrPem: string,
  ca: AgentCA,
  opts?: { days?: number; sanUri?: string }
): IssuedLeaf {
  const trimmed = csrPem.trim();
  if (!trimmed.includes("BEGIN CERTIFICATE REQUEST")) {
    throw new Error("invalid_csr_pem");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-issue-"));
  try {
    const csrPath = path.join(dir, "req.csr");
    const caCertPath = path.join(dir, "ca.crt");
    const caKeyPath = path.join(dir, "ca.key");
    const outPath = path.join(dir, "leaf.crt");
    const extPath = path.join(dir, "leaf.ext");
    fs.writeFileSync(csrPath, trimmed + "\n");
    fs.writeFileSync(caCertPath, ca.certPem + "\n");
    fs.writeFileSync(caKeyPath, ca.keyPem + "\n", { mode: 0o600 });
    fs.writeFileSync(
      extPath,
      [
        "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature,keyEncipherment",
        "extendedKeyUsage=clientAuth",
        ...(opts?.sanUri
          ? [
              "subjectAltName=URI:" + opts.sanUri,
            ]
          : []),
        "",
      ].join("\n")
    );
    const days = opts?.days ?? DEFAULT_LEAF_DAYS;
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
    const fingerprintSha256 = createHash("sha256")
      .update(x509.raw)
      .digest("hex");
    return {
      certificatePem,
      fingerprintSha256,
      notAfter: new Date(x509.validTo),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
