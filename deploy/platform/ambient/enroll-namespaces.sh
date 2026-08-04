#!/usr/bin/env bash
# Label Platform namespaces for Istio Ambient dataplane (ztunnel interception).
# Usage: ./enroll-namespaces.sh <ns1> [ns2 ...]
# Typical: fabric-control (Gateway) + namespaces hosting Platform Services / Connectors.
set -euo pipefail

CONTEXT="${KUBE_CONTEXT:-}"
ctx_args=()
if [[ -n "$CONTEXT" ]]; then
  ctx_args=(--context "$CONTEXT")
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <namespace> [namespace...]" >&2
  echo "Example: $0 fabric-control 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c" >&2
  exit 2
fi

for ns in "$@"; do
  kubectl "${ctx_args[@]}" get ns "$ns" >/dev/null
  # Ambient L4 enrollment (required for ztunnel on A1/A2/A3/B1/B4 hops in that ns)
  kubectl "${ctx_args[@]}" label namespace "$ns" istio.io/dataplane-mode=ambient --overwrite
  echo "enrolled namespace=$ns dataplane-mode=ambient"
done

echo "OK. Optional L7: ./deploy/platform/ambient/waypoint-apply.sh <service-namespace>"
echo "    Do NOT apply waypoints for Resource-only / DB namespaces (B1/B4 never use waypoint)."
