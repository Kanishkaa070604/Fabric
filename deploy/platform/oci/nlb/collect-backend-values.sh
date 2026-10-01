#!/usr/bin/env bash
# Print terraform.tfvars snippets for deploy/platform/oci/nlb (Step 5b).
# Run AFTER Gateway is deployed and fabric-gateway Service is NodePort.
set -euo pipefail

NS="${FABRIC_NAMESPACE:-fabric-control}"

echo "==> Namespace: $NS"
if ! kubectl -n "$NS" get svc fabric-gateway >/dev/null 2>&1; then
  echo "ERROR: Service fabric-gateway not found in $NS."
  echo "       Apply deploy/gateway/deployment.yaml first."
  exit 1
fi

TYPE=$(kubectl -n "$NS" get svc fabric-gateway -o jsonpath='{.spec.type}')
if [ "$TYPE" != "NodePort" ]; then
  echo "ERROR: fabric-gateway Service type is '$TYPE' (want NodePort)."
  echo "       Run:"
  echo "       kubectl -n $NS patch svc fabric-gateway --type='json' -p='[{\"op\":\"replace\",\"path\":\"/spec/type\",\"value\":\"NodePort\"}]'"
  exit 1
fi

nodeport_for() {
  local name="$1" port="$2"
  local np
  np=$(kubectl -n "$NS" get svc fabric-gateway -o jsonpath="{.spec.ports[?(@.name==\"${name}\")].nodePort}")
  if [ -z "$np" ]; then
    np=$(kubectl -n "$NS" get svc fabric-gateway -o jsonpath="{.spec.ports[?(@.port==${port})].nodePort}")
  fi
  echo "$np"
}

MTLS_NP=$(nodeport_for mtls 8443)
INBOUND_NP=$(nodeport_for inbound 8444)

if [ -z "$MTLS_NP" ]; then
  echo "ERROR: could not read NodePort for port 8443 / name mtls."
  kubectl -n "$NS" get svc fabric-gateway -o yaml
  exit 1
fi

echo "==> Worker node private IPs (use as backend_ip_addresses):"
IPS=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' | sed '/^$/d')
if [ -z "$IPS" ]; then
  echo "ERROR: no node InternalIPs found."
  kubectl get nodes -o wide
  exit 1
fi
echo "$IPS" | sed 's/^/  /'

echo ""
echo "==> Paste into terraform.tfvars:"
echo "display_name = \"fabric-gateway-nlb\""
echo "backend_ip_addresses = ["
echo "$IPS" | while read -r ip; do
  echo "  \"$ip\","
done
echo "]"
echo "backend_port  = $MTLS_NP   # NodePort for Ghostunnel :8443"
echo "listener_port = 8443"
echo ""
if [ -n "$INBOUND_NP" ]; then
  echo "enable_inbound         = true"
  echo "inbound_backend_port   = $INBOUND_NP   # NodePort for Gateway inbound :8444"
  echo "inbound_listener_port  = 8444"
else
  echo "# No inbound NodePort found — set enable_inbound = false or expose Service port 8444"
  echo "enable_inbound = false"
fi
echo ""
echo "==> NSG reminder:"
echo "    NLB subnet → workers TCP $MTLS_NP (agent-mtls)"
if [ -n "$INBOUND_NP" ]; then
  echo "    NLB subnet → workers TCP $INBOUND_NP (inbound)"
fi
echo "    Internet → NLB VIP TCP 8443 (and 8444 if inbound enabled)"
echo "    Do NOT expose control-plane :8080 or revoke :9090 on this NLB."
