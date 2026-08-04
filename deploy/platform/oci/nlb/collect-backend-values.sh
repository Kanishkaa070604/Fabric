#!/usr/bin/env bash
# Print backend_ip_addresses + backend_port for deploy/platform/oci/nlb/terraform.tfvars.
# Run AFTER Gateway is deployed and fabric-gateway Service is NodePort
# (docs/Operational-Runbook.md Day 0 Step 5b).
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
  echo "       Run (Operational-Runbook Day 0 Step 5b — NodePort):"
  echo "       kubectl -n $NS patch svc fabric-gateway --type='json' -p='[{\"op\":\"replace\",\"path\":\"/spec/type\",\"value\":\"NodePort\"}]'"
  exit 1
fi

NODEPORT=$(kubectl -n "$NS" get svc fabric-gateway -o jsonpath='{.spec.ports[?(@.name=="mtls")].nodePort}')
if [ -z "$NODEPORT" ]; then
  NODEPORT=$(kubectl -n "$NS" get svc fabric-gateway -o jsonpath='{.spec.ports[?(@.port==8443)].nodePort}')
fi
if [ -z "$NODEPORT" ]; then
  echo "ERROR: could not read NodePort for port 8443 / name mtls."
  kubectl -n "$NS" get svc fabric-gateway -o yaml
  exit 1
fi

echo "==> Worker node private IPs (use as backend_ip_addresses):"
# Prefer InternalIP; fall back to first address.
IPS=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' | sed '/^$/d')
if [ -z "$IPS" ]; then
  echo "ERROR: no node InternalIPs found. Is this an OKE/kubeadm cluster with nodes Ready?"
  kubectl get nodes -o wide
  exit 1
fi
echo "$IPS" | sed 's/^/  /'

# Emit HCL snippet
echo ""
echo "==> Paste into terraform.tfvars:"
echo "backend_ip_addresses = ["
echo "$IPS" | while read -r ip; do
  echo "  \"$ip\","
done
echo "]"
echo "backend_port = $NODEPORT"
echo "listener_port = 8443"
echo ""
echo "==> Reminder: NSG must allow NLB subnet → these node IPs on TCP $NODEPORT"
