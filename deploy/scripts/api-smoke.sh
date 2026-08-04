#!/usr/bin/env bash
# Verified against control-plane MemoryStore HTTP APIs (slice 1–3).
# Usage:
#   FABRIC_CONTROL_PLANE_URL=http://127.0.0.1:8080 ./deploy/scripts/api-smoke.sh
# Or let the script start a local CP if URL is unset and deps are installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CP_URL="${FABRIC_CONTROL_PLANE_URL:-}"
TENANT="${FABRIC_SMOKE_TENANT_ID:-00000000-0000-0000-0000-0000000000aa}"
ACTOR="${FABRIC_SMOKE_ACTOR:-ops-smoke}"
STARTED_CP=0

cleanup() {
  if [[ "$STARTED_CP" -eq 1 && -n "${CP_PID:-}" ]]; then
    kill "$CP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -z "$CP_URL" ]]; then
  CP_URL="http://127.0.0.1:18080"
  echo "==> starting local control-plane on $CP_URL"
  (
    cd "$ROOT/control-plane"
    FABRIC_CONTROL_PLANE_PORT=18080 \
      ABLV_ACCESS_URL=http://127.0.0.1:9/v1/access \
      npx tsx src/index.ts
  ) &
  CP_PID=$!
  STARTED_CP=1
  for i in $(seq 1 30); do
    if curl -sf "$CP_URL/healthz" >/dev/null; then
      break
    fi
    sleep 0.2
  done
  curl -sf "$CP_URL/healthz" >/dev/null
fi

CP_TOKEN="${FABRIC_CONTROL_PLANE_TOKEN:-}"
hdr=(-H "Content-Type: application/json" -H "X-ABLV-Actor: $ACTOR")
if [[ -n "$CP_TOKEN" ]]; then
  hdr+=(-H "Authorization: Bearer $CP_TOKEN")
fi
json() { python3 -c 'import json,sys; print(json.load(sys.stdin)'"$1"')'; }

echo "==> ensure tenant"
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\"}" "$CP_URL/v1/tenants/ensure" >/dev/null

echo "==> bootstrap token"
TOK_JSON=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/tenants/$TENANT/bootstrap-token")
TOKEN=$(printf '%s' "$TOK_JSON" | json "['bootstrap_token']")
test -n "$TOKEN"

echo "==> enroll (expect PendingApproval)"
FP="smoke$(date +%s)"
ENROLL=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"bootstrap_token\":\"$TOKEN\",\"substrate\":\"kubernetes\",\"cert_fingerprint_sha256\":\"$FP\"}" \
  "$CP_URL/v1/agents/enroll")
AGENT_ID=$(printf '%s' "$ENROLL" | json "['id']")
STATE=$(printf '%s' "$ENROLL" | json "['state']")
test "$STATE" = "PendingApproval"

echo "==> tunnel up while pending (G-BOOT-1)"
TUN=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"cert_fingerprint\":\"$FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event")
test "$(printf '%s' "$TUN" | json "['state']")" = "PendingApproval"
test "$(printf '%s' "$TUN" | json "['tunnel_state']")" = "up_pending_approval"

AUTHZ=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/authz-context?tenant_id=$TENANT&cert_fingerprint=$FP")
test "$(printf '%s' "$AUTHZ" | json "['agent_approved']")" = "False"

echo "==> approve → Connected (tunnel already up)"
APR=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT_ID/approve")
test "$(printf '%s' "$APR" | json "['state']")" = "Connected"

echo "==> create PLATFORM_SERVICE registration"
REG=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"smoke-plat\",\"connectivity_type\":\"SERVICE\",\"destination_kind\":\"PLATFORM_SERVICE\",\"host\":\"127.0.0.1\",\"port\":9}" \
  "$CP_URL/v1/registrations")
REG_ID=$(printf '%s' "$REG" | json "['id']")
test "$(printf '%s' "$REG" | json "['state']")" = "Active"

echo "==> authz-context eligible agent present"
AUTHZ2=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/authz-context?tenant_id=$TENANT&registration_id=$REG_ID&cert_fingerprint=$FP")
test "$(printf '%s' "$AUTHZ2" | json "['agent_approved']")" = "True"
test "$(printf '%s' "$AUTHZ2" | json "['registration']['State']")" = "Active"

echo "==> agent-by-cert"
BY=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/agent-by-cert?cert_fingerprint=$FP")
test "$(printf '%s' "$BY" | json "['agent_id']")" = "$AGENT_ID"

echo "OK api-smoke passed tenant=$TENANT agent=$AGENT_ID reg=$REG_ID"
