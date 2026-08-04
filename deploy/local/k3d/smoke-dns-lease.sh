#!/usr/bin/env bash
# Prove DNS reconciler Lease failover (L3-DNS-02) on a Platform k3d cluster.
# Uses the compose-built control-plane image + host Postgres (compose :54329).
#
#   export KUBE_CONTEXT=k3d-fabric-platform
#   ./deploy/local/k3d/smoke-dns-lease.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTEXT="${KUBE_CONTEXT:-k3d-fabric-platform}"
NS=3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c
LOCAL="$ROOT/deploy/local"
IMG_TAG=fabric-control-plane:lease-smoke
ctx=(--context "$CONTEXT")

echo "==> DNS Lease smoke (context=$CONTEXT)"

kubectl "${ctx[@]}" cluster-info >/dev/null

echo "==> ensure compose Postgres reachable; tag + import CP image"
curl -sf http://127.0.0.1:18080/healthz >/dev/null || {
  echo "FAIL: host control-plane :18080 not up (start deploy/local compose first)"
  exit 1
}
docker tag local-control-plane:latest "$IMG_TAG"
k3d image import "$IMG_TAG" -c "${CONTEXT#k3d-}" >/dev/null

HOST_GW_IP=$(docker run --rm --add-host=host.docker.internal:host-gateway alpine:3.20 \
  getent hosts host.docker.internal | awk '{print $1; exit}')
test -n "$HOST_GW_IP"
echo "host_gw_ip=$HOST_GW_IP"

kubectl "${ctx[@]}" create namespace "$NS" --dry-run=client -o yaml | kubectl "${ctx[@]}" apply -f -

# SA + Lease RBAC (same as deploy/control-plane/deployment.yaml)
kubectl "${ctx[@]}" apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fabric-control-plane
  namespace: $NS
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: fabric-control-plane-dns-lease
  namespace: $NS
rules:
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    resourceNames: ["fabric-dns-reconciler"]
    verbs: ["get", "update"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: fabric-control-plane-dns-lease
  namespace: $NS
subjects:
  - kind: ServiceAccount
    name: fabric-control-plane
    namespace: $NS
roleRef:
  kind: Role
  name: fabric-control-plane-dns-lease
  apiGroup: rbac.authorization.k8s.io
EOF

# Dummy CA so enroll path can start (reconciler does not need real signing for this test)
kubectl "${ctx[@]}" -n "$NS" create secret generic fabric-agent-ca \
  --from-file=ca.crt="$LOCAL/certs/ca.crt" \
  --from-file=ca.key="$LOCAL/certs/ca.key" \
  --dry-run=client -o yaml | kubectl "${ctx[@]}" apply -f -

kubectl "${ctx[@]}" -n "$NS" delete deploy fabric-control-plane --ignore-not-found --wait=true >/dev/null 2>&1 || true

kubectl "${ctx[@]}" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fabric-control-plane
  namespace: $NS
spec:
  replicas: 2
  selector:
    matchLabels:
      app: fabric-control-plane
  template:
    metadata:
      labels:
        app: fabric-control-plane
    spec:
      serviceAccountName: fabric-control-plane
      hostAliases:
        - ip: "$HOST_GW_IP"
          hostnames: ["host.docker.internal"]
      containers:
        - name: control-plane
          image: $IMG_TAG
          imagePullPolicy: Never
          ports:
            - containerPort: 8080
          env:
            - name: FABRIC_STORE
              value: postgres
            - name: FABRIC_DATABASE_URL
              value: postgres://fabric:fabric@host.docker.internal:54329/mesh
            - name: FABRIC_CONTROL_PLANE_PORT
              value: "8080"
            - name: FABRIC_LOG_LEVEL
              value: info
            - name: FABRIC_ENSURE_SAAS_TENANT
              value: "0"
            - name: ABLV_ACCESS_URL
              value: http://127.0.0.1:9/v1/access
            - name: ABLV_PLATFORM_TENANT_ID
              value: "00000000-0000-0000-0000-000000000001"
            - name: ABLV_PLATFORM_ENVIRONMENT_ID
              value: "00000000-0000-0000-0000-000000000002"
            - name: FABRIC_CONTROL_PLANE_TOKEN
              value: fabric-local-dev-token
            - name: FABRIC_DUAL_CONTROL_TOKEN
              value: fabric-break-glass
            - name: FABRIC_GATEWAY_INBOUND_DOMAIN
              value: connect.fabric
            - name: FABRIC_DNS_RECONCILE_ENABLED
              value: "1"
            - name: FABRIC_DNS_LEADER_ELECTION
              value: "1"
            - name: FABRIC_DNS_LEASE_NAME
              value: fabric-dns-reconciler
            - name: FABRIC_DNS_LEASE_NAMESPACE
              value: $NS
            - name: FABRIC_DNS_LEASE_DURATION_SECONDS
              value: "15"
            - name: FABRIC_DNS_LEASE_RENEW_INTERVAL_MS
              value: "5000"
            - name: FABRIC_DNS_PROVIDER
              value: file
            - name: FABRIC_DNS_FILE_PATH
              value: /var/run/fabric/dns-records.json
            - name: FABRIC_DNS_TARGET
              value: 127.0.0.1
            - name: FABRIC_AGENT_CA_CERT_FILE
              value: /etc/fabric/agent-ca/ca.crt
            - name: FABRIC_AGENT_CA_KEY_FILE
              value: /etc/fabric/agent-ca/ca.key
          volumeMounts:
            - name: dns-state
              mountPath: /var/run/fabric
            - name: agent-ca
              mountPath: /etc/fabric/agent-ca
              readOnly: true
      volumes:
        - name: dns-state
          emptyDir: {}
        - name: agent-ca
          secret:
            secretName: fabric-agent-ca
EOF

kubectl "${ctx[@]}" -n "$NS" rollout status deploy/fabric-control-plane --timeout=120s

lease_holder() {
  kubectl "${ctx[@]}" -n "$NS" get lease fabric-dns-reconciler \
    -o jsonpath='{.spec.holderIdentity}' 2>/dev/null || true
}

echo "==> wait for initial Lease holder (identity must match a live pod)"
HOLDER=""
for _ in $(seq 1 60); do
  HOLDER=$(lease_holder)
  if [[ -n "$HOLDER" ]] && kubectl "${ctx[@]}" -n "$NS" get pod "$HOLDER" >/dev/null 2>&1; then
    break
  fi
  HOLDER=""
  sleep 0.5
done
test -n "$HOLDER" || {
  echo "FAIL: no lease holder with a live pod"
  kubectl "${ctx[@]}" -n "$NS" get pods,lease -o wide
  kubectl "${ctx[@]}" -n "$NS" logs -l app=fabric-control-plane --tail=40 || true
  exit 1
}
echo "leader=$HOLDER"

echo "==> delete leader pod → standby must acquire"
kubectl "${ctx[@]}" -n "$NS" delete pod "$HOLDER" --ignore-not-found --wait=true
NEW=""
for _ in $(seq 1 60); do
  NEW=$(lease_holder)
  if [[ -n "$NEW" && "$NEW" != "$HOLDER" ]]; then
    break
  fi
  sleep 0.5
done
test -n "$NEW" && test "$NEW" != "$HOLDER" || {
  echo "FAIL: lease did not move (old=$HOLDER new=$NEW)"
  kubectl "${ctx[@]}" -n "$NS" get lease fabric-dns-reconciler -o yaml
  kubectl "${ctx[@]}" -n "$NS" logs -l app=fabric-control-plane --tail=50 || true
  exit 1
}
echo "new_leader=$NEW"
echo "OK DNS Lease failover Proven"
