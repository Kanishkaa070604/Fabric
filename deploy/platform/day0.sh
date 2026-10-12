#!/usr/bin/env bash
# ============================================================
# Fabric platform Day 0 (certs, Secrets, Gateway / CP / dns-webhook, Ambient).
#
# Fabric platform Day 0 (certs, Secrets, Gateway / CP / dns-webhook, Ambient).
#
# Called from the workspace root by ./day-0.sh (see that script).
# You can also run this file directly from anywhere; paths are relative
# to this checkout, not to cwd.
#
# No SQL, no NLB, no Cloudflare, no infra-api YAML (that is ./day-0.sh).
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FABRIC_ROOT="$(cd "$ROOT/../.." && pwd)"
FABRIC_NAME="$(basename "$FABRIC_ROOT")"

if [[ ! -f "$FABRIC_ROOT/deploy/k8s/kustomization.yaml" ]]; then
  echo "ERROR: expected ${FABRIC_NAME}/deploy/k8s/kustomization.yaml" >&2
  exit 1
fi


FABRIC_CONTROL_NAMESPACE="${FABRIC_CONTROL_NAMESPACE:-fabric-control}"
SAAS_NAMESPACE="${SAAS_NAMESPACE:-3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c}"
AMBIENT_PLANE_NAMESPACE="${AMBIENT_PLANE_NAMESPACE:-ambient-plane}"
FABRIC_EDGE_NAMESPACE="${FABRIC_EDGE_NAMESPACE:-fabric-edge}"
FABRIC_NAMESPACE="${FABRIC_NAMESPACE:-$FABRIC_CONTROL_NAMESPACE}"

FABRIC_GATEWAY_HOSTNAME="${FABRIC_GATEWAY_HOSTNAME:-fabric.abluva.com}"
FABRIC_INBOUND_DOMAIN="${FABRIC_INBOUND_DOMAIN:-connect.abluva.com}"
PKI_DIR="${PKI_DIR:-$HOME/fabric-pki}"
SKIP_AMBIENT="${SKIP_AMBIENT:-0}"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"
FORCE_PKI="${FORCE_PKI:-0}"
ISTIO_VERSION="${ISTIO_VERSION:-1.24.2}"

ctx_args=()
if [[ -n "${KUBE_CONTEXT:-}" ]]; then
  ctx_args=(--context "$KUBE_CONTEXT")
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing required tool: $1" >&2
    exit 1
  }
}

need kubectl
need openssl
kubectl "${ctx_args[@]}" cluster-info >/dev/null

ABLV_PLATFORM_TENANT_ID="${ABLV_PLATFORM_TENANT_ID:-${SAAS_NAMESPACE:0:36}}"
ABLV_PLATFORM_ENVIRONMENT_ID="${ABLV_PLATFORM_ENVIRONMENT_ID:-5620f907-0281-497d-9098-8cfed51f5be1}"
export ABLV_PLATFORM_TENANT_ID ABLV_PLATFORM_ENVIRONMENT_ID

echo "==> Fabric platform Day 0"
echo "    Fabric tree:    ${FABRIC_NAME}/  ($FABRIC_ROOT)"
echo "    cluster:        $(kubectl "${ctx_args[@]}" config current-context 2>/dev/null || echo unknown)"
echo "    fabric-control: $FABRIC_CONTROL_NAMESPACE"
echo "    SaaS ns:        $SAAS_NAMESPACE"
echo "    tenant_id:      $ABLV_PLATFORM_TENANT_ID"
echo "    environment_id: $ABLV_PLATFORM_ENVIRONMENT_ID"
echo "    PKI dir:        $PKI_DIR"
echo "    gateway SAN:    $FABRIC_GATEWAY_HOSTNAME"
echo ""

mkdir -p "$PKI_DIR"

write_if_missing() {
  local path="$1"
  if [[ -f "$path" && "$FORCE_PKI" != "1" ]]; then
    echo "    keep $path"
    return 1
  fi
  return 0
}

echo "==> [1/5] Certificates"
if write_if_missing "$PKI_DIR/agent-ca.crt" || write_if_missing "$PKI_DIR/agent-ca.key"; then
  openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
    -keyout "$PKI_DIR/agent-ca.key" -out "$PKI_DIR/agent-ca.crt" \
    -subj "/CN=fabric-edge-ca" >/dev/null
  chmod 600 "$PKI_DIR/agent-ca.key"
  echo "    wrote Agent CA"
else
  echo "    Agent CA already present"
fi

if write_if_missing "$PKI_DIR/gateway.crt" || write_if_missing "$PKI_DIR/gateway.key"; then
  openssl req -newkey rsa:4096 -nodes -keyout "$PKI_DIR/gateway.key" \
    -subj "/CN=${FABRIC_GATEWAY_HOSTNAME}" -out "$PKI_DIR/gateway.csr" >/dev/null
  openssl x509 -req -in "$PKI_DIR/gateway.csr" -signkey "$PKI_DIR/gateway.key" \
    -out "$PKI_DIR/gateway.crt" -days 365 \
    -extfile <(printf "subjectAltName=DNS:%s" "$FABRIC_GATEWAY_HOSTNAME") >/dev/null
  rm -f "$PKI_DIR/gateway.csr"
  chmod 600 "$PKI_DIR/gateway.key"
  echo "    wrote Gateway TLS (SAN DNS:${FABRIC_GATEWAY_HOSTNAME})"
else
  echo "    Gateway TLS already present"
fi

if write_if_missing "$PKI_DIR/inbound.crt" || write_if_missing "$PKI_DIR/inbound.key"; then
  openssl req -newkey rsa:4096 -nodes -keyout "$PKI_DIR/inbound.key" \
    -subj "/CN=*.${FABRIC_INBOUND_DOMAIN}" -out "$PKI_DIR/inbound.csr" >/dev/null
  openssl x509 -req -in "$PKI_DIR/inbound.csr" -signkey "$PKI_DIR/inbound.key" \
    -out "$PKI_DIR/inbound.crt" -days 365 \
    -extfile <(printf "subjectAltName=DNS:*.%s,DNS:*.%s.%s,DNS:%s" \
      "$FABRIC_INBOUND_DOMAIN" "$ABLV_PLATFORM_TENANT_ID" "$FABRIC_INBOUND_DOMAIN" "$FABRIC_INBOUND_DOMAIN") >/dev/null
  rm -f "$PKI_DIR/inbound.csr"
  chmod 600 "$PKI_DIR/inbound.key"
  echo "    wrote inbound TLS (*.${FABRIC_INBOUND_DOMAIN})"
else
  echo "    inbound TLS already present"
fi

FABRIC_AGENT_CA_CERT_FILE="$PKI_DIR/agent-ca.crt"
FABRIC_AGENT_CA_KEY_FILE="$PKI_DIR/agent-ca.key"
FABRIC_GATEWAY_CERT_FILE="$PKI_DIR/gateway.crt"
FABRIC_GATEWAY_KEY_FILE="$PKI_DIR/gateway.key"
FABRIC_GATEWAY_CA_FILE="$PKI_DIR/agent-ca.crt"
FABRIC_GATEWAY_INBOUND_CERT_FILE="$PKI_DIR/inbound.crt"
FABRIC_GATEWAY_INBOUND_KEY_FILE="$PKI_DIR/inbound.key"

echo ""
echo "==> [2/5] Namespaces + Secrets"
for ns in \
  "$FABRIC_CONTROL_NAMESPACE" \
  "$SAAS_NAMESPACE" \
  "$AMBIENT_PLANE_NAMESPACE"
do
  kubectl "${ctx_args[@]}" get ns "$ns" >/dev/null 2>&1 || kubectl "${ctx_args[@]}" create ns "$ns"
done
kubectl "${ctx_args[@]}" label ns "$SAAS_NAMESPACE" abluva.io/saas=true --overwrite

WRITER_TOKEN="${FABRIC_CONTROL_PLANE_TOKEN:-$(openssl rand -hex 24)}"
DUAL_TOKEN="${FABRIC_DUAL_CONTROL_TOKEN:-$(openssl rand -hex 24)}"
GATEWAY_CONTROL_TOKEN="${FABRIC_GATEWAY_CONTROL_TOKEN:-$(openssl rand -hex 24)}"
REVOKE_PUSH_TOKEN="${FABRIC_REVOKE_PUSH_TOKEN:-$(openssl rand -hex 24)}"

kubectl "${ctx_args[@]}" -n "$SAAS_NAMESPACE" create secret generic fabric-control-plane-auth \
  --from-literal=bearer_token="$WRITER_TOKEN" \
  --from-literal=dual_control_token="$DUAL_TOKEN" \
  --from-literal=gateway_control_token="$GATEWAY_CONTROL_TOKEN" \
  --from-literal=revoke_push_token="$REVOKE_PUSH_TOKEN" \
  --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -

kubectl "${ctx_args[@]}" -n "$FABRIC_CONTROL_NAMESPACE" create secret generic fabric-gateway-auth \
  --from-literal=gateway_control_token="$GATEWAY_CONTROL_TOKEN" \
  --from-literal=revoke_push_token="$REVOKE_PUSH_TOKEN" \
  --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -

for ns in "$FABRIC_CONTROL_NAMESPACE" "$SAAS_NAMESPACE"; do
  kubectl "${ctx_args[@]}" -n "$ns" create secret generic fabric-platform-ids \
    --from-literal=tenant_id="$ABLV_PLATFORM_TENANT_ID" \
    --from-literal=environment_id="$ABLV_PLATFORM_ENVIRONMENT_ID" \
    --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -
done

if [[ -n "${CERT_EXPIRY_WEBHOOK_URL:-}" ]]; then
  kubectl "${ctx_args[@]}" -n "$SAAS_NAMESPACE" create secret generic fabric-cert-expiry-webhook \
    --from-literal=url="$CERT_EXPIRY_WEBHOOK_URL" \
    --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -
fi

DNS_TOKEN="${DNS_WEBHOOK_TOKEN:-$(openssl rand -hex 24)}"
DNS_URL="${FABRIC_DNS_WEBHOOK_URL:-http://fabric-dns-webhook.${SAAS_NAMESPACE}.svc:8090}"
kubectl "${ctx_args[@]}" -n "$SAAS_NAMESPACE" create secret generic fabric-dns-webhook \
  --from-literal=url="$DNS_URL" \
  --from-literal=token="$DNS_TOKEN" \
  --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -
kubectl "${ctx_args[@]}" -n "$SAAS_NAMESPACE" create secret generic fabric-dns-webhook-token \
  --from-literal=token="$DNS_TOKEN" \
  --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -

kubectl "${ctx_args[@]}" -n "$SAAS_NAMESPACE" create secret generic fabric-agent-ca \
  --from-file=ca.crt="$FABRIC_AGENT_CA_CERT_FILE" \
  --from-file=ca.key="$FABRIC_AGENT_CA_KEY_FILE" \
  --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -

kubectl "${ctx_args[@]}" -n "$FABRIC_CONTROL_NAMESPACE" create secret generic fabric-gateway-tls \
  --from-file=gateway-cert.pem="$FABRIC_GATEWAY_CERT_FILE" \
  --from-file=gateway-key.pem="$FABRIC_GATEWAY_KEY_FILE" \
  --from-file=intermediate-ca.pem="$FABRIC_GATEWAY_CA_FILE" \
  --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -

kubectl "${ctx_args[@]}" -n "$FABRIC_CONTROL_NAMESPACE" create secret generic fabric-gateway-inbound-tls \
  --from-file=inbound-cert.pem="$FABRIC_GATEWAY_INBOUND_CERT_FILE" \
  --from-file=inbound-key.pem="$FABRIC_GATEWAY_INBOUND_KEY_FILE" \
  --dry-run=client -o yaml | kubectl "${ctx_args[@]}" apply -f -

echo "    Secrets applied."
echo "    Tokens (save securely):"
echo "      FABRIC_CONTROL_PLANE_TOKEN=$WRITER_TOKEN"
echo "      FABRIC_DUAL_CONTROL_TOKEN=$DUAL_TOKEN"
echo "      FABRIC_GATEWAY_CONTROL_TOKEN=$GATEWAY_CONTROL_TOKEN"
echo "      FABRIC_REVOKE_PUSH_TOKEN=$REVOKE_PUSH_TOKEN"
echo "      DNS_WEBHOOK_TOKEN=$DNS_TOKEN"
echo "      FABRIC_DNS_WEBHOOK_URL=$DNS_URL"

if [[ "$SKIP_DEPLOY" == "1" ]]; then
  echo ""
  echo "==> Deploy skipped (SKIP_DEPLOY=1)"
  exit 0
fi

echo ""
echo "==> [3/5] Fabric deployments (${FABRIC_NAME}/deploy/k8s)"
kubectl kustomize --load-restrictor=LoadRestrictionsNone "$FABRIC_ROOT/deploy/k8s" \
  | kubectl "${ctx_args[@]}" apply -f -

echo "    waiting for fabric-gateway..."
kubectl "${ctx_args[@]}" -n "$FABRIC_CONTROL_NAMESPACE" rollout status deploy/fabric-gateway --timeout=180s
echo "    waiting for fabric-control-plane..."
kubectl "${ctx_args[@]}" -n "$SAAS_NAMESPACE" rollout status deploy/fabric-control-plane --timeout=180s || true
echo "    waiting for fabric-dns-webhook..."
kubectl "${ctx_args[@]}" -n "$SAAS_NAMESPACE" rollout status deploy/fabric-dns-webhook --timeout=180s || true

install_ambient() {
  echo "==> Platform Ambient install (Istio ${ISTIO_VERSION})"
  local istioctl_bin cache os arch url tgz
  if [[ -n "${ISTIOCTL:-}" && -x "${ISTIOCTL}" ]]; then
    istioctl_bin="$ISTIOCTL"
  elif command -v istioctl >/dev/null 2>&1; then
    istioctl_bin="$(command -v istioctl)"
  else
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/ablv-fabric/istio-${ISTIO_VERSION}"
    if [[ ! -x "$cache/bin/istioctl" ]]; then
      echo "    downloading Istio ${ISTIO_VERSION}"
      mkdir -p "$(dirname "$cache")"
      os="$(uname -s | tr '[:upper:]' '[:lower:]')"
      case "$os" in darwin) os=osx ;; esac
      arch="$(uname -m)"
      case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
      url="https://github.com/istio/istio/releases/download/${ISTIO_VERSION}/istio-${ISTIO_VERSION}-${os}-${arch}.tar.gz"
      tgz="$(mktemp)"
      curl -fsSL -o "$tgz" "$url"
      rm -rf "$cache"
      mkdir -p "$cache"
      tar -xzf "$tgz" -C "$cache" --strip-components=1
      rm -f "$tgz"
    fi
    istioctl_bin="$cache/bin/istioctl"
  fi

  kubectl "${ctx_args[@]}" create namespace "$AMBIENT_PLANE_NAMESPACE" --dry-run=client -o yaml \
    | kubectl "${ctx_args[@]}" apply -f -
  if [[ -f "$ROOT/ambient/psa-ambient-plane.example.yaml" ]]; then
    kubectl "${ctx_args[@]}" apply -f "$ROOT/ambient/psa-ambient-plane.example.yaml"
  fi

  local cni_set=()
  if kubectl "${ctx_args[@]}" get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}' 2>/dev/null | grep -q '+k3s'; then
    echo "    k3s node detected — CNI path overrides"
    cni_set=(
      --set values.cni.cniConfDir=/var/lib/rancher/k3s/agent/etc/cni/net.d
      --set values.cni.cniBinDir=/bin
    )
  fi

  "$istioctl_bin" "${ctx_args[@]}" install --set profile=ambient \
    --set "values.global.istioNamespace=${AMBIENT_PLANE_NAMESPACE}" \
    "${cni_set[@]}" --skip-confirmation
  kubectl "${ctx_args[@]}" -n "$AMBIENT_PLANE_NAMESPACE" rollout status ds/ztunnel --timeout=180s

  local ns
  for ns in "$FABRIC_CONTROL_NAMESPACE" "$SAAS_NAMESPACE"; do
    kubectl "${ctx_args[@]}" label namespace "$ns" istio.io/dataplane-mode=ambient --overwrite
    echo "    enrolled namespace=$ns"
  done
}

if [[ "$SKIP_AMBIENT" != "1" ]]; then
  echo ""
  echo "==> [4/5] Ambient"
  install_ambient
else
  echo ""
  echo "==> [4/5] Ambient skipped"
fi

echo ""
echo "==> [5/5] Done"
echo ""
echo "Still outside this script:"
echo "  - SQL schema"
echo "  - OCI NLB / public DNS"
echo "  - ocir-secret in $FABRIC_CONTROL_NAMESPACE and $SAAS_NAMESPACE if images will not pull"
echo "  - CA for customers: $PKI_DIR/agent-ca.crt (Gateway server cert: $PKI_DIR/gateway.crt)"
echo ""
