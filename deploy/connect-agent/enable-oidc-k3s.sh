#!/usr/bin/env bash
# k3s (incl. Fabric VM k3s appliance): same kubernetes_oidc strategy as EKS/RKE2.
# Usage: ./enable-oidc-k3s.sh <public-issuer-url>
# On appliance nodes, edit /etc/rancher/k3s/config.yaml then restart k3s.
set -euo pipefail
ISSUER="${1:-}"
if [[ -z "$ISSUER" ]]; then
  echo "usage: $0 <public-issuer-url>" >&2
  exit 1
fi
JWKS="${ISSUER%/}/openid/v1/jwks"
echo "==> Write /etc/rancher/k3s/config.yaml (merge with existing keys):"
cat <<EOF
kube-apiserver-arg:
  - "anonymous-auth=true"
  - "service-account-issuer=${ISSUER}"
  - "service-account-jwks-uri=${JWKS}"
EOF
echo
echo "==> systemctl restart k3s   # or k3s-server"
echo "==> kubectl create clusterrolebinding fabric-sa-issuer-discovery \\"
echo "      --clusterrole=system:service-account-issuer-discovery \\"
echo "      --group=system:unauthenticated"
echo
echo "Note: VM install flavor still uses strategy kubernetes_oidc when Agent runs on k3s."
echo "Register: PUT /v1/tenants/:id/workload-evidence"
echo "  {\"strategy\":\"kubernetes_oidc\",\"oidc_issuer_url\":\"${ISSUER}\"}"
