/**
 * L3-EVID-01: fetch OIDC discovery document and resolve jwks_uri.
 * Used when PUT /v1/tenants/:id/workload-evidence sets kubernetes_oidc + issuer.
 */

export type DiscoveryResult =
  | { ok: true; issuer: string; jwks_uri: string }
  | { ok: false; error: string };

export async function discoverOidcIssuer(
  issuerUrl: string,
  opts?: { caBundlePem?: string | null; timeoutMs?: number }
): Promise<DiscoveryResult> {
  const base = issuerUrl.replace(/\/$/, "");
  const discoveryUrl = `${base}/.well-known/openid-configuration`;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(discoveryUrl, {
        method: "GET",
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
        // Node 18+ fetch; custom CA for private JWKS hosts is Phase-2
        // (oidc_ca_bundle_pem stored for Gateway TLS). Discovery probe uses
        // the process trust store; private clusters use JWKS proxy / allowlist.
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `discovery_http_${res.status}: ${discoveryUrl}`,
      };
    }
    const body = (await res.json()) as {
      issuer?: string;
      jwks_uri?: string;
    };
    const jwks = body.jwks_uri?.trim();
    if (!jwks) {
      return { ok: false, error: "discovery_missing_jwks_uri" };
    }
    return {
      ok: true,
      issuer: (body.issuer || base).replace(/\/$/, ""),
      jwks_uri: jwks,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `discovery_failed: ${msg}` };
  }
}
