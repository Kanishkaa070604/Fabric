#!/usr/bin/env bash
# Install Istio Ambient on the Platform Kubernetes cluster (ztunnel + CNI + istiod).
# Spec §5.4 / L2 §B.1. Never run this against a Customer Environment cluster.
set -euo pipefail

ISTIO_VERSION="${ISTIO_VERSION:-1.24.2}"
CONTEXT="${KUBE_CONTEXT:-}"

ctx_args=()
if [[ -n "$CONTEXT" ]]; then
  ctx_args=(--context "$CONTEXT")
fi

echo "==> Platform Ambient install (Istio ${ISTIO_VERSION})"
echo "    Components: istiod, istio-cni, ztunnel"
echo "    Do NOT install on Customer Agent clusters."

resolve_istioctl() {
  if [[ -n "${ISTIOCTL:-}" && -x "${ISTIOCTL}" ]]; then
    echo "$ISTIOCTL"
    return
  fi
  if command -v istioctl >/dev/null 2>&1; then
    command -v istioctl
    return
  fi
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/ablv-fabric/istio-${ISTIO_VERSION}"
  if [[ -x "$cache/bin/istioctl" ]]; then
    echo "$cache/bin/istioctl"
    return
  fi
  echo "==> Downloading Istio ${ISTIO_VERSION} to $cache" >&2
  mkdir -p "$(dirname "$cache")"
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  # Istio's release asset naming uses "osx" for macOS, not the raw `uname -s`
  # value ("darwin") -- getting this wrong 404s the download on every Mac.
  case "$os" in
    darwin) os=osx ;;
  esac
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
  esac
  local url="https://github.com/istio/istio/releases/download/${ISTIO_VERSION}/istio-${ISTIO_VERSION}-${os}-${arch}.tar.gz"
  local tgz
  tgz="$(mktemp)"
  curl -fsSL -o "$tgz" "$url"
  rm -rf "$cache"
  mkdir -p "$cache"
  tar -xzf "$tgz" -C "$cache" --strip-components=1
  rm -f "$tgz"
  echo "$cache/bin/istioctl"
}

ISTIOCTL_BIN="$(resolve_istioctl)"
echo "==> Using $ISTIOCTL_BIN ($("$ISTIOCTL_BIN" version --remote=false 2>/dev/null | head -1 || true))"

kubectl "${ctx_args[@]}" create namespace "${AMBIENT_PLANE_NAMESPACE:-ambient-plane}" --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AMBIENT_NS="${AMBIENT_PLANE_NAMESPACE:-ambient-plane}"
if [[ -f "$SCRIPT_DIR/psa-ambient-plane.example.yaml" ]]; then
  kubectl "${ctx_args[@]}" apply -f "$SCRIPT_DIR/psa-ambient-plane.example.yaml"
fi

# k3s (and therefore k3d) puts CNI config and binaries in non-default paths.
# Without both overrides:
#   - install-cni waits forever: "no networks found in /host/etc/cni/net.d"
#   - new pods fail sandbox create: 'failed to find plugin "istio-cni" in path [/bin]'
#     because k3s containerd's cni.bin_dir is /bin, while istio-cni defaults to
#     installing into /opt/cni/bin. istioctl's ambient profile has no k3s-aware
#     default for either. Same on Mac Docker Desktop k3d and on Linux/OCI k3s.
cni_set=()
if kubectl "${ctx_args[@]}" get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}' 2>/dev/null | grep -q '+k3s'; then
  echo "==> detected k3s node(s) -- overriding cni.cniConfDir + cni.cniBinDir for k3s"
  cni_set=(
    --set values.cni.cniConfDir=/var/lib/rancher/k3s/agent/etc/cni/net.d
    --set values.cni.cniBinDir=/bin
  )
fi

echo "==> istioctl install --set profile=ambient --set values.global.istioNamespace=${AMBIENT_NS}"
"$ISTIOCTL_BIN" "${ctx_args[@]}" install --set profile=ambient --set "values.global.istioNamespace=${AMBIENT_NS}" "${cni_set[@]}" --skip-confirmation

echo "==> Waiting for ztunnel DaemonSet"
kubectl "${ctx_args[@]}" -n "$AMBIENT_NS" rollout status ds/ztunnel --timeout=180s
kubectl "${ctx_args[@]}" -n "$AMBIENT_NS" get ds ztunnel
kubectl "${ctx_args[@]}" -n "$AMBIENT_NS" get pods -l app=ztunnel

echo "OK Ambient installed. Next:"
echo "  ./deploy/platform/ambient/enroll-namespaces.sh fabric-control 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c"
echo "  ./deploy/platform/ambient/verify-ambient.sh"
