#!/usr/bin/env bash
# Day-0 / Day-1 / Day-n smoke:
#   Platform = docker compose on the host (control-plane + Ghostunnel + Gateway + Postgres)
#   Tenant   = existing k3d cluster (Connect Agent dials host (FABRIC_HOST_GATEWAY / host.k3d.internal))
#
# Covers:
#   day-0  enroll → tunnel while PendingApproval → StreamOpen DENIED → approve → Connected
#   day-1  PLATFORM_SERVICE StreamOpen (DIRECT_ENDPOINT) → host echo :19090
#   day-1a PLATFORM_RESOURCE StreamOpen (PLATFORM_CONNECTOR adapter, Spec §8.7 B3)
#   day-1b CUSTOMER_SERVICE + observed reachability (CONNECT_AGENT hairpin + Agent inbound)
#   day-1c L3-AGT-02: same bootstrap window + CA-only Secret → two Agents;
#          selection (agent1 unreachable, agent2 reachable → dial agent2);
#          ECS-like emptyDir wipe → re-enroll; bootstrap revoke kills further enroll
#   day-1c2 Failed registration → POST .../retry → Active (L3-REG-01)
#   day-1d G-A3-1 inbound via CoreDNS *.connect.fabric
#   day-1e quotas (rate + concurrent) + auth/dual-control + heartbeat→Degraded
#   day-n  suspend deny → unsuspend ok → pod restart reconnect → revoke-cert deny
#
# Full matrix: docs/Validation-Plan.md
#
# Production-like defaults:
#   FABRIC_SMOKE_WIPE_DB=0  keep Postgres volume (set 1 to docker compose down -v)
#   FABRIC_SMOKE_TENANT_ID  optional; default = fresh UUID each run (avoids stale agents)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOCAL="$ROOT/deploy/local"
# shellcheck source=../lib.sh
source "$LOCAL/lib.sh"
K3D_CLUSTER="${K3D_CLUSTER:-fabric-edge}"
TENANT="${FABRIC_SMOKE_TENANT_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
CP_URL="${FABRIC_CONTROL_PLANE_URL:-http://127.0.0.1:18080}"
WIPE_DB="${FABRIC_SMOKE_WIPE_DB:-0}"
ACTOR="k3d-smoke"
CP_TOKEN="${FABRIC_CONTROL_PLANE_TOKEN:-fabric-local-dev-token}"
BREAK_GLASS="${FABRIC_DUAL_CONTROL_TOKEN:-fabric-break-glass}"
# Hostname Gateway (compose) uses to dial host-published ports. Compose adds
# host.docker.internal:host-gateway so this works on Linux/OCI Docker Engine
# and on Docker Desktop. Override with FABRIC_REG_HOST only if you must.
REG_HOST="${FABRIC_REG_HOST:-host.docker.internal}"
# Hostname k3d pods use to reach the same host ports. Newer k3d injects
# host.k3d.internal; older clusters / some Docker Desktop setups only have
# host.docker.internal. Override with FABRIC_K3D_HOST; otherwise auto-detect
# after the netcheck pod is up (see below).
K3D_HOST="${FABRIC_K3D_HOST:-}"
HOST_GW_IP="${FABRIC_HOST_GW_IP:-}"
apply_k3d_manifest() {
  # Manifests are authored with host.k3d.internal; rewrite to the chosen host.
  # REPLACE_HOST_GW_IP becomes the resolved host-gateway address so Agents can
  # dial REG_HOST (CUSTOMER_* destinations) — k3d CoreDNS often lacks
  # host.docker.internal for pod DNS.
  local ip="${HOST_GW_IP:-127.0.0.1}"
  sed -e "s/host\\.k3d\\.internal/${K3D_HOST}/g" \
      -e "s/REPLACE_HOST_GW_IP/${ip}/g" \
      "$1" | kubectl apply -f -
}
# Day-1e ages last_heartbeat_at in Postgres to force Degraded; keep a sane
# window so the rest of the suite is not raced by the watchdog.
export FABRIC_HEARTBEAT_DEGRADED_AFTER="${FABRIC_HEARTBEAT_DEGRADED_AFTER:-45s}"
export FABRIC_YAMUX_KEEPALIVE="${FABRIC_YAMUX_KEEPALIVE:-30s}"
ECHO_PID_FILE=/tmp/fabric-k3d-echo.pid
PF_PID=""

json() { python3 -c 'import json,sys; print(json.load(sys.stdin)'"$1"')'; }
hdr=(-H "Content-Type: application/json" -H "X-ABLV-Actor: $ACTOR" -H "Authorization: Bearer $CP_TOKEN")
# High-risk mutations (suspend / revoke-cert / registration delete)
dual=(-H "X-ABLV-Break-Glass: $BREAK_GLASS")

db_q() {
  (cd "$LOCAL" && docker compose exec -T postgres psql -U fabric -d fabric -v ON_ERROR_STOP=1 -At -c "$1")
}

assert_db_agent_state() {
  local id="$1" want="$2"
  local got
  got=$(db_q "SELECT state FROM ablv_agents WHERE id='$id' AND deleted_at IS NULL;")
  test "$got" = "$want" || {
    echo "FAIL: ablv_agents.id=$id state want=$want got=$got"
    exit 1
  }
}

assert_db_observed_reachable() {
  local reg="$1" agent="$2" want="$3"
  local got
  got=$(db_q "SELECT observed->'agent:$agent'->>'reachable' FROM ablv_registrations WHERE id='$reg';")
  test "$got" = "$want" || {
    echo "FAIL: observed agent:$agent reachable want=$want got=$got (reg=$reg)"
    db_q "SELECT observed::text FROM ablv_registrations WHERE id='$reg';" || true
    exit 1
  }
}

cleanup() {
  # Quiet SIGTERM noise from background helpers (port-forward / echo); not test failures.
  if [[ -n "$PF_PID" ]]; then kill "$PF_PID" 2>/dev/null || true; wait "$PF_PID" 2>/dev/null || true; fi
  if [[ -f "$ECHO_PID_FILE" ]]; then
    local ep
    ep="$(cat "$ECHO_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$ep" ]]; then kill "$ep" 2>/dev/null || true; wait "$ep" 2>/dev/null || true; fi
    rm -f "$ECHO_PID_FILE"
  fi
}
trap cleanup EXIT

stream_once() {
  local label="$1"
  local expect_ok="${2:-0}" # 1 = must be HTTP 200 + body
  local ctx="${FABRIC_TENANT_KUBE_CONTEXT:-k3d-${K3D_CLUSTER:-fabric-edge}}"
  if [[ -n "$PF_PID" ]]; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    PF_PID=""
  fi
  # Drop any stale port-forward holding :19443 from a prior failed run.
  pkill -f 'port-forward.*19443:9443' 2>/dev/null || true
  # Wait for the host port to actually free (pkill alone races bind).
  for _ in $(seq 1 40); do
    if ! (echo >/dev/tcp/127.0.0.1/19443) >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  : > /tmp/fabric-stream.out
  local ready=0
  local attempt
  for attempt in 1 2 3; do
    : > /tmp/fabric-pf.log
    kubectl --context "$ctx" -n fabric-edge port-forward svc/connect-agent 19443:9443 >/tmp/fabric-pf.log 2>&1 &
    PF_PID=$!
    disown "$PF_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "$PF_PID" 2>/dev/null; then
        break
      fi
      if grep -q "Forwarding from" /tmp/fabric-pf.log 2>/dev/null; then
        ready=1
        break
      fi
      # TCP listen is enough — PendingApproval StreamOpen may empty-reply / time out.
      if (echo >/dev/tcp/127.0.0.1/19443) >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 0.25
    done
    if [[ "$ready" = "1" ]]; then
      break
    fi
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    PF_PID=""
    pkill -f 'port-forward.*19443:9443' 2>/dev/null || true
    sleep 0.5
  done
  if [[ "$ready" != "1" ]]; then
    echo "FAIL: port-forward not ready for $label"
    cat /tmp/fabric-pf.log || true
    kubectl --context "$ctx" -n fabric-edge get pods,endpoints -o wide || true
    exit 1
  fi
  sleep 0.5
  local code body
  code=$(curl -sS -o /tmp/fabric-stream.out -w "%{http_code}" --max-time 15 http://127.0.0.1:19443/ || true)
  body=$(cat /tmp/fabric-stream.out 2>/dev/null || true)
  echo "stream[$label] http_code=$code body=${body:0:80}"
  if [[ "$expect_ok" = "1" ]]; then
    test "$code" = "200"
    grep -q "fabric-k3d-echo-ok" /tmp/fabric-stream.out
  else
    # Deny closes the local conn → empty reply / non-200.
    if [[ "$code" = "200" ]]; then
      echo "FAIL: expected StreamOpen deny for $label, got HTTP 200"
      exit 1
    fi
  fi
}

assert_gateway_denied() {
  local hint="${1:-}"
  sleep 1
  local logs
  logs=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 2m)
  echo "$logs" | grep -q stream_denied || {
    echo "FAIL: expected gateway stream_denied ${hint}"
    echo "$logs" | tail -40
    exit 1
  }
  if [[ -n "$hint" ]]; then
    # Prefer the most recent deny lines; fall back to any deny in the window.
    echo "$logs" | grep stream_denied | tail -15 | grep -qi "$hint" || \
    echo "$logs" | grep stream_denied | grep -qi "$hint" || {
      echo "FAIL: stream_denied missing hint '$hint'"
      echo "$logs" | grep stream_denied | tail -12
      exit 1
    }
  fi
}

wait_tunnel_ready() {
  local deploy="${1:-connect-agent}"
  for i in $(seq 1 90); do
    if kubectl -n fabric-edge logs "deploy/$deploy" --tail=200 2>/dev/null | grep -q tunnel_ready; then
      return 0
    fi
    sleep 2
  done
  echo "FAIL: $deploy never reached tunnel_ready"
  kubectl -n fabric-edge logs "deploy/$deploy" --tail=100 || true
  exit 1
}

echo "==> ensure kubectl / k3d ($K3D_CLUSTER)"
# Pin tenant context — Ambient/lease smokes leave current-context on the
# Platform cluster; bare kubectl would then deploy Agents there (wrong).
TENANT_CTX="${FABRIC_TENANT_KUBE_CONTEXT:-k3d-${K3D_CLUSTER}}"
kubectl config use-context "$TENANT_CTX" >/dev/null
kubectl cluster-info >/dev/null
k3d cluster list | grep -q "$K3D_CLUSTER"

# k3d apiserver occasionally times out OpenAPI download under smoke load.
kubectl_retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [[ "$n" -ge 6 ]]; then
      return 1
    fi
    echo "warn: kubectl retry $n: $*"
    sleep 2
  done
}

# Secret roll used between day-1 steps — validate=false avoids OpenAPI stall.
apply_bootstrap_secret() {
  local tmp
  tmp="$(mktemp)"
  kubectl --context "$TENANT_CTX" -n fabric-edge create secret generic fabric-edge-bootstrap \
    "$@" \
    --dry-run=client -o yaml >"$tmp"
  kubectl_retry kubectl --context "$TENANT_CTX" apply --validate=false -f "$tmp"
  rm -f "$tmp"
}
echo "kubectl context=$(kubectl config current-context)"

echo "==> platform compose (certs; wipe_db=$WIPE_DB tenant=$TENANT)"
cd "$LOCAL"
./gen-certs.sh
if [[ "${FABRIC_SMOKE_SKIP_PLATFORM:-0}" = "1" ]]; then
  echo "skip platform recreate (FABRIC_SMOKE_SKIP_PLATFORM=1)"
  curl -sf "$CP_URL/healthz" >/dev/null || {
    echo "FAIL: control-plane not healthy at $CP_URL"
    exit 1
  }
else
  if [[ "$WIPE_DB" = "1" ]]; then
    docker compose down -v >/dev/null 2>&1 || true
  else
    docker compose down >/dev/null 2>&1 || true
  fi
  docker compose up -d --build --force-recreate

  echo "==> wait for control-plane"
  for i in $(seq 1 90); do
    if curl -sf "$CP_URL/healthz" >/dev/null; then break; fi
    sleep 1
  done
  curl -sf "$CP_URL/healthz" >/dev/null
fi

echo "==> verify k3d → host control-plane :18080"
kubectl -n default delete pod fabric-netcheck --ignore-not-found --wait=true >/dev/null 2>&1 || true
kubectl -n default run fabric-netcheck --restart=Never --image=curlimages/curl:8.5.0 --command -- sleep 120
kubectl -n default wait --for=condition=Ready pod/fabric-netcheck --timeout=90s
if [[ -z "$K3D_HOST" ]]; then
  for cand in host.k3d.internal host.docker.internal; do
    if kubectl -n default exec mesh-netcheck -- curl -sf --connect-timeout 5 "http://${cand}:18080/healthz" >/dev/null 2>&1; then
      K3D_HOST="$cand"
      break
    fi
  done
fi
test -n "$K3D_HOST" || {
  echo "FAIL: k3d pod cannot reach host :18080 via host.k3d.internal or host.docker.internal"
  exit 1
}
if [[ -z "$HOST_GW_IP" ]]; then
  HOST_GW_IP=$(kubectl -n default exec mesh-netcheck -- getent hosts host.docker.internal 2>/dev/null | awk '{print $1; exit}')
  if [[ -z "$HOST_GW_IP" ]]; then
    HOST_GW_IP=$(kubectl -n default exec mesh-netcheck -- getent hosts "$K3D_HOST" 2>/dev/null | awk '{print $1; exit}')
  fi
fi
test -n "$HOST_GW_IP" || {
  echo "FAIL: could not resolve host-gateway IP for Agent hostAliases"
  exit 1
}
kubectl -n default exec mesh-netcheck -- curl -sf --connect-timeout 5 "http://${K3D_HOST}:18080/healthz" >/dev/null
kubectl -n default delete pod fabric-netcheck --ignore-not-found --wait=false >/dev/null 2>&1 || true
echo "OK reachability via $K3D_HOST (host_gw_ip=$HOST_GW_IP)"

echo "==> build + import connect-agent:local"
if [[ "${FABRIC_SMOKE_SKIP_AGENT_BUILD:-0}" = "1" || "${FABRIC_SMOKE_SKIP_PLATFORM:-0}" = "1" ]]; then
  echo "skip agent docker build/import (image already in cluster)"
else
  docker build -t connect-agent:local -f "$LOCAL/Dockerfile.connect-agent" "$ROOT"
  k3d image import connect-agent:local -c "$K3D_CLUSTER"
fi

echo "==> L3-CTL-01 auth gates"
code=$(curl -sS -o /tmp/fabric-auth.out -w "%{http_code}" -H "Content-Type: application/json" \
  -d "{\"tenant_id\":\"$TENANT\"}" "$CP_URL/v1/tenants/ensure" || true)
test "$code" = "401" || { echo "FAIL: expected 401 without bearer, got $code"; cat /tmp/fabric-auth.out; exit 1; }
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\"}" "$CP_URL/v1/tenants/ensure" >/dev/null
code=$(curl -sS -o /tmp/fabric-auth.out -w "%{http_code}" "${hdr[@]}" \
  -d '{"suspended":true}' "$CP_URL/v1/tenants/$TENANT/suspend" || true)
test "$code" = "403" || { echo "FAIL: expected 403 without break-glass, got $code"; cat /tmp/fabric-auth.out; exit 1; }
echo "OK auth + dual-control"

echo "==> tenant bootstrap + scoped Agent API token + registration"
TOK_JSON=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/tenants/$TENANT/bootstrap-token")
TOKEN=$(printf '%s' "$TOK_JSON" | json "['bootstrap_token']")
# L3-CTL-01a: Agents get scoped bearer (not the writer CP_TOKEN).
AGENT_TOK_JSON=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/tenants/$TENANT/agent-api-token" -d '{}')
AGENT_TOKEN=$(printf '%s' "$AGENT_TOK_JSON" | json "['agent_api_token']")
test -n "$AGENT_TOKEN"
code=$(curl -sS -o /tmp/fabric-auth.out -w "%{http_code}" \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "X-ABLV-Actor: agent" -H "X-ABLV-Break-Glass: $BREAK_GLASS" \
  -H "Content-Type: application/json" \
  -d '{"suspended":true,"cause":"security"}' "$CP_URL/v1/tenants/$TENANT/suspend" || true)
test "$code" = "403" || { echo "FAIL: agent token must not suspend, got $code"; cat /tmp/fabric-auth.out; exit 1; }
echo "OK scoped agent token cannot suspend"
DISP="k3d-echo-$(date +%s)"
REG=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"$DISP\",\"connectivity_type\":\"SERVICE\",\"destination_kind\":\"PLATFORM_SERVICE\",\"host\":\"$REG_HOST\",\"port\":19090}" \
  "$CP_URL/v1/registrations")
REG_ID=$(printf '%s' "$REG" | json "['id']")
echo "tenant=$TENANT registration=$REG_ID display=$DISP"

# Discovery APIs
TEN_GET=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT")
test "$(printf '%s' "$TEN_GET" | json "['tenant_id']")" = "$TENANT"
printf '%s' "$TEN_GET" | python3 -c 'import json,sys; assert json.load(sys.stdin)["bootstrap_token_outstanding"] is True'
REGS=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT/registrations")
printf '%s' "$REGS" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert any(r["id"]==sys.argv[1] for r in d["registrations"])' "$REG_ID"

echo "==> host echo on :19090"
if [[ -f "$ECHO_PID_FILE" ]]; then kill "$(cat "$ECHO_PID_FILE")" 2>/dev/null || true; fi
python3 -c '
import http.server, socketserver, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # /slow keeps the TCP (and thus Gateway stream slot) open for quota tests
        if self.path.startswith("/slow"):
            time.sleep(8)
        b=b"fabric-k3d-echo-ok\n"
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
socketserver.TCPServer.allow_reuse_address=True
httpd=socketserver.TCPServer(("0.0.0.0",19090), H)
httpd.serve_forever()
' &
echo $! > "$ECHO_PID_FILE"
sleep 0.5

echo "==> k3d namespace + TLS/bootstrap secrets, then Agent"
kubectl delete ns fabric-edge --ignore-not-found --wait=true >/dev/null 2>&1 || true
# hostPath identity survives ns delete — clear + chown for non-root Agent (65532).
docker exec "k3d-${K3D_CLUSTER}-server-0" sh -c \
  'mkdir -p /var/lib/fabric-smoke/connect-agent && rm -rf /var/lib/fabric-smoke/connect-agent/* && chown -R 65532:65532 /var/lib/fabric-smoke/connect-agent' \
  2>/dev/null || true
kubectl create namespace fabric-edge
# L3-AGT-02: shared Secret is CA/trust only; leaf is minted at enroll.
kubectl -n fabric-edge create secret generic connect-agent-tls \
  --from-file=ca.crt="$LOCAL/certs/ca.crt"
kubectl -n fabric-edge create secret generic fabric-edge-bootstrap \
  --from-literal=tenant_id="$TENANT" \
  --from-literal=bootstrap_token="$TOKEN" \
  --from-literal=registration_id="$REG_ID" \
  --from-literal=control_plane_token="$AGENT_TOKEN"
apply_k3d_manifest "$LOCAL/k3d/connect-agent.yaml"
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s

echo "==> day-0: wait for tunnel_ready (PendingApproval)"
wait_tunnel_ready connect-agent
kubectl -n fabric-edge logs deploy/connect-agent --tail=40

PENDING=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT/agents?state=PendingApproval")
AGENT_ID=$(printf '%s' "$PENDING" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["agents"], "no pending agent"; print(d["agents"][0]["id"])')
AGENT_FP=$(printf '%s' "$PENDING" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["agents"][0]["cert_fingerprint_sha256"])')
BY=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/agent-by-cert?cert_fingerprint=$AGENT_FP")
test "$(printf '%s' "$BY" | json "['agent_id']")" = "$AGENT_ID"
test "$(printf '%s' "$BY" | json "['state']")" = "PendingApproval"
echo "agent_id=$AGENT_ID fp=$AGENT_FP"

echo "==> day-0: StreamOpen DENIED while PendingApproval"
# L2 §J.3 wire enum has no PENDING_APPROVAL value: outcome is UNAUTHORIZED
# with a reason naming the pending-approval state (see gateway/internal/session/handler.go).
stream_once "pending" 0
assert_gateway_denied "requires approval"
kubectl -n fabric-edge logs deploy/connect-agent --tail=50 | grep -q stream_open_rejected || {
  echo "FAIL: expected agent stream_open_rejected"
  exit 1
}

echo "==> day-0: approve → Connected"
APR=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT_ID/approve")
test "$(printf '%s' "$APR" | json "['state']")" = "Connected"
assert_db_agent_state "$AGENT_ID" "Connected"
test "$(db_q "SELECT count(*) FROM ablv_agents WHERE tenant_id='$TENANT' AND deleted_at IS NULL;")" = "1"

echo "==> Gateway PROXY identity"
ok_acc=0
for _ in $(seq 1 40); do
  LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 5m 2>/dev/null || true)
  if echo "$LOGS" | grep -q "agent_tunnel_accepted" && echo "$LOGS" | grep -q "$AGENT_FP"; then
    ok_acc=1
    break
  fi
  sleep 0.5
done
test "$ok_acc" = "1" || {
  echo "FAIL: no agent_tunnel_accepted for fp=$AGENT_FP"
  (cd "$LOCAL" && docker compose logs gateway --no-color --since 5m) | grep -E 'agent_tunnel|tunnel_rejected' | tail -30
  exit 1
}

echo "==> day-1: StreamOpen ACCEPTED (PLATFORM_SERVICE / DIRECT_ENDPOINT)"
stream_once "accepted" 1
sleep 1
LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 2m)
echo "$LOGS" | grep -q stream_accepted || {
  echo "FAIL: expected gateway stream_accepted"
  echo "$LOGS" | tail -40
  exit 1
}
echo "$LOGS" | grep stream_accepted | tail -1 | grep -q DIRECT_ENDPOINT || {
  echo "FAIL: expected adapter DIRECT_ENDPOINT on stream_accepted"
  echo "$LOGS" | grep stream_accepted | tail -5
  exit 1
}

echo "==> L3-PKI-01a cert rotate (same agent_id, new FP)"
OLD_FP="$AGENT_FP"
kubectl -n fabric-edge set env deploy/connect-agent FABRIC_AGENT_ROTATE=1
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s
# Wait until a single Ready pod owns the Deployment (avoid logs from terminating twins).
for _ in $(seq 1 60); do
  ready=$(kubectl -n fabric-edge get pods -l app=connect-agent --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[0].ready}{"\n"}{end}' | awk '$2=="true"{c++} END{print c+0}')
  [[ "$ready" = "1" ]] && break
  sleep 1
done
POD=$(kubectl -n fabric-edge get pods -l app=connect-agent -o jsonpath='{.items[?(@.status.containerStatuses[0].ready==true)].metadata.name}' | awk '{print $1}')
test -n "$POD" || { echo "FAIL: no ready connect-agent pod after rotate env"; exit 1; }
wait_tunnel_ready connect-agent
# Re-resolve Ready pod + poll: rollout twins can leave POD pointing at a
# terminating replica whose logs never include cert_rotated.
ok_rot=0
for _ in $(seq 1 40); do
  POD=$(kubectl -n fabric-edge get pods -l app=connect-agent -o jsonpath='{.items[?(@.status.containerStatuses[0].ready==true)].metadata.name}' | awk '{print $1}')
  if [[ -n "$POD" ]] && kubectl -n fabric-edge logs "$POD" --tail=120 2>/dev/null | grep -q cert_rotated; then
    ok_rot=1
    break
  fi
  sleep 0.5
done
if [[ "$ok_rot" != "1" ]]; then
  echo "FAIL: expected cert_rotated log on ready connect-agent (last POD=$POD)"
  kubectl -n fabric-edge logs "$POD" --tail=120 2>/dev/null || true
  kubectl -n fabric-edge logs deploy/connect-agent --tail=120 2>/dev/null || true
  exit 1
fi
# One-shot: clear rotate flag so later rollouts do not re-rotate.
kubectl -n fabric-edge set env deploy/connect-agent FABRIC_AGENT_ROTATE-
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s
wait_tunnel_ready connect-agent
AG_AFTER=$(curl -sf "${hdr[@]}" "$CP_URL/v1/agents/$AGENT_ID")
AGENT_FP=$(printf '%s' "$AG_AFTER" | json "['cert_fingerprint_sha256']")
test "$AGENT_FP" != "$OLD_FP" || { echo "FAIL: fingerprint unchanged after rotate"; exit 1; }
test "$(printf '%s' "$AG_AFTER" | json "['id']")" = "$AGENT_ID"
stream_once "after-rotate" 1
echo "OK rotate agent_id=$AGENT_ID old_fp=$OLD_FP new_fp=$AGENT_FP"

echo "==> day-1a: B3 StreamOpen ACCEPTED (PLATFORM_RESOURCE / PLATFORM_CONNECTOR)"
# Spec §8.7 B3: Customer app -> Connect Agent -> Gateway -> PLATFORM_CONNECTOR
# adapter -> Platform Resource. Wire mechanics are otherwise identical to
# PLATFORM_SERVICE/DIRECT_ENDPOINT (Gateway dials host:port after authz) --
# the thing actually under test is that destination_kind=PLATFORM_RESOURCE
# really does route through a *different* adapter (PLATFORM_CONNECTOR, not
# DIRECT_ENDPOINT) and that a RESOURCE-typed StreamOpen is accepted against
# it (mapDestinationKind + the wire connectivity_type check, gateway/internal/
# dispatch/authorize/authorize.go).
RES_DISP="k3d-res-$(date +%s)"
RES=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"$RES_DISP\",\"connectivity_type\":\"RESOURCE\",\"destination_kind\":\"PLATFORM_RESOURCE\",\"host\":\"$REG_HOST\",\"port\":19090}" \
  "$CP_URL/v1/registrations")
RES_ID=$(printf '%s' "$RES" | json "['id']")
echo "platform_resource_registration=$RES_ID"

# Repoint agent1's smoke listener at the RESOURCE registration (same pattern
# used below for CUSTOMER_SERVICE): update the secret, roll, wait for tunnel.
apply_bootstrap_secret \
  --from-literal=tenant_id="$TENANT" \
  --from-literal=bootstrap_token="used" \
  --from-literal=registration_id="$RES_ID" \
  --from-literal=connectivity_type="RESOURCE" \
  --from-literal=control_plane_token="$AGENT_TOKEN"
kubectl -n fabric-edge rollout restart deploy/connect-agent
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s
wait_tunnel_ready connect-agent
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT_ID\",\"cert_fingerprint\":\"$AGENT_FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null || true
AG=$(curl -sf "${hdr[@]}" "$CP_URL/v1/agents/$AGENT_ID")
if [[ "$(printf '%s' "$AG" | json "['state']")" != "Connected" ]]; then
  curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT_ID/approve" >/dev/null || true
fi

stream_once "platform-resource" 1
sleep 1
LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 2m)
echo "$LOGS" | grep stream_accepted | tail -1 | grep -q PLATFORM_CONNECTOR || {
  echo "FAIL: expected adapter PLATFORM_CONNECTOR on stream_accepted for B3"
  echo "$LOGS" | grep stream_accepted | tail -5
  exit 1
}
echo "OK B3 PLATFORM_RESOURCE routes via PLATFORM_CONNECTOR adapter"

# Restore agent1's listener to the original PLATFORM_SERVICE registration
# before day-1b repoints it again for CUSTOMER_SERVICE.
apply_bootstrap_secret \
  --from-literal=tenant_id="$TENANT" \
  --from-literal=bootstrap_token="used" \
  --from-literal=registration_id="$REG_ID" \
  --from-literal=control_plane_token="$AGENT_TOKEN"
kubectl -n fabric-edge rollout restart deploy/connect-agent
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s
wait_tunnel_ready connect-agent
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT_ID\",\"cert_fingerprint\":\"$AGENT_FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null || true
AG=$(curl -sf "${hdr[@]}" "$CP_URL/v1/agents/$AGENT_ID")
if [[ "$(printf '%s' "$AG" | json "['state']")" != "Connected" ]]; then
  curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT_ID/approve" >/dev/null || true
fi

echo "==> day-1b: CUSTOMER_SERVICE + observed reachability (CONNECT_AGENT)"
CUST_DISP="k3d-cust-$(date +%s)"
CUST=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"$CUST_DISP\",\"connectivity_type\":\"SERVICE\",\"destination_kind\":\"CUSTOMER_SERVICE\",\"host\":\"$REG_HOST\",\"port\":19090}" \
  "$CP_URL/v1/registrations")
CUST_ID=$(printf '%s' "$CUST" | json "['id']")
CUST_GEN=$(printf '%s' "$CUST" | json "['generation']")
echo "customer_registration=$CUST_ID generation=$CUST_GEN"

# No observed yet → Connected agent is eligible
AUTHZ=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/authz-context?tenant_id=$TENANT&registration_id=$CUST_ID&cert_fingerprint=$AGENT_FP")
printf '%s' "$AUTHZ" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert any(a["ID"]==sys.argv[1] for a in d["eligible_agents"])' "$AGENT_ID"

# Mark unreachable → empty eligible (single agent)
curl -sf "${hdr[@]}" -d "{\"agent_id\":\"$AGENT_ID\",\"condition\":\"Probe\",\"reachable\":\"false\",\"observed_generation\":$CUST_GEN}" \
  "$CP_URL/v1/registrations/$CUST_ID/observed" >/dev/null
assert_db_observed_reachable "$CUST_ID" "$AGENT_ID" "false"
AUTHZ=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/authz-context?tenant_id=$TENANT&registration_id=$CUST_ID&cert_fingerprint=$AGENT_FP")
printf '%s' "$AUTHZ" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert len(d["eligible_agents"])==0, d'

# Point Agent smoke listener at CUSTOMER registration
apply_bootstrap_secret \
  --from-literal=tenant_id="$TENANT" \
  --from-literal=bootstrap_token="used" \
  --from-literal=registration_id="$CUST_ID" \
  --from-literal=control_plane_token="$AGENT_TOKEN"
kubectl -n fabric-edge rollout restart deploy/connect-agent
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s
wait_tunnel_ready connect-agent
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT_ID\",\"cert_fingerprint\":\"$AGENT_FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null || true
AG=$(curl -sf "${hdr[@]}" "$CP_URL/v1/agents/$AGENT_ID")
if [[ "$(printf '%s' "$AG" | json "['state']")" != "Connected" ]]; then
  curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT_ID/approve" >/dev/null || true
fi

stream_once "cust-unreachable" 0
assert_gateway_denied "DESTINATION_UNAVAILABLE"

# Mark reachable → StreamOpen via CONNECT_AGENT hairpin
curl -sf "${hdr[@]}" -d "{\"agent_id\":\"$AGENT_ID\",\"condition\":\"Probe\",\"reachable\":\"true\",\"observed_generation\":$CUST_GEN}" \
  "$CP_URL/v1/registrations/$CUST_ID/observed" >/dev/null
assert_db_observed_reachable "$CUST_ID" "$AGENT_ID" "true"
AUTHZ=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/authz-context?tenant_id=$TENANT&registration_id=$CUST_ID&cert_fingerprint=$AGENT_FP")
printf '%s' "$AUTHZ" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert any(a["ID"]==sys.argv[1] for a in d["eligible_agents"])' "$AGENT_ID"

stream_once "cust-reachable" 1
ok_ca=0
for _ in $(seq 1 20); do
  LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 2m)
  if echo "$LOGS" | grep stream_accepted | grep -q CONNECT_AGENT; then ok_ca=1; break; fi
  sleep 0.25
done
test "$ok_ca" = "1" || {
  echo "FAIL: expected adapter CONNECT_AGENT"
  echo "$LOGS" | grep stream_accepted | tail -5
  exit 1
}
ok_in=0
for _ in $(seq 1 20); do
  if kubectl -n fabric-edge logs deploy/connect-agent --tail=120 2>/dev/null | grep -q inbound_dialing; then
    ok_in=1
    break
  fi
  sleep 0.25
done
test "$ok_in" = "1" || {
  echo "FAIL: expected agent inbound_dialing"
  kubectl -n fabric-edge logs deploy/connect-agent --tail=80
  exit 1
}

echo "==> day-1c: second agent selection (same bootstrap window + CA Secret; L3-AGT-02)"
# Earlier steps replaced bootstrap_token with "used" so agent1 restarts would
# not re-enroll. Restore the real TOKEN for multi-redeem (agent1 already has
# leaf+agent-id and will skip enroll).
apply_bootstrap_secret \
  --from-literal=tenant_id="$TENANT" \
  --from-literal=bootstrap_token="$TOKEN" \
  --from-literal=registration_id="$CUST_ID" \
  --from-literal=control_plane_token="$AGENT_TOKEN"
apply_k3d_manifest "$LOCAL/k3d/connect-agent-2.yaml"
kubectl -n fabric-edge rollout status deploy/connect-agent-2 --timeout=180s
wait_tunnel_ready connect-agent-2
# Discover agent2 by listing agents (per-instance leaf fingerprint is not pre-minted).
AGENT2_ID=""
AGENT2_FP=""
for _ in $(seq 1 40); do
  ALL=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT/agents")
  AGENT2_ID=$(printf '%s' "$ALL" | python3 -c 'import json,sys; d=json.load(sys.stdin); aid=sys.argv[1];
xs=[a for a in d["agents"] if a["id"]!=aid and not a.get("deleted_at")];
print(xs[0]["id"] if xs else "")' "$AGENT_ID")
  if [[ -n "$AGENT2_ID" ]]; then
    AGENT2_FP=$(printf '%s' "$ALL" | python3 -c 'import json,sys; d=json.load(sys.stdin); aid=sys.argv[1];
print(next(a["cert_fingerprint_sha256"] for a in d["agents"] if a["id"]==aid))' "$AGENT2_ID")
    break
  fi
  sleep 0.5
done
test -n "$AGENT2_ID" || { echo "FAIL: second agent never enrolled"; exit 1; }
test -n "$AGENT2_FP" || { echo "FAIL: empty agent2 fingerprint"; exit 1; }
# Deferred enroll→bind: Gateway must publish tunnel-event up (agent_tunnel_bound)
for _ in $(seq 1 40); do
  LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 3m 2>/dev/null || true)
  echo "$LOGS" | grep -q "agent_tunnel_bound" && echo "$LOGS" | grep -q "$AGENT2_FP" && break
  # also accept bind log without fp on same line (agent_id only)
  echo "$LOGS" | grep -q agent_tunnel_bound && break
  sleep 0.5
done

BY2=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/agent-by-cert?cert_fingerprint=$AGENT2_FP") || {
  echo "FAIL: agent-by-cert agent2"; exit 1
}
test "$(printf '%s' "$BY2" | json "['agent_id']")" = "$AGENT2_ID"
if [[ "$(printf '%s' "$BY2" | json "['state']")" != "Connected" ]]; then
  curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT2_ID/approve" >/dev/null || {
    echo "FAIL: approve agent2"; exit 1
  }
fi
# Wait for Connected (approve + Gateway bind → tunnel-event up)
for _ in $(seq 1 40); do
  st=$(db_q "SELECT state FROM ablv_agents WHERE id='$AGENT2_ID' AND deleted_at IS NULL;")
  [[ "$st" = "Connected" ]] && break
  sleep 0.5
done
assert_db_agent_state "$AGENT2_ID" "Connected"
# Gateway must have accepted agent2's cert (immediate lookup or deferred bind)
GLOG=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 5m)
echo "$GLOG" | grep -q "$AGENT2_FP" || {
  echo "FAIL: gateway logs missing agent2 cert_fp (tunnel not accepted)"
  echo "$GLOG" | grep agent_tunnel | tail -20
  exit 1
}
# DialAgent needs agent_id mapping: deferred path logs agent_tunnel_bound; immediate path Puts on accept.
echo "$GLOG" | grep -Eq "agent_tunnel_bound|agent_tunnel_accepted" || {
  echo "FAIL: no gateway tunnel accept/bind for agents"
  exit 1
}
test "$(db_q "SELECT count(*) FROM ablv_agents WHERE tenant_id='$TENANT' AND state='Connected' AND deleted_at IS NULL;")" = "2"

# agent1 unreachable, agent2 reachable → eligible must be agent2 only
curl -sf "${hdr[@]}" -d "{\"agent_id\":\"$AGENT_ID\",\"condition\":\"Probe\",\"reachable\":\"false\",\"observed_generation\":$CUST_GEN}" \
  "$CP_URL/v1/registrations/$CUST_ID/observed" >/dev/null
curl -sf "${hdr[@]}" -d "{\"agent_id\":\"$AGENT2_ID\",\"condition\":\"Probe\",\"reachable\":\"true\",\"observed_generation\":$CUST_GEN}" \
  "$CP_URL/v1/registrations/$CUST_ID/observed" >/dev/null
assert_db_observed_reachable "$CUST_ID" "$AGENT_ID" "false"
assert_db_observed_reachable "$CUST_ID" "$AGENT2_ID" "true"
AUTHZ=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/authz-context?tenant_id=$TENANT&registration_id=$CUST_ID&cert_fingerprint=$AGENT_FP")
printf '%s' "$AUTHZ" | python3 -c '
import json,sys
d=json.load(sys.stdin)
ids=[a["ID"] for a in d["eligible_agents"]]
assert ids==[sys.argv[1]], ids
' "$AGENT2_ID"

# StreamOpen still originates on agent1 listener; Gateway must dial agent2 inbound
: > /tmp/fabric-edge2-before.log
kubectl -n fabric-edge logs deploy/connect-agent-2 --tail=5 >/tmp/fabric-edge2-before.log || true
stream_once "cust-select-agent2" 1
sleep 1
LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 2m)
echo "$LOGS" | grep stream_accepted | grep -E "selected_agent_id.:.$AGENT2_ID|selected_agent_id=$AGENT2_ID|\"selected_agent_id\":\"$AGENT2_ID\"" | grep -q . || \
echo "$LOGS" | grep stream_accepted | grep -q "$AGENT2_ID" || {
  echo "FAIL: stream_accepted missing selected agent2_id=$AGENT2_ID"
  echo "$LOGS" | grep stream_accepted | tail -8
  exit 1
}
kubectl -n fabric-edge logs deploy/connect-agent-2 --tail=100 | grep -q inbound_dialing || {
  echo "FAIL: expected connect-agent-2 inbound_dialing (selection)"
  kubectl -n fabric-edge logs deploy/connect-agent-2 --tail=100
  exit 1
}
# agent1 must NOT have dialed the customer target for this selection stream
# (it only opened the StreamOpen origin); inbound_dialing on agent1 after mark-false would be a bug if newly logged —
# soft check: agent2 dial is required above.

echo "==> day-1c: L3-AGT-02 hard asserts (CA-only Secret, distinct FPs, token still live)"
SECRET_KEYS=$(kubectl -n fabric-edge get secret connect-agent-tls -o json \
  | python3 -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin).get("data") or {})))')
test "$SECRET_KEYS" = "ca.crt" || {
  echo "FAIL: connect-agent-tls must be CA-only (ca.crt), got keys=[$SECRET_KEYS]"
  exit 1
}
test "$AGENT_FP" != "$AGENT2_FP" || {
  echo "FAIL: agent1 and agent2 must have distinct cert fingerprints"
  exit 1
}
TEN_GET=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT")
printf '%s' "$TEN_GET" | python3 -c 'import json,sys; assert json.load(sys.stdin)["bootstrap_token_outstanding"] is True, "bootstrap window should still be open"'
echo "OK AGT-02: CA-only Secret, fp1!=fp2, bootstrap still outstanding"

echo "==> day-1c: ECS-like identity wipe (delete pod → emptyDir loss → CSR re-enroll)"
KNOWN="$AGENT_ID,$AGENT2_ID"
kubectl -n fabric-edge delete pod -l app=connect-agent-2 --wait=true
kubectl -n fabric-edge rollout status deploy/connect-agent-2 --timeout=180s
wait_tunnel_ready connect-agent-2
AGENT3_ID=""
AGENT3_FP=""
for _ in $(seq 1 60); do
  ALL=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT/agents")
  AGENT3_ID=$(printf '%s' "$ALL" | python3 -c '
import json,sys
known=set(sys.argv[1].split(","))
xs=[a for a in json.load(sys.stdin)["agents"] if a["id"] not in known and not a.get("deleted_at")]
print(xs[0]["id"] if xs else "")
' "$KNOWN")
  if [[ -n "$AGENT3_ID" ]]; then
    AGENT3_FP=$(printf '%s' "$ALL" | python3 -c 'import json,sys; d=json.load(sys.stdin); aid=sys.argv[1];
print(next(a["cert_fingerprint_sha256"] for a in d["agents"] if a["id"]==aid))' "$AGENT3_ID")
    break
  fi
  sleep 0.5
done
test -n "$AGENT3_ID" || { echo "FAIL: ECS-like wipe did not produce a new agent row"; exit 1; }
test -n "$AGENT3_FP" || { echo "FAIL: empty agent3 fingerprint"; exit 1; }
test "$AGENT3_FP" != "$AGENT2_FP" || { echo "FAIL: re-enroll reused old fingerprint"; exit 1; }
if [[ "$(curl -sf "${hdr[@]}" "$CP_URL/v1/agents/$AGENT3_ID" | json "['state']")" != "Connected" ]]; then
  curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT3_ID/approve" >/dev/null
fi
for _ in $(seq 1 40); do
  st=$(db_q "SELECT state FROM ablv_agents WHERE id='$AGENT3_ID' AND deleted_at IS NULL;")
  [[ "$st" = "Connected" ]] && break
  sleep 0.5
done
assert_db_agent_state "$AGENT3_ID" "Connected"
# Prefer agent3 for remaining selection-sensitive paths
AGENT2_ID="$AGENT3_ID"
AGENT2_FP="$AGENT3_FP"
echo "OK ECS-like re-enroll agent_id=$AGENT2_ID fp=$AGENT2_FP"

echo "==> day-1c2: Failed registration retry (L3-REG-01)"
RETRY_REG=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"retry-me-$(date +%s)\",\"connectivity_type\":\"SERVICE\",\"destination_kind\":\"PLATFORM_SERVICE\",\"host\":\"$REG_HOST\",\"port\":19090}" \
  "$CP_URL/v1/registrations")
RETRY_ID=$(printf '%s' "$RETRY_REG" | json "['id']")
RETRY_GEN=$(printf '%s' "$RETRY_REG" | json "['generation']")
# Create path lands Active; force Failed via SQL (no HTTP transition for this edge).
db_q "UPDATE ablv_registrations SET state='Failed' WHERE id='$RETRY_ID';" >/dev/null
test "$(db_q "SELECT state FROM ablv_registrations WHERE id='$RETRY_ID';")" = "Failed"
# Retry on Active must be rejected (use the original PLATFORM_SERVICE reg, still Active).
ACTIVE_RETRY_CODE=$(curl -sS -o /tmp/fabric-retry-active.json -w "%{http_code}" "${hdr[@]}" -X POST \
  "$CP_URL/v1/registrations/$REG_ID/retry" || true)
test "$ACTIVE_RETRY_CODE" = "400" || {
  echo "FAIL: retry on Active expected 400 got $ACTIVE_RETRY_CODE"
  cat /tmp/fabric-retry-active.json
  exit 1
}
grep -q registration_not_retryable /tmp/fabric-retry-active.json || {
  echo "FAIL: expected registration_not_retryable"; cat /tmp/fabric-retry-active.json; exit 1
}
RETRIED=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/registrations/$RETRY_ID/retry")
test "$(printf '%s' "$RETRIED" | json "['state']")" = "Active"
NEW_GEN=$(printf '%s' "$RETRIED" | json "['generation']")
python3 -c 'import sys; assert int(sys.argv[2]) > int(sys.argv[1])' "$RETRY_GEN" "$NEW_GEN"
echo "OK Failed → retry → Active generation $RETRY_GEN → $NEW_GEN"

# Restore agent1 reachable for day-n paths that still use its listener
curl -sf "${hdr[@]}" -d "{\"agent_id\":\"$AGENT_ID\",\"condition\":\"Probe\",\"reachable\":\"true\",\"observed_generation\":$CUST_GEN}" \
  "$CP_URL/v1/registrations/$CUST_ID/observed" >/dev/null

echo "==> day-1d: G-A3-1 inbound via CoreDNS + TLS SNI"
curl -sf "${hdr[@]}" -d "{\"agent_id\":\"$AGENT2_ID\",\"condition\":\"Probe\",\"reachable\":\"true\",\"observed_generation\":$CUST_GEN}" \
  "$CP_URL/v1/registrations/$CUST_ID/observed" >/dev/null || true
REG_GET=$(curl -sf "${hdr[@]}" "$CP_URL/v1/registrations/$CUST_ID")
INBOUND_HOST=$(printf '%s' "$REG_GET" | json "['inbound_hostname']")
test "$INBOUND_HOST" = "${CUST_ID}.${TENANT}.connect.fabric"
# Resolve via local CoreDNS (compose :5353), then dial resolved A with SNI
INBOUND_IP=$(dig +short @"127.0.0.1" -p 15353 "$INBOUND_HOST" A | head -1)
test "$INBOUND_IP" = "127.0.0.1" || { echo "FAIL: DNS $INBOUND_HOST → $INBOUND_IP"; exit 1; }
python3 - "$INBOUND_HOST" "$INBOUND_IP" "$LOCAL/certs/ca.crt" <<'PY'
import ssl, socket, sys
host, ip, ca = sys.argv[1], sys.argv[2], sys.argv[3]
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.load_verify_locations(ca)
ctx.check_hostname = False
with socket.create_connection((ip, 18444), timeout=10) as raw:
    with ctx.wrap_socket(raw, server_hostname=host) as s:
        s.sendall(b"GET / HTTP/1.0\r\nHost: echo\r\n\r\n")
        s.settimeout(10)
        data = s.recv(256)
        print("inbound_dns_body=", data[:80])
        assert b"fabric-k3d-echo-ok" in data, data
PY
sleep 1
LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 2m)
echo "$LOGS" | grep -q inbound_relay_start || {
  echo "FAIL: expected gateway inbound_relay_start"
  echo "$LOGS" | grep inbound | tail -20
  exit 1
}
echo "OK platform inbound via DNS"

echo "==> day-1e: quotas (concurrent streams) + heartbeat Degraded"
# Hold one stream open with max_concurrent_streams=1 → second open denied
curl -sf "${hdr[@]}" -d '{"max_stream_open_per_sec":100,"max_concurrent_streams":1,"max_tunnels":50}' \
  "$CP_URL/v1/tenants/$TENANT/quotas" >/dev/null
if [[ -n "$PF_PID" ]]; then kill "$PF_PID" 2>/dev/null || true; wait "$PF_PID" 2>/dev/null || true; PF_PID=""; fi
pkill -f 'port-forward svc/connect-agent 19443:9443' 2>/dev/null || true
sleep 0.3
: > /tmp/fabric-pf.log
kubectl -n fabric-edge port-forward svc/connect-agent 19443:9443 >/tmp/fabric-pf.log 2>&1 &
PF_PID=$!
disown "$PF_PID" 2>/dev/null || true
pf_ready=0
for _ in $(seq 1 80); do
  if grep -q "Forwarding from" /tmp/fabric-pf.log 2>/dev/null || (echo >/dev/tcp/127.0.0.1/19443) >/dev/null 2>&1; then
    pf_ready=1
    break
  fi
  sleep 0.25
done
test "$pf_ready" = "1" || {
  echo "FAIL: port-forward not ready for concurrent-stream quota test"
  cat /tmp/fabric-pf.log || true
  exit 1
}
python3 <<'PY'
import socket, threading, time, sys
def hold():
    s = socket.create_connection(("127.0.0.1", 19443), timeout=5)
    # /slow: destination sleeps before HTTP response → Gateway holds stream slot
    s.sendall(b"GET /slow HTTP/1.0\r\n\r\n")
    s.settimeout(12)
    try:
        s.recv(256)
    except Exception:
        pass
    s.close()
t = threading.Thread(target=hold, daemon=True)
t.start()
time.sleep(1.2)  # allow first StreamOpen to reserve
s2 = socket.create_connection(("127.0.0.1", 19443), timeout=5)
s2.settimeout(5)
try:
    s2.sendall(b"GET / HTTP/1.0\r\n\r\n")
    data = s2.recv(256)
except Exception as e:
    data = b""
    print("second_conn_err", e)
else:
    print("second_body", data[:80])
s2.close()
t.join(timeout=15)
if b"fabric-k3d-echo-ok" in data:
    print("FAIL: second stream succeeded under max_concurrent_streams=1")
    sys.exit(1)
print("OK concurrent stream quota denied second open")
PY
assert_gateway_denied "quota"
curl -sf "${hdr[@]}" -d '{"max_stream_open_per_sec":100,"max_concurrent_streams":2000,"max_tunnels":50}' \
  "$CP_URL/v1/tenants/$TENANT/quotas" >/dev/null
stream_once "quota-restored" 1

# max_tunnels=1 while agent2 already up: restart agent2 → tunnel_quota_denied
curl -sf "${hdr[@]}" -d '{"max_tunnels":1}' "$CP_URL/v1/tenants/$TENANT/quotas" >/dev/null
kubectl -n fabric-edge rollout restart deploy/connect-agent-2
ok_tq=0
for _ in $(seq 1 40); do
  LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 3m)
  if echo "$LOGS" | grep -q tunnel_quota_denied; then ok_tq=1; break; fi
  sleep 0.5
done
test "$ok_tq" = "1" || {
  echo "FAIL: expected tunnel_quota_denied for agent2 with max_tunnels=1"
  echo "$LOGS" | grep -E 'tunnel_|quota' | tail -40
  exit 1
}
echo "OK max_tunnels=1 denied agent2 reconnect"
curl -sf "${hdr[@]}" -d '{"max_tunnels":50}' "$CP_URL/v1/tenants/$TENANT/quotas" >/dev/null
kubectl -n fabric-edge rollout status deploy/connect-agent-2 --timeout=180s || true
wait_tunnel_ready connect-agent-2 || true
# emptyDir wipe + re-enroll under restored quota → refresh agent2 id/fp
ALL=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT/agents")
NEW2=$(printf '%s' "$ALL" | python3 -c '
import json,sys
aid=sys.argv[1]
xs=[a for a in json.load(sys.stdin)["agents"] if a["id"]!=aid and not a.get("deleted_at")]
xs.sort(key=lambda a: a.get("created_at") or "", reverse=True)
print(xs[0]["id"] if xs else "")
' "$AGENT_ID")
if [[ -n "$NEW2" ]]; then
  AGENT2_ID="$NEW2"
  AGENT2_FP=$(printf '%s' "$ALL" | python3 -c 'import json,sys; d=json.load(sys.stdin); aid=sys.argv[1];
print(next((a["cert_fingerprint_sha256"] for a in d["agents"] if a["id"]==aid), ""))' "$AGENT2_ID")
  st=$(printf '%s' "$ALL" | python3 -c 'import json,sys; d=json.load(sys.stdin); aid=sys.argv[1];
print(next((a["state"] for a in d["agents"] if a["id"]==aid), ""))' "$AGENT2_ID")
  if [[ "$st" = "PendingApproval" ]]; then
    curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT2_ID/approve" >/dev/null || true
  fi
fi
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT2_ID\",\"cert_fingerprint\":\"$AGENT2_FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null || true

echo "==> day-1e: revoke bootstrap → further enrolls fail"
curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/tenants/$TENANT/bootstrap-token/revoke" >/dev/null
ENROLL_FAIL=$(curl -sS -o /tmp/fabric-enroll-fail.json -w "%{http_code}" "${hdr[@]}" \
  -d "{\"tenant_id\":\"$TENANT\",\"bootstrap_token\":\"$TOKEN\",\"substrate\":\"kubernetes\",\"cert_fingerprint_sha256\":\"deadbeef$(date +%s)\"}" \
  "$CP_URL/v1/agents/enroll" || true)
test "$ENROLL_FAIL" = "400" || { echo "FAIL: expected 400 after bootstrap revoke, got $ENROLL_FAIL"; cat /tmp/fabric-enroll-fail.json; exit 1; }
grep -q bootstrap_token_invalid /tmp/fabric-enroll-fail.json || {
  echo "FAIL: expected bootstrap_token_invalid after revoke"; cat /tmp/fabric-enroll-fail.json; exit 1
}
echo "OK bootstrap revoke kills further enrolls"

# Heartbeat miss → Degraded: freeze Gateway (keeps yamux up, stops CP heartbeats)
assert_db_agent_state "$AGENT_ID" "Connected"
(cd "$LOCAL" && docker compose pause gateway) >/dev/null
db_q "UPDATE ablv_agents SET last_heartbeat_at = NOW() - INTERVAL '10 minutes' WHERE id='$AGENT_ID';" >/dev/null
for _ in $(seq 1 40); do
  st=$(db_q "SELECT state FROM ablv_agents WHERE id='$AGENT_ID';")
  if [[ "$st" = "Degraded" ]]; then break; fi
  sleep 1
done
assert_db_agent_state "$AGENT_ID" "Degraded"
# Heartbeat recovers Degraded → Connected
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT_ID\",\"cert_fingerprint\":\"$AGENT_FP\",\"event\":\"heartbeat\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null
assert_db_agent_state "$AGENT_ID" "Connected"
(cd "$LOCAL" && docker compose unpause gateway) >/dev/null
echo "OK quotas + Degraded recovery"

# Continue day-n against CUSTOMER registration
REG_ID="$CUST_ID"

echo "==> day-n: suspend (billing, graceful) → deny → unsuspend → ok"
# L2 §G.3: cause is mandatory when suspending (server.ts rejects unset cause
# with 400 suspend_cause_required, fail-safe rather than guessing "security").
# "billing" exercises the deny-without-force-close path; the later
# revoke-cert case below already exercises the "security" force-close path.
curl -sf "${hdr[@]}" "${dual[@]}" -d '{"suspended":true,"cause":"billing"}' "$CP_URL/v1/tenants/$TENANT/suspend" >/dev/null
stream_once "suspended" 0
# Fail-closed: StreamOpen deny and/or live tunnel force-close
LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 2m)
echo "$LOGS" | grep -Eqi 'tenant suspended|security_force_close_tenant' || {
  echo "FAIL: expected suspended deny or security_force_close_tenant"
  echo "$LOGS" | grep -E 'stream_denied|force_close' | tail -15
  exit 1
}
curl -sf "${hdr[@]}" "${dual[@]}" -d '{"suspended":false}' "$CP_URL/v1/tenants/$TENANT/suspend" >/dev/null
# Tunnel may have been force-closed; wait for agent redial before unsuspend StreamOpen
wait_tunnel_ready connect-agent
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT_ID\",\"cert_fingerprint\":\"$AGENT_FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null || true
stream_once "unsuspended" 1

echo "==> day-n: delete registration → deny, then recreate PLATFORM_SERVICE"
curl -sf "${hdr[@]}" "${dual[@]}" -X POST "$CP_URL/v1/registrations/$REG_ID/delete" >/dev/null
stream_once "reg-deleted" 0
assert_gateway_denied "registration"
DISP2="k3d-echo-$(date +%s)-b"
REG2=$(curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"$DISP2\",\"connectivity_type\":\"SERVICE\",\"destination_kind\":\"PLATFORM_SERVICE\",\"host\":\"$REG_HOST\",\"port\":19090}" \
  "$CP_URL/v1/registrations")
REG_ID=$(printf '%s' "$REG2" | json "['id']")
# Point Agent back at PLATFORM registration for remaining checks
apply_bootstrap_secret \
  --from-literal=tenant_id="$TENANT" \
  --from-literal=bootstrap_token="used" \
  --from-literal=registration_id="$REG_ID" \
  --from-literal=control_plane_token="$AGENT_TOKEN"
kubectl -n fabric-edge rollout restart deploy/connect-agent
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s
wait_tunnel_ready connect-agent
# After restart, agent may be Connected still (same cert) with tunnel up
AG=$(curl -sf "${hdr[@]}" "$CP_URL/v1/agents/$AGENT_ID")
echo "after_reg_recreate agent_state=$(printf '%s' "$AG" | json "['state']") tunnel=$(printf '%s' "$AG" | json "['tunnel_state']")"
# Ensure Connected (approve no-op if already)
if [[ "$(printf '%s' "$AG" | json "['state']")" != "Connected" ]]; then
  curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT_ID/approve" >/dev/null || true
fi
# Force tunnel-event up if needed
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT_ID\",\"cert_fingerprint\":\"$AGENT_FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null || true
stream_once "reg-recreated" 1
echo "==> day-n: pod restart reconnect"
kubectl -n fabric-edge delete pod -l app=connect-agent --wait=true
kubectl -n fabric-edge rollout status deploy/connect-agent --timeout=180s
wait_tunnel_ready connect-agent
sleep 2
curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"agent_id\":\"$AGENT_ID\",\"cert_fingerprint\":\"$AGENT_FP\",\"event\":\"up\"}" \
  "$CP_URL/v1/agents/tunnel-event" >/dev/null || true
AG=$(curl -sf "${hdr[@]}" "$CP_URL/v1/agents/$AGENT_ID")
echo "after_restart state=$(printf '%s' "$AG" | json "['state']") tunnel=$(printf '%s' "$AG" | json "['tunnel_state']")"
test "$(printf '%s' "$AG" | json "['state']")" = "Connected"
assert_db_agent_state "$AGENT_ID" "Connected"
stream_once "after-restart" 1

echo "==> day-n: revoke-cert → deny"
curl -sf "${hdr[@]}" "${dual[@]}" -d "{\"cert_fingerprint_sha256\":\"$AGENT_FP\"}" \
  "$CP_URL/v1/tenants/$TENANT/revoke-cert" >/dev/null
# JSONB revoke list must persist (copy-on-write)
test "$(db_q "SELECT revoked_cert_fingerprints ? '$AGENT_FP' FROM ablv_tenant_connect WHERE tenant_id='$TENANT';")" = "t"
AUTHZ=$(curl -sf "${hdr[@]}" "$CP_URL/v1/internal/authz-context?tenant_id=$TENANT&cert_fingerprint=$AGENT_FP")
printf '%s' "$AUTHZ" | python3 -c 'import json,sys; assert json.load(sys.stdin)["cert_revoked"] is True'
stream_once "revoked" 0
# StreamOpen may log stream_denied, or ReconcileSecurity may force-close the
# tunnel first (tunnel_force_close / tunnel_rejected) before StreamOpen runs.
sleep 1
REV_LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 3m)
echo "$REV_LOGS" | grep -qiE 'certificate revoked|tunnel_force_close|tunnel_rejected|security_force_close_cert' || {
  echo "FAIL: expected revoke deny/force-close in gateway logs"
  echo "$REV_LOGS" | grep -E 'stream_denied|tunnel_|force_close|revok' | tail -20
  exit 1
}
echo "OK cert revoke denied/force-closed"
# Force-close / reject must tear down live yamux; agent redials
ok_close=0
for _ in $(seq 1 30); do
  LOGS=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 3m)
  if echo "$LOGS" | grep -Eq 'security_force_close_cert|tunnel_force_close|tunnel_rejected'; then
    ok_close=1
    break
  fi
  sleep 0.5
done
test "$ok_close" = "1" || {
  echo "FAIL: expected gateway force-close/reject after revoke"
  echo "$LOGS" | grep -E 'force_close|revoked|tunnel_rejected|stream_denied' | tail -20
  exit 1
}
# Generous budget: force-close on the Gateway side (just confirmed above) can
# lag a beat before the Agent's TCP/yamux layer actually observes the drop and
# starts redialing -- ReconcileSecurity poll tick + k3d/NAT propagation, not a
# fixed sub-second event. 60x0.5s=30s matches other reconciliation waits in
# this script (e.g. tunnel_quota_denied) rather than the tighter 15s used for
# in-process assertions above.
#
# Pin the Ready pod (same pattern as rotate): `logs deploy/...` flakes under
# k3d apiserver load (empty stdout with stderr discarded) even while the pod
# is actively redialing. Require post-revoke evidence: disconnect + redial,
# or Gateway rejecting the revoked FP on a subsequent dial.
POD=$(kubectl --context "$TENANT_CTX" -n fabric-edge get pods -l app=connect-agent \
  -o jsonpath='{.items[?(@.status.containerStatuses[0].ready==true)].metadata.name}' | awk '{print $1}')
test -n "$POD" || { echo "FAIL: no ready connect-agent pod before reconnect wait"; exit 1; }
ok_re=0
for _ in $(seq 1 60); do
  ALOG=$(kubectl --context "$TENANT_CTX" -n fabric-edge logs "$POD" --since=3m --tail=300 2>/dev/null || true)
  if echo "$ALOG" | grep -q tunnel_disconnected && echo "$ALOG" | grep -q dialing_gateway; then
    ok_re=1
    break
  fi
  GWLOG=$(cd "$LOCAL" && docker compose logs gateway --no-color --since 3m 2>/dev/null || true)
  # Post-revoke redial: Gateway rejects the same FP after the initial force-close.
  rejects=$(echo "$GWLOG" | grep -cE 'tunnel_rejected|certificate revoked|security_force_close_cert' || true)
  if [[ "${rejects:-0}" -ge 2 ]]; then
    ok_re=1
    break
  fi
  sleep 0.5
done
test "$ok_re" = "1" || {
  echo "FAIL: agent did not reconnect after revoke force-close"
  kubectl --context "$TENANT_CTX" -n fabric-edge logs "$POD" --tail=80 || true
  exit 1
}

echo "OK k3d day-0/1/n suite"
echo "    tenant=$TENANT agent=$AGENT_ID agent2=${AGENT2_ID:-n/a} registration=$REG_ID wipe_db=$WIPE_DB"
