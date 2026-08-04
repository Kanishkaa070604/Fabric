#!/usr/bin/env bash
# ============================================================
# Platform Day-0 Secrets — one script, run once per environment.
#
# Creates Kubernetes Secrets for fabric-control (Gateway) and the SaaS
# control-plane namespace. Names + keys must match deploy YAML.
#
# WHO RUNS THIS: Platform ops (not tenant admins).
# WHEN: Day-0, after namespaces exist, BEFORE applying Deployments.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=namespaces.sh
source "$ROOT/namespaces.sh"

echo "==> Platform Day-0 secrets"
echo "    fabric-control (Gateway): $FABRIC_CONTROL_NAMESPACE"
echo "    SaaS control plane:       $SAAS_NAMESPACE"

for ns in "$FABRIC_CONTROL_NAMESPACE" "$SAAS_NAMESPACE"; do
  kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns"
done

# --- SaaS namespace: Control Plane + DNS webhook ---
WRITER_TOKEN="${FABRIC_CONTROL_PLANE_TOKEN:-$(openssl rand -hex 24)}"
DUAL_TOKEN="${FABRIC_DUAL_CONTROL_TOKEN:-$(openssl rand -hex 24)}"
echo "  [1/8] fabric-control-plane-auth → $SAAS_NAMESPACE"
kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-control-plane-auth \
  --from-literal=bearer_token="$WRITER_TOKEN" \
  --from-literal=dual_control_token="$DUAL_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

TENANT_ID="${ABLV_PLATFORM_TENANT_ID:-}"
ENV_ID="${ABLV_PLATFORM_ENVIRONMENT_ID:-}"
if [ -z "$TENANT_ID" ] || [ -z "$ENV_ID" ]; then
  echo "  [2/8] fabric-platform-ids SKIPPED (set ABLV_PLATFORM_TENANT_ID + ABLV_PLATFORM_ENVIRONMENT_ID)"
else
  echo "  [2/8] fabric-platform-ids → fabric-control + SaaS ns"
  for ns in "$FABRIC_CONTROL_NAMESPACE" "$SAAS_NAMESPACE"; do
    kubectl -n "$ns" create secret generic fabric-platform-ids \
      --from-literal=tenant_id="$TENANT_ID" \
      --from-literal=environment_id="$ENV_ID" \
      --dry-run=client -o yaml | kubectl apply -f -
  done
fi

EXPIRY_URL="${CERT_EXPIRY_WEBHOOK_URL:-}"
if [ -z "$EXPIRY_URL" ]; then
  echo "  [3/8] fabric-cert-expiry-webhook SKIPPED"
else
  echo "  [3/8] fabric-cert-expiry-webhook → $SAAS_NAMESPACE"
  kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-cert-expiry-webhook \
    --from-literal=url="$EXPIRY_URL" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

DNS_TOKEN="${DNS_WEBHOOK_TOKEN:-$(openssl rand -hex 24)}"
DNS_URL="${FABRIC_DNS_WEBHOOK_URL:-http://fabric-dns-webhook.${SAAS_NAMESPACE}.svc:8090}"
echo "  [4/8] fabric-dns-webhook → $SAAS_NAMESPACE"
kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-dns-webhook \
  --from-literal=url="$DNS_URL" \
  --from-literal=token="$DNS_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-dns-webhook-token \
  --from-literal=token="$DNS_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

CA_CERT="${FABRIC_AGENT_CA_CERT_FILE:-}"
CA_KEY="${FABRIC_AGENT_CA_KEY_FILE:-}"
if [ -n "$CA_CERT" ] && [ -n "$CA_KEY" ]; then
  echo "  [5/8] fabric-agent-ca → $SAAS_NAMESPACE"
  kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-agent-ca \
    --from-file=ca.crt="$CA_CERT" \
    --from-file=ca.key="$CA_KEY" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  echo "  [5/8] fabric-agent-ca SKIPPED"
fi

# --- fabric-control: Gateway / Ghostunnel only ---
GW_CERT="${FABRIC_GATEWAY_CERT_FILE:-}"
GW_KEY="${FABRIC_GATEWAY_KEY_FILE:-}"
GW_CA="${FABRIC_GATEWAY_CA_FILE:-${FABRIC_AGENT_CA_CERT_FILE:-}}"
if [ -n "$GW_CERT" ] && [ -n "$GW_KEY" ] && [ -n "$GW_CA" ]; then
  echo "  [6/8] fabric-gateway-tls → $FABRIC_CONTROL_NAMESPACE"
  kubectl -n "$FABRIC_CONTROL_NAMESPACE" create secret generic fabric-gateway-tls \
    --from-file=gateway-cert.pem="$GW_CERT" \
    --from-file=gateway-key.pem="$GW_KEY" \
    --from-file=intermediate-ca.pem="$GW_CA" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  echo "  [6/8] fabric-gateway-tls SKIPPED"
fi

echo "  [7/8] Replace your-registry/*:REPLACE in Deployments"
echo "  [8/8] Set ABLV_ACCESS_URL and FABRIC_DNS_TARGET"

echo ""
echo "Secrets in $FABRIC_CONTROL_NAMESPACE:"
kubectl -n "$FABRIC_CONTROL_NAMESPACE" get secrets -o name 2>/dev/null | grep mesh || true
echo "Secrets in $SAAS_NAMESPACE:"
kubectl -n "$SAAS_NAMESPACE" get secrets -o name 2>/dev/null | grep mesh || true
echo ""
echo "Next:"
echo "  kubectl apply -f deploy/gateway/deployment.yaml"
echo "  kubectl apply -f deploy/control-plane/deployment.yaml"
echo "  kubectl apply -f deploy/platform/oci/dns-webhook/deployment.yaml"
echo ""
echo "Tokens (save securely):"
echo "  FABRIC_CONTROL_PLANE_TOKEN=$WRITER_TOKEN"
echo "  FABRIC_DUAL_CONTROL_TOKEN=$DUAL_TOKEN"
echo "  DNS_WEBHOOK_TOKEN=$DNS_TOKEN"
echo "  FABRIC_DNS_WEBHOOK_URL=$DNS_URL"
