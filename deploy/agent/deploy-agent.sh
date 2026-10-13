#!/usr/bin/env bash
# ============================================================
# Abluva launcher (Deployment/agent + agent-svc) — after Agent Connected
#
# Inputs (after Connect Agent is Connected and the listen port is known):
#   --tenant-id / -t
#   --environment-id / -e
#   --email / -m         login email → X_ABLV_PRINCIPAL
#   --port / -p          CONTROL_SERVER_LISTEN_PORT (control-server)
#
# The script derives TENANT_NAMESPACE (same as Connect UI Install),
# writes deploy-agent.env, and applies agent-deployment.yaml.
#
# Usage:
#   ./deploy-agent.sh -t <TENANT_ID> -e <ENVIRONMENT_ID> -m <EMAIL> -p <PORT>
#
# VM / k3s appliance (namespace is always fabric-edge):
#   KUBECTL="k3s kubectl" ./deploy-agent.sh -t ... -e ... -m ... -p ... --vm
#
# Optional:
#   --namespace=<ns>     override derived ns
#   --env-out=<path>     where to write env (default: ./deploy-agent.env)
#   --env-file=<path>    use an existing env instead of flags
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DEPLOY_YAML="${AGENT_DEPLOY_YAML:-$SCRIPT_DIR/agent-deployment.yaml}"
KUBECTL="${KUBECTL:-kubectl}"
ENV_OUT="${ENV_OUT:-$SCRIPT_DIR/deploy-agent.env}"

TENANT_ID=""
ENVIRONMENT_ID=""
PRINCIPAL_EMAIL=""
CS_PORT=""
TENANT_NAMESPACE=""
ENV_FILE=""
VM_MODE=0

usage() {
  cat <<'EOF'
Usage:
  ./deploy-agent.sh -t <TENANT_ID> -e <ENVIRONMENT_ID> -m <EMAIL> -p <PORT> [--vm]

  Creates deploy-agent.env from those values and deploys the launcher.

Options:
  -t, --tenant-id          Fabric tenant UUID
  -e, --environment-id     Environment UUID
  -m, --email              Login email (X_ABLV_PRINCIPAL / X-ABLV-Principal)
  -p, --port               control-server agent_listen_port (required)
      --vm                 use namespace fabric-edge (k3s appliance)
      --namespace=<ns>     override namespace (default: <tenant>-<env[:26]>)
      --env-out=<path>     write env here (default: ./deploy-agent.env)
      --env-file=<path>    use existing env instead of flags
  -h, --help

VM example:
  KUBECTL="k3s kubectl" ./deploy-agent.sh -t ... -e ... -m you@company.com -p 9444 --vm
EOF
  exit 1
}

# Namespace convention matches Connect UI Install (fabric.js tenantNamespace):
#   <tenantId>-<environmentId without leading tmp-, first 26 chars>
derive_namespace() {
  local tid="$1" eid="$2"
  local env_part
  env_part="$(printf '%s' "$eid" | sed 's/^tmp-//' | cut -c1-26)"
  printf '%s-%s' "$tid" "$env_part"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tenant-id)       TENANT_ID="${2:-}"; shift 2 ;;
    --tenant-id=*)        TENANT_ID="${1#*=}"; shift ;;
    -e|--environment-id)  ENVIRONMENT_ID="${2:-}"; shift 2 ;;
    --environment-id=*)   ENVIRONMENT_ID="${1#*=}"; shift ;;
    -m|--email|--principal) PRINCIPAL_EMAIL="${2:-}"; shift 2 ;;
    --email=*|--principal=*) PRINCIPAL_EMAIL="${1#*=}"; shift ;;
    -p|--port)            CS_PORT="${2:-}"; shift 2 ;;
    --port=*)             CS_PORT="${1#*=}"; shift ;;
    --namespace=*)        TENANT_NAMESPACE="${1#*=}"; shift ;;
    --namespace)          TENANT_NAMESPACE="${2:-}"; shift 2 ;;
    --env-out=*)          ENV_OUT="${1#*=}"; shift ;;
    --env-out)            ENV_OUT="${2:-}"; shift 2 ;;
    --env-file=*)         ENV_FILE="${1#*=}"; shift ;;
    --env-file)           ENV_FILE="${2:-}"; shift 2 ;;
    --vm)                 VM_MODE=1; shift ;;
    -h|--help)            usage ;;
    -*)                   echo "Unknown arg: $1"; usage ;;
    *)                    echo "Unexpected arg: $1"; usage ;;
  esac
done

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: --env-file not found: $ENV_FILE"
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  TENANT_ID="${TENANT_ID:-${FABRIC_TENANT_ID:-}}"
  ENVIRONMENT_ID="${ENVIRONMENT_ID:-}"
  PRINCIPAL_EMAIL="${PRINCIPAL_EMAIL:-${X_ABLV_PRINCIPAL:-}}"
  CS_PORT="${CS_PORT:-${CONTROL_SERVER_LISTEN_PORT:-}}"
  TENANT_NAMESPACE="${TENANT_NAMESPACE:-${NAMESPACE:-}}"
fi

: "${TENANT_ID:?Error: --tenant-id (-t) required}"
: "${ENVIRONMENT_ID:?Error: --environment-id (-e) required}"
: "${PRINCIPAL_EMAIL:?Error: --email (-m) required (login email for X_ABLV_PRINCIPAL)}"
: "${CS_PORT:?Error: --port (-p) required (control-server listen port after Agent Connected)}"

if ! [[ "$CS_PORT" =~ ^[0-9]+$ ]]; then
  echo "Error: port must be numeric (got: $CS_PORT)"
  exit 1
fi
if [[ "$PRINCIPAL_EMAIL" != *@* ]]; then
  echo "Error: --email must look like an email address (got: $PRINCIPAL_EMAIL)"
  exit 1
fi
# Escape for sed replacement (/, &, \)
escape_sed() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}
EMAIL_SED="$(escape_sed "$PRINCIPAL_EMAIL")"

if [[ -z "$TENANT_NAMESPACE" ]]; then
  if [[ "$VM_MODE" -eq 1 ]]; then
    TENANT_NAMESPACE="fabric-edge"
  else
    TENANT_NAMESPACE="$(derive_namespace "$TENANT_ID" "$ENVIRONMENT_ID")"
  fi
fi

if [[ ! -f "$AGENT_DEPLOY_YAML" ]]; then
  echo "Error: missing $AGENT_DEPLOY_YAML"
  exit 1
fi

# Write env for re-runs / audit
cat >"$ENV_OUT" <<EOF
# Generated by deploy-agent.sh — $(date -u +%Y-%m-%dT%H:%MZ)
TENANT_NAMESPACE=${TENANT_NAMESPACE}
TENANT_ID=${TENANT_ID}
ENVIRONMENT_ID=${ENVIRONMENT_ID}
X_ABLV_PRINCIPAL=${PRINCIPAL_EMAIL}
CONTROL_SERVER_LISTEN_PORT=${CS_PORT}
EOF
echo "[OK] wrote $ENV_OUT"

echo ""
echo "============================================================"
echo " Abluva launcher — deploy agent"
echo "============================================================"
echo "  Namespace:     $TENANT_NAMESPACE"
echo "  Tenant ID:     $TENANT_ID"
echo "  Environment:   $ENVIRONMENT_ID"
echo "  Principal:     $PRINCIPAL_EMAIL"
echo "  Listen port:   $CS_PORT  (control-server → INFRA_BASE_URL)"
echo "  kubectl:       $KUBECTL"
echo ""

$KUBECTL get ns "$TENANT_NAMESPACE" >/dev/null 2>&1 || {
  echo "Error: namespace $TENANT_NAMESPACE not found. Run the Connect Agent installer first."
  exit 1
}

sed -e "s/<tenant-namespace>/${TENANT_NAMESPACE}/g" \
    -e "s/<tenantId>/${TENANT_ID}/g" \
    -e "s/<envid>/${ENVIRONMENT_ID}/g" \
    -e "s/<control-server-listen-port>/${CS_PORT}/g" \
    -e "s/<principal-email>/${EMAIL_SED}/g" \
    -e "s/you@yourcompany.com/${EMAIL_SED}/g" \
    "$AGENT_DEPLOY_YAML" | $KUBECTL apply -f -

echo "[OK] agent-deployment.yaml applied (INFRA_BASE_URL → connect-agent:${CS_PORT})."
echo ""
echo "  Check:"
echo "    $KUBECTL -n ${TENANT_NAMESPACE} get pods,svc -l tier=agent"
echo "============================================================"
