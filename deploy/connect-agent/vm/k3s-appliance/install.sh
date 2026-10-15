#!/usr/bin/env bash
# ============================================================
# Abluva Connect Agent — VM / bare metal installer (k3s appliance)
#
# Tenant guide: repo root README (secure-agent-net.README.md / README.md).
# Part A Steps 1–4 (this script is Step 4). Part B only after Agent is ready.
#
#   1. Get the installer (clone → connect-agent/vm/k3s-appliance)
#   2. CA → Download → ca.crt
#   3. Generate token (auto-fills BOOTSTRAP_TOKEN; leave page → placeholder →
#      Generate again) → save fabric-edge.env HERE with ca.crt + daemonset.yaml
#   4. Run:  sudo ./install.sh
#            or: sudo ./install.sh ./fabric-edge.env
#
# Ready for Part B when Install → Refresh shows CONTROL_SERVER_LISTEN_PORT,
# or Customer registrations → Create is enabled.
#
# Needs: root, curl, python3; egress to Gateway :8443 + control plane.
# Optional CLI (after env, CLI wins): --token= --gateway= --image= --ca-url= …
# Ports: :8443 tunnel · :8444 inbound · :9443+ listen (Refresh) · :5004 agent-svc
# Uninstall: /usr/local/bin/k3s-uninstall.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Defaults ---
K3S_VERSION="${K3S_VERSION:-}"  # empty = latest stable
DAEMONSET_YAML="${DAEMONSET_YAML:-$SCRIPT_DIR/daemonset.yaml}"
NP_YAML="${NP_YAML:-$SCRIPT_DIR/networkpolicy-example.yaml}"
SKIP_NETWORK_POLICY="${SKIP_NETWORK_POLICY:-0}"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-300s}"
# Default: fabric-edge.env next to this script (not the .example template)
ENV_FILE="${SCRIPT_DIR}/fabric-edge.env"

# CLI overrides — collected first, applied after source so CLI wins over env.
CLI_BOOTSTRAP_TOKEN=""
CLI_FABRIC_GATEWAY_ADDRESS=""
CLI_FABRIC_CONTROL_PLANE_URL=""
CLI_TENANT_ID=""
CLI_TENANT_NAMESPACE=""
CLI_CA_CERT_FILE=""
CLI_CA_URL=""
CLI_CONNECT_AGENT_IMAGE=""
CLI_FABRIC_TLS_SERVER_NAME=""

usage() {
  echo "Usage (same method as kubernetes/tenant-start.sh):"
  echo "  $0 [path/to/fabric-edge.env]"
  echo "  $0 --env-file=<path/to/fabric-edge.env>"
  echo "Default env file: ${SCRIPT_DIR}/fabric-edge.env"
  echo "       See fabric-edge.env.example for the template only."
  echo "CLI (optional, overrides env): --token=... --gateway=... --control-plane=..."
  echo "  --tenant-id=... --namespace=... --image=... --ca-file=... --ca-url=..."
  exit 1
}

# Positional fabric-edge.env (same as tenant-start.sh ./tenant-start.env)
if [[ $# -ge 1 && "$1" != --* ]]; then
  ENV_FILE="$1"
  shift
fi

for arg in "$@"; do
  case "$arg" in
    --token=*)           CLI_BOOTSTRAP_TOKEN="${arg#*=}" ;;
    --gateway=*)         CLI_FABRIC_GATEWAY_ADDRESS="${arg#*=}" ;;
    --control-plane=*)   CLI_FABRIC_CONTROL_PLANE_URL="${arg#*=}" ;;
    --tenant-id=*)       CLI_TENANT_ID="${arg#*=}" ;;
    --namespace=*)       CLI_TENANT_NAMESPACE="${arg#*=}" ;;
    --ca-file=*)         CLI_CA_CERT_FILE="${arg#*=}" ;;
    --ca-url=*)          CLI_CA_URL="${arg#*=}" ;;
    --env-file=*)        ENV_FILE="${arg#*=}" ;;
    --image=*)           CLI_CONNECT_AGENT_IMAGE="${arg#*=}" ;;
    --tls-server-name=*) CLI_FABRIC_TLS_SERVER_NAME="${arg#*=}" ;;
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
ENVIRONMENT_ID="${ENVIRONMENT_ID:-}"
SAAS_NAMESPACE="${SAAS_NAMESPACE:-}"

# CLI overrides win over env file
[[ -n "$CLI_BOOTSTRAP_TOKEN" ]] && BOOTSTRAP_TOKEN="$CLI_BOOTSTRAP_TOKEN"
[[ -n "$CLI_FABRIC_GATEWAY_ADDRESS" ]] && FABRIC_GATEWAY_ADDRESS="$CLI_FABRIC_GATEWAY_ADDRESS"
[[ -n "$CLI_FABRIC_CONTROL_PLANE_URL" ]] && FABRIC_CONTROL_PLANE_URL="$CLI_FABRIC_CONTROL_PLANE_URL"
[[ -n "$CLI_TENANT_ID" ]] && TENANT_ID="$CLI_TENANT_ID"
[[ -n "$CLI_TENANT_NAMESPACE" ]] && TENANT_NAMESPACE="$CLI_TENANT_NAMESPACE"
[[ -n "$CLI_CA_CERT_FILE" ]] && CA_CERT_FILE="$CLI_CA_CERT_FILE"
[[ -n "$CLI_CONNECT_AGENT_IMAGE" ]] && CONNECT_AGENT_IMAGE="$CLI_CONNECT_AGENT_IMAGE"
[[ -n "$CLI_FABRIC_TLS_SERVER_NAME" ]] && FABRIC_TLS_SERVER_NAME="$CLI_FABRIC_TLS_SERVER_NAME"
CA_URL="${CLI_CA_URL:-${CA_URL:-}}"

# Same namespace convention as Connect UI / deploy-agent.sh / Kubernetes Install:
#   <tenantId>-<environmentId without leading tmp-, first 26 chars>
derive_namespace() {
  local tid="$1" eid="$2"
  local env_part
  env_part="$(printf '%s' "$eid" | sed 's/^tmp-//' | cut -c1-26)"
  printf '%s-%s' "$tid" "$env_part"
}

: "${TENANT_ID:?TENANT_ID required}"
: "${FABRIC_GATEWAY_ADDRESS:?FABRIC_GATEWAY_ADDRESS required}"
: "${FABRIC_CONTROL_PLANE_URL:?FABRIC_CONTROL_PLANE_URL required}"
: "${CONNECT_AGENT_IMAGE:?CONNECT_AGENT_IMAGE required}"
: "${CA_CERT_FILE:?CA_CERT_FILE required}"
: "${BOOTSTRAP_TOKEN:?BOOTSTRAP_TOKEN required}"

# Prefer TENANT_NAMESPACE from env; else derive from TENANT_ID + ENVIRONMENT_ID
# (same as deploy-agent.sh — fabric-edge.env from older Install snippets often omits ns).
if [[ -z "${TENANT_NAMESPACE:-}" ]]; then
  : "${ENVIRONMENT_ID:?ENVIRONMENT_ID required to derive TENANT_NAMESPACE (or set TENANT_NAMESPACE)}"
  TENANT_NAMESPACE="$(derive_namespace "$TENANT_ID" "$ENVIRONMENT_ID")"
  echo "[OK] Derived TENANT_NAMESPACE=$TENANT_NAMESPACE"
fi

# Resolve relative CA path against this script's directory (not caller's cwd).
case "$CA_CERT_FILE" in
  /*) ;;
  *) CA_CERT_FILE="${SCRIPT_DIR}/${CA_CERT_FILE#./}" ;;
esac

# Optional fetch before existence check (CLI --ca-url or CA_URL in env).
if [[ -n "${CA_URL:-}" && ! -s "$CA_CERT_FILE" ]]; then
  echo "[OK] Fetching Gateway CA from $CA_URL → $CA_CERT_FILE"
  curl -sSf "$CA_URL" >"$CA_CERT_FILE"
fi

if [[ ! -f "$CA_CERT_FILE" ]]; then
  echo "ERROR: CA_CERT_FILE not found: $CA_CERT_FILE"
  echo "       Put Gateway ca.crt next to install.sh, or pass --ca-url=…"
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
if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root (sudo ./install.sh) — k3s install requires root"
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
echo "  CA_CERT_FILE=$CA_CERT_FILE  (must be Gateway cert from Fetch CA /ca-bundle)"


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
if [[ "$SKIP_NETWORK_POLICY" == "1" ]]; then
  echo "  [SKIP] SKIP_NETWORK_POLICY=1"
elif [[ -f "$NP_YAML" ]]; then
  if [[ -z "$SAAS_NAMESPACE" ]]; then
    echo "  [WARN] SAAS_NAMESPACE unset — NetPol SaaS peer selector will be empty placeholder."
  fi
  sed -e "s/TENANT_NAMESPACE/${TENANT_NAMESPACE}/g" \
      -e "s/SAAS_NAMESPACE/${SAAS_NAMESPACE:-SAAS_NAMESPACE}/g" \
    "$NP_YAML" | k3s kubectl apply -f -
  k3s kubectl -n "$TENANT_NAMESPACE" delete netpol connect-agent-ingress --ignore-not-found >/dev/null 2>&1 || true
  echo "  [OK] NetworkPolicy applied from $NP_YAML."
else
  echo "  [SKIP] NetworkPolicy YAML not found at $NP_YAML"
fi

# --- Step 6: Wait for Agent to be ready ---
echo "[6/6] Waiting for Agent DaemonSet..."
if k3s kubectl -n "$TENANT_NAMESPACE" rollout status "daemonset/connect-agent" --timeout="$AGENT_TIMEOUT"; then
  echo ""
  echo "============================================================"
  echo "  PART A COMPLETE — Connect Agent installed (Step 4)"
  echo "============================================================"
  echo ""
  echo "  Verify:"
  echo "    k3s kubectl -n ${TENANT_NAMESPACE} get pods"
  echo "    Expect: connect-agent  Running  1/1"
  echo ""
  echo "  Ready for Part B when either is true:"
  echo "    - Install → Refresh shows CONTROL_SERVER_LISTEN_PORT"
  echo "    - Customer registrations → Create is enabled"
  echo ""
  echo "  Then Part B:"
  echo "    1. Install → Refresh → copy CONTROL_SERVER_LISTEN_PORT"
  echo "    2. Deploy launcher:"
  echo "         cd ../../../agent   # or from repo root: cd agent"
  echo "         KUBECTL=\"k3s kubectl\" ./deploy-agent.sh -t ${TENANT_ID} -e ${ENVIRONMENT_ID:-<ENVIRONMENT_ID>} -m <LOGIN_EMAIL> -p <CONTROL_SERVER_LISTEN_PORT> --vm"
  echo "    3. Customer registrations: host=agent-svc port=5004"
  echo "    4. Resources → Register Resource:"
  echo "         Name: choose a label for this tenant/env"
  echo "         Type: agent#https · Auth: Credentials"
  echo "         base_url: https:// + exact dial host:port from Connect Agent tab"
  echo "         endpoint: api/v1/launcher/create"
  echo "         (copy dial from agent-launcher row — not agent-svc)"
  echo ""
  echo "  Guide: README.md at the repo root"
  echo "============================================================"
  exit 0
fi

echo ""
echo "WARNING: DaemonSet not ready within ${AGENT_TIMEOUT}. Check:"
echo "  k3s kubectl -n $TENANT_NAMESPACE describe pods -l app=connect-agent"
echo "  k3s kubectl -n $TENANT_NAMESPACE logs -l app=connect-agent"
echo "  Full guide: README.md at the repo root → Troubleshooting"
exit 1
