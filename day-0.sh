#!/usr/bin/env bash
# ============================================================
# Platform Day 0 — run from the workspace ROOT:
#
#   ./day-0.sh
#
# Expected layout at that root:
#   Fabric/                                              this repo
#   saas-control-plane/infra-discovery/abluva-infra-api/k8s/kustomization.yaml
#
# 1) Fabric: secrets + Fabric/deploy/k8s (+ Ambient)
# 2) kustomize apply of the infra-api k8s overlay
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$HERE/deploy/platform/day0.sh" ]]; then
  ROOT="$(cd "$HERE/.." && pwd)"
else
  ROOT="$HERE"
fi

FABRIC=""
for d in "$ROOT/Fabric" "$ROOT/fabric.v3" "$HERE"; do
  if [[ -f "$d/deploy/platform/day0.sh" ]]; then
    FABRIC="$d"
    break
  fi
done
INFRA_K8S="$ROOT/saas-control-plane/infra-discovery/abluva-infra-api/k8s"

if [[ -z "$FABRIC" ]]; then
  echo "ERROR: Fabric checkout not found (expected $ROOT/Fabric)" >&2
  exit 1
fi
if [[ ! -f "$INFRA_K8S/kustomization.yaml" ]]; then
  echo "ERROR: missing $INFRA_K8S/kustomization.yaml" >&2
  echo "       Run ./day-0.sh from the root that contains Fabric/ and saas-control-plane/" >&2
  exit 1
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing required tool: $1" >&2
    exit 1
  }
}
need kubectl

echo "==> Day 0 (root=$ROOT)"
echo "    Fabric:     $FABRIC"
echo "    infra-api:  $INFRA_K8S"
echo ""

echo "==> [1/2] Fabric (secrets + ${FABRIC##*/}/deploy/k8s)"
"$FABRIC/deploy/platform/day0.sh"

echo ""
echo "==> [2/2] kubectl kustomize $INFRA_K8S"
kubectl kustomize --load-restrictor=LoadRestrictionsNone "$INFRA_K8S" \
  | kubectl apply -f -

echo ""
echo "==> Day 0 complete"
