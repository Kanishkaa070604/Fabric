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
echo "    Ambient plane:            $AMBIENT_PLANE_NAMESPACE"
echo "    Fabric edge (Agent):      $FABRIC_EDGE_NAMESPACE"

for ns in \
  "$FABRIC_CONTROL_NAMESPACE" \
  "$SAAS_NAMESPACE" \
  "$AMBIENT_PLANE_NAMESPACE" \
  "$FABRIC_EDGE_NAMESPACE"
do
  kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns"
done

# --- SaaS namespace: Control Plane + DNS webhook ---
WRITER_TOKEN="${FABRIC_CONTROL_PLANE_TOKEN:-$(openssl rand -hex 24)}"
DUAL_TOKEN="${FABRIC_DUAL_CONTROL_TOKEN:-$(openssl rand -hex 24)}"
# Two Platform service credentials that are deliberately NOT the writer token:
#   gateway_control_token — Gateway → CP, scoped server-side to authz-context /
#     agent-by-cert / tunnel-event. Sharing the writer bearer here would give
#     every Gateway replica authority to suspend tenants and approve Agents.
#   revoke_push_token     — CP → Gateway revoke listener. The Gateway refuses to
#     start with the listener enabled and no token, so this is not optional.
# Both are shared secrets between the two namespaces, so each is written into
# both places from one generated value.
GATEWAY_CONTROL_TOKEN="${FABRIC_GATEWAY_CONTROL_TOKEN:-$(openssl rand -hex 24)}"
REVOKE_PUSH_TOKEN="${FABRIC_REVOKE_PUSH_TOKEN:-$(openssl rand -hex 24)}"
echo "  [1/9] fabric-control-plane-auth → $SAAS_NAMESPACE"
kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-control-plane-auth \
  --from-literal=bearer_token="$WRITER_TOKEN" \
  --from-literal=dual_control_token="$DUAL_TOKEN" \
  --from-literal=gateway_control_token="$GATEWAY_CONTROL_TOKEN" \
  --from-literal=revoke_push_token="$REVOKE_PUSH_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "  [1b/9] fabric-gateway-auth → $FABRIC_CONTROL_NAMESPACE"
kubectl -n "$FABRIC_CONTROL_NAMESPACE" create secret generic fabric-gateway-auth \
  --from-literal=gateway_control_token="$GATEWAY_CONTROL_TOKEN" \
  --from-literal=revoke_push_token="$REVOKE_PUSH_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

TENANT_ID="${ABLV_PLATFORM_TENANT_ID:-}"
ENV_ID="${ABLV_PLATFORM_ENVIRONMENT_ID:-}"
if [ -z "$TENANT_ID" ] || [ -z "$ENV_ID" ]; then
  echo "  [2/9] fabric-platform-ids SKIPPED (set ABLV_PLATFORM_TENANT_ID + ABLV_PLATFORM_ENVIRONMENT_ID)"
else
  echo "  [2/9] fabric-platform-ids → fabric-control + SaaS ns"
  for ns in "$FABRIC_CONTROL_NAMESPACE" "$SAAS_NAMESPACE"; do
    kubectl -n "$ns" create secret generic fabric-platform-ids \
      --from-literal=tenant_id="$TENANT_ID" \
      --from-literal=environment_id="$ENV_ID" \
      --dry-run=client -o yaml | kubectl apply -f -
  done
fi

EXPIRY_URL="${CERT_EXPIRY_WEBHOOK_URL:-}"
if [ -z "$EXPIRY_URL" ]; then
  echo "  [3/9] fabric-cert-expiry-webhook SKIPPED"
else
  echo "  [3/9] fabric-cert-expiry-webhook → $SAAS_NAMESPACE"
  kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-cert-expiry-webhook \
    --from-literal=url="$EXPIRY_URL" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

DNS_TOKEN="${DNS_WEBHOOK_TOKEN:-$(openssl rand -hex 24)}"
DNS_URL="${FABRIC_DNS_WEBHOOK_URL:-http://fabric-dns-webhook.${SAAS_NAMESPACE}.svc:8090}"
echo "  [4/9] fabric-dns-webhook → $SAAS_NAMESPACE"
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
  echo "  [5/9] fabric-agent-ca → $SAAS_NAMESPACE"
  kubectl -n "$SAAS_NAMESPACE" create secret generic fabric-agent-ca \
    --from-file=ca.crt="$CA_CERT" \
    --from-file=ca.key="$CA_KEY" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  echo "  [5/9] fabric-agent-ca SKIPPED"
fi

# --- fabric-control: Gateway / Ghostunnel only ---
GW_CERT="${FABRIC_GATEWAY_CERT_FILE:-}"
GW_KEY="${FABRIC_GATEWAY_KEY_FILE:-}"
GW_CA="${FABRIC_GATEWAY_CA_FILE:-${FABRIC_AGENT_CA_CERT_FILE:-}}"
if [ -n "$GW_CERT" ] && [ -n "$GW_KEY" ] && [ -n "$GW_CA" ]; then
  echo "  [6/9] fabric-gateway-tls → $FABRIC_CONTROL_NAMESPACE"
  kubectl -n "$FABRIC_CONTROL_NAMESPACE" create secret generic fabric-gateway-tls \
    --from-file=gateway-cert.pem="$GW_CERT" \
    --from-file=gateway-key.pem="$GW_KEY" \
    --from-file=intermediate-ca.pem="$GW_CA" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  echo "  [6/9] fabric-gateway-tls SKIPPED"
fi

# Platform→Customer inbound (A3/B4) TLS. This is a DIFFERENT certificate from
# the Ghostunnel one above: Agents authenticate to Ghostunnel with mTLS against
# the Agent CA, whereas SaaS services dial the inbound listener by hostname
# (`<service>.<tenant_id>.$INBOUND_DOMAIN`) and need a normal server cert whose
# SANs cover that wildcard. Without this secret the inbound listener stays off
# and Platform→Customer is not available -- see FABRIC_A3B4_ENABLED in
# deploy/gateway/deployment.yaml.
IN_CERT="${FABRIC_GATEWAY_INBOUND_CERT_FILE:-}"
IN_KEY="${FABRIC_GATEWAY_INBOUND_KEY_FILE:-}"
if [ -n "$IN_CERT" ] && [ -n "$IN_KEY" ]; then
  echo "  [7/9] fabric-gateway-inbound-tls → $FABRIC_CONTROL_NAMESPACE"
  kubectl -n "$FABRIC_CONTROL_NAMESPACE" create secret generic fabric-gateway-inbound-tls \
    --from-file=inbound-cert.pem="$IN_CERT" \
    --from-file=inbound-key.pem="$IN_KEY" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  echo "  [7/9] fabric-gateway-inbound-tls SKIPPED (Platform→Customer inbound stays disabled)"
fi

echo "  [8/9] Replace your-registry/*:REPLACE in Deployments"
echo "  [9/9] Set ABLV_ACCESS_URL, FABRIC_DNS_TARGET and FABRIC_GATEWAY_INBOUND_DOMAIN"

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
echo "  FABRIC_GATEWAY_CONTROL_TOKEN=$GATEWAY_CONTROL_TOKEN"
echo "  FABRIC_REVOKE_PUSH_TOKEN=$REVOKE_PUSH_TOKEN"
echo "  DNS_WEBHOOK_TOKEN=$DNS_TOKEN"
echo "  FABRIC_DNS_WEBHOOK_URL=$DNS_URL"
