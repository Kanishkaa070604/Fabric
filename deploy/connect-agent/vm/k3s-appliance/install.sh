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
#   # Or with a pre-downloaded env file:
#   ./install.sh --env-file=/path/to/fabric-edge.env
#
# Prerequisites:
#   - Linux host (amd64/arm64) — k3s installs a systemd unit; Agent still
#     runs as a DaemonSet inside k3s (not the plain systemd/ Agent package)
#   - curl or wget; root access; python3 (renders DaemonSet YAML)
#   - Outbound TCP to FABRIC_GATEWAY_ADDRESS host:port (typically :8443)
#     and HTTPS to FABRIC_CONTROL_PLANE_URL
#   - daemonset.yaml + networkpolicy-example.yaml next to this script
#     (same content as ../../kubernetes/ — keep copies in sync)
#
# What gets installed:
#   - /usr/local/bin/k3s (single static binary, ~60MB)
#   - systemd unit: k3s.service (managed by the k3s installer)
#   - Namespace: same as K8s — TENANT_NAMESPACE or <tenantId>-<envId[:26]>
#   - DaemonSet/Service/RBAC: same kubernetes/daemonset.yaml as K8s customers
#   - Secrets: connect-agent-tls (CA), fabric-edge-bootstrap (token)
#
# Uninstall:
#   /usr/local/bin/k3s-uninstall.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Defaults ---
K3S_VERSION="${K3S_VERSION:-}"  # empty = latest stable
AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/abluva/connect-agent:latest}"
SAAS_NAMESPACE="${SAAS_NAMESPACE:-3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c}"
FABRIC_IDENTITY_STORE="kubernetes"
# YAML next to this script (copies of kubernetes/ manifests).
DAEMONSET_YAML="${DAEMONSET_YAML:-$SCRIPT_DIR/daemonset.yaml}"
NP_YAML="${NP_YAML:-$SCRIPT_DIR/networkpolicy-example.yaml}"

# Same namespace convention as Connect UI / tenant-start.sh (fabric.js):
#   <tenantId>-<environmentId without leading tmp-, first 26 chars>
derive_namespace() {
  local tid="$1" eid="$2"
  local env_part
  env_part="$(printf '%s' "$eid" | sed 's/^tmp-//' | cut -c1-26)"
  printf '%s-%s' "$tid" "$env_part"
}

# --- Parse args ---
BOOTSTRAP_TOKEN=""
GATEWAY_ADDRESS=""
CONTROL_PLANE_URL=""
TENANT_ID=""
TENANT_NAMESPACE=""
ENVIRONMENT_ID=""
CA_FILE=""
CA_URL=""
ENV_FILE=""
TLS_SERVER_NAME=""

usage() {
  echo "Usage: $0 --token=<TOKEN> --gateway=<HOST:PORT> --control-plane=<URL> --tenant-id=<UUID> [--ca-file=<PATH> | --ca-url=<URL>]"
  echo "   Or: $0 --env-file=<PATH>"
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --token=*)          BOOTSTRAP_TOKEN="${arg#*=}" ;;
    --gateway=*)        GATEWAY_ADDRESS="${arg#*=}" ;;
    --control-plane=*)  CONTROL_PLANE_URL="${arg#*=}" ;;
    --tenant-id=*)      TENANT_ID="${arg#*=}" ;;
    --ca-file=*)        CA_FILE="${arg#*=}" ;;
    --ca-url=*)         CA_URL="${arg#*=}" ;;
    --env-file=*)       ENV_FILE="${arg#*=}" ;;
    --image=*)          AGENT_IMAGE="${arg#*=}" ;;
    --tls-server-name=*) TLS_SERVER_NAME="${arg#*=}" ;;
    --help|-h)          usage ;;
    *)                  echo "Unknown arg: $arg"; usage ;;
  esac
done

# Load from env file if provided
if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: --env-file=$ENV_FILE not found"
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN:-${FABRIC_BOOTSTRAP_TOKEN:-}}"
  GATEWAY_ADDRESS="${GATEWAY_ADDRESS:-${FABRIC_GATEWAY_ADDRESS:-}}"
  CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-${FABRIC_CONTROL_PLANE_URL:-}}"
  TENANT_ID="${TENANT_ID:-${FABRIC_TENANT_ID:-}}"
  TENANT_NAMESPACE="${TENANT_NAMESPACE:-${NAMESPACE:-}}"
  TLS_SERVER_NAME="${TLS_SERVER_NAME:-${FABRIC_TLS_SERVER_NAME:-}}"
  ENVIRONMENT_ID="${ENVIRONMENT_ID:-}"
  AGENT_IMAGE="${AGENT_IMAGE:-${CONNECT_AGENT_IMAGE:-$AGENT_IMAGE}}"
  CA_FILE="${CA_FILE:-${CA_CERT_FILE:-}}"
fi

# Validate required args
[[ -n "$BOOTSTRAP_TOKEN" ]] || { echo "ERROR: --token is required"; usage; }
[[ -n "$GATEWAY_ADDRESS" ]] || { echo "ERROR: --gateway is required"; usage; }
[[ -n "$CONTROL_PLANE_URL" ]] || { echo "ERROR: --control-plane is required"; usage; }
[[ -n "$TENANT_ID" ]] || { echo "ERROR: --tenant-id is required"; usage; }
[[ -n "$ENVIRONMENT_ID" ]] || { echo "ERROR: ENVIRONMENT_ID is required (same as K8s — used for tenant namespace)"; exit 1; }

# Namespace: same as kubernetes/tenant-start.sh
if [[ -z "$TENANT_NAMESPACE" ]]; then
  TENANT_NAMESPACE="$(derive_namespace "$TENANT_ID" "$ENVIRONMENT_ID")"
fi
NAMESPACE="$TENANT_NAMESPACE"

if [[ ! -f "$DAEMONSET_YAML" ]]; then
  echo "ERROR: missing DaemonSet YAML: $DAEMONSET_YAML"
  echo "       Expected daemonset.yaml next to install.sh (same as kubernetes/daemonset.yaml)."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to render daemonset.yaml (same as tenant-start.sh)"
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

# --- Step 2: Fetch CA bundle ---
echo "[2/6] Setting up CA trust bundle..."
CA_CONTENT=""
if [[ -n "$CA_FILE" ]]; then
  CA_CONTENT=$(cat "$CA_FILE")
elif [[ -n "$CA_URL" ]]; then
  CA_CONTENT=$(curl -sSf "$CA_URL")
else
  echo "  WARNING: No --ca-file or --ca-url provided. Agent will use system trust only."
  echo "  For production, provide the Platform CA via --ca-file or --ca-url."
  CA_CONTENT=""
fi

# --- Step 3: Create tenant namespace + secrets (same shape as tenant-start.sh) ---
echo "[3/6] Creating namespace and secrets..."
echo "  Namespace: $TENANT_NAMESPACE  (tenant=$TENANT_ID env=$ENVIRONMENT_ID)"
k3s kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${TENANT_NAMESPACE}
  labels:
    abluva.io/tenant: "true"
EOF

if [[ -n "$CA_CONTENT" ]]; then
  k3s kubectl -n "$NAMESPACE" create secret generic connect-agent-tls \
    --from-literal=ca.crt="$CA_CONTENT" \
    --dry-run=client -o yaml | k3s kubectl apply -f -
fi

# Upsert bootstrap: re-run with --token=... overwrites the Secret.
# Enrolled Agents ignore bootstrap. New Agent pods read the new token at start.
_bs_yaml="$(k3s kubectl -n "$NAMESPACE" create secret generic fabric-edge-bootstrap \
  --from-literal=bootstrap_token="$BOOTSTRAP_TOKEN" \
  --dry-run=client -o yaml)"
if k3s kubectl -n "$NAMESPACE" get secret fabric-edge-bootstrap >/dev/null 2>&1; then
  echo "$_bs_yaml" | k3s kubectl -n "$NAMESPACE" replace -f -
  echo "[OK] fabric-edge-bootstrap updated (new enrolls use this token)."
else
  echo "$_bs_yaml" | k3s kubectl -n "$NAMESPACE" apply -f -
  echo "[OK] fabric-edge-bootstrap created."
fi

# --- Step 4: Deploy Connect Agent (same daemonset.yaml as kubernetes/tenant-start.sh) ---
echo "[4/6] Deploying Connect Agent (shared kubernetes/daemonset.yaml)..."
GW_HOST="${GATEWAY_ADDRESS%%:*}"
NO_PROXY_VALUE="${GW_HOST},localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.svc.cluster.local,.cluster.local"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

export TENANT_NAMESPACE="$NAMESPACE"
export CONNECT_AGENT_IMAGE="$AGENT_IMAGE"
export FABRIC_GATEWAY_ADDRESS="$GATEWAY_ADDRESS"
export FABRIC_CONTROL_PLANE_URL="$CONTROL_PLANE_URL"
export FABRIC_TLS_SERVER_NAME="${TLS_SERVER_NAME:-}"
export TENANT_ID
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
  sed -e "s/TENANT_NAMESPACE/${NAMESPACE}/g" \
      -e "s/SAAS_NAMESPACE/${SAAS_NAMESPACE}/g" \
    "$NP_YAML" | k3s kubectl apply -f -
  echo "  [OK] NetworkPolicy applied from $NP_YAML."
else
  echo "  [SKIP] NetworkPolicy YAML not found at $NP_YAML"
fi

# --- Step 6: Wait for Agent to be ready ---
echo "[6/6] Waiting for Agent to start..."
for i in $(seq 1 60); do
  if k3s kubectl -n "$NAMESPACE" get pods -l app=connect-agent --field-selector=status.phase=Running 2>/dev/null | grep -q Running; then
    echo ""
    echo "============================================================"
    echo "  Abluva Connect Agent installed successfully!"
    echo ""
    echo "  Next:"
    echo "    1. Check pods:"
    echo "         k3s kubectl -n $TENANT_NAMESPACE get pods"
    echo "       Expect Running 1/1: connect-agent"
    echo ""
    echo "    2. Abluva UI → Subscriptions → Connect Agent:"
    echo "       - Wait until Connected (Approve if PendingApproval)."
    echo "       - Install → Refresh for CONTROL_SERVER_LISTEN_PORT."
    echo ""
    echo "    3. Deploy the launcher (tenant + env + email + listen port):"
    echo "         cd ../../../agent"
    echo "         KUBECTL=\"k3s kubectl\" ./deploy-agent.sh -t ${TENANT_ID} -e <ENVIRONMENT_ID> -m <LOGIN_EMAIL> -p <PORT> --vm"
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
echo "  k3s kubectl -n $NAMESPACE describe pods -l app=connect-agent"
echo "  k3s kubectl -n $NAMESPACE logs -l app=connect-agent"
echo "  Full guide: deploy/secure-agent-net.README.md → Troubleshooting"
exit 1
