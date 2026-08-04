#!/usr/bin/env bash
# Deploy optional Ambient waypoint (L7) for a Platform Service namespace.
# Spec §5.4: platform default for business-app namespaces; omit for pure batch/cron.
# Never use for Resource / DB pathways (B1–B4).
set -euo pipefail

NS="${1:-}"
CONTEXT="${KUBE_CONTEXT:-}"
ISTIOCTL="${ISTIOCTL:-istioctl}"

if [[ -z "$NS" ]]; then
  echo "Usage: $0 <namespace>" >&2
  exit 2
fi

ctx_args=()
if [[ -n "$CONTEXT" ]]; then
  ctx_args=(--context "$CONTEXT")
fi

kubectl "${ctx_args[@]}" get ns "$NS" >/dev/null
# Ensure ambient enrollment first
kubectl "${ctx_args[@]}" label namespace "$NS" istio.io/dataplane-mode=ambient --overwrite

if command -v "$ISTIOCTL" >/dev/null 2>&1; then
  echo "==> istioctl waypoint apply -n $NS"
  "$ISTIOCTL" "${ctx_args[@]}" waypoint apply -n "$NS"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "==> istioctl not found; applying example waypoint manifest (edit name/ns as needed)"
  sed "s/NAMESPACE_PLACEHOLDER/$NS/g" "$SCRIPT_DIR/waypoint.example.yaml" | kubectl "${ctx_args[@]}" apply -f -
fi

kubectl "${ctx_args[@]}" -n "$NS" get gateway,svc,deploy -l istio.io/gateway-name 2>/dev/null || \
  kubectl "${ctx_args[@]}" -n "$NS" get pods | grep -i waypoint || true

echo "OK waypoint requested for ns=$NS (A1/A2/A3 L7 only)."
