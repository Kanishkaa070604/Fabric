#!/usr/bin/env bash
# Prove Agent K8s Service reconciler: two Active regs → Service ports (no FABRIC_SMOKE_*).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LOCAL="$ROOT/deploy/local"
K3D="$LOCAL/k3d"
CP_URL="${FABRIC_CONTROL_PLANE_URL:-http://127.0.0.1:18080}"
CP_TOKEN="${FABRIC_CONTROL_PLANE_TOKEN:-fabric-local-dev-token}"
NS=fabric-k8ssvc
TENANT="$(uuidgen | tr '[:upper:]' '[:lower:]')"
ACTOR=k8ssvc-smoke
hdr=(-H "Content-Type: application/json" -H "X-ABLV-Actor: $ACTOR" -H "Authorization: Bearer $CP_TOKEN")
json() { python3 -c 'import json,sys; print(json.load(sys.stdin)'"$1"')'; }

echo "==> K8s Service reconciler smoke (tenant=$TENANT ns=$NS)"
curl -sf "$CP_URL/healthz" >/dev/null

HOST="${FABRIC_K3D_HOST:-host.docker.internal}"
HOST_GW_IP=$(docker run --rm --add-host=host.docker.internal:host-gateway alpine:3.20 \
  getent hosts host.docker.internal | awk '{print $1; exit}')
test -n "$HOST_GW_IP"

# NEVER honor KUBE_CONTEXT here — that env is used for Platform Ambient/lease
# and would schedule the Agent on the wrong cluster (Pending forever).
TENANT_CTX="${FABRIC_TENANT_KUBE_CONTEXT:-k3d-fabric-edge}"
kubectl() { command kubectl --context "$TENANT_CTX" "$@"; }
echo "kubectl context=$TENANT_CTX (forced — dedicated light tenant cluster; not Platform Ambient)"
kubectl delete ns "$NS" --ignore-not-found --wait=true >/dev/null 2>&1 || true
kubectl create namespace "$NS"

curl -sf "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\"}" "$CP_URL/v1/tenants/ensure" >/dev/null
TOK=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/tenants/$TENANT/bootstrap-token" | json "['bootstrap_token']")
test -n "$TOK"
AGENT_TOKEN=$(curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/tenants/$TENANT/agent-api-token" -d '{}' | json "['agent_api_token']")
test -n "$AGENT_TOKEN"
curl -sf "${hdr[@]}" -d "{\"max_tunnels\":4}" "$CP_URL/v1/tenants/$TENANT/quotas" >/dev/null || true

mkreg() {
  local name="$1" port="$2" body
  body=$(curl -sS "${hdr[@]}" -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"$name\",\"destination_kind\":\"CUSTOMER_SERVICE\",\"connectivity_type\":\"SERVICE\",\"host\":\"127.0.0.1\",\"port\":$port}" \
    "$CP_URL/v1/registrations")
  printf '%s' "$body" | json "['id']"
}
REG1=$(mkreg "svc-a-$TENANT" 19091)
REG2=$(mkreg "svc-b-$TENANT" 19092)
test -n "$REG1" && test -n "$REG2"
echo "reg1=$REG1 reg2=$REG2"

kubectl -n "$NS" create secret generic connect-agent-tls --from-file=ca.crt="$LOCAL/certs/ca.crt"
kubectl -n "$NS" create secret generic fabric-edge-bootstrap \
  --from-literal=bootstrap_token="$TOK" \
  --from-literal=tenant_id="$TENANT" \
  --from-literal=control_plane_token="$AGENT_TOKEN"

TMP_YAML=$(mktemp)
trap 'rm -f "$TMP_YAML"' EXIT
python3 - "$K3D/connect-agent.yaml" "$NS" "$HOST_GW_IP" "$HOST" "$TMP_YAML" <<'PY'
import sys, re
path, ns, hip, host, out = sys.argv[1:6]
text = open(path).read()
text = text.replace("name: fabric-edge\n", f"name: {ns}\n", 1)
text = text.replace("namespace: fabric-edge", f"namespace: {ns}")
text = text.replace("REPLACE_HOST_GW_IP", hip)
text = text.replace("host.docker.internal", host)
text = text.replace("host.k3d.internal", host)
text = re.sub(
    r"(?s)hostPath:\s*\n\s*path: /var/lib/fabric-smoke/connect-agent\s*\n\s*type: DirectoryOrCreate",
    "emptyDir: {}",
    text,
)
text = text.replace(
    "- name: FABRIC_K8S_SERVICE_MANAGE_ENABLED\n              value: \"\"",
    "- name: FABRIC_K8S_SERVICE_MANAGE_ENABLED\n              value: \"1\"",
)
# Drop FABRIC_SMOKE_* env var blocks (name line + following indented lines until next list item)
drop = {"FABRIC_SMOKE_REGISTRATION_ID", "FABRIC_SMOKE_LISTEN", "FABRIC_SMOKE_CONNECTIVITY_TYPE"}
lines = text.splitlines(keepends=True)
out_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    m = re.match(r"^(\s*)- name: (\S+)\s*$", line)
    if m and m.group(2) in drop:
        indent = len(m.group(1))
        i += 1
        while i < len(lines):
            nxt = lines[i]
            if nxt.strip() == "":
                i += 1
                continue
            # stop at next list item at same indent
            if re.match(rf"^\s{{{indent}}}- ", nxt):
                break
            # stop if de-indented to at-or-above list indent without being continuation
            leading = len(nxt) - len(nxt.lstrip(" "))
            if leading <= indent and nxt.lstrip().startswith("- "):
                break
            if leading <= indent and not nxt.startswith(" " * (indent + 2)):
                break
            i += 1
        continue
    out_lines.append(line)
    i += 1
text = "".join(out_lines)
assert f"name: {ns}\n" in text and "name: fabric-edge\n" not in text
assert "- name: FABRIC_SMOKE_REGISTRATION_ID" not in text
assert '- name: FABRIC_K8S_SERVICE_MANAGE_ENABLED\n              value: "1"' in text
open(out, "w").write(text)
print(f"manifest ok → {out}", file=sys.stderr)
PY

kubectl apply -f "$TMP_YAML"
kubectl -n "$NS" get deploy,pods,svc -o wide
kubectl -n "$NS" rollout status deploy/connect-agent --timeout=240s

AGENT_ID=""
for _ in $(seq 1 90); do
  LIST=$(curl -sf "${hdr[@]}" "$CP_URL/v1/tenants/$TENANT/agents" || echo '{"agents":[]}')
  AGENT_ID=$(printf '%s' "$LIST" | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  a=d["agents"] if isinstance(d, dict) else d
  print(a[0]["id"] if a else "")
except Exception:
  print("")')
  [[ -n "$AGENT_ID" ]] && break
  sleep 1
done
test -n "$AGENT_ID" || {
  echo "FAIL: no agent enrolled"
  kubectl -n "$NS" get pods -o wide
  kubectl -n "$NS" describe pod -l app=connect-agent | tail -40
  kubectl -n "$NS" logs -l app=connect-agent --tail=80
  exit 1
}
curl -sf "${hdr[@]}" -X POST "$CP_URL/v1/agents/$AGENT_ID/approve" >/dev/null
echo "agent=$AGENT_ID approved"

# Service reconciler may take a few ticks after approve + listeners
ok=0
PORTS=""
ANN=""
for _ in $(seq 1 90); do
  PORTS=$(kubectl -n "$NS" get svc connect-agent -o jsonpath='{.spec.ports[*].port}' 2>/dev/null || true)
  ANN=$(kubectl -n "$NS" get svc connect-agent -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}' 2>/dev/null || true)
  N=$(echo "$PORTS" | wc -w | tr -d ' ')
  if [[ "$N" -ge 2 ]]; then ok=1; break; fi
  sleep 1
done
test "$ok" = "1" || {
  echo "FAIL: expected ≥2 Service ports, got: [$PORTS] ann=[$ANN]"
  kubectl -n "$NS" get svc connect-agent -o yaml || true
  kubectl -n "$NS" logs -l app=connect-agent --tail=120
  exit 1
}
echo "ports=$PORTS annotation=$ANN"
echo "OK Agent K8s Service reconciler E2E PASS"
