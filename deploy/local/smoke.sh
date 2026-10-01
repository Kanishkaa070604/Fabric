#!/usr/bin/env bash
# Bring up local Ghostunnel + Gateway + SequelizeStore control-plane and verify:
# 1) API smoke against Postgres-backed control-plane
# 2) mTLS dial through Ghostunnel; Gateway logs agent_tunnel_accepted with cert FP
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCAL="$ROOT/deploy/local"
cd "$LOCAL"

./gen-certs.sh
AGENT_FP=$(cert_sha256 certs/agent.crt)
echo "expected_agent_fp=$AGENT_FP"

echo "==> docker compose up"
docker compose up -d --build

echo "==> wait for control-plane"
ok_cp=0
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:18080/healthz >/dev/null; then
    ok_cp=1
    break
  fi
  sleep 1
done
test "$ok_cp" = "1" || {
  echo "FAIL: control-plane not healthy on :18080"
  (cd "$LOCAL" && docker compose ps && docker compose logs control-plane --tail=40) || true
  exit 1
}

echo "==> API smoke (Postgres store)"
FABRIC_CONTROL_PLANE_URL=http://127.0.0.1:18080 \
  FABRIC_CONTROL_PLANE_TOKEN="${FABRIC_CONTROL_PLANE_TOKEN:-fabric-local-dev-token}" \
  FABRIC_SMOKE_TENANT_ID=00000000-0000-0000-0000-0000000000bb \
  "$ROOT/deploy/scripts/api-smoke.sh"

echo "==> wait for Ghostunnel port"
for i in $(seq 1 30); do
  if (echo >/dev/tcp/127.0.0.1/18443) >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> mTLS dial via Ghostunnel"
(
  cd "$LOCAL"
  go run ./cmd/smoke-dial
)

echo "==> check Gateway logs for PROXY identity"
sleep 1
LOGS=$(docker compose logs gateway --no-color --tail=200)
echo "$LOGS" | grep -q "agent_tunnel_accepted" || {
  echo "FAIL: gateway did not log agent_tunnel_accepted"
  echo "$LOGS"
  exit 1
}
echo "$LOGS" | grep -q "$AGENT_FP" || {
  echo "FAIL: gateway log missing agent cert fingerprint $AGENT_FP"
  echo "$LOGS"
  exit 1
}

echo "OK local Ghostunnel + SequelizeStore smoke passed"
