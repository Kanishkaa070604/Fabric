#!/usr/bin/env bash
# ============================================================
# Abluva Connect Agent — customer cluster bootstrap (Kubernetes)
#
# Pass-as-is installer for a tenant cluster. Same *role* as
# secure-agent-net's agent/tenant-start.sh, different product path:
#
#   Skupper script: inbound link + MetalLB + Skupper site/token redeem
#   This script:    outbound mTLS dial to Platform NLB (Ghostunnel :8443)
#                   — no Skupper, no customer LoadBalancer for the tunnel
#
# Usage:
#   ./tenant-start.sh <path/to/tenant-start.env>
#
# Prerequisites:
#   - kubectl with rights to create Namespace / Secret / DaemonSet / Role / Service
#   - Day-1 values from Abluva Connect UI (see tenant-start.env.example)
#   - Egress to FABRIC_GATEWAY_ADDRESS :8443 and to FABRIC_CONTROL_PLANE_URL
#   - python3 (used only to render the DaemonSet YAML)
#
# Support trap (read this):
#   Agent→Gateway is raw mutual-TLS TCP, not HTTP. If the node/cluster injects
#   HTTP_PROXY/HTTPS_PROXY and the Gateway host is missing from NO_PROXY, the
#   proxy intercepts the dial and the tunnel fails silently (Connecting forever).
#   This script always sets NO_PROXY to include the Gateway hostname.
# ============================================================

set -euo pipefail

ENV_FILE="${1:-}"
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "Usage: $0 <path/to/tenant-start.env>"
  echo "       See tenant-start.env.example"
  exit 1
fi

# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${TENANT_NAMESPACE:?TENANT_NAMESPACE required}"
: "${TENANT_ID:?TENANT_ID required}"
: "${FABRIC_GATEWAY_ADDRESS:?FABRIC_GATEWAY_ADDRESS required}"
: "${FABRIC_CONTROL_PLANE_URL:?FABRIC_CONTROL_PLANE_URL required}"
: "${CONNECT_AGENT_IMAGE:?CONNECT_AGENT_IMAGE required}"
: "${CA_CERT_FILE:?CA_CERT_FILE required}"
: "${BOOTSTRAP_TOKEN:?BOOTSTRAP_TOKEN required}"

if [[ ! -f "$CA_CERT_FILE" ]]; then
  echo "Error: CA_CERT_FILE not found: $CA_CERT_FILE"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required to render daemonset.yaml"
  exit 1
fi

GW_HOST="${FABRIC_GATEWAY_ADDRESS%%:*}"
if [[ -z "$GW_HOST" || "$GW_HOST" == "$FABRIC_GATEWAY_ADDRESS" ]]; then
  # allow host-only; append default port for Agent
  if [[ "$FABRIC_GATEWAY_ADDRESS" != *:* ]]; then
    FABRIC_GATEWAY_ADDRESS="${FABRIC_GATEWAY_ADDRESS}:8443"
    GW_HOST="${FABRIC_GATEWAY_ADDRESS%%:*}"
  fi
fi
if [[ -z "$GW_HOST" ]]; then
  echo "Error: FABRIC_GATEWAY_ADDRESS must be host or host:port (got: $FABRIC_GATEWAY_ADDRESS)"
  exit 1
fi

NO_PROXY_VALUE="${GW_HOST},localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.svc.cluster.local,.cluster.local"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-300s}"
SKIP_NETWORK_POLICY="${SKIP_NETWORK_POLICY:-0}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo ""
echo "============================================================"
echo " Abluva Connect Agent — tenant bootstrap"
echo "============================================================"
echo "  Namespace:     $TENANT_NAMESPACE"
echo "  Tenant ID:     $TENANT_ID"
echo "  Gateway:       $FABRIC_GATEWAY_ADDRESS  (NO_PROXY includes $GW_HOST)"
echo "  Control plane: $FABRIC_CONTROL_PLANE_URL"
echo "  Context:       $(kubectl config current-context 2>/dev/null || echo unknown)"
echo ""

echo "[1/5] Namespace"
kubectl create namespace "$TENANT_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl config set-context --current --namespace "$TENANT_NAMESPACE" >/dev/null || true
echo "[OK] Namespace ready."

echo "[2/5] Secrets"
kubectl -n "$TENANT_NAMESPACE" create secret generic connect-agent-tls \
  --from-file=ca.crt="$CA_CERT_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$TENANT_NAMESPACE" create secret generic fabric-edge-bootstrap \
  --from-literal=bootstrap_token="$BOOTSTRAP_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "[OK] Secrets applied (CA + bootstrap). No separate Agent API seed needed."

echo "[3/5] DaemonSet + Service + RBAC"
export NO_PROXY_VALUE
python3 - "$SCRIPT_DIR/daemonset.yaml" "$WORKDIR/daemonset.yaml" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
import os
ns = os.environ["TENANT_NAMESPACE"]
image = os.environ["CONNECT_AGENT_IMAGE"]
gw = os.environ["FABRIC_GATEWAY_ADDRESS"]
tid = os.environ["TENANT_ID"]
cp = os.environ["FABRIC_CONTROL_PLANE_URL"]
noproxy = os.environ["NO_PROXY_VALUE"]
sni = os.environ.get("FABRIC_TLS_SERVER_NAME", "").strip()

text = open(src).read()
text = text.replace("TENANT_NAMESPACE", ns)
text = text.replace("your-registry/connect-agent:REPLACE", image)
text = text.replace("fabric.platform.example.com:8443", gw)
text = text.replace("REPLACE_TENANT_UUID", tid)
text = text.replace("https://control-plane.platform.example.com", cp)
# Replace both NO_PROXY / no_proxy placeholder values
text = re.sub(
    r'(name: NO_PROXY\n\s+value: ")[^"]+(")',
    r"\1" + noproxy + r"\2",
    text,
)
text = re.sub(
    r'(name: no_proxy\n\s+value: ")[^"]+(")',
    r"\1" + noproxy + r"\2",
    text,
)

def uncomment_env(name: str, blob: str) -> str:
    """Uncomment only the env entry `# - name: NAME` … `#       key: …` block."""
    lines = blob.splitlines(True)
    out = []
    i = 0
    marker = re.compile(rf"^[ \t]*# - name: {re.escape(name)}\s*$")
    found = False
    while i < len(lines):
        if marker.match(lines[i]):
            found = True
            while i < len(lines):
                l = lines[i]
                indent = l[: len(l) - len(l.lstrip())]
                rest = l.lstrip()
                if not rest.startswith("#"):
                    break
                rest = rest[1:]
                if rest.startswith(" "):
                    rest = rest[1:]
                out.append(indent + rest)
                if rest.lstrip().startswith("key:"):
                    i += 1
                    break
                i += 1
            continue
        out.append(lines[i])
        i += 1
    if not found:
        raise SystemExit(f"render error: could not find commented env {name}")
    return "".join(out)

text = uncomment_env("FABRIC_BOOTSTRAP_TOKEN", text)

if sni:
    insert = (
        f'            - name: FABRIC_TLS_SERVER_NAME\n'
        f'              value: "{sni}"\n'
    )
    marker = '            - name: FABRIC_GATEWAY_ADDRESS\n'
    i = text.find(marker)
    if i < 0:
        raise SystemExit("render error: FABRIC_GATEWAY_ADDRESS missing")
    # after name + value lines
    j = text.find("\n", text.find("value:", i))
    text = text[: j + 1] + insert + text[j + 1 :]

open(dst, "w").write(text)
PY
kubectl apply -f "$WORKDIR/daemonset.yaml"
echo "[OK] DaemonSet applied."

echo "[4/5] NetworkPolicy"
if [[ "$SKIP_NETWORK_POLICY" == "1" ]]; then
  echo "[SKIP] SKIP_NETWORK_POLICY=1"
else
  sed "s/TENANT_NAMESPACE/${TENANT_NAMESPACE}/g" \
    "$SCRIPT_DIR/networkpolicy-example.yaml" | kubectl apply -f -
  echo "[OK] NetworkPolicy applied. Label consumer pods: abluva.io/connect-consumer=true"
fi

echo "[5/5] Wait for DaemonSet"
kubectl -n "$TENANT_NAMESPACE" rollout status "daemonset/connect-agent" --timeout="$AGENT_TIMEOUT"

echo ""
echo "============================================================"
echo "  TENANT AGENT INSTALL COMPLETE"
echo "============================================================"
echo ""
echo "  Next (Abluva Connect UI / ops):"
echo "    1. Approve the Agent if it is PendingApproval"
echo "    2. Confirm tunnel_ready / Connected in the UI"
echo "    3. Create a registration (e.g. CUSTOMER_RESOURCE → your Postgres host:port)"
echo "    4. Wait ~5–10s for the Agent poll, then dial:"
echo "       connect-agent.${TENANT_NAMESPACE}.svc:<port>"
echo "       (port map: kubectl -n $TENANT_NAMESPACE get svc connect-agent -o yaml | grep registration-ports)"
echo ""
echo "  Identity: stored in a per-node Kubernetes Secret (FABRIC_IDENTITY_STORE=kubernetes)."
echo "    Survives Agent image rollouts. No hostPath or Pod Security exception needed."
echo ""
echo "  Proxy check (if stuck Connecting):"
echo "    POD=\$(kubectl -n $TENANT_NAMESPACE get pod -l app=connect-agent -o jsonpath='{.items[0].metadata.name}')"
echo "    kubectl -n $TENANT_NAMESPACE exec \"\$POD\" -- printenv | egrep -i 'proxy|FABRIC_GATEWAY'"
echo "    # Gateway host must appear in NO_PROXY; do not rely on HTTP_PROXY for the tunnel."
echo ""
echo "  Day-1 tokens: after successful enroll, revoke the"
echo "  bootstrap token in the UI if the install window should close."
echo "============================================================"
