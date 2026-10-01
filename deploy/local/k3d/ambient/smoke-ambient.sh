#!/usr/bin/env bash
# Optional Platform Ambient smoke (A1 Service + B1 Resource L4 path).
#
# Needs a Kubernetes cluster that plays the *Platform* role (not the tenant
# k3d cluster). Typical laptop:
#   k3d cluster create fabric-platform
#   export KUBE_CONTEXT=k3d-fabric-platform
#   ./deploy/local/k3d/ambient/smoke-ambient.sh
#
# On Linux/OCI the same script works — install-ambient.sh auto-detects k3s
# (cniConfDir + cniBinDir) and downloads the correct linux-{amd64,arm64} istioctl.
#
# What this proves (Spec §8.1 / §8.5):
#   A1: client → server HTTP over Ambient-enrolled namespace (ztunnel L4;
#       optional waypoint L7 when FABRIC_AMBIENT_WAYPOINT=1)
#   B1: client → TCP "resource" (nc) over Ambient L4 only — no waypoint
#
# This does NOT involve Gateway or Connect Agent (by Spec).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CONTEXT="${KUBE_CONTEXT:-}"
NS="${FABRIC_AMBIENT_NS:-3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c}"
WITH_WAYPOINT="${FABRIC_AMBIENT_WAYPOINT:-1}"
ISTIOCTL="${ISTIOCTL:-}"

ctx_args=()
if [[ -n "$CONTEXT" ]]; then
  ctx_args=(--context "$CONTEXT")
fi

echo "==> Ambient smoke (platform cluster context=${CONTEXT:-current} ns=$NS)"

echo "==> install Ambient (idempotent-ish; re-run install if CNI was misconfigured)"
export KUBE_CONTEXT="${CONTEXT}"
export ISTIOCTL
"$ROOT/deploy/platform/ambient/install-ambient.sh"

echo "==> enroll namespace $NS"
kubectl "${ctx_args[@]}" create namespace "$NS" --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -
"$ROOT/deploy/platform/ambient/enroll-namespaces.sh" "$NS"

if [[ "$WITH_WAYPOINT" = "1" ]]; then
  echo "==> optional waypoint for A1 L7 ($NS)"
  if [[ -z "$ISTIOCTL" ]]; then
    ISTIOCTL="${XDG_CACHE_HOME:-$HOME/.cache}/ablv-fabric/istio-${ISTIO_VERSION:-1.24.2}/bin/istioctl"
  fi
  if [[ -x "$ISTIOCTL" ]]; then
    export ISTIOCTL
  fi
  "$ROOT/deploy/platform/ambient/waypoint-apply.sh" "$NS" || true
fi

"$ROOT/deploy/platform/ambient/verify-ambient.sh"

echo "==> deploy A1 echo server + client (SERVICE) and B1 TCP echo (RESOURCE-shaped)"
kubectl "${ctx_args[@]}" -n "$NS" apply -f - <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: a1-echo
  labels:
    app: a1-echo
spec:
  selector:
    app: a1-echo
  ports:
    - name: http
      port: 80
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: a1-echo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: a1-echo
  template:
    metadata:
      labels:
        app: a1-echo
    spec:
      containers:
        - name: echo
          image: hashicorp/http-echo:1.0
          args: ["-text=fabric-a1-ambient-ok", "-listen=:8080"]
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: b1-tcp
  labels:
    app: b1-tcp
spec:
  selector:
    app: b1-tcp
  ports:
    - name: tcp
      port: 9999
      targetPort: 9999
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: b1-tcp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: b1-tcp
  template:
    metadata:
      labels:
        app: b1-tcp
    spec:
      containers:
        - name: tcp
          image: busybox:1.36
          command: ["/bin/sh", "-c"]
          args:
            - |
              while true; do
                echo -n "fabric-b1-ambient-ok" | nc -l -p 9999 -w 1 || true
              done
          ports:
            - containerPort: 9999
YAML

kubectl "${ctx_args[@]}" -n "$NS" rollout status deploy/a1-echo --timeout=180s
kubectl "${ctx_args[@]}" -n "$NS" rollout status deploy/b1-tcp --timeout=180s

echo "==> A1: curl a1-echo from an Ambient-enrolled client pod"
kubectl "${ctx_args[@]}" -n "$NS" delete pod a1-client --ignore-not-found --wait=true >/dev/null 2>&1 || true
kubectl "${ctx_args[@]}" -n "$NS" run a1-client --restart=Never --image=curlimages/curl:8.5.0 --command -- sleep 300
kubectl "${ctx_args[@]}" -n "$NS" wait --for=condition=Ready pod/a1-client --timeout=120s
# Give ztunnel a beat to claim the new pod
sleep 3
out=$(kubectl "${ctx_args[@]}" -n "$NS" exec a1-client -- curl -sf --connect-timeout 5 --max-time 10 http://a1-echo.$NS.svc.cluster.local/ || true)
echo "a1_body=$out"
echo "$out" | grep -q fabric-a1-ambient-ok || {
  echo "FAIL: A1 ambient HTTP path"
  kubectl "${ctx_args[@]}" -n ambient-plane get pods
  kubectl "${ctx_args[@]}" -n "$NS" get pods -o wide
  exit 1
}
echo "OK A1 Platform Service → Platform Service via Ambient (ztunnel L4; waypoint if provisioned)"

echo "==> B1: TCP dial b1-tcp (Resource-shaped; L4 only — no waypoint required)"
kubectl "${ctx_args[@]}" -n "$NS" delete pod b1-client --ignore-not-found --wait=true >/dev/null 2>&1 || true
kubectl "${ctx_args[@]}" -n "$NS" run b1-client --restart=Never --image=busybox:1.36 --command -- sleep 300
kubectl "${ctx_args[@]}" -n "$NS" wait --for=condition=Ready pod/b1-client --timeout=120s
sleep 3
bout=$(kubectl "${ctx_args[@]}" -n "$NS" exec b1-client -- sh -c 'echo | nc -w 3 b1-tcp 9999' || true)
echo "b1_body=$bout"
echo "$bout" | grep -q fabric-b1-ambient-ok || {
  echo "FAIL: B1 ambient TCP path"
  kubectl "${ctx_args[@]}" -n "$NS" get pods -o wide
  exit 1
}
echo "OK B1 Platform Service → Platform Resource-shaped TCP via Ambient L4 (no waypoint)"

# Show ztunnel saw traffic if logs are available (best-effort)
kubectl "${ctx_args[@]}" -n ambient-plane logs -l app=ztunnel --tail=5 2>/dev/null | head -5 || true

echo "OK ambient smoke: A1 + B1 on platform cluster"
