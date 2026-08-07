#!/usr/bin/env bash
# Enable Kubernetes service-account OIDC discovery for workload evidence
# (L3-EVID-01 / kubernetes_oidc). Audience tokens use: abluva-connect
#
# Usage: ./enable-oidc-eks.sh <issuer-url>
# Example issuer: https://oidc.eks.<region>.amazonaws.com/id/<HASH>
#
# After this script: register issuer in Tenant UI / API:
#   PUT /v1/tenants/:id/workload-evidence
#   { "strategy":"kubernetes_oidc", "oidc_issuer_url":"<issuer-url>" }
set -euo pipefail

ISSUER="${1:-}"
if [[ -z "$ISSUER" ]]; then
  echo "usage: $0 <oidc-issuer-url>" >&2
  exit 1
fi

echo "==> EKS: ensure cluster OIDC provider is associated (IAM / eksctl)"
echo "    eksctl utils associate-iam-oidc-provider --cluster <name> --approve"
echo "    Issuer should already serve:"
echo "      ${ISSUER}/.well-known/openid-configuration"
echo "      ${ISSUER}/openid/v1/jwks   (or jwks_uri from discovery)"
echo
echo "==> Projected SA tokens for callers (audience abluva-connect):"
cat <<'EOF'
# On consumer Deployments that dial connect-agent (or Agent sidecar share):
volumeMounts:
  - name: abluva-evidence
    mountPath: /var/run/abluva/evidence
    readOnly: true
volumes:
  - name: abluva-evidence
    projected:
      sources:
        - serviceAccountToken:
            path: token
            audience: abluva-connect
            expirationSeconds: 3600
EOF
echo
echo "==> Platform must reach JWKS (public issuer, or JWKS proxy / IP allowlist)."
echo "==> Then: PUT workload-evidence with strategy=kubernetes_oidc and this issuer."
echo "Done (manual steps printed)."
