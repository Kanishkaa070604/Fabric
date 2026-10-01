#!/usr/bin/env bash
# Verify Platform Ambient (ztunnel / CNI / optional waypoints) for mesh Day-0.
set -euo pipefail

CONTEXT="${KUBE_CONTEXT:-}"
ctx_args=()
if [[ -n "$CONTEXT" ]]; then
  ctx_args=(--context "$CONTEXT")
fi

fail=0

check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "PASS  $desc"
  else
    echo "FAIL  $desc"
    fail=1
  fi
}

echo "==> Ambient verify (platform cluster)"

check "ambient-plane exists" kubectl "${ctx_args[@]}" get ns ambient-plane
check "ztunnel DaemonSet present" kubectl "${ctx_args[@]}" -n ambient-plane get ds ztunnel
check "ztunnel pods Ready" bash -c 'n=$(kubectl '"${ctx_args[*]}"' -n ambient-plane get ds ztunnel -o jsonpath="{.status.numberReady}"); test -n "$n" && test "$n" -gt 0'
check "istio-cni present" kubectl "${ctx_args[@]}" -n ambient-plane get ds istio-cni-node

echo ""
echo "==> Ambient-enrolled namespaces (istio.io/dataplane-mode=ambient)"
kubectl "${ctx_args[@]}" get ns -l istio.io/dataplane-mode=ambient -o custom-columns=NAME:.metadata.name,MODE:.metadata.labels.istio\\.io/dataplane-mode 2>/dev/null \
  || kubectl "${ctx_args[@]}" get ns --show-labels | grep dataplane-mode=ambient || echo "(none labeled yet)"

echo ""
echo "==> Waypoints (optional L7 — Services only)"
kubectl "${ctx_args[@]}" get gateway -A 2>/dev/null | grep -i waypoint || echo "(no waypoints found — OK if namespaces are L4-only)"

echo ""
if [[ $fail -ne 0 ]]; then
  echo "VERIFY FAILED — Ambient not ready for A1/A2/A3/B1/B4 Platform hops"
  exit 1
fi
echo "OK Ambient baseline healthy"
echo "  Pathways needing ztunnel: A1, A2 (after GW), A3 (before GW), B1, B4"
echo "  Pathways with no Ambient: A4, B2, B3 (and never Customer clusters)"
