import http from "http";
import { URL } from "url";
import { log } from "../logging";
import type { AgentState, FabricStore, WorkloadEvidenceStrategy } from "../store/types";
import {
  publicRegistration,
  publicTenant,
  publicWorkloadEvidence,
  DEFAULT_TOKEN_OVERLAP_SECONDS,
} from "../store/types";
import { discoverOidcIssuer } from "../oidc/discovery";
import { loadGatewayPushConfig, pushRevoke, type GatewayPushConfig } from "../gatewayPush";
import { issueLeafFromCsr, loadAgentCA, type AgentCA } from "../pki/issueLeaf";
import { verifyAgentLeafPop } from "../pki/verifyAgentLeaf";

type Json = Record<string, unknown>;

export type ServerOpts = {
  /** When set, all /v1/* require Authorization: Bearer <token>. */
  authToken?: string;
  /** When set, high-risk mutations also require X-ABLV-Break-Glass. */
  dualControlToken?: string;
  inboundDomainSuffix?: string;
  /** L2 §D.3 push half of revocation transport; empty urls = push disabled (poll-only). */
  gatewayPush?: GatewayPushConfig;
  /**
   * CA used to sign Agent CSRs on enroll (L3-AGT-02). When omitted, loaded
   * from FABRIC_AGENT_CA_* env. Fingerprint-only enroll still works for
   * api-smoke / pre-minted leaves; CSR enroll requires this material.
   */
  agentCA?: AgentCA | null;
};

// Default cap on request bodies read via readBody. Without one, an
// oversized POST (accidental or malicious) accumulates unbounded in
// process memory before "end" ever fires -- every one of this server's
// mutation endpoints is exposed to that, so a single slow/large upload (or
// a handful of concurrent ones) is enough to OOM the control-plane
// process. 1MB comfortably covers every real body this API accepts
// (tenant/registration/agent JSON payloads).
const MAX_BODY_BYTES = Number(process.env.FABRIC_HTTP_MAX_BODY_BYTES || 1_000_000);

/** Thrown by readBody when the request body exceeds its byte cap. */
export class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes} byte limit`);
    this.name = "PayloadTooLargeError";
  }
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (c: Buffer) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        settled = true;
        req.destroy();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Audit attribution only — not authentication.
 * Privilege: writer bearer (`FABRIC_CONTROL_PLANE_TOKEN`) or scoped Agent API
 * token (L3-CTL-01a); high-risk also needs dual-control.
 */
function actorFrom(req: http.IncomingMessage): string {
  return (req.headers["x-ablv-actor"] as string) || "system";
}

function bad(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function bearerToken(req: http.IncomingMessage): string {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

function isHighRisk(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return (
    /\/v1\/tenants\/[^/]+\/suspend$/.test(path) ||
    /\/v1\/tenants\/[^/]+\/revoke-cert$/.test(path) ||
    /\/v1\/tenants\/[^/]+\/substrate-binding$/.test(path) ||
    /\/v1\/registrations\/[^/]+\/delete$/.test(path)
  );
}

/** Routes an Agent API token may call (L3-CTL-01a). Tenant scoping checked per-handler. */
function isAgentApiRoute(method: string, path: string): boolean {
  if (method === "POST" && path === "/v1/agents/enroll") return true;
  if (method === "GET" && /^\/v1\/tenants\/[^/]+\/registrations$/.test(path)) {
    return true;
  }
  if (method === "POST" && /^\/v1\/registrations\/[^/]+\/observed$/.test(path)) {
    return true;
  }
  // Mid-life cert rotate keeps agent_id (L3-PKI-01a); Agent presents scoped token.
  if (method === "POST" && /^\/v1\/agents\/[^/]+\/rotate$/.test(path)) {
    return true;
  }
  return false;
}

type Authz =
  | { role: "writer" }
  | { role: "agent"; tenantId: string }
  | { role: "anonymous" };

function parseSuspendCause(v: unknown): "billing" | "security" | undefined {
  return v === "billing" || v === "security" ? v : undefined;
}

function parseRevokeCause(v: unknown): "decommission" | "security" | undefined {
  return v === "decommission" || v === "security" ? v : undefined;
}

export function createServer(store: FabricStore, opts: ServerOpts = {}) {
  const domain = opts.inboundDomainSuffix || "connect.fabric";
  const gatewayPush = opts.gatewayPush ?? loadGatewayPushConfig();
  return http.createServer(async (req, res) => {
    const correlation = (req.headers["x-correlation-id"] as string) || "";
    try {
      if (!req.url || !req.method) {
        return send(res, 400, { error: "bad_request" });
      }
      const u = new URL(req.url, "http://localhost");
      const path = u.pathname;
      const method = req.method.toUpperCase();

      log.info("http_request", {
        layer: "control-plane.http",
        correlation_id: correlation,
        method,
        path,
      });

      if (method === "GET" && path === "/healthz") {
        return send(res, 200, { ok: true });
      }

      // Public CA trust bundle — no auth required, same posture as
      // /healthz. This is exactly what a customer's TLS trust store needs
      // to verify the Gateway/Ghostunnel *server* certificate: the CA's
      // public certificate only, never the signing key. The k3s appliance
      // installer already assumes this exact path (--ca-url=.../v1/ca-bundle);
      // shipping it here closes that previously-unimplemented assumption.
      // Returning it publicly is safe by design -- a CA certificate is
      // trust-anchor material meant to be widely distributed (this is the
      // same "ca.crt" file already shipped read-only in the Agent's
      // connect-agent-tls Secret); it grants no capability by itself.
      if (method === "GET" && path === "/v1/ca-bundle") {
        const ca = opts.agentCA !== undefined ? opts.agentCA : loadAgentCA();
        if (!ca) {
          return send(res, 404, { error: "agent_ca_not_configured" });
        }
        res.writeHead(200, {
          "Content-Type": "application/x-pem-file",
          "Content-Length": Buffer.byteLength(ca.certPem),
        });
        res.end(ca.certPem);
        return;
      }

      const bearer = bearerToken(req);
      let authz: Authz = { role: "anonymous" };
      // G-CRED-1: leaf PoP pull does not require a bearer (that is the point).
      const isApiTokenPull =
        method === "POST" &&
        /^\/v1\/agents\/[^/]+\/api-token\/current$/.test(path);
      // Enroll authenticates via bootstrap_token in the request body, not
      // via a bearer header — it's the one call an Agent makes before it
      // has any other credential. Requiring a separate "seed" bearer here
      // was redundant with the bootstrap token and added a Day-1
      // distribution step that didn't carry security value.
      const isEnroll = method === "POST" && path === "/v1/agents/enroll";
      // Rotate (L3-PKI-01a) is PoP-authenticated in its own handler --
      // the leaf's private key signing the request is what actually
      // proves the caller may rotate THIS agent_id, not the tenant-scoped
      // bearer (which is shared by every DaemonSet instance in a tenant
      // and proves tenant membership at best). A missing or already-
      // invalid/expired bearer must not shortcut to 401 here, or the PoP
      // check the handler is supposed to perform never runs at all --
      // exactly the gap that let FABRIC_AGENT_ROTATE=1 fail whenever
      // PullCurrent hadn't yet succeeded, even though certlife.RotateLeaf
      // always sends a valid PoP signature regardless of bearer state.
      const isRotate = method === "POST" && /^\/v1\/agents\/[^/]+\/rotate$/.test(path);
      // Routes where a missing OR invalid bearer falls through to
      // "anonymous" instead of a hard 401, because the route's own
      // handler enforces a second, independent authentication mechanism
      // (leaf PoP) that doesn't depend on the bearer being valid. Every
      // other route still hard-401s on a bearer that fails to resolve.
      const isPopFallbackRoute = isApiTokenPull || isEnroll || isRotate;
      if (opts.authToken) {
        if (bearer && bearer === opts.authToken) {
          authz = { role: "writer" };
        } else if (bearer) {
          const agentTenant = await store.resolveAgentApiToken(bearer);
          if (agentTenant) {
            authz = { role: "agent", tenantId: agentTenant };
          } else if (isPopFallbackRoute) {
            authz = { role: "anonymous" };
          } else {
            return send(res, 401, { error: "unauthorized" });
          }
        } else if (isPopFallbackRoute) {
          authz = { role: "anonymous" };
        } else {
          return send(res, 401, { error: "unauthorized" });
        }
        if (authz.role === "agent") {
          if (!isAgentApiRoute(method, path)) {
            return send(res, 403, { error: "agent_token_insufficient" });
          }
        }
      } else {
        // Auth unset (unit tests / open local): treat as writer.
        authz = { role: "writer" };
      }
      if (
        opts.dualControlToken &&
        isHighRisk(method, path) &&
        authz.role === "writer"
      ) {
        const bg = (req.headers["x-ablv-break-glass"] as string) || "";
        if (bg !== opts.dualControlToken) {
          return send(res, 403, { error: "dual_control_required" });
        }
      }
      // Agent tokens never satisfy dual-control high-risk (blocked above).

      if (method === "POST" && path === "/v1/tenants/ensure") {
        const body = JSON.parse(await readBody(req)) as Json;
        const tenantId = String(body.tenant_id || "");
        if (!tenantId) return send(res, 400, { error: "tenant_id_required" });
        const t = await store.ensureTenant(tenantId, actorFrom(req));
        return send(res, 200, publicTenant(t));
      }

      if (method === "GET" && /^\/v1\/tenants\/[^/]+$/.test(path)) {
        const tenantId = path.split("/")[3];
        const t = await store.getTenant(tenantId);
        if (!t) return send(res, 404, { error: "tenant_not_found" });
        return send(res, 200, publicTenant(t));
      }

      if (method === "POST" && /^\/v1\/tenants\/[^/]+\/agent-api-token$/.test(path)) {
        if (authz.role !== "writer") {
          return send(res, 403, { error: "writer_required" });
        }
        const tenantId = path.split("/")[3];
        const body = JSON.parse((await readBody(req)) || "{}") as Json;
        const ttl =
          body.ttl_minutes !== undefined
            ? Number(body.ttl_minutes)
            : undefined;
        const raw = await store.issueAgentApiToken(
          tenantId,
          actorFrom(req),
          ttl
        );
        const t = await store.getTenant(tenantId);
        log.info("agent_api_token_issued", {
          layer: "control-plane.auth",
          tenant_id: tenantId,
          expires_at: t?.agent_api_token_expires_at,
          correlation_id: correlation,
        });
        return send(res, 200, {
          tenant_id: tenantId,
          agent_api_token: raw,
          expires_at: t?.agent_api_token_expires_at ?? null,
          note: "Scoped: enroll, list registrations, observed, rotate. Not writer.",
        });
      }

      if (
        method === "POST" &&
        /^\/v1\/tenants\/[^/]+\/agent-api-token\/revoke$/.test(path)
      ) {
        if (authz.role !== "writer") {
          return send(res, 403, { error: "writer_required" });
        }
        const tenantId = path.split("/")[3];
        const t = await store.revokeAgentApiToken(tenantId, actorFrom(req));
        log.info("agent_api_token_revoked", {
          layer: "control-plane.auth",
          tenant_id: tenantId,
          correlation_id: correlation,
        });
        return send(res, 200, publicTenant(t));
      }

      if (method === "POST" && /^\/v1\/tenants\/[^/]+\/bootstrap-token$/.test(path)) {
        const tenantId = path.split("/")[3];
        const raw = await store.issueBootstrapToken(tenantId, actorFrom(req));
        const t = await store.getTenant(tenantId);
        log.info("bootstrap_token_issued", {
          layer: "control-plane.bootstrap",
          tenant_id: tenantId,
          bootstrap_expires_at: t?.bootstrap_expires_at?.toISOString() ?? null,
          correlation_id: correlation,
        });
        return send(res, 200, {
          tenant_id: tenantId,
          bootstrap_token: raw,
          bootstrap_expires_at: t?.bootstrap_expires_at ?? null,
          note: "valid until bootstrap_expires_at; multi-redeem across Agent instances; revoke to kill early; shown once; prod stores hash only",
        });
      }

      if (
        method === "POST" &&
        /^\/v1\/tenants\/[^/]+\/bootstrap-token\/revoke$/.test(path)
      ) {
        const tenantId = path.split("/")[3];
        const t = await store.revokeBootstrapToken(tenantId, actorFrom(req));
        return send(res, 200, publicTenant(t));
      }

      if (method === "POST" && /^\/v1\/tenants\/[^/]+\/auto-approve$/.test(path)) {
        const tenantId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        const t = await store.setAutoApprove(
          tenantId,
          Boolean(body.enabled),
          actorFrom(req)
        );
        return send(res, 200, publicTenant(t));
      }

      if (method === "POST" && /^\/v1\/tenants\/[^/]+\/suspend$/.test(path)) {
        const tenantId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        const suspended = Boolean(body.suspended);
        // L2 §G.3: cause decides drain vs immediate force-close. Required when
        // suspending; unset (fail safe → security) is rejected rather than guessed.
        if (suspended && !parseSuspendCause(body.cause)) {
          return send(res, 400, {
            error: "suspend_cause_required",
            note: "cause must be 'billing' or 'security' (L2 §G.3)",
          });
        }
        const cause = parseSuspendCause(body.cause);
        const t = await store.setSuspended(
          tenantId,
          suspended,
          actorFrom(req),
          cause
        );
        if (suspended && cause === "security") {
          pushRevoke(gatewayPush, {
            tenant_id: tenantId,
            cause: "security",
            kind: "tenant_suspend",
          });
        }
        return send(res, 200, publicTenant(t));
      }

      if (
        method === "POST" &&
        /^\/v1\/tenants\/[^/]+\/substrate-binding$/.test(path)
      ) {
        const tenantId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        const t = await store.setSubstrateBinding(
          tenantId,
          {
            enabled: Boolean(body.enabled),
            expected_substrate_fingerprint:
              body.expected_substrate_fingerprint !== undefined
                ? body.expected_substrate_fingerprint === null
                  ? null
                  : String(body.expected_substrate_fingerprint)
                : undefined,
          },
          actorFrom(req)
        );
        return send(res, 200, publicTenant(t));
      }

      if (method === "POST" && /^\/v1\/tenants\/[^/]+\/quotas$/.test(path)) {
        const tenantId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          const t = await store.setQuotas(
            tenantId,
            {
              max_tunnels:
                body.max_tunnels !== undefined
                  ? Number(body.max_tunnels)
                  : undefined,
              max_concurrent_streams:
                body.max_concurrent_streams !== undefined
                  ? Number(body.max_concurrent_streams)
                  : undefined,
              max_stream_open_per_sec:
                body.max_stream_open_per_sec !== undefined
                  ? Number(body.max_stream_open_per_sec)
                  : undefined,
            },
            actorFrom(req)
          );
          return send(res, 200, publicTenant(t));
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (
        method === "GET" &&
        /^\/v1\/tenants\/[^/]+\/workload-evidence$/.test(path)
      ) {
        const tenantId = path.split("/")[3];
        const t = await store.getTenant(tenantId);
        if (!t) return send(res, 404, { error: "tenant_not_found" });
        return send(res, 200, publicWorkloadEvidence(t));
      }

      if (
        method === "PUT" &&
        /^\/v1\/tenants\/[^/]+\/workload-evidence$/.test(path)
      ) {
        if (authz.role !== "writer") {
          return send(res, 403, { error: "writer_required" });
        }
        const tenantId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          const strategy = body.strategy as WorkloadEvidenceStrategy | undefined;
          let oidc_issuer_url =
            body.oidc_issuer_url !== undefined
              ? body.oidc_issuer_url === null
                ? null
                : String(body.oidc_issuer_url)
              : undefined;
          let oidc_jwks_uri =
            body.oidc_jwks_uri !== undefined
              ? body.oidc_jwks_uri === null
                ? null
                : String(body.oidc_jwks_uri)
              : undefined;
          let oidc_enabled =
            body.oidc_enabled !== undefined
              ? Boolean(body.oidc_enabled)
              : undefined;
          let oidc_last_discovery_ok_at: Date | null | undefined;
          let oidc_last_discovery_error: string | null | undefined;

          const runDiscovery =
            body.probe_discovery !== false &&
            (strategy === "kubernetes_oidc" ||
              (strategy === undefined && oidc_issuer_url)) &&
            oidc_issuer_url;

          if (runDiscovery && oidc_issuer_url) {
            const disc = await discoverOidcIssuer(oidc_issuer_url, {
              caBundlePem:
                body.oidc_ca_bundle_pem !== undefined
                  ? body.oidc_ca_bundle_pem === null
                    ? null
                    : String(body.oidc_ca_bundle_pem)
                  : undefined,
            });
            if (disc.ok) {
              oidc_jwks_uri = disc.jwks_uri;
              oidc_enabled = true;
              oidc_last_discovery_ok_at = new Date();
              oidc_last_discovery_error = null;
              if (!oidc_issuer_url) oidc_issuer_url = disc.issuer;
            } else {
              oidc_enabled = false;
              oidc_last_discovery_ok_at = null;
              oidc_last_discovery_error = disc.error;
            }
          }

          if (strategy === "none") {
            oidc_enabled = false;
          }

          const t = await store.setWorkloadEvidence(
            tenantId,
            {
              strategy,
              oidc_issuer_url,
              oidc_jwks_uri,
              oidc_audience:
                body.oidc_audience !== undefined
                  ? String(body.oidc_audience)
                  : undefined,
              oidc_allowed_algs: Array.isArray(body.oidc_allowed_algs)
                ? (body.oidc_allowed_algs as unknown[]).map(String)
                : undefined,
              oidc_ca_bundle_pem:
                body.oidc_ca_bundle_pem !== undefined
                  ? body.oidc_ca_bundle_pem === null
                    ? null
                    : String(body.oidc_ca_bundle_pem)
                  : undefined,
              oidc_enabled,
              oidc_last_discovery_ok_at,
              oidc_last_discovery_error,
              workload_evidence_config:
                body.config !== undefined &&
                body.config !== null &&
                typeof body.config === "object"
                  ? (body.config as Record<string, unknown>)
                  : undefined,
            },
            actorFrom(req)
          );
          return send(res, 200, publicWorkloadEvidence(t));
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (method === "POST" && /^\/v1\/tenants\/[^/]+\/revoke-cert$/.test(path)) {
        const tenantId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        const fp = String(body.cert_fingerprint_sha256 || "");
        if (!fp) return send(res, 400, { error: "cert_fingerprint_sha256_required" });
        // L2 §D.3: default "security" (fail safe → immediate teardown, no drain).
        const cause = parseRevokeCause(body.cause) ?? "security";
        const t = await store.revokeCertFingerprint(
          tenantId,
          fp,
          actorFrom(req),
          cause
        );
        if (cause === "security") {
          pushRevoke(gatewayPush, {
            tenant_id: tenantId,
            cert_fingerprint: fp,
            cause: "security",
            kind: "cert_revoke",
          });
        }
        return send(res, 200, publicTenant(t));
      }

      if (method === "GET" && /^\/v1\/tenants\/[^/]+\/agents$/.test(path)) {
        const tenantId = path.split("/")[3];
        const state = u.searchParams.get("state") || undefined;
        const agents = await store.listAgents(
          tenantId,
          state ? { state: state as AgentState } : undefined
        );
        return send(res, 200, { tenant_id: tenantId, agents });
      }

      if (method === "GET" && /^\/v1\/tenants\/[^/]+\/registrations$/.test(path)) {
        const tenantId = path.split("/")[3];
        if (authz.role === "agent" && authz.tenantId !== tenantId) {
          return send(res, 403, { error: "tenant_mismatch" });
        }
        const registrations = await store.listRegistrations(tenantId);
        return send(res, 200, {
          tenant_id: tenantId,
          registrations: registrations.map((r) => publicRegistration(r, domain)),
        });
      }

      if (method === "POST" && path === "/v1/agents/enroll") {
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          const tenantId = String(body.tenant_id || "");
          if (authz.role === "agent" && authz.tenantId !== tenantId) {
            return send(res, 403, { error: "tenant_mismatch" });
          }
          const csrPem = body.csr_pem ? String(body.csr_pem) : "";
          let certFingerprint = body.cert_fingerprint_sha256
            ? String(body.cert_fingerprint_sha256)
            : undefined;
          let certificatePem: string | undefined;
          let certNotAfter: Date | undefined;
          if (csrPem) {
            const ca = opts.agentCA !== undefined ? opts.agentCA : loadAgentCA();
            if (!ca) {
              return send(res, 400, { error: "agent_ca_not_configured" });
            }
            const issued = issueLeafFromCsr(csrPem, ca, {
              sanUri: `spiffe://fabric.abluva.io/tenant/${tenantId}/agent`,
            });
            certFingerprint = issued.fingerprintSha256;
            certificatePem = issued.certificatePem;
            certNotAfter = issued.notAfter;
          }
          if (!certFingerprint) {
            return send(res, 400, {
              error: "csr_or_cert_fingerprint_required",
            });
          }
          const agent = await store.enrollAgent({
            tenant_id: tenantId,
            bootstrap_token: String(body.bootstrap_token || ""),
            substrate: String(body.substrate || "kubernetes"),
            substrate_fingerprint: body.substrate_fingerprint
              ? String(body.substrate_fingerprint)
              : undefined,
            cert_fingerprint_sha256: certFingerprint,
            cert_not_after: certNotAfter ?? null,
            actor: actorFrom(req),
          });
          log.info("agent_enrolled", {
            layer: "control-plane.enroll",
            tenant_id: agent.tenant_id,
            agent_id: agent.id,
            state: agent.state,
            cert_fp: agent.cert_fingerprint_sha256,
            csr_issued: !!certificatePem,
            correlation_id: correlation,
          });
          // Optional redemption audit (L3-AGT-02): not a second invalidation path.
          log.info("bootstrap_token_redeemed", {
            layer: "control-plane.bootstrap",
            tenant_id: agent.tenant_id,
            agent_id: agent.id,
            correlation_id: correlation,
          });
          return send(
            res,
            201,
            certificatePem ? { ...agent, certificate_pem: certificatePem } : agent
          );
        } catch (e) {
          log.warn("agent_enroll_rejected", {
            layer: "control-plane.enroll",
            error: bad(e),
            correlation_id: correlation,
          });
          return send(res, 400, { error: bad(e) });
        }
      }

      // G-CRED-1 / L3-CRED-01: Agent pulls a fresh scoped bearer via leaf PoP.
      if (
        method === "POST" &&
        /^\/v1\/agents\/[^/]+\/api-token\/current$/.test(path)
      ) {
        const agentId = path.split("/")[3];
        const body = JSON.parse((await readBody(req)) || "{}") as Json;
        try {
          const existing = await store.getAgent(agentId);
          if (!existing || existing.deleted_at) {
            return send(res, 404, { error: "agent_not_found" });
          }
          const ca = opts.agentCA !== undefined ? opts.agentCA : loadAgentCA();
          if (!ca) {
            return send(res, 400, { error: "agent_ca_not_configured" });
          }
          const certPem = String(body.certificate_pem || "");
          const signedAt = Number(body.signed_at);
          const signatureB64 = String(body.signature_b64 || "");
          if (!certPem || !signatureB64 || !Number.isFinite(signedAt)) {
            return send(res, 400, { error: "pop_fields_required" });
          }
          const { fingerprintSha256 } = verifyAgentLeafPop({
            certificatePem: certPem,
            caCertPem: ca.certPem,
            agentId,
            signedAt,
            signatureB64,
          });
          const byFp = await store.findAgentByCertFingerprint(fingerprintSha256);
          if (!byFp || byFp.id !== agentId) {
            return send(res, 403, { error: "cert_not_bound_to_agent" });
          }
          if (byFp.tenant_id !== existing.tenant_id) {
            return send(res, 403, { error: "tenant_mismatch" });
          }
          const overlap =
            body.overlap_seconds !== undefined
              ? Number(body.overlap_seconds)
              : 3600;
          const ttl =
            body.ttl_minutes !== undefined
              ? Number(body.ttl_minutes)
              : undefined;
          const forceRenew = Boolean(body.force_renew);
          // D1: reuse presented bearer when still valid and not near expiry so
          // N DaemonSet instances do not mint+stomp the single prior slot each hour.
          const presented = String(
            body.current_agent_api_token || body.current_token || ""
          ).trim();
          const renewBeforeSec = Number.isFinite(Number(body.renew_before_seconds))
            ? Number(body.renew_before_seconds)
            : 7 * 24 * 3600; // default: re-mint only when < 7d remain
          if (!forceRenew && presented) {
            const tid = await store.resolveAgentApiToken(presented);
            if (tid === existing.tenant_id) {
              const cur = await store.getTenant(existing.tenant_id);
              const exp = cur?.agent_api_token_expires_at;
              const stillFresh =
                !exp ||
                exp.getTime() > Date.now() + renewBeforeSec * 1000;
              if (stillFresh) {
                log.info("agent_api_token_reused", {
                  layer: "control-plane.auth",
                  tenant_id: existing.tenant_id,
                  agent_id: agentId,
                  cert_fp: fingerprintSha256,
                  correlation_id: correlation,
                });
                return send(res, 200, {
                  tenant_id: existing.tenant_id,
                  agent_id: agentId,
                  agent_api_token: presented,
                  expires_at: exp ?? null,
                  reused: true,
                  note: "G-CRED-1: existing bearer still fresh; no re-issue.",
                });
              }
            }
          }
          const raw = await store.issueAgentApiToken(
            existing.tenant_id,
            `agent:${agentId}`,
            ttl,
            { overlap_seconds: Number.isFinite(overlap) ? overlap : DEFAULT_TOKEN_OVERLAP_SECONDS }
          );
          const t = await store.getTenant(existing.tenant_id);
          log.info("agent_api_token_pulled", {
            layer: "control-plane.auth",
            tenant_id: existing.tenant_id,
            agent_id: agentId,
            cert_fp: fingerprintSha256,
            overlap_seconds: overlap,
            correlation_id: correlation,
          });
          return send(res, 200, {
            tenant_id: existing.tenant_id,
            agent_id: agentId,
            agent_api_token: raw,
            expires_at: t?.agent_api_token_expires_at ?? null,
            reused: false,
            note: "G-CRED-1: write to local agent-api.token file; prior bearer valid through overlap.",
          });
        } catch (e) {
          return send(res, 403, { error: bad(e) });
        }
      }

      if (method === "POST" && /^\/v1\/agents\/[^/]+\/rotate$/.test(path)) {
        const agentId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          const existing = await store.getAgent(agentId);
          if (!existing) return send(res, 404, { error: "agent_not_found" });
          if (authz.role === "agent" && authz.tenantId !== existing.tenant_id) {
            return send(res, 403, { error: "tenant_mismatch" });
          }
          const csrPem = body.csr_pem ? String(body.csr_pem) : "";
          if (!csrPem) return send(res, 400, { error: "csr_pem_required" });
          const ca = opts.agentCA !== undefined ? opts.agentCA : loadAgentCA();
          if (!ca) {
            return send(res, 400, { error: "agent_ca_not_configured" });
          }
          // L3-PKI-01a: PoP is required for every caller except writer.
          // An agent-role bearer is scoped to the whole tenant, shared by
          // every DaemonSet instance -- checking only tenantId above lets
          // any sibling node rotate a cert it never held the private key
          // for. An anonymous caller (missing or already-invalid bearer --
          // see isPopFallbackRoute above) has proven nothing at all yet.
          // Either way, proof of possession of THIS agent's current (or
          // still-in-overlap prior) leaf, same PoP scheme as
          // api-token/current, is what actually authorizes the rotate --
          // not the bearer. A writer-role caller (break-glass / operator
          // tooling) is not bound by this -- writer already has unscoped
          // authority.
          if (authz.role !== "writer") {
            const certPem = String(body.certificate_pem || "");
            const signedAt = Number(body.signed_at);
            const signatureB64 = String(body.signature_b64 || "");
            if (!certPem || !signatureB64 || !Number.isFinite(signedAt)) {
              return send(res, 400, { error: "pop_fields_required" });
            }
            try {
              const { fingerprintSha256 } = verifyAgentLeafPop({
                certificatePem: certPem,
                caCertPem: ca.certPem,
                agentId,
                signedAt,
                signatureB64,
              });
              const byFp = await store.findAgentByCertFingerprint(fingerprintSha256);
              if (!byFp || byFp.id !== agentId) {
                return send(res, 403, { error: "cert_not_bound_to_agent" });
              }
            } catch (popErr) {
              // Same 403 (not the outer catch's 400) as api-token/current:
              // a failed PoP check is an authentication failure, not a
              // malformed-request error.
              return send(res, 403, { error: bad(popErr) });
            }
          }
          const issued = issueLeafFromCsr(csrPem, ca, {
            sanUri: `spiffe://fabric.abluva.io/tenant/${existing.tenant_id}/agent`,
          });
          const overlap =
            body.overlap_seconds !== undefined
              ? Number(body.overlap_seconds)
              : undefined;
          const { agent, previous_fingerprint } = await store.rotateAgentCert({
            agent_id: agentId,
            cert_fingerprint_sha256: issued.fingerprintSha256,
            cert_not_after: issued.notAfter,
            actor: actorFrom(req),
            overlap_seconds: overlap,
          });
          log.info("agent_cert_rotated", {
            layer: "control-plane.pki",
            tenant_id: agent.tenant_id,
            agent_id: agent.id,
            cert_fp: agent.cert_fingerprint_sha256,
            previous_fp: previous_fingerprint,
            overlap_seconds: overlap ?? 300,
            correlation_id: correlation,
          });
          return send(res, 200, {
            ...agent,
            certificate_pem: issued.certificatePem,
            previous_fingerprint,
          });
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (method === "POST" && /^\/v1\/agents\/[^/]+\/approve$/.test(path)) {
        const agentId = path.split("/")[3];
        try {
          const agent = await store.approveAgent(agentId, actorFrom(req));
          log.info("agent_approved", {
            layer: "control-plane.approve",
            tenant_id: agent.tenant_id,
            agent_id: agent.id,
            state: agent.state,
            correlation_id: correlation,
          });
          return send(res, 200, agent);
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (method === "POST" && /^\/v1\/agents\/[^/]+\/retire$/.test(path)) {
        const agentId = path.split("/")[3];
        try {
          const agent = await store.retireAgent(agentId, actorFrom(req));
          return send(res, 200, agent);
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (method === "POST" && path === "/v1/agents/tunnel-event") {
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          const event = String(body.event || "") as "up" | "down" | "heartbeat";
          if (event !== "up" && event !== "down" && event !== "heartbeat") {
            return send(res, 400, { error: "event_invalid" });
          }
          const agent = await store.reportTunnel({
            tenant_id: String(body.tenant_id || ""),
            agent_id: body.agent_id ? String(body.agent_id) : undefined,
            cert_fingerprint: body.cert_fingerprint
              ? String(body.cert_fingerprint)
              : undefined,
            event,
            actor: actorFrom(req),
          });
          log.info("agent_tunnel_event", {
            layer: "control-plane.tunnel",
            tenant_id: agent.tenant_id,
            agent_id: agent.id,
            event,
            state: agent.state,
            tunnel_state: agent.tunnel_state,
            correlation_id: correlation,
          });
          return send(res, 200, agent);
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (method === "GET" && /^\/v1\/agents\/[^/]+$/.test(path)) {
        const agentId = path.split("/")[3];
        const agent = await store.getAgent(agentId);
        if (!agent) return send(res, 404, { error: "agent_not_found" });
        return send(res, 200, agent);
      }

      if (method === "POST" && path === "/v1/registrations") {
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          const reg = await store.createRegistration({
            tenant_id: String(body.tenant_id || ""),
            display_name: String(body.display_name || ""),
            connectivity_type:
              (body.connectivity_type as "SERVICE" | "RESOURCE") || "SERVICE",
            destination_kind: String(
              body.destination_kind || "PLATFORM_SERVICE"
            ),
            host: body.host ? String(body.host) : undefined,
            port: body.port ? Number(body.port) : undefined,
            actor: actorFrom(req),
          });
          log.info("registration_created", {
            layer: "control-plane.registration",
            tenant_id: reg.tenant_id,
            registration_id: reg.id,
            state: reg.state,
            inbound_hostname: publicRegistration(reg, domain).inbound_hostname,
            correlation_id: correlation,
          });
          return send(res, 201, publicRegistration(reg, domain));
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (method === "GET" && /^\/v1\/registrations\/[^/]+$/.test(path)) {
        const registrationId = path.split("/")[3];
        const reg = await store.getRegistration(registrationId);
        if (!reg) return send(res, 404, { error: "registration_not_found" });
        return send(res, 200, publicRegistration(reg, domain));
      }

      if (
        method === "POST" &&
        /^\/v1\/registrations\/[^/]+\/delete$/.test(path)
      ) {
        const registrationId = path.split("/")[3];
        try {
          const reg = await store.deleteRegistration(
            registrationId,
            actorFrom(req)
          );
          return send(res, 200, publicRegistration(reg, domain));
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      // L3-REG-01: Failed → Validating → Provisioning → Active without
      // delete+recreate. Not dual-control (same posture as create/update —
      // recovery of the caller's own registration, not suspend/revoke).
      if (
        method === "POST" &&
        /^\/v1\/registrations\/[^/]+\/retry$/.test(path)
      ) {
        const registrationId = path.split("/")[3];
        try {
          const reg = await store.retryRegistration(
            registrationId,
            actorFrom(req)
          );
          log.info("registration_retried", {
            layer: "control-plane.registration",
            tenant_id: reg.tenant_id,
            registration_id: reg.id,
            state: reg.state,
            generation: reg.generation,
            correlation_id: correlation,
          });
          return send(res, 200, publicRegistration(reg, domain));
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      // L2 §A.2 Updating / §G.5 / §F.3: change an existing Active
      // registration's name and/or destination in place, instead of
      // delete+recreate. Only Active -> Updating -> Active is legal; any
      // failure restores the prior last-known-good fields (never half-applied).
      if (
        method === "POST" &&
        /^\/v1\/registrations\/[^/]+\/update$/.test(path)
      ) {
        const registrationId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          const reg = await store.updateRegistration(
            registrationId,
            {
              display_name:
                body.display_name !== undefined
                  ? String(body.display_name)
                  : undefined,
              host: body.host !== undefined ? String(body.host) : undefined,
              port: body.port !== undefined ? Number(body.port) : undefined,
            },
            actorFrom(req)
          );
          log.info("registration_updated", {
            layer: "control-plane.registration",
            tenant_id: reg.tenant_id,
            registration_id: reg.id,
            state: reg.state,
            generation: reg.generation,
            correlation_id: correlation,
          });
          return send(res, 200, publicRegistration(reg, domain));
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (
        method === "POST" &&
        /^\/v1\/registrations\/[^/]+\/observed$/.test(path)
      ) {
        const registrationId = path.split("/")[3];
        const body = JSON.parse(await readBody(req)) as Json;
        try {
          if (authz.role === "agent") {
            const existing = await store.getRegistration(registrationId);
            if (!existing || existing.tenant_id !== authz.tenantId) {
              return send(res, 403, { error: "tenant_mismatch" });
            }
          }
          const reg = await store.reportObserved(
            registrationId,
            String(body.agent_id || ""),
            {
              condition: String(body.condition || "Probe"),
              reachable: body.reachable as
                | "true"
                | "false"
                | "unknown"
                | undefined,
              observed_generation: Number(body.observed_generation || 0),
            },
            actorFrom(req)
          );
          return send(res, 200, publicRegistration(reg, domain));
        } catch (e) {
          return send(res, 400, { error: bad(e) });
        }
      }

      if (method === "GET" && path === "/v1/internal/agent-by-cert") {
        const fp = u.searchParams.get("cert_fingerprint") || "";
        if (!fp) return send(res, 400, { error: "cert_fingerprint_required" });
        // include_retired=1: Gateway's ReconcileSecurity (L2 §A.3) needs to find
        // a Retired agent BY cert to force-close its tunnel. The default lookup
        // excludes Retired/deleted agents on purpose (a new tunnel dial from a
        // retired cert must not rebind at accept time) -- that same exclusion
        // would make the Retired agent unfindable here, so callers that need to
        // detect "this cert belongs to a Retired agent" opt in explicitly.
        const includeRetired = u.searchParams.get("include_retired") === "1";
        const agent = includeRetired
          ? await store.findAgentByCertFingerprintAny(fp)
          : await store.findAgentByCertFingerprint(fp);
        if (!agent) return send(res, 404, { error: "agent_not_found" });
        return send(res, 200, {
          agent_id: agent.id,
          tenant_id: agent.tenant_id,
          state: agent.state,
          tunnel_state: agent.tunnel_state,
        });
      }

      if (method === "GET" && path === "/v1/internal/authz-context") {
        const ctx = await store.authzContext({
          tenant_id: u.searchParams.get("tenant_id") || "",
          registration_id: u.searchParams.get("registration_id") || undefined,
          cert_fingerprint: u.searchParams.get("cert_fingerprint") || undefined,
          agent_id: u.searchParams.get("agent_id") || undefined,
        });
        return send(res, 200, ctx);
      }

      return send(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        log.warn("http_payload_too_large", {
          layer: "control-plane.http",
          correlation_id: correlation,
        });
        return send(res, 413, { error: "payload_too_large" });
      }
      log.error("http_handler_error", {
        layer: "control-plane.http",
        error: bad(e),
        correlation_id: correlation,
      });
      return send(res, 500, { error: "internal_error" });
    }
  });
}
