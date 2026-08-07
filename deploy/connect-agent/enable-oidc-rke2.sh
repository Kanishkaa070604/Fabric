#!/usr/bin/env bash
# RKE2: expose SA issuer discovery for Fabric kubernetes_oidc (L3-EVID-01).
# Usage: ./enable-oidc-rke2.sh <public-issuer-url>
set -euo pipefail
ISSUER="${1:-}"
if [[ -z "$ISSUER" ]]; then
  echo "usage: $0 <public-issuer-url>" >&2
  exit 1
fi
JWKS="${ISSUER%/}/openid/v1/jwks"
echo "==> Add to RKE2 server config (then restart rke2-server):"
cat <<EOF
kube-apiserver-arg:
  - "service-account-issuer=${ISSUER}"
  - "service-account-jwks-uri=${JWKS}"
  - "anonymous-auth=true"
EOF
echo
echo "==> Allow unauthenticated discovery (once API is up):"
echo "kubectl create clusterrolebinding fabric-sa-issuer-discovery \\"
echo "  --clusterrole=system:service-account-issuer-discovery \\"
echo "  --group=system:unauthenticated"
echo
echo "==> Register in Fabric: PUT .../workload-evidence strategy=kubernetes_oidc issuer=${ISSUER}"
