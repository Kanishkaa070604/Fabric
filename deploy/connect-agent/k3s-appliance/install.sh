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
#   - curl or wget; root access
#   - Outbound TCP to FABRIC_GATEWAY_ADDRESS host:port (typically :8443)
#     and HTTPS to FABRIC_CONTROL_PLANE_URL
#
# What gets installed:
#   - /usr/local/bin/k3s (single static binary, ~60MB)
#   - systemd unit: k3s.service (managed by the k3s installer)
#   - Namespace: fabric-edge
#   - DaemonSet: connect-agent (same manifest as the K8s path)
#   - Secrets: connect-agent-tls (CA), fabric-edge-bootstrap (token)
#
# Uninstall:
#   /usr/local/bin/k3s-uninstall.sh
# ============================================================
set -euo pipefail

# --- Defaults ---
K3S_VERSION="${K3S_VERSION:-}"  # empty = latest stable
AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/abluva/connect-agent:latest}"
NAMESPACE="fabric-edge"
FABRIC_IDENTITY_STORE="kubernetes"

# --- Parse args ---
BOOTSTRAP_TOKEN=""
GATEWAY_ADDRESS=""
CONTROL_PLANE_URL=""
TENANT_ID=""
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
  TLS_SERVER_NAME="${TLS_SERVER_NAME:-${FABRIC_TLS_SERVER_NAME:-}}"
fi

# Validate required args
[[ -n "$BOOTSTRAP_TOKEN" ]] || { echo "ERROR: --token is required"; usage; }
[[ -n "$GATEWAY_ADDRESS" ]] || { echo "ERROR: --gateway is required"; usage; }
[[ -n "$CONTROL_PLANE_URL" ]] || { echo "ERROR: --control-plane is required"; usage; }
[[ -n "$TENANT_ID" ]] || { echo "ERROR: --tenant-id is required"; usage; }

# --- Step 1: Install k3s ---
echo "[1/5] Installing k3s..."
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
echo "[2/5] Setting up CA trust bundle..."
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

# --- Step 3: Create namespace + secrets ---
echo "[3/5] Creating namespace and secrets..."
k3s kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | k3s kubectl apply -f -

if [[ -n "$CA_CONTENT" ]]; then
  k3s kubectl -n "$NAMESPACE" create secret generic connect-agent-tls \
    --from-literal=ca.crt="$CA_CONTENT" \
    --dry-run=client -o yaml | k3s kubectl apply -f -
fi

k3s kubectl -n "$NAMESPACE" create secret generic fabric-edge-bootstrap \
  --from-literal=bootstrap_token="$BOOTSTRAP_TOKEN" \
  --dry-run=client -o yaml | k3s kubectl apply -f -

# --- Step 4: Deploy Connect Agent ---
echo "[4/5] Deploying Connect Agent..."
NO_PROXY_VALUE="${GATEWAY_ADDRESS%%:*},localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.svc.cluster.local"

cat <<EOF | k3s kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: connect-agent
  namespace: $NAMESPACE
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: connect-agent
  namespace: $NAMESPACE
rules:
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "create", "patch"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: connect-agent
  namespace: $NAMESPACE
subjects:
  - kind: ServiceAccount
    name: connect-agent
    namespace: $NAMESPACE
roleRef:
  kind: Role
  name: connect-agent
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: connect-agent
  namespace: $NAMESPACE
spec:
  selector:
    matchLabels:
      app: connect-agent
  template:
    metadata:
      labels:
        app: connect-agent
    spec:
      serviceAccountName: connect-agent
      containers:
        - name: connect-agent
          image: $AGENT_IMAGE
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          env:
            - name: FABRIC_GATEWAY_ADDRESS
              value: "$GATEWAY_ADDRESS"
            - name: FABRIC_TLS_SERVER_NAME
              value: "${TLS_SERVER_NAME:-}"
            - name: FABRIC_TENANT_ID
              value: "$TENANT_ID"
            - name: FABRIC_CONTROL_PLANE_URL
              value: "$CONTROL_PLANE_URL"
            - name: FABRIC_BOOTSTRAP_TOKEN
              valueFrom:
                secretKeyRef:
                  name: fabric-edge-bootstrap
                  key: bootstrap_token
            - name: FABRIC_AGENT_CERT_DIR
              value: /var/run/fabric/tls
            - name: FABRIC_AGENT_CA_FILE
              value: /etc/connect-agent/tls/ca.crt
            - name: FABRIC_AGENT_ID_PATH
              value: /var/run/fabric/agent-id
            - name: FABRIC_IDENTITY_STORE
              value: "$FABRIC_IDENTITY_STORE"
            - name: FABRIC_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: FABRIC_K8S_SERVICE_MANAGE_ENABLED
              value: "1"
            - name: FABRIC_SUBSTRATE
              value: "vm"
            - name: NO_PROXY
              value: "$NO_PROXY_VALUE"
            - name: no_proxy
              value: "$NO_PROXY_VALUE"
          volumeMounts:
            - name: agent-trust
              mountPath: /etc/connect-agent/tls
              readOnly: true
            - name: agent-cache
              mountPath: /var/run/fabric
          readinessProbe:
            exec:
              command: ["/connect-agent", "ready"]
            periodSeconds: 10
          livenessProbe:
            exec:
              command: ["/connect-agent", "health"]
            periodSeconds: 15
          resources:
            requests: { cpu: "50m", memory: "64Mi" }
            limits: { cpu: "200m", memory: "128Mi" }
      volumes:
        - name: agent-trust
          secret:
            secretName: connect-agent-tls
            optional: true
        - name: agent-cache
          emptyDir: {}
EOF

# --- Step 5: Wait for Agent to be ready ---
echo "[5/5] Waiting for Agent to start..."
for i in $(seq 1 60); do
  if k3s kubectl -n "$NAMESPACE" get pods -l app=connect-agent --field-selector=status.phase=Running 2>/dev/null | grep -q Running; then
    echo ""
    echo "============================================================"
    echo "  Abluva Connect Agent installed successfully!"
    echo ""
    echo "  Status:   k3s kubectl -n $NAMESPACE get pods"
    echo "  Logs:     k3s kubectl -n $NAMESPACE logs -l app=connect-agent"
    echo "  Uninstall: /usr/local/bin/k3s-uninstall.sh"
    echo ""
    echo "  Next steps:"
    echo "    1. Approve the Agent in the Abluva UI"
    echo "    2. Create registrations for your services"
    echo "    3. Point apps (pods on this k3s) at:"
    echo "         connect-agent.$NAMESPACE.svc.cluster.local:<port>"
    echo "       Port map:"
    echo "         k3s kubectl -n $NAMESPACE get svc connect-agent -o jsonpath='{.metadata.annotations.fabric\\.abluva\\.io/registration-ports}'"
    echo "       (Host-OS apps need NodePort/hostPort — ClusterIP is in-cluster only.)"
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
exit 1
