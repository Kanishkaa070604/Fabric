#!/usr/bin/env bash
# ============================================================
# Abluva Connect Agent — k3s Appliance Installer (VM / Bare Metal)
#
# Single command that turns a bare Linux host into a Fabric-connected
# appliance. Installs k3s (lightweight Kubernetes) and deploys the
# Connect Agent as a DaemonSet inside it — giving the customer:
#   - Liveness/readiness probes (automatic restart on hang)
#   - Resource limits (no OOM killing the host)
#   - Rolling zero-downtime updates (same as full K8s customers)
#   - K8s-Secret-based identity store (same as full K8s path)
#   - Same DaemonSet manifest as Kubernetes customers (one path)
#
# The customer never needs to know k3s is underneath. They see one
# install command, one status command, and one uninstall command.
#
# Usage:
#   curl -sSL https://install.fabric.abluva.io | sh -s -- \
#     --token=<BOOTSTRAP_TOKEN> \
#     --gateway=fabric.platform.example.com:8443 \
#     --control-plane=https://cp.platform.example.com \
#     --tenant-id=<TENANT_UUID> \
#     --ca-url=https://cp.platform.example.com/v1/ca-bundle  (or --ca-file=/path/to/ca.crt)
#
#   # Same method as kubernetes/tenant-start.sh (sources fabric-edge.env):
#   ./install.sh ./fabric-edge.env
#   # or (default path next to this script):
#   ./install.sh
#
# Prerequisites:
#   - Linux host (amd64/arm64) — k3s installs a systemd unit; Agent still
#     runs as a DaemonSet inside k3s (not the plain systemd/ Agent package)
#   - curl or wget; root access; python3 (renders DaemonSet YAML)
#   - ca.crt + fabric-edge.env in the SAME directory as this script
#   - fabric-edge.env requires (same as tenant-start.sh):
#       TENANT_NAMESPACE TENANT_ID FABRIC_GATEWAY_ADDRESS
#       FABRIC_CONTROL_PLANE_URL CONNECT_AGENT_IMAGE CA_CERT_FILE BOOTSTRAP_TOKEN
#   - daemonset.yaml + networkpolicy-example.yaml next to this script
#
# What gets installed:
#   - /usr/local/bin/k3s (single static binary, ~60MB)
#   - systemd unit: k3s.service (managed by the k3s installer)
#   - Namespace: TENANT_NAMESPACE (same as K8s)
#   - DaemonSet/Service/RBAC: same daemonset.yaml as K8s customers
#   - Secrets: connect-agent-tls (CA), fabric-edge-bootstrap (token)
#
# Uninstall:
#   /usr/local/bin/k3s-uninstall.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Defaults ---
K3S_VERSION="${K3S_VERSION:-}"  # empty = latest stable
SAAS_NAMESPACE="${SAAS_NAMESPACE:-3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c}"
FABRIC_IDENTITY_STORE="kubernetes"
DAEMONSET_YAML="${DAEMONSET_YAML:-$SCRIPT_DIR/daemonset.yaml}"
NP_YAML="${NP_YAML:-$SCRIPT_DIR/networkpolicy-example.yaml}"
CA_URL=""
# Default: fabric-edge.env next to this script (not the .example template)
ENV_FILE="${SCRIPT_DIR}/fabric-edge.env"

usage() {
  echo "Usage (same method as kubernetes/tenant-start.sh):"
  echo "  $0 [path/to/fabric-edge.env]"
  echo "  $0 --env-file=<path/to/fabric-edge.env>"
  echo "Default env file: ${SCRIPT_DIR}/fabric-edge.env"
  echo "       See fabric-edge.env.example for the template only."
  echo "CLI (optional overrides): --token=... --gateway=... --control-plane=... --tenant-id=... --namespace=... --image=... --ca-file=..."
  exit 1
}

# Positional fabric-edge.env (same as tenant-start.sh ./tenant-start.env)
if [[ $# -ge 1 && "$1" != --* ]]; then
  ENV_FILE="$1"
  shift
fi

for arg in "$@"; do
  case "$arg" in
    --token=*)           BOOTSTRAP_TOKEN="${arg#*=}" ;;
    --gateway=*)         FABRIC_GATEWAY_ADDRESS="${arg#*=}" ;;
    --control-plane=*)   FABRIC_CONTROL_PLANE_URL="${arg#*=}" ;;
    --tenant-id=*)       TENANT_ID="${arg#*=}" ;;
    --namespace=*)       TENANT_NAMESPACE="${arg#*=}" ;;
    --ca-file=*)         CA_CERT_FILE="${arg#*=}" ;;
    --ca-url=*)          CA_URL="${arg#*=}" ;;
    --env-file=*)        ENV_FILE="${arg#*=}" ;;
    --image=*)           CONNECT_AGENT_IMAGE="${arg#*=}" ;;
    --tls-server-name=*) FABRIC_TLS_SERVER_NAME="${arg#*=}" ;;
    --help|-h)           usage ;;
    *)                   echo "Unknown arg: $arg"; usage ;;
  esac
done

# Load fabric-edge.env — same method as kubernetes/tenant-start.sh
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  echo "       Place fabric-edge.env next to install.sh (from Connect UI Install)."
  echo "       Template only: fabric-edge.env.example"
  exit 1
fi
# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
echo "[OK] Loaded env from $ENV_FILE"

# Legacy aliases from older VM Install snippets
BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN:-${FABRIC_BOOTSTRAP_TOKEN:-}}"
TENANT_ID="${TENANT_ID:-${FABRIC_TENANT_ID:-}}"
CONNECT_AGENT_IMAGE="${CONNECT_AGENT_IMAGE:-${AGENT_IMAGE:-}}"
CA_CERT_FILE="${CA_CERT_FILE:-${CA_FILE:-}}"
TENANT_NAMESPACE="${TENANT_NAMESPACE:-${NAMESPACE:-}}"

# Same required vars as tenant-start.sh (lines 50–56)
: "${TENANT_NAMESPACE:?TENANT_NAMESPACE required}"
: "${TENANT_ID:?TENANT_ID required}"
: "${FABRIC_GATEWAY_ADDRESS:?FABRIC_GATEWAY_ADDRESS required}"
: "${FABRIC_CONTROL_PLANE_URL:?FABRIC_CONTROL_PLANE_URL required}"
: "${CONNECT_AGENT_IMAGE:?CONNECT_AGENT_IMAGE required}"
: "${CA_CERT_FILE:?CA_CERT_FILE required}"
: "${BOOTSTRAP_TOKEN:?BOOTSTRAP_TOKEN required}"

if [[ ! -f "$CA_CERT_FILE" ]]; then
  echo "ERROR: CA_CERT_FILE not found: $CA_CERT_FILE"
  echo "       Put ca.crt next to install.sh (same as tenant-start.sh)."
  exit 1
fi
if [[ ! -f "$DAEMONSET_YAML" ]]; then
  echo "ERROR: missing DaemonSet YAML: $DAEMONSET_YAML"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to render daemonset.yaml (same as tenant-start.sh)"
  exit 1
fi

GW_HOST="${FABRIC_GATEWAY_ADDRESS%%:*}"
if [[ -z "$GW_HOST" || "$GW_HOST" == "$FABRIC_GATEWAY_ADDRESS" ]]; then
  if [[ "$FABRIC_GATEWAY_ADDRESS" != *:* ]]; then
    FABRIC_GATEWAY_ADDRESS="${FABRIC_GATEWAY_ADDRESS}:8443"
    GW_HOST="${FABRIC_GATEWAY_ADDRESS%%:*}"
  fi
fi
if [[ -z "$GW_HOST" ]]; then
  echo "ERROR: FABRIC_GATEWAY_ADDRESS must be host or host:port (got: $FABRIC_GATEWAY_ADDRESS)"
  exit 1
fi

# --- Step 1: Install k3s ---
echo "[1/6] Installing k3s..."
if command -v k3s >/dev/null 2>&1; then
  echo "  k3s already installed: $(k3s --version | head -1)"
else
  INSTALL_K3S_EXEC="server --disable=traefik,servicelb,metrics-server --write-kubeconfig-mode=644"
  if [[ -n "$K3S_VERSION" ]]; then
    INSTALL_K3S_VERSION="$K3S_VERSION"
    export INSTALL_K3S_VERSION
  fi
  export INSTALL_K3S_EXEC
  curl -sfL https://get.k3s.io | sh -
  echo "  k3s installed: $(k3s --version | head -1)"
fi

# Wait for k3s API server
echo "  Waiting for k3s API server..."
KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export KUBECONFIG
for i in $(seq 1 60); do
  if k3s kubectl get nodes >/dev/null 2>&1; then
    echo "  k3s API server ready."
    break
  fi
  sleep 2
done
k3s kubectl get nodes >/dev/null 2>&1 || { echo "ERROR: k3s API server not ready after 120s"; exit 1; }

# --- Step 2: CA trust (same as tenant-start.sh — from CA_CERT_FILE) ---
echo "[2/6] Setting up CA trust bundle..."
if [[ -n "$CA_URL" && ! -s "$CA_CERT_FILE" ]]; then
  curl -sSf "$CA_URL" >"$CA_CERT_FILE"
  echo "  [OK] fetched CA to $CA_CERT_FILE"
fi
echo "  CA_CERT_FILE=$CA_CERT_FILE"

# --- Step 3: Create tenant namespace + secrets (same shape as tenant-start.sh) ---
echo "[3/6] Creating namespace and secrets..."
echo "  Namespace: $TENANT_NAMESPACE  (tenant=$TENANT_ID)"
k3s kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${TENANT_NAMESPACE}
  labels:
    abluva.io/tenant: "true"
EOF

k3s kubectl -n "$TENANT_NAMESPACE" create secret generic connect-agent-tls \
  --from-file=ca.crt="$CA_CERT_FILE" \
  --dry-run=client -o yaml | k3s kubectl apply -f -

# Upsert bootstrap: re-run with a new token overwrites the Secret.
_bs_yaml="$(k3s kubectl -n "$TENANT_NAMESPACE" create secret generic fabric-edge-bootstrap \
  --from-literal=bootstrap_token="$BOOTSTRAP_TOKEN" \
  --dry-run=client -o yaml)"
if k3s kubectl -n "$TENANT_NAMESPACE" get secret fabric-edge-bootstrap >/dev/null 2>&1; then
  echo "$_bs_yaml" | k3s kubectl -n "$TENANT_NAMESPACE" replace -f -
  echo "[OK] fabric-edge-bootstrap updated (new enrolls use this token)."
else
  echo "$_bs_yaml" | k3s kubectl -n "$TENANT_NAMESPACE" apply -f -
  echo "[OK] fabric-edge-bootstrap created."
fi
echo "[OK] Secrets applied (CA + bootstrap)."

# --- Step 4: Deploy Connect Agent (same daemonset.yaml as kubernetes/tenant-start.sh) ---
echo "[4/6] Deploying Connect Agent..."
NO_PROXY_VALUE="${GW_HOST},localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.svc.cluster.local,.cluster.local"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

export TENANT_NAMESPACE TENANT_ID CONNECT_AGENT_IMAGE
export FABRIC_GATEWAY_ADDRESS FABRIC_CONTROL_PLANE_URL
export FABRIC_TLS_SERVER_NAME="${FABRIC_TLS_SERVER_NAME:-}"
export NO_PROXY_VALUE

python3 - "$DAEMONSET_YAML" "$WORKDIR/daemonset.yaml" <<'PY'
import re, sys, os
src, dst = sys.argv[1], sys.argv[2]
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
# Appliance substrate (shared YAML defaults to kubernetes)
text = re.sub(
    r'(name: FABRIC_SUBSTRATE\n\s+value: ")[^"]+(")',
    r'\1vm\2',
    text,
    count=1,
)
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
    j = text.find("\n", text.find("value:", i))
    text = text[: j + 1] + insert + text[j + 1 :]

open(dst, "w").write(text)
PY

k3s kubectl apply -f "$WORKDIR/daemonset.yaml"
echo "  [OK] DaemonSet/Service/RBAC applied from $DAEMONSET_YAML (FABRIC_SUBSTRATE=vm)."

echo "[5/6] Applying NetworkPolicy..."
if [[ -f "$NP_YAML" ]]; then
  sed -e "s/TENANT_NAMESPACE/${TENANT_NAMESPACE}/g" \
      -e "s/SAAS_NAMESPACE/${SAAS_NAMESPACE}/g" \
    "$NP_YAML" | k3s kubectl apply -f -
  echo "  [OK] NetworkPolicy applied from $NP_YAML."
else
  echo "  [SKIP] NetworkPolicy YAML not found at $NP_YAML"
fi

# --- Step 6: Wait for Agent to be ready ---
echo "[6/6] Waiting for Agent to start..."
for i in $(seq 1 60); do
  if k3s kubectl -n "$TENANT_NAMESPACE" get pods -l app=connect-agent --field-selector=status.phase=Running 2>/dev/null | grep -q Running; then
    echo ""
    echo "============================================================"
    echo "  Abluva Connect Agent installed successfully!"
    echo ""
    echo "  Next:"
    echo "    1. Check pods:"
    echo "         k3s kubectl -n ${TENANT_NAMESPACE} get pods"
    echo "       Expect Running 1/1: connect-agent"
    echo ""
    echo "    2. Abluva UI → Subscriptions → Connect Agent:"
    echo "       - Wait until Connected (Approve if PendingApproval)."
    echo "       - Install → Refresh for CONTROL_SERVER_LISTEN_PORT."
    echo ""
    echo "    3. Deploy the launcher (tenant + env + email + listen port):"
    echo "         cd ../../../agent"
    echo "         KUBECTL=\"k3s kubectl\" ./deploy-agent.sh -t ${TENANT_ID} -e ${ENVIRONMENT_ID:-<ENVIRONMENT_ID>} -m <LOGIN_EMAIL> -p <PORT> --vm"
    echo "       See deploy/agent/README.md"
    echo ""
    echo "    4. UI → Add customer registrations:"
    echo "           agent-launcher   host=agent-svc          port=5004"
    echo "           data-privacy     host=data-privacy-svc   port=8080   (if privacy)"
    echo ""
    echo "  Errors or detailed steps:"
    echo "    See deploy/secure-agent-net.README.md → Troubleshooting"
    echo "============================================================"
    exit 0
  fi
  printf "."
  sleep 2
done

echo ""
echo "WARNING: Agent pod not Running after 120s. Check:"
echo "  k3s kubectl -n $TENANT_NAMESPACE describe pods -l app=connect-agent"
echo "  k3s kubectl -n $TENANT_NAMESPACE logs -l app=connect-agent"
echo "  Full guide: deploy/secure-agent-net.README.md → Troubleshooting"
exit 1
