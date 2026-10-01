#!/usr/bin/env bash
# ============================================================
# Manifest / code drift check (FAB-UNIT-004, FAB-DRIFT-001/002).
#
# Every finding here was a real bug found by reading manifests against code:
# the Gateway had no control-plane credential, the revoke listener had no token,
# the inbound listener and its Service port were absent while the docs described
# the feature as available, and CP/Gateway disagreed on the inbound domain.
# A passing unit suite could not catch any of them, because none of them are
# reachable from code alone.
#
# Runs offline against the repo -- no cluster required.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GW="$ROOT/deploy/gateway/deployment.yaml"
CP="$ROOT/deploy/control-plane/deployment.yaml"
CP_SPLIT="$ROOT/deploy/control-plane/deployment-split-reconciler.yaml"
MIGRATION="$ROOT/control-plane/migrations/20260723120000-init-fabric.sql"
# Additional migrations whose tables are also mirrored into the compose init.
# The schema-mirror check compares the UNION of all migration columns against
# the compose init, so every subsystem's schema stays in sync.
MIGRATION_PACKS="$ROOT/control-plane/migrations/20260727120000-packs.sql"
COMPOSE_INIT="$ROOT/deploy/local/postgres/init.sql"

fail=0
note() { printf '  %-6s %s\n' "$1" "$2"; }
ok()   { note "OK" "$1"; }
bad()  { note "FAIL" "$1"; fail=1; }

need_env() { # file, env var
  if grep -q "name: $2\$" "$1"; then ok "$(basename "$1"): $2 set"; else bad "$(basename "$1"): $2 MISSING"; fi
}

echo "==> Gateway credentials"
need_env "$GW" FABRIC_GATEWAY_CONTROL_TOKEN
# The writer bearer must not appear in the Gateway manifest: that was the
# tempting "fix" for the 401s and it hands the data plane unscoped authority.
if grep -q "name: FABRIC_CONTROL_PLANE_TOKEN\$" "$GW"; then
  bad "gateway deployment must NOT carry the writer token (FABRIC_CONTROL_PLANE_TOKEN)"
else
  ok "gateway deployment does not carry the writer token"
fi

echo "==> Revoke push is authenticated on both sides"
if grep -q "name: FABRIC_REVOKE_PUSH_LISTEN\$" "$GW"; then
  need_env "$GW" FABRIC_REVOKE_PUSH_TOKEN
  need_env "$CP" FABRIC_GATEWAY_PUSH_TOKEN
else
  ok "revoke push listener disabled (poll-only) -- no token needed"
fi

echo "==> Platform->Customer inbound (A3/B4)"
if grep -q "name: FABRIC_GATEWAY_INBOUND_LISTEN\$" "$GW"; then
  # Declaring the listener commits to the cert, the container port and the
  # Service port. Any one of them missing means the feature is documented but
  # unreachable -- exactly the state the deep review flagged.
  need_env "$GW" FABRIC_GATEWAY_INBOUND_TLS_CERT
  need_env "$GW" FABRIC_GATEWAY_INBOUND_TLS_KEY
  port="$(grep -A1 'name: FABRIC_GATEWAY_INBOUND_LISTEN$' "$GW" | grep value | sed 's/.*://; s/"//g' | tr -d ' ')"
  if [ "$port" != "8444" ]; then
    bad "inbound listen port is $port; the Service/NLB/docs all assume 8444"
  else
    ok "inbound listen port is 8444"
  fi
  if grep -q 'containerPort: 8444' "$GW"; then ok "containerPort 8444 declared"; else bad "containerPort 8444 MISSING"; fi
  if grep -q 'port: 8444' "$GW"; then ok "Service exposes 8444"; else bad "Service port 8444 MISSING"; fi
else
  ok "inbound listener disabled -- A3/B4 not deployed"
fi

echo "==> Inbound domain agrees across control plane and Gateway"
# The CP builds inbound hostnames with this suffix; the Gateway matches incoming
# SNI against it. A mismatch makes every Platform->Customer dial miss, and the
# failure looks like a routing bug rather than a config one.
gw_domain="$(grep -A1 'name: FABRIC_GATEWAY_INBOUND_DOMAIN$' "$GW" | grep value | head -1 | sed 's/.*value: //' | tr -d ' "')"
for f in "$CP" "$CP_SPLIT"; do
  while read -r d; do
    if [ "$d" != "$gw_domain" ]; then
      bad "$(basename "$f") inbound domain '$d' != gateway '$gw_domain'"
    else
      ok "$(basename "$f") inbound domain matches gateway ($d)"
    fi
  done < <(grep -A1 'name: FABRIC_GATEWAY_INBOUND_DOMAIN$' "$f" | grep value | sed 's/.*value: //' | tr -d ' "')
done

echo "==> Schema mirror stays in sync with the migration"
# deploy/local/postgres/init.sql is a hand-maintained mirror of the single
# migration. When they drift, local passes and production breaks.
a="$(cat "$MIGRATION" "$MIGRATION_PACKS" | grep -oE '^  [a-z_]+ ' | tr -d ' ' | sort -u)"
b="$(grep -oE '^  [a-z_]+ ' "$COMPOSE_INIT" | tr -d ' ' | sort -u)"
if [ "$a" = "$b" ]; then
  ok "migration and compose init.sql declare the same columns"
else
  bad "migration vs compose init.sql column drift:"
  diff <(echo "$a") <(echo "$b") | sed 's/^/         /' || true
fi

echo "==> Agent API bearer is per-Agent, not per-tenant"
# The tenant-wide credential and its mint route were removed; a manifest that
# still seeds one is wiring a credential nothing issues.
if grep -rqn 'control_plane_token' "$ROOT/deploy/local/k3d/" 2>/dev/null; then
  bad "k3d manifests still seed control_plane_token (tenant-wide Agent bearer is gone)"
else
  ok "no manifest seeds a tenant-wide Agent bearer"
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "MANIFEST DRIFT DETECTED"
  exit 1
fi
echo "No manifest drift."
