#!/usr/bin/env bash
# ============================================================
# Platform Day 0 — Fabric + abluva-infra-api (platform ops only)
#
# PRODUCTION LAYOUT
#   Put this script at the workspace root. Under that root, check out both
#   repos as siblings:
#
#   <ROOT>/
#   ├── day-0.sh                         ← run from here:  ./day-0.sh
#   ├── Fabric/                          ← this repo (name may be fabric.v3 in dev)
#   │   └── deploy/platform/day0.sh      ← step [1/2]
#   └── saas-control-plane/
#       └── infra-discovery/abluva-infra-api/k8s/
#           └── kustomization.yaml       ← step [2/2]
#
# RUN
#   cd <ROOT>
#   ./day-0.sh
#
# STEPS
#   [1/2] Fabric/deploy/platform/day0.sh
#         PKI → Secrets → Fabric/deploy/k8s → Ambient
#   [2/2] kubectl apply abluva-infra-api/k8s overlay
#
# OUT OF SCOPE
#   SQL, NLB, public DNS, imagePullSecrets
#   Tenant Connect Agent / launcher (secure-agent-net README — not Day 0)
#
# OPTIONAL OVERRIDES (dev only — not needed in production siblings layout)
#   FABRIC_ROOT=…  INFRA_API_K8S=…  DAY0_ROOT=…
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Workspace ROOT = directory that contains Fabric/ and saas-control-plane/.
# If this file was copied into the Fabric checkout, ROOT is the parent.
if [[ -n "${DAY0_ROOT:-}" ]]; then
  ROOT="$(cd "$DAY0_ROOT" && pwd)"
elif [[ -f "$HERE/deploy/platform/day0.sh" ]]; then
  ROOT="$(cd "$HERE/.." && pwd)"
else
  ROOT="$HERE"
fi

# Fabric checkout (production: <ROOT>/Fabric)
FABRIC="${FABRIC_ROOT:-}"
if [[ -z "$FABRIC" ]]; then
  for d in "$ROOT/Fabric" "$ROOT/fabric.v3" "$HERE"; do
    if [[ -f "$d/deploy/platform/day0.sh" ]]; then
      FABRIC="$(cd "$d" && pwd)"
      break
    fi
  done
fi

# abluva-infra-api k8s (production: <ROOT>/saas-control-plane/.../k8s)
INFRA_K8S="${INFRA_API_K8S:-}"
if [[ -z "$INFRA_K8S" ]]; then
  candidate="$ROOT/saas-control-plane/infra-discovery/abluva-infra-api/k8s"
  if [[ -f "$candidate/kustomization.yaml" ]]; then
    INFRA_K8S="$(cd "$candidate" && pwd)"
  fi
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing required tool: $1" >&2
    exit 1
  }
}
need kubectl

fail() {
  echo "ERROR: $1" >&2
  echo "" >&2
  echo "Production layout under <ROOT>:" >&2
  echo "  <ROOT>/day-0.sh" >&2
  echo "  <ROOT>/Fabric/deploy/platform/day0.sh" >&2
  echo "  <ROOT>/saas-control-plane/infra-discovery/abluva-infra-api/k8s/kustomization.yaml" >&2
  echo "" >&2
  echo "Then:  cd <ROOT> && ./day-0.sh" >&2
  exit 1
}

[[ -n "$FABRIC" && -f "$FABRIC/deploy/platform/day0.sh" ]] \
  || fail "Fabric/ not found under $ROOT (expected $ROOT/Fabric)"
[[ -n "$INFRA_K8S" && -f "$INFRA_K8S/kustomization.yaml" ]] \
  || fail "saas-control-plane/.../abluva-infra-api/k8s not found under $ROOT"

echo "==> Platform Day 0 (Fabric + abluva-infra-api)"
echo "    ROOT:       $ROOT"
echo "    Fabric:     $FABRIC"
echo "    infra-api:  $INFRA_K8S"
echo ""

echo "==> [1/2] Fabric platform Day 0"
echo "    $FABRIC/deploy/platform/day0.sh"
"$FABRIC/deploy/platform/day0.sh"

echo ""
echo "==> [2/2] abluva-infra-api k8s overlay"
echo "    $INFRA_K8S"
kubectl kustomize --load-restrictor=LoadRestrictionsNone "$INFRA_K8S" \
  | kubectl apply -f -

echo ""
echo "==> Platform Day 0 complete"
echo ""
echo "Next (not this script):"
echo "  - SQL / NLB / DNS — docs/Operational-Runbook.md"
echo "  - Tenant Connect — secure-agent-net README"
echo ""
