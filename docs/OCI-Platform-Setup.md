# OCI Platform Setup — Executed Steps

This document tracks the actual commands and outputs from the OCI Platform side setup.

---

## Step 1: Create OKE Cluster + Namespace

```bash
kubectl cluster-info
kubectl create ns fabric-control
```

**Result:** Done. OKE cluster running (ARM64 / Ampere A1 nodes).

---

## Step 2: Create OCI Network Load Balancer

### 2a — NLB Created via OCI CLI (Cloud Shell)

```bash
oci nlb network-load-balancer create \
  --compartment-id "ocid1.tenancy.oc1..aaaaaaaazrqdvyighgi6vt34gjvgur7dylkhwisomxehsy3hhprr5omslmaq" \
  --display-name "mesh-gateway-nlb" \
  --subnet-id "ocid1.subnet.oc1.phx.aaaaaaaac2mxvu4wn6ybuhpbq4s6nv7r25a3jdi7zlgqs6lcjhf4nqhbabea" \
  --is-private false \
  --is-preserve-source-destination false \
  --wait-for-state SUCCEEDED
```

### 2b — Backend Set Created

```bash
oci nlb backend-set create \
  --network-load-balancer-id "ocid1.networkloadbalancer.oc1.phx.amaaaaaabmk3n2aaygxcukcmymgngbdvrsrvpmuiv4fusq3qfwjmhncrlw2q" \
  --name "ghostunnel-8443" \
  --policy "FIVE_TUPLE" \
  --health-checker '{"protocol":"TCP","port":32443}' \
  --is-preserve-source true \
  --wait-for-state SUCCEEDED
```

### 2c — Listener Created

```bash
oci nlb listener create \
  --network-load-balancer-id "ocid1.networkloadbalancer.oc1.phx.amaaaaaabmk3n2aaygxcukcmymgngbdvrsrvpmuiv4fusq3qfwjmhncrlw2q" \
  --name "agent-mtls" \
  --default-backend-set-name "ghostunnel-8443" \
  --port 8443 \
  --protocol "TCP" \
  --wait-for-state SUCCEEDED
```

### 2d — NLB VIP

| ip-address     | is-public |
|----------------|-----------|
| 161.153.73.176 | True      |
| 10.0.1.103     | False     |

### 2e — DNS A Record — Done

Cloudflare: `mesh-gateway` A → `161.153.73.176` (DNS only, no proxy)

**Verified:**
```bash
dig fabric.abluva.com +short
# 161.153.73.176
```

### 2f — NSG Rules Added for External + NodePort Access

Added ingress rules to allow external traffic to reach NLB and backends:

```bash
# Added 8443 to NLB subnet security list
oci network security-list update \
  --security-list-id "ocid1.securitylist.oc1.phx.aaaaaaaahwgf235plxgppvso4x6kpi7aggeeygsgqzp4jkeb4not6s4bucvq" \
  --ingress-security-rules '[
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":55671,"max":55671}}},
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":8443,"max":8443}}}
  ]' --force

# Added NSG rules for worker NodePorts (31697 for Ghostunnel, 31897 for internal)
oci network nsg rules add \
  --nsg-id "ocid1.networksecuritygroup.oc1.phx.aaaaaaaaochjp5vd4acvcjruizfaybldsj36jap3tgxtpat27c2gs3gko4yq" \
  --security-rules '[
    {"direction":"INGRESS","protocol":"6","source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","tcpOptions":{"destinationPortRange":{"min":31697,"max":31697}}},
    {"direction":"INGRESS","protocol":"6","source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","tcpOptions":{"destinationPortRange":{"min":31897,"max":31897}}}
  ]'
```

### 2g — Verify External NLB Access

```bash
curl -sk --connect-timeout 10 https://161.153.73.176:8443
```

---

## Step 3: OCI DNS Zone for Inbound

### 3a — Zone Created

```bash
oci dns zone create \
  --compartment-id "ocid1.tenancy.oc1..aaaaaaaazrqdvyighgi6vt34gjvgur7dylkhwisomxehsy3hhprr5omslmaq" \
  --name "connect.abluva.com" \
  --zone-type PRIMARY
```

- Zone OCID: `ocid1.dns-zone.oc1..aaaaaaaalwopebd3cccnln7j3o6rn4pokxo2xle7ylr7jyqxlkys7pzi7s4q`
- Nameservers: `ns1-4.p201.dns.oraclecloud.net`

### 3b — NS Delegation — Not Required

Cloudflare wildcard `*.connect.abluva.com` already points to the Gateway VIP. No separate NS delegation needed.

### 3c — IAM Dynamic Group + Policy — Done (already existed)

---

## Step 4: Generate Certificates

```bash
# Agent CA
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
  -keyout agent-ca.key -out agent-ca.crt -subj "/CN=fabric-edge-ca"

# Gateway TLS (SAN: fabric.abluva.com)
openssl req -newkey rsa:4096 -nodes -keyout gateway.key \
  -subj "/CN=fabric.abluva.com" -out gateway.csr
openssl x509 -req -in gateway.csr -signkey gateway.key \
  -out gateway.crt -days 365 \
  -extfile <(printf "subjectAltName=DNS:fabric.abluva.com")
```

**Verified:** SAN = `DNS:fabric.abluva.com`

---

## Step 5: Build and Push Container Images

**OKE nodes are ARM64 (Ampere A1).** All images built with `--platform linux/arm64`.

```bash
docker buildx build --platform linux/arm64 \
  -t phx.ocir.io/axsfgj15p1je/mesh-gateway:v4 \
  -f deploy/local/Dockerfile.gateway --push .

docker buildx build --platform linux/arm64 \
  -t phx.ocir.io/axsfgj15p1je/mesh-control-plane:v3 \
  -f deploy/local/Dockerfile.control-plane --push .

docker buildx build --platform linux/arm64 \
  -t phx.ocir.io/axsfgj15p1je/mesh-connect-agent:v2 \
  -f deploy/local/Dockerfile.connect-agent --push .
```

| Image | Tag | Platform |
|-------|-----|----------|
| `phx.ocir.io/axsfgj15p1je/mesh-gateway` | v4 | linux/arm64 |
| `phx.ocir.io/axsfgj15p1je/mesh-control-plane` | v3 | linux/arm64 |
| `phx.ocir.io/axsfgj15p1je/mesh-connect-agent` | v2 | linux/arm64 |

---

## Step 6: Apply SQL Migration

Schema: `control`. Prerequisite: `control.ablv_tenants(tenant_id)` exists.

```bash
psql "$DATABASE_URL" -f control-plane/migrations/20260723120000-init-mesh.sql
```

Tables created:
- `control.ablv_tenant_connect`
- `control.ablv_registrations`
- `control.ablv_agents`

**Result:** Done.

---

## Step 7: Create Platform Secrets

```bash
WRITER_TOKEN=$(openssl rand -hex 24)
DUAL_TOKEN=$(openssl rand -hex 24)
DNS_TOKEN=$(openssl rand -hex 24)

kubectl -n fabric-control create secret generic mesh-platform-auth \
  --from-literal=control-plane-token="$WRITER_TOKEN" \
  --from-literal=dual-control-token="$DUAL_TOKEN"

kubectl -n fabric-control create secret generic mesh-dns-webhook-token \
  --from-literal=token="$DNS_TOKEN"

kubectl -n fabric-control create secret generic fabric-edge-ca \
  --from-file=ca.crt=~/agent-ca.crt \
  --from-file=ca.key=~/agent-ca.key

kubectl -n fabric-control create secret generic mesh-gateway-tls \
  --from-file=gateway-cert.pem=~/gateway.crt \
  --from-file=gateway-key.pem=~/gateway.key \
  --from-file=intermediate-ca.pem=~/agent-ca.crt

kubectl -n fabric-control create secret generic mesh-platform-ids \
  --from-literal=tenant_id="3407e407-792a-452d-8bb4-03c54ac34d52" \
  --from-literal=environment_id="5620f907-0281-497d-9098-8cfed51f5be1"

kubectl -n fabric-control create secret docker-registry ocir-secret \
  --docker-server=phx.ocir.io \
  --docker-username='axsfgj15p1je/oracleidentitycloudservice/kk8529p@abluva.com' \
  --docker-password='<auth-token>'
```

**Result:** All secrets created.

---

## Step 8: Deploy Gateway + Ghostunnel

```bash
kubectl -n fabric-control apply -f deploy/gateway/deployment.yaml
```

- Image: `phx.ocir.io/axsfgj15p1je/mesh-gateway:v4` (linux/arm64)
- Ghostunnel: `docker.io/ghostunnel/ghostunnel:v1.11.1-distroless`

**Result:** Running. `gateway_listening` confirmed on Unix socket.

---

## Step 9: Deploy Control Plane

```bash
kubectl -n fabric-control apply -f deploy/control-plane/deployment.yaml
```

- Image: `phx.ocir.io/axsfgj15p1je/mesh-control-plane:v4` (linux/arm64)
- Store: `postgres` (direct via `MESH_DATABASE_URL`)
- Database: `postgresql://abluva:***@10.0.20.134:5432/abluva_dev` (schema: `control`)
- SSL: `no-verify` (self-signed Postgres cert, encrypted but no CA validation)
- Resource type: `control#database` (if Access API is used)

**Result:** Running. 2 pods healthy (1/1).

**NOTE:** Currently using `MESH_DATABASE_URL` directly because Access API (`172.16.1.101:3000`) is not reachable from OKE. Once Access API is deployed in OCI (same VCN as OKE), switch to Access API-based credential fetch:
1. Remove `MESH_DATABASE_URL` from the deployment
2. Set `ABLV_ACCESS_URL` to the in-cluster or VCN-reachable Access API endpoint
3. CP will call `POST $ABLV_ACCESS_URL` with `X-ABLV-ResourceType: control#database` to get DB creds dynamically
4. This eliminates hardcoded DB credentials in the deployment manifest

```
mesh-control-plane-844787b6db-slvt9   1/1     Running
mesh-control-plane-844787b6db-wxv28   1/1     Running
mesh-gateway-6465ff7c65-2kbph         2/2     Running
mesh-gateway-6465ff7c65-6b6cx         2/2     Running
```

---

## Key Values (Reference)

| Item | Value |
|------|-------|
| Tenancy OCID | `ocid1.tenancy.oc1..aaaaaaaazrqdvyighgi6vt34gjvgur7dylkhwisomxehsy3hhprr5omslmaq` |
| Subnet OCID (public, PHX) | `ocid1.subnet.oc1.phx.aaaaaaaac2mxvu4wn6ybuhpbq4s6nv7r25a3jdi7zlgqs6lcjhf4nqhbabea` |
| NLB OCID | `ocid1.networkloadbalancer.oc1.phx.amaaaaaabmk3n2aaygxcukcmymgngbdvrsrvpmuiv4fusq3qfwjmhncrlw2q` |
| NLB Public VIP | `161.153.73.176` |
| Worker NSG OCID | `ocid1.networksecuritygroup.oc1.phx.aaaaaaaaochjp5vd4acvcjruizfaybldsj36jap3tgxtpat27c2gs3gko4yq` |
| Worker Node IPs | `10.0.11.114`, `10.0.11.222` |
| Gateway NodePort | `32299` |
| CP NodePort | `30582` |
| Bootstrap Token | `acbc90f983052078a38abc09afc53ff824ea416c315e16dc` (expires 2026-08-06) |
| Agent ID | `621042df-161c-4db0-aa2b-e85384a2b839` |
| Agent Cert FP | `e205462e5ac8bbc04aeb263f6cc869be39542e0c35fdd747884a36e1570b9a1a` |
| Customer VM | `172.16.1.81` (amd64, k3s v1.36.2) |
| CP External URL | `http://fabric.abluva.com:8080` |
| DNS Zone OCID | `ocid1.dns-zone.oc1..aaaaaaaalwopebd3cccnln7j3o6rn4pokxo2xle7ylr7jyqxlkys7pzi7s4q` |
| OKE Cluster OCID | `ocid1.cluster.oc1.phx.aaaaaaaaliidgpb3dr5p2nosdkdk6sskw6zd7ogm2utacnm6pc4neamomfuq` |
| OKE Cluster Name | `saas-platform-early-oke-cluster` |
| OKE Node Arch | ARM64 (Ampere A1) |
| OCIR Namespace | `axsfgj15p1je` |
| OCIR Registry | `phx.ocir.io/axsfgj15p1je` |
| Gateway Image | `phx.ocir.io/axsfgj15p1je/mesh-gateway:v4` |
| Control Plane Image | `phx.ocir.io/axsfgj15p1je/mesh-control-plane:v4` |
| Connect Agent Image | `phx.ocir.io/axsfgj15p1je/mesh-connect-agent:v2` |
| Gateway hostname | `fabric.abluva.com` |
| Agent dial address | `fabric.abluva.com:8443` |
| Access API URL | `http://172.16.1.101:3000/v1/access` (not reachable from OKE — using direct DB URL) |
| Database URL | `postgresql://abluva:***@10.0.20.134:5432/abluva_dev` (schema: control, sslmode: no-verify) |
| Access Resource Type | `control#database` |
| DB Schema | `control` |
| Tenant ID | `3407e407-792a-452d-8bb4-03c54ac34d52` |
| Environment ID | `5620f907-0281-497d-9098-8cfed51f5be1` |
| Region | `us-phoenix-1` |
| DNS (abluva.com) | Cloudflare |
| DNS (connect.abluva.com) | OCI DNS |

---

## Step 10: Wire NLB Backends

```bash
# Gateway: fabric-control namespace, NodePort 32299
kubectl -n fabric-control patch svc mesh-gateway --type='json' -p='[{"op":"replace","path":"/spec/type","value":"NodePort"}]'

# CP: tenant namespace, NodePort 30582
NS="3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c"
kubectl -n $NS patch svc mesh-control-plane --type='json' -p='[{"op":"replace","path":"/spec/type","value":"NodePort"}]'

# NLB backends for Gateway (port 32299)
oci nlb backend create ... --ip-address "10.0.11.114" --port 32299
oci nlb backend create ... --ip-address "10.0.11.222" --port 32299

# NLB backends for CP (port 30582) on listener :8080
oci nlb backend create ... --backend-set-name "control-plane-8080" --ip-address "10.0.11.114" --port 30582
oci nlb backend create ... --backend-set-name "control-plane-8080" --ip-address "10.0.11.222" --port 30582

# NSG rules added for 32299 and 30582
```

**Result:** Both paths working from customer VM:
- `nc -zv fabric.abluva.com 8443` → succeeded
- `curl http://fabric.abluva.com:8080/healthz` → `{"ok":true}`

---

## Step 11: Onboard Tenant

```bash
NS="3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c"
TOKEN=$(kubectl -n $NS get secret mesh-platform-auth -o jsonpath='{.data.control-plane-token}' | base64 -d)

# Ensure tenant
kubectl -n $NS exec deploy/mesh-control-plane -- node -e "
fetch('http://localhost:8080/v1/tenants/ensure', {
  method:'POST',
  headers:{'Authorization':'Bearer $TOKEN','Content-Type':'application/json'},
  body:JSON.stringify({tenant_id:'3407e407-792a-452d-8bb4-03c54ac34d52'})
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)))
"

# Issue bootstrap token
kubectl -n $NS exec deploy/mesh-control-plane -- node -e "
fetch('http://localhost:8080/v1/tenants/3407e407-792a-452d-8bb4-03c54ac34d52/bootstrap-token', {
  method:'POST',
  headers:{'Authorization':'Bearer $TOKEN','X-ABLV-Actor':'ops'}
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)))
"
```

**Result:**
- Tenant ensured: `3407e407-792a-452d-8bb4-03c54ac34d52`
- Bootstrap token: `acbc90f983052078a38abc09afc53ff824ea416c315e16dc`
- Expires: `2026-08-06T11:25:45.295Z`

---

## Remaining Steps

| Step | Status |
|------|--------|
| All core steps | ✅ Complete |

---

## Step 14: Approve Agent

```bash
NS="3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c"
TOKEN=$(kubectl -n $NS get secret mesh-platform-auth -o jsonpath='{.data.control-plane-token}' | base64 -d)

kubectl -n $NS exec deploy/mesh-control-plane -- node -e "
fetch('http://localhost:8080/v1/agents/621042df-161c-4db0-aa2b-e85384a2b839/approve', {
  method:'POST',
  headers:{'Authorization':'Bearer $TOKEN','X-ABLV-Actor':'admin'}
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)))
"
```

**Result:** Agent approved → state `Connected`.

---

## Step 15: Fix Gateway → CP Auth

Gateway was getting `401` when calling CP's authz-context endpoint. Fixed by adding the CP token to the Gateway:

```bash
TOKEN=$(kubectl -n $NS get secret mesh-platform-auth -o jsonpath='{.data.control-plane-token}' | base64 -d)

kubectl -n fabric-control set env deployment/mesh-gateway -c gateway \
  MESH_CONTROL_PLANE_TOKEN=$TOKEN
```

---

## Step 16: Deploy Echo Server (Platform Test Pod)

```bash
NS="3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c"

kubectl -n $NS apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: echo-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: echo-server
  template:
    metadata:
      labels:
        app: echo-server
    spec:
      containers:
        - name: echo
          image: docker.io/hashicorp/http-echo:latest
          args: ["-text=hello from platform"]
          ports:
            - containerPort: 5678
---
apiVersion: v1
kind: Service
metadata:
  name: echo-server
spec:
  selector:
    app: echo-server
  ports:
    - port: 5678
      targetPort: 5678
EOF
```

---

## Step 17: Create Registration for Echo Server

```bash
kubectl -n $NS exec deploy/mesh-control-plane -- node -e "
fetch('http://localhost:8080/v1/registrations', {
  method:'POST',
  headers:{'Authorization':'Bearer $TOKEN','Content-Type':'application/json','X-ABLV-Actor':'admin'},
  body:JSON.stringify({
    tenant_id:'3407e407-792a-452d-8bb4-03c54ac34d52',
    display_name:'echo-platform',
    connectivity_type:'SERVICE',
    destination_kind:'PLATFORM_SERVICE',
    host:'echo-server.$NS.svc.cluster.local',
    port:5678
  })
}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)))
"
```

**Result:** Registration `ad8a5b61-080d-4c2e-8699-e2460ccf9e56` created, state Active. Agent listener on port 9444.

---

## Step 18: End-to-End Traffic Test ✅

### Customer side (VM):

```bash
# Customer tenant namespace
k3s kubectl create ns efecc4f6-79d4-42d9-b893-7c011367a7b5-3ade940c-a588-4cc6-9b30-77

# Deploy test client
k3s kubectl -n efecc4f6-79d4-42d9-b893-7c011367a7b5-3ade940c-a588-4cc6-9b30-77 run test-client \
  --image=docker.io/curlimages/curl:latest --restart=Never --command -- sleep 3600

# Test
k3s kubectl -n efecc4f6-79d4-42d9-b893-7c011367a7b5-3ade940c-a588-4cc6-9b30-77 \
  exec test-client -- curl -s --connect-timeout 10 http://connect-agent.mesh-agent.svc:9444
```

**Result:** `hello from platform` ✅

### Traffic flow verified:

```
Customer pod (VM k3s)
  → connect-agent.mesh-agent.svc:9444
  → mTLS tunnel (fabric.abluva.com:8443)
  → Gateway (fabric-control) → authz check → ACCEPTED
  → echo-server.3407e407-...-8c.svc.cluster.local:5678
  → "hello from platform"
```

---

## Summary: What's Deployed and Working

| Component | Location | Status |
|-----------|----------|--------|
| OCI NLB (public VIP 161.153.73.176) | OCI PHX | ✅ Active |
| Gateway + Ghostunnel (2 replicas) | `fabric-control` namespace | ✅ Running |
| Gateway Inbound Listener (:9443) | `fabric-control` namespace | ✅ Platform→Customer ready |
| Control Plane (2 replicas, Postgres) | tenant namespace | ✅ Running |
| Connect Agent (k3s DaemonSet) | Customer VM 172.16.1.81 | ✅ Running, tunnel connected |
| Access Service (unified-access-broker) | tenant namespace | ✅ Running |
| Infra API (control server) | tenant namespace | ✅ Running |
| Pseudo-anonymization (privacy) | Customer VM tenant namespace | ✅ Deployed |
| Echo server (test) | tenant namespace | ✅ Running |
| E2E: Customer → Platform (A2) | Full path | ✅ `hello from platform` |
| E2E: Access Service via mesh | Full path | ✅ `{"status":"ok"}` |
| E2E: Discovery via mesh | Full path | ✅ Returns tenant resources |
| E2E: Platform → Customer inbound | TLS SNI accepted | ✅ Working |
| Access Service: control#database | Platform tenant | ✅ `host: 10.0.20.134, db: abluva_dev, schema: control` |
| Access Service: keys#database | Customer tenant (efecc4f6) | ✅ `host: 10.0.20.134, db: acme_dev, schema: tenant_retail_dev` |
| Access Service: pseudonyms#database | Customer tenant (efecc4f6) | ✅ Same as keys#database |
| Platform→Customer: tenant-keys | infra-api → Gateway:9443 → tunnel → pseudo-anonymization | ✅ Keys generated + stored in DB |
| Nested mesh call | pseudo-anonymization → access-service (via mesh) → DB creds → DB write | ✅ Full round-trip |
| DNS Webhook | OCI DNS zone auto-records for CUSTOMER_SERVICE registrations | ✅ CNAME records created |
| Istio Ambient (ztunnel) | L4 mTLS between all Platform pods | ✅ Installed, both namespaces enrolled |
| Agent identity store | kubernetes (Secret `connect-agent-identity-aarav-ai`) | ✅ Survives pod restarts |
| Post-Ambient verification | All services still working after ztunnel enrollment | ✅ Agent Connected, streams accepted |
| Test pods cleanup | echo-server, test-client, echo-platform registration removed | ✅ Done |

### Active Registrations (production):

| Name | Kind | Host:Port |
|------|------|-----------|
| access-service | PLATFORM_SERVICE | access-service...svc:3000 |
| infra-api | PLATFORM_SERVICE | infra-api...svc:5001 |
| pseudo-anonymization | CUSTOMER_SERVICE | pseudo-anonymization...svc:8080 |

### Remaining (configure when ready):

| Item | What's needed |
|------|--------------|
| Cert-expiry webhook | Slack/PagerDuty webhook URL → `mesh-cert-expiry-webhook` secret |
| HTTPS on CP endpoint | Flexible LB or Cloudflare proxy |
| Real CA (not self-signed) | PKI team: Intermediate CA → sign Gateway leaf |

### Architecture:

```
Customer VM (172.16.1.81)                    OCI OKE (us-phoenix-1)
┌──────────────────────────────┐             ┌──────────────────────────────────────────┐
│ k3s (v1.36.2, amd64)        │             │ fabric-control namespace                 │
│                              │             │   Gateway (2x, arm64)                    │
│ mesh-agent namespace         │  mTLS      │   Ghostunnel :8443 (Agent tunnel)        │
│   Connect Agent ─────────────│─ tunnel ──▶│   Inbound :9443 (Platform→Customer)      │
│   listeners :9443-9446       │  :8443     │                                          │
│                              │             │ tenant namespace (3407e407...)            │
│ tenant namespace (efecc4f6)  │             │   Control Plane (2x, Postgres)           │
│   pseudo-anonymization :8080 │             │   Access Service :3000                   │
│   test-client pod            │             │   Infra API :5001                        │
│                              │             │   echo-server :5678                      │
└──────────────────────────────┘             └──────────────────────────────────────────┘

Traffic flows:
  Customer→Platform: App → Agent:port → tunnel → Gateway → authz → Platform pod
  Platform→Customer: Platform pod → TLS SNI → Gateway:9443 → authz → tunnel → Agent → Customer pod
  Credentials:       pseudo-anon → Agent:9445 → tunnel → Gateway → access-service:3000 → DB creds
  Full E2E:          infra-api → Gateway:9443 → tunnel → pseudo-anon → (mesh call for creds) → DB write → response back
```

---

## Step 19: Platform→Customer E2E with DB Write ✅

**Test:** infra-api calls pseudo-anonymization `/v1/api/privacy/tenant-keys` via Gateway inbound (A3 path).

```bash
kubectl -n $NS exec deploy/infra-api -- node -e "
const tls = require('tls');
const conn = tls.connect(9443, 'mesh-gateway.fabric-control.svc', {
  servername: '9aaf5ed0-...',
  rejectUnauthorized: false
}, () => { conn.write('POST /v1/api/privacy/tenant-keys ...'); });
"
```

**Result:** `Keys generated successfully` ✅

**Flow verified:**
```
infra-api (OKE) → TLS SNI → Gateway:9443 → authz → tunnel → Agent
  → pseudo-anonymization (VM)
    → calls access-service via mesh (Agent:9445 → tunnel → Gateway → access-service)
    → gets DB creds: host=172.16.1.81, db=acme_dev, schema=tenant_retail_dev
    → connects to Postgres (no SSL, same network as VM)
    → generates master/data/envelope keys + salt
    → stores all keys in DB
    → responds HTTP 201 "Keys generated successfully"
  ← response back through tunnel → Gateway → infra-api
```

**This proves:**
- Platform→Customer communication (A3 pathway) ✅
- Nested mesh calls (Customer→Platform for creds during a Platform→Customer request) ✅
- Credential distribution via access-service through the mesh ✅
- Real DB write from customer side using mesh-delivered credentials ✅

---

## Step 12: Deploy Connect Agent (Customer VM — k3s Appliance)

### 12a — Install k3s on Customer VM (172.16.1.81)

```bash
ssh root@172.16.1.81

curl -sSL https://raw.githubusercontent.com/Kanishkaa070604/Mesh/main/deploy/connect-agent/k3s-appliance/install.sh | bash -s -- \
  --token=acbc90f983052078a38abc09afc53ff824ea416c315e16dc \
  --gateway=fabric.abluva.com:8443 \
  --control-plane=http://fabric.abluva.com:8080 \
  --tenant-id=3407e407-792a-452d-8bb4-03c54ac34d52 \
  --ca-file=$HOME/agent-ca.crt \
  --image=phx.ocir.io/axsfgj15p1je/mesh-connect-agent:v2
```

k3s version: `v1.36.2+k3s1` (amd64). Agent image repo made public for pull.

### 12b — Fix: runAsNonRoot Numeric UID

```bash
k3s kubectl -n fabric-edge patch daemonset connect-agent -p '{"spec":{"template":{"spec":{"containers":[{"name":"connect-agent","securityContext":{"runAsNonRoot":true,"runAsUser":65534,"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}}]}}}}'
```

### 12c — Fix: CA Trust (Gateway cert is self-signed)

The Agent's CA must trust the Gateway's server cert. Since `gateway.crt` is self-signed, it IS its own CA:

```bash
# Get gateway.crt content from Cloud Shell: cat ~/gateway.crt
# Paste into /tmp/gateway-ca.crt on the VM, then:
k3s kubectl -n fabric-edge create secret generic connect-agent-tls \
  --from-file=ca.crt=/tmp/gateway-ca.crt \
  --dry-run=client -o yaml | k3s kubectl apply -f -

k3s kubectl -n fabric-edge delete pods -l app=connect-agent
```

### 12d — Fix: Control Plane URL

VM can't reach OKE internal IPs. CP exposed via NLB port 8080:

```bash
k3s kubectl -n fabric-edge set env daemonset/connect-agent \
  MESH_CONTROL_PLANE_URL=http://fabric.abluva.com:8080
```

### 12e — Result: Tunnel Connected

```
tunnel_ready
agent_running  cert_fp=e205462e5ac8bbc04aeb263f6cc869be39542e0c35fdd747884a36e1570b9a1a
agent_id=621042df-161c-4db0-aa2b-e85384a2b839
```

Agent state: enrolled, tunnel up, cert auto-rotate active, API token pulled.

---

## Step 13: Expose Control Plane via NLB (port 8080)

Required because customer VM can't reach OKE worker nodes directly.

```bash
# Backend set
oci nlb backend-set create \
  --network-load-balancer-id "ocid1.networkloadbalancer.oc1.phx.amaaaaaabmk3n2aaygxcukcmymgngbdvrsrvpmuiv4fusq3qfwjmhncrlw2q" \
  --name "control-plane-8080" \
  --policy "FIVE_TUPLE" \
  --health-checker '{"protocol":"TCP","port":31320}' \
  --is-preserve-source false \
  --wait-for-state SUCCEEDED

# Backends (10.0.11.114:31320 + 10.0.11.222:31320)
# Listener: port 8080, TCP
# Security list: added port 8080
```

**Result:** `curl http://fabric.abluva.com:8080/healthz` → `{"ok":true}` from VM.
