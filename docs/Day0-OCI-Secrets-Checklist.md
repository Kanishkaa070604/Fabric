# Day 0 — `setup-day0.sh` requirements & generation guide (OCI)

Companion to `deploy/platform/day0.sh` (one-shot) and `setup-day0.sh` (secrets only). See `docs/Operational-Runbook.md` Day 0 (A0–A7).

**Fresh install:** run `deploy/platform/day0.sh` (generates PEMs, Secrets, Gateway / Fabric CP / dns-webhook, Ambient). **This session’s checkboxes:** **§6**.

**Tokens** (writer, dual-control, Gateway, revoke-push, DNS webhook) are generated automatically if you leave those env vars unset. NLB + public DNS stay outside the script (OCI / Cloudflare).

---

## Environment (this install)

| Item | Value |
|---|---|
| Region | `us-phoenix-1` |
| Gateway dial hostname (SAN) | `fabric.abluva.com` |
| Inbound domain | `connect.abluva.com` |
| PKI working dir | `~/fabric-pki` |
| Script dir | `deploy/platform/` (must contain `setup-day0.sh` **and** `namespaces.sh`) |
| `FABRIC_CONTROL_NAMESPACE` | `fabric-control` (default) |
| `SAAS_NAMESPACE` | `3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c` (default) |

---

## 1. What you must have before running the script

### 1.1 Tools / access

| # | Requirement | Required? | How |
|---|---|---|---|
| 1 | `kubectl` pointed at OKE | **Yes** | Cloud Shell / kubeconfig |
| 2 | `openssl` | **Yes** | Cloud Shell has it |
| 3 | `setup-day0.sh` + `namespaces.sh` in the same directory | **Yes** | Clone / copy repo `deploy/platform/` |

### 1.2 All environment variables the script understands

| # | Variable | Required? | Who creates the value | What the script does with it |
|---|---|---|---|---|
| 1 | `ABLV_PLATFORM_TENANT_ID` | **Yes** (for platform-ids) | You (from SaaS) | Writes Secret `fabric-platform-ids` |
| 2 | `ABLV_PLATFORM_ENVIRONMENT_ID` | **Yes** | You (from SaaS) | Same secret |
| 3 | `FABRIC_AGENT_CA_CERT_FILE` | **Yes** for Agent enroll signing | You generate PEM, then set **path** | Secret `fabric-agent-ca` → `ca.crt` |
| 4 | `FABRIC_AGENT_CA_KEY_FILE` | **Yes** with #3 | You generate PEM, then set **path** | Secret `fabric-agent-ca` → `ca.key` |
| 5 | `FABRIC_GATEWAY_CERT_FILE` | **Yes** for Ghostunnel | You generate PEM, then set **path** | Secret `fabric-gateway-tls` → `gateway-cert.pem` |
| 6 | `FABRIC_GATEWAY_KEY_FILE` | **Yes** with #5 | You generate PEM, then set **path** | → `gateway-key.pem` |
| 7 | `FABRIC_GATEWAY_CA_FILE` | **Yes** with #5–6 (or defaults to Agent CA cert path) | Path to CA that Ghostunnel trusts for **client** certs | → `intermediate-ca.pem` |
| 8 | `FABRIC_GATEWAY_INBOUND_CERT_FILE` | Optional (A3/B4) | You generate PEM, then set **path** | Secret `fabric-gateway-inbound-tls` → `inbound-cert.pem` |
| 9 | `FABRIC_GATEWAY_INBOUND_KEY_FILE` | Optional with #8 | You generate PEM, then set **path** | → `inbound-key.pem` |
| 10 | `CERT_EXPIRY_WEBHOOK_URL` | Optional (recommended) | You (Grafana IRM HTTP endpoint string) | Secret `fabric-cert-expiry-webhook` → `url` |
| 11 | `FABRIC_CONTROL_PLANE_TOKEN` | Optional | **Script auto** if unset | Auth secrets |
| 12 | `FABRIC_DUAL_CONTROL_TOKEN` | Optional | **Script auto** if unset | Auth secrets |
| 13 | `FABRIC_GATEWAY_CONTROL_TOKEN` | Optional | **Script auto** if unset | Auth secrets (both namespaces) |
| 14 | `FABRIC_REVOKE_PUSH_TOKEN` | Optional | **Script auto** if unset | Auth secrets (both namespaces) |
| 15 | `DNS_WEBHOOK_TOKEN` | Optional | **Script auto** if unset | DNS webhook secrets |
| 16 | `FABRIC_DNS_WEBHOOK_URL` | Optional | **Script default** if unset | In-cluster dns-webhook URL |
| 17 | `FABRIC_CONTROL_NAMESPACE` | Optional | Default `fabric-control` | Target ns for Gateway secrets |
| 18 | `SAAS_NAMESPACE` | Optional | Default long tenant-env string | Target ns for CP secrets |

**If a cert path var is unset → that step is SKIPPED (no Secret created/updated for it).**  
**If a cert path is set but the file does not exist → kubectl fails.**

---

## 2. Step-by-step: generate everything, then run

Do these **in order** on Cloud Shell.

### Step A — Working directory for PEMs

```bash
mkdir -p ~/fabric-pki
cd ~/fabric-pki
```

### Step B — Generate Agent CA (required)

**Purpose:** Control plane signs Agent leaf CSRs; Ghostunnel uses this as `--cacert` for client mTLS.

```bash
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
  -keyout agent-ca.key -out agent-ca.crt -subj "/CN=fabric-edge-ca"

ls -la agent-ca.crt agent-ca.key
```

| Output file | Export as |
|---|---|
| `~/fabric-pki/agent-ca.crt` | `FABRIC_AGENT_CA_CERT_FILE` |
| `~/fabric-pki/agent-ca.key` | `FABRIC_AGENT_CA_KEY_FILE` |
| same `agent-ca.crt` | also `FABRIC_GATEWAY_CA_FILE` (typical) |

### Step C — Generate Gateway TLS (required)

**Purpose:** Ghostunnel server certificate. SAN must match the public dial hostname.

```bash
openssl req -newkey rsa:4096 -nodes -keyout gateway.key \
  -subj "/CN=fabric.abluva.com" -out gateway.csr

openssl x509 -req -in gateway.csr -signkey gateway.key \
  -out gateway.crt -days 365 \
  -extfile <(printf "subjectAltName=DNS:fabric.abluva.com")

openssl x509 -in gateway.crt -noout -text | grep -A1 'Subject Alternative Name'
# Expect: DNS:fabric.abluva.com

rm -f gateway.csr
ls -la gateway.crt gateway.key
```

| Output file | Export as |
|---|---|
| `~/fabric-pki/gateway.crt` | `FABRIC_GATEWAY_CERT_FILE` |
| `~/fabric-pki/gateway.key` | `FABRIC_GATEWAY_KEY_FILE` |

**Note:** This Gateway cert is self-signed. Agents must trust **`gateway.crt`** as the server CA at install time. Agent CA is separate (signs Agent leaves).

### Step D — Generate Inbound TLS (optional — Platform→Customer)

**Purpose:** Gateway inbound listener (`:8444`). Skip if you do not need A3/B4 yet.

```bash
openssl req -newkey rsa:4096 -nodes -keyout inbound.key \
  -subj "/CN=*.connect.abluva.com" -out inbound.csr

openssl x509 -req -in inbound.csr -signkey inbound.key \
  -out inbound.crt -days 365 \
  -extfile <(printf "subjectAltName=DNS:*.connect.abluva.com,DNS:*.3407e407-792a-452d-8bb4-03c54ac34d52.connect.abluva.com,DNS:connect.abluva.com")

openssl x509 -in inbound.crt -noout -text | grep -A2 'Subject Alternative Name'
rm -f inbound.csr
ls -la inbound.crt inbound.key
```

| Output file | Export as |
|---|---|
| `~/fabric-pki/inbound.crt` | `FABRIC_GATEWAY_INBOUND_CERT_FILE` |
| `~/fabric-pki/inbound.key` | `FABRIC_GATEWAY_INBOUND_KEY_FILE` |

### Step E — Grafana cert-expiry webhook URL (optional — recommended)

**Purpose:** Fabric POSTs JSON when Agent certs are near expiry. Grafana sends email. Fabric does **not** send SMTP.

1. Grafana → **IRM → Integrations** → webhook (e.g. `saas-platform-alerts`).
2. Copy **HTTP Endpoint**.
3. Attach an **Escalation chain** on Default route; enable **Email** on IRM users.
4. Test:

```bash
curl -sS -o /tmp/oncall-resp.txt -w "HTTP %{http_code}\n" \
  -X POST "$CERT_EXPIRY_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"agent_cert_expiry","count":1,"agents":[{"tenant_id":"3407e407-792a-452d-8bb4-03c54ac34d52","agent_id":"00000000-0000-0000-0000-000000000001","state":"Connected","cert_fingerprint_sha256":"test","cert_not_after":"2026-10-01T00:00:00.000Z","days_remaining":1}]}'
cat /tmp/oncall-resp.txt
# Expect: HTTP 200 and Ok.
```

| Value | Export as |
|---|---|
| Grafana HTTP Endpoint URL string | `CERT_EXPIRY_WEBHOOK_URL` |

### Step F — Platform IDs (required)

You do not generate these; copy from SaaS / product:

```bash
export ABLV_PLATFORM_TENANT_ID=3407e407-792a-452d-8bb4-03c54ac34d52
export ABLV_PLATFORM_ENVIRONMENT_ID=5620f907-0281-497d-9098-8cfed51f5be1
```

### Step G — Export cert paths (files must already exist)

```bash
export FABRIC_AGENT_CA_CERT_FILE=$HOME/fabric-pki/agent-ca.crt
export FABRIC_AGENT_CA_KEY_FILE=$HOME/fabric-pki/agent-ca.key
export FABRIC_GATEWAY_CERT_FILE=$HOME/fabric-pki/gateway.crt
export FABRIC_GATEWAY_KEY_FILE=$HOME/fabric-pki/gateway.key
export FABRIC_GATEWAY_CA_FILE=$HOME/fabric-pki/agent-ca.crt

# Optional:
export FABRIC_GATEWAY_INBOUND_CERT_FILE=$HOME/fabric-pki/inbound.crt
export FABRIC_GATEWAY_INBOUND_KEY_FILE=$HOME/fabric-pki/inbound.key
export CERT_EXPIRY_WEBHOOK_URL='https://oncall-prod-us-central-0.grafana.net/oncall/integrations/v1/webhook/<YOUR_TOKEN>/'

# Confirm files exist before running the script:
ls -la \
  "$FABRIC_AGENT_CA_CERT_FILE" "$FABRIC_AGENT_CA_KEY_FILE" \
  "$FABRIC_GATEWAY_CERT_FILE" "$FABRIC_GATEWAY_KEY_FILE" \
  "$FABRIC_GATEWAY_CA_FILE"
```

### Step H — Run `setup-day0.sh`

```bash
cd ~/path/to/fabric.v3/deploy/platform   # directory that contains both .sh files
./setup-day0.sh
```

**Do not set** token env vars on first run (script generates them).  
**Save** the printed tokens. On later re-runs, export the **same** tokens or auth Secrets will rotate.

### Step I — What the script creates automatically (no PEM needed)

| Script step | Secret(s) | How value is created |
|---|---|---|
| Namespaces | — | `kubectl create ns` if missing |
| [1/9] | `fabric-control-plane-auth` | `openssl rand -hex 24` per token unless env set |
| [1b/9] | `fabric-gateway-auth` | Same gateway/revoke tokens |
| [2/9] | `fabric-platform-ids` | From `ABLV_PLATFORM_*` env |
| [3/9] | `fabric-cert-expiry-webhook` | From `CERT_EXPIRY_WEBHOOK_URL` (skipped if unset) |
| [4/9] | `fabric-dns-webhook`, `fabric-dns-webhook-token` | Token auto; URL default or override |
| [5/9] | `fabric-agent-ca` | **From your PEM files** (skipped if paths unset) |
| [6/9] | `fabric-gateway-tls` | **From your PEM files** — created in **`fabric-control`** (Ghostunnel) **and SaaS ns** (CP `/v1/ca-bundle` / Fetch CA). Skipped if paths unset |
| [7/9] | `fabric-gateway-inbound-tls` | **From your PEM files** (skipped if paths unset) |
| [8/9] | *(echo only)* | Reminder: replace image `REPLACE` in Deployments — **not done by this script** |
| [9/9] | *(echo only)* | Reminder: set `ABLV_ACCESS_URL`, `FABRIC_DNS_TARGET`, `FABRIC_GATEWAY_INBOUND_DOMAIN` — **not done by this script** |

---

## 3. Full copy-paste block (after PEMs exist)

```bash
cd ~/fabric.v3/deploy/platform   # adjust path

export ABLV_PLATFORM_TENANT_ID=3407e407-792a-452d-8bb4-03c54ac34d52
export ABLV_PLATFORM_ENVIRONMENT_ID=5620f907-0281-497d-9098-8cfed51f5be1

export FABRIC_AGENT_CA_CERT_FILE=$HOME/fabric-pki/agent-ca.crt
export FABRIC_AGENT_CA_KEY_FILE=$HOME/fabric-pki/agent-ca.key
export FABRIC_GATEWAY_CERT_FILE=$HOME/fabric-pki/gateway.crt
export FABRIC_GATEWAY_KEY_FILE=$HOME/fabric-pki/gateway.key
export FABRIC_GATEWAY_CA_FILE=$HOME/fabric-pki/agent-ca.crt

export FABRIC_GATEWAY_INBOUND_CERT_FILE=$HOME/fabric-pki/inbound.crt
export FABRIC_GATEWAY_INBOUND_KEY_FILE=$HOME/fabric-pki/inbound.key

export CERT_EXPIRY_WEBHOOK_URL='https://oncall-prod-us-central-0.grafana.net/oncall/integrations/v1/webhook/<YOUR_TOKEN>/'

./setup-day0.sh
```

---

## 4. Verify Secrets

```bash
NS=3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c

kubectl get ns fabric-control ambient-plane fabric-edge "$NS"

kubectl -n fabric-control get secret \
  fabric-gateway-auth fabric-platform-ids fabric-gateway-tls fabric-gateway-inbound-tls

kubectl -n "$NS" get secret \
  fabric-control-plane-auth fabric-platform-ids fabric-agent-ca \
  fabric-gateway-tls \
  fabric-dns-webhook fabric-dns-webhook-token fabric-cert-expiry-webhook
```

`fabric-gateway-tls` in **`$NS` (SaaS)** is required for Fabric CP `GET /v1/ca-bundle` / UI Fetch CA (Gateway server cert). Ghostunnel still uses the copy in `fabric-control`.

---

## 5. Full Day 0 playbook (fresh start)

Normative order: [Operational-Runbook.md](Operational-Runbook.md) **A0–A7**.  
Always **list/get first**, **create if missing**, **configure if present**. Do not skip create/check because this tenancy already had a zone, NLB, or ztunnel.

**Control plane for this install:** product YAML  
`deploy/control-plane/control-plane.yaml` → `control-server` / `control-client`  
Service: `control-server-svc:5001`.

Gateway in-cluster CP URL (set in `deploy/gateway/deployment.yaml`):

`FABRIC_CONTROL_PLANE_URL=http://control-server-svc.3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c.svc:5001`

Do **not** point Gateway at `fabric-control-plane:8080` for this env.  
`deploy/control-plane/deployment.yaml` (Fabric binary) is optional / unused while product CP is the authority.

Registry: `phx.ocir.io/axsfgj15p1je/` — `fabric-gateway:v1`, `fabric-dns-webhook:v1`. OKE is **ARM64**. Need `ocir-secret` in each pull namespace.

### 5.0 Namespaces + secrets (A0–A1)

Follow **§2–§4**. Then:

```bash
NS=3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c
kubectl get ns fabric-control ambient-plane fabric-edge "$NS"
kubectl -n fabric-control get secret fabric-gateway-tls fabric-gateway-auth ocir-secret
kubectl -n "$NS" get secret fabric-control-plane-auth fabric-agent-ca fabric-gateway-tls fabric-dns-webhook-token ocir-secret
```

### 5.1 Access + SQL (A3–A4)

Confirm Access `POST …/v1/access` → success. Apply migrations into schema **control**:

- `control-plane/migrations/20260723120000-init-fabric.sql`
- `control-plane/migrations/20260727120000-packs.sql` (packs only)
- `control-plane/migrations/20260930150000-ablv-agents-api-token-columns.sql` (required if agents table pre-dates API-token columns)
- `control-plane/migrations/20260930160000-ablv-tenant-connect-evidence-columns.sql` (required if tenant_connect pre-dates workload_evidence_*)

### 5.2 Gateway + Ghostunnel (A5)

`ABLV_ACCESS_URL` =

`http://unified-access-service.${NS}.svc.cluster.local:3100/v1/access`

`FABRIC_CONTROL_PLANE_URL` (Fabric CP, **not** product control-server:5001):

`http://fabric-control-plane.${NS}.svc:8080`

Ghostunnel image must be `docker.io/ghostunnel/ghostunnel:v1.11.1-distroless`.

```bash
docker build --platform linux/arm64 -t phx.ocir.io/axsfgj15p1je/fabric-gateway:v1 .
docker push phx.ocir.io/axsfgj15p1je/fabric-gateway:v1
kubectl apply -f deploy/gateway/deployment.yaml
kubectl -n fabric-control rollout status deploy/fabric-gateway
kubectl -n fabric-control logs deploy/fabric-gateway -c ghostunnel --tail=20
kubectl -n fabric-control logs deploy/fabric-gateway -c gateway --tail=20
# Expect listen :8443, unix socket, inbound :8444, revoke :9090
```

**Public path = hostPort (required).** Manifest sets Ghostunnel `hostPort: 8443` and
inbound `hostPort: 8444`. Service stays **ClusterIP** (in-cluster revoke `:9090` only).
**Do not** patch Service to NodePort for Agent dial — NodePort + Ambient RSTs TLS.

Confirm after apply:

```bash
kubectl -n fabric-control get pods -l app=fabric-gateway -o jsonpath='{range .items[*]}{.metadata.name}{" hostPort="}{.spec.containers[0].ports[0].hostPort}{" redir="}{.metadata.annotations.ambient\.istio\.io/redirection}{"\n"}{end}'
# expect: hostPort=8443  redir=disabled
kubectl get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}'
# this env: 10.0.11.114  10.0.11.222
```

Never put **9090** on the public NLB.

### 5.3 NLB (A5b)

**Network LB only**, PPv2 **off**. Create if missing (`deploy/platform/oci/nlb/` or Console). If present, reshape.

This env NLB: `mesh-gateway-nlb`, VIP `161.153.73.176`,

`ocid1.networkloadbalancer.oc1.phx.amaaaaaabmk3n2aaygxcukcmymgngbdvrsrvpmuiv4fusq3qfwjmhncrlw2q`

Listeners (correct shape):

| Listener | Port | Backend set | Backends |
|---|---|---|---|
| `agent-mtls` | TCP **8443** | `ghostunnel-8443` | workers **`:8443`** (hostPort) |
| `inbound` | TCP **8444** | `inbound-8444` | workers **`:8444`** (hostPort) |
| `control-plane-http` | TCP **8080** | `control-plane-8080` | workers **NodePort** of `fabric-control-plane` |

```bash
NLB_OCID=ocid1.networkloadbalancer.oc1.phx.amaaaaaabmk3n2aaygxcukcmymgngbdvrsrvpmuiv4fusq3qfwjmhncrlw2q
# ghostunnel → hostPort 8443
oci nlb backend-set update --network-load-balancer-id "$NLB_OCID" \
  --backend-set-name ghostunnel-8443 --policy FIVE_TUPLE --is-preserve-source false --force \
  --health-checker '{"protocol":"TCP","port":8443,"intervalInMillis":10000,"timeoutInMillis":3000,"retries":3}' \
  --backends '[{"ipAddress":"10.0.11.114","port":8443,"weight":1},{"ipAddress":"10.0.11.222","port":8443,"weight":1}]'
# inbound → hostPort 8444 (same pattern, port 8444)
oci nlb backend-set-health get --network-load-balancer-id "$NLB_OCID" --backend-set-name ghostunnel-8443
# expect status OK
oci nlb listener list --network-load-balancer-id "$NLB_OCID" --all \
  --query 'data.items[].[name,port,"default-backend-set-name"]' --output table
```

**Always check SLs/NSGs:** public-subnet ingress 8443/8444/8080; worker subnet allow NLB → **hostPort 8443/8444** (+ CP NodePort for 8080).

In-cluster proof:

```bash
kubectl -n fabric-control port-forward svc/fabric-gateway 18443:8443
# wait for "Forwarding from…" then:
openssl s_client -connect 127.0.0.1:18443 -servername fabric.abluva.com </dev/null 2>/dev/null | openssl x509 -noout -subject
# subject=CN = fabric.abluva.com
```

Public (must pass for Agents):

```bash
nc -zv fabric.abluva.com 8443
openssl s_client -connect fabric.abluva.com:8443 -servername fabric.abluva.com </dev/null 2>/dev/null | openssl x509 -noout -subject
```

Cloudflare A `fabric.abluva.com` → VIP, **grey cloud**.

### 5.4 Ambient (A7)

Run even if ztunnel already exists:

```bash
chmod +x deploy/platform/ambient/*.sh
./deploy/platform/ambient/install-ambient.sh
./deploy/platform/ambient/enroll-namespaces.sh fabric-control "$NS"
./deploy/platform/ambient/verify-ambient.sh
```

Keep namespaces enrolled. Opt out pods that break under ztunnel redirect
(`deploy/gateway/deployment.yaml` already opts out Ghostunnel):

| Workload | Why |
|---|---|
| `fabric-gateway` | Ghostunnel owns Agent mTLS on hostPort; Ambient → public TLS RST |
| `fabric-control-plane` | HTTP to Access / apps |
| `unified-access-service`, `control-server`, `control-client`, `pricing-manager-svc` | SaaS HTTP |

Waypoint optional. Never install Ambient on customer clusters.

### 5.5 DNS zone + dns-webhook (A5c Path B)

```bash
COMPARTMENT_OCID="ocid1.compartment.oc1..aaaaaaaa7l74kazg75zgn6rxulvxmxaf4fspc3qx5an2d72nmbvs6nikdnbq"

oci dns zone list --compartment-id "$COMPARTMENT_OCID" --output table
# May be 0 rows — zone can live on tenancy root.

oci dns zone get --zone-name-or-id connect.abluva.com \
  --query 'data.{"id":id,"name":name,"compartment":"compartment-id"}' --output json

# Create only if get fails:
oci dns zone create --compartment-id "$COMPARTMENT_OCID" \
  --name connect.abluva.com --zone-type PRIMARY
# 400 Invalid tags = tenancy tag policy. Create in Console, then get again.
```

This env: **get succeeded** without create. Zone OCID `ocid1.dns-zone.oc1..aaaaaaaalwopebd3cccnln7j3o6rn4pokxo2xle7ylr7jyqxlkys7pzi7s4q`. Compartment = **tenancy** `ocid1.tenancy.oc1..aaaaaaaazrqdvyighgi6vt34gjvgur7dylkhwisomxehsy3hhprr5omslmaq` (yaml `OCI_DNS_COMPARTMENT_ID`).

IAM (create if missing). Dynamic group matches **worker** compartment; DNS policy is **tenancy** when the zone is on tenancy:

```bash
oci iam dynamic-group create \
  --name fabric-platform-workers \
  --description "OKE workers for Fabric dns-webhook" \
  --matching-rule "ALL {instance.compartment.id = '${COMPARTMENT_OCID}'}"
```

```text
Allow dynamic-group fabric-platform-workers to manage dns-records in tenancy
Allow dynamic-group fabric-platform-workers to use dns-zones in tenancy
```

Webhook: **do not** apply a dummy `fabric-dns-webhook-token` Secret.

```bash
cd deploy/platform/oci/dns-webhook
docker build --platform linux/arm64 -t phx.ocir.io/axsfgj15p1je/fabric-dns-webhook:v1 .
docker push phx.ocir.io/axsfgj15p1je/fabric-dns-webhook:v1
kubectl apply -f deployment.yaml
kubectl -n "$NS" logs deploy/fabric-dns-webhook --tail=50
```

Cloudflare: NS `connect` → OCI nameservers from zone get. CP `FABRIC_DNS_PROVIDER=webhook` when Fabric CP is applied.

Path C (wildcard CNAME) skips webhook + this IAM.

### 5.6 Control plane (A6) — product YAML

This env uses the **original** product control plane (already running or re-apply):

```bash
kubectl apply -f deploy/control-plane/control-plane.yaml
kubectl -n "$NS" get deploy,svc control-server control-client
# Service: control-server-svc:5001
```

Confirm Gateway env matches that Service (`FABRIC_CONTROL_PLANE_URL` above).  
Skip `deploy/control-plane/deployment.yaml` unless you deliberately run the separate Fabric CP binary.

### 5.7 A6p

Public HTTPS to product CP (`control-server` / existing play front door).  
Not the Ghostunnel NLB (`:8443`).

### 5.8 Day 1 Connect Agent

Done this session — see §6 **Done — Connect Agent on tenant VM**.

---

## 6. Status (this OCI session)

Updated: **2026-09-30** (us-phoenix-1 / CloudShell + customer VM `aarav-ai`).  
Day‑0 Platform + Day‑1 Agent tunnel/approve/registration complete.

SaaS / Fabric namespace:

`3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c`

Tenant UUID: `3407e407-792a-452d-8bb4-03c54ac34d52`  
Environment UUID: `5620f907-0281-497d-9098-8cfed51f5be1`

### Done — Step 0 (`setup-day0.sh`)

- [x] Prerequisites (kubectl, openssl, scripts)
- [x] IDs exported
- [x] Agent CA generated + Secret (`fabric-agent-ca`)
- [x] Gateway TLS generated + Secret
- [x] Inbound TLS Secret present
- [x] Auth + DNS webhook Secrets (`fabric-control-plane-auth`, etc.)
- [x] Cert-expiry webhook Secret + Grafana email working
- [x] Namespaces Active (`fabric-control`, SaaS ns, `ambient-plane`, `fabric-edge`)

### Done — Gateway + NLB (Agent dial)

- [x] Gateway image OCIR + Ghostunnel; Deployment in `fabric-control` **2/2 Ready**
- [x] `deploy/gateway/deployment.yaml`: **hostPort 8443/8444**, Service **ClusterIP**, Ambient opt-out on Gateway pods
- [x] NLB `mesh-gateway-nlb` VIP **`161.153.73.176`**
  - Listener **TCP 8443** → `ghostunnel-8443` → workers **`10.0.11.114:8443` / `10.0.11.222:8443`** (hostPort)
  - Listener **TCP 8444** → `inbound-8444` → workers **`:8444`** (hostPort)
  - Listener **TCP 8080** → `control-plane-8080` → Fabric CP NodePort
- [x] DNS A `fabric.abluva.com` → VIP (Cloudflare grey cloud)
- [x] Public TLS: `openssl s_client … fabric.abluva.com:8443` → `CN=fabric.abluva.com`

### Done — Ambient + PeerAuthentication PERMISSIVE

- [x] Ambient installed; SaaS ns + `fabric-control` enrolled
- [x] `PeerAuthentication` PERMISSIVE in **both** SaaS ns + `fabric-control`
      (`deploy/platform/ambient/peer-authentication-permissive.yaml`)
- [x] Re-enroll Access / control-server / control-client / pricing-manager-svc /
      fabric-control-plane / secure-data-hub (`REDIR=enabled`); see
      `deploy/platform/ambient/access-ambient-exclude.yaml`
- [x] Verified: mesh→Access `/healthz`, mesh→FCP `/healthz`, Gateway(debug)→FCP
      `/healthz` (PERMISSIVE plaintext)
- [x] Keep **`fabric-gateway` opted out** (`deploy/gateway/deployment.yaml`) —
      Ghostunnel hostPort 8443/8444; Ambient redirect would RST Agent TLS.
      `fabric-dns-webhook` stays out via `hostNetwork` (IMDS)
- [x] Notes: `deploy/platform/ambient/README.md`

### Done — Fabric control plane (not product `control-server:5001`)

Fabric CP is the Agent enroll / authz / registrations API (`:8080`). Product
`control-server` stays for SaaS UI/discovery.

- [x] Image `phx.ocir.io/axsfgj15p1je/fabric-control-plane:v5` (linux/arm64)
- [x] Deploy: `deploy/control-plane/deployment.yaml`
- [x] **DB creds via Access** — do **not** set `FABRIC_DATABASE_URL`
  - `ABLV_ACCESS_URL=http://unified-access-service.<saas-ns>.svc.cluster.local:3100/v1/access`
  - `ABLV_ACCESS_DB_RESOURCE_TYPE=control#database` (not `keys#database` — that 404s)
  - TLS: Access may advertise `VERIFY_FULL`; OCI Postgres uses private CA → mapper uses
    `rejectUnauthorized: false` (encrypt, no CA verify)
- [x] Logs: `store_ready` `via: access_api` → `control_plane_listening` port 8080
- [x] Gateway `FABRIC_CONTROL_PLANE_URL` →  
  `http://fabric-control-plane.<saas-ns>.svc:8080` (in-cluster)

### Done — Schema gaps on existing `control` DB

Older Day-0 tables used `CREATE TABLE IF NOT EXISTS` and missed later columns.

- [x] Additive migrations in repo:
  - `control-plane/migrations/20260930150000-ablv-agents-api-token-columns.sql`
  - `control-plane/migrations/20260930160000-ablv-tenant-connect-evidence-columns.sql`
- [x] Applied on live DB (via Access + `node`/`pg` from `control-server` pod):
  - `ablv_agents`: `api_token_hash`, prior-cert / prior-token columns
  - `ablv_tenant_connect`: `workload_evidence_strategy`, `workload_evidence_config`
  - `ablv_registrations`: `workload_evidence_attribution_level`
- [x] Fixed ensure error: `column "workload_evidence_strategy" does not exist`

### Done — Tenant ensure + bootstrap (Day 1 start)

```bash
NS=3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c
TENANT=3407e407-792a-452d-8bb4-03c54ac34d52
kubectl -n "$NS" port-forward svc/fabric-control-plane 8080:8080 &
TOKEN=$(kubectl -n "$NS" get secret fabric-control-plane-auth \
  -o jsonpath='{.data.bearer_token}' | base64 -d)

curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-ABLV-Actor: ops" \
  -d "{\"tenant_id\":\"$TENANT\"}" http://127.0.0.1:8080/v1/tenants/ensure

curl -sS -H "Authorization: Bearer $TOKEN" -H "X-ABLV-Actor: ops" \
  -X POST "http://127.0.0.1:8080/v1/tenants/$TENANT/bootstrap-token"
```

- [x] Ensure → `tenant_id` profile created (`auto_approve_agents: false`)
- [x] Bootstrap issued (raw shown once; expires ~7 days). **Save offline — do not commit.**

### Done — Public Fabric CP for customer VM (NLB :8080)

Agents on a VM cannot use `*.svc.cluster.local`. Same pattern as prior Mesh OCI setup:

- [x] `fabric-control-plane` Service **NodePort**
- [x] NLB backend set / listener **TCP 8080** → that NodePort (workers `10.0.11.114` / `.222`)
- [x] NSG / security list allows 8080 + NodePort
- [x] From VM `aarav-ai`:
  ```bash
  nc -zv fabric.abluva.com 8443          # OK
  curl -sf http://fabric.abluva.com:8080/healthz   # → {"ok":true}
  ```

### Saved targets (current)

| Env / item | Value |
|---|---|
| `FABRIC_GATEWAY_ADDRESS` | `fabric.abluva.com:8443` |
| NLB VIP | `161.153.73.176` |
| Public Fabric CP (Agents) | `http://fabric.abluva.com:8080` |
| In-cluster Fabric CP (Gateway) | `http://fabric-control-plane.<saas-ns>.svc:8080` |
| `ABLV_ACCESS_URL` | `http://unified-access-service.<saas-ns>.svc.cluster.local:3100/v1/access` |
| Access DB resource | `control#database` |
| `FABRIC_PG_SCHEMA` | `control` |
| Tenant ID | `3407e407-792a-452d-8bb4-03c54ac34d52` |
| Customer VM | `aarav-ai` (k3s appliance) |
| Agent image | `phx.ocir.io/axsfgj15p1je/connect-agent:v1` (**linux/amd64**) |
| Agent ID (this session) | `94b34a08-7afd-4e05-a7b2-1c11b3771228` |
| Agent trust CA | **Gateway self-signed cert** (`gateway.crt` / `gateway-cert.pem`) — not `agent-ca.crt` |
| Registration (demo) | `4541bd51-b1b7-4f9f-96a1-138bb278b6a5` Active · listener `:9443` |
| Registration (control-server PLATFORM) | `c0b6ea35-0c98-45e9-aefb-9216e464de66` Active · listener **`:9446`** · `GET /api/v1/control/discovery` ✅ customer→platform |

### Done — Connect Agent on tenant VM (Day 1)

k3s appliance on `aarav-ai` (`deploy/connect-agent/vm/k3s-appliance/`).

1. Build/push Agent image for the VM arch (x86_64 → **amd64**):
   ```bash
   docker build --platform linux/amd64 -f deploy/local/Dockerfile.connect-agent \
     -t phx.ocir.io/axsfgj15p1je/connect-agent:v1 .
   docker push phx.ocir.io/axsfgj15p1je/connect-agent:v1
   # OCIR repo visibility: public (or pull-secret on fabric-edge)
   ```
2. Export Gateway server cert (self-signed) for Agent trust:
   ```bash
   kubectl -n fabric-control get secret fabric-gateway-tls \
     -o jsonpath='{.data.gateway-cert\.pem}' | base64 -d > gateway.crt
   ```
3. On VM — `fabric-edge.env` (same keys as `tenant-start.env`):
   ```bash
   TENANT_NAMESPACE=<tenantId>-<envId first 26 chars>
   TENANT_ID=3407e407-792a-452d-8bb4-03c54ac34d52
   FABRIC_GATEWAY_ADDRESS=fabric.abluva.com:8443
   FABRIC_CONTROL_PLANE_URL=http://fabric.abluva.com:8080
   CONNECT_AGENT_IMAGE=phx.ocir.io/axsfgj15p1je/connect-agent:v1
   CA_CERT_FILE=./ca.crt                 # Gateway server cert, NOT agent-ca.crt
   BOOTSTRAP_TOKEN=<from bootstrap-token>
   ENVIRONMENT_ID=<env uuid>
   ```
4. Put `ca.crt` + `fabric-edge.env` next to `install.sh`, then:
   `sudo ./install.sh`
5. Distroless UID (if `CreateContainerConfigError`):
   ```bash
   NS=<TENANT_NAMESPACE>
   k3s kubectl -n "$NS" patch ds connect-agent --type=json -p='[
     {"op":"add","path":"/spec/template/spec/containers/0/securityContext/runAsUser","value":65532}
   ]'
   k3s kubectl -n "$NS" delete pod -l app=connect-agent
   ```
6. Logs: `enroll_submitted` → `PendingApproval` → after NLB/CA fix → `tunnel_ready` → `agent_running`.
7. CloudShell — approve:
   ```bash
   curl -sS -H "Authorization: Bearer $TOKEN" -H "X-ABLV-Actor: ops" \
     -X POST "http://127.0.0.1:8080/v1/agents/94b34a08-7afd-4e05-a7b2-1c11b3771228/approve"
   # state Connected, tunnel_state up
   ```
8. Create registration (CloudShell, port-forward to Fabric CP):
   ```bash
   curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -H "X-ABLV-Actor: ops" \
     -X POST "http://127.0.0.1:8080/v1/registrations" \
     -d "{\"tenant_id\":\"$TENANT\",\"display_name\":\"demo-echo\",\"connectivity_type\":\"SERVICE\",\"destination_kind\":\"CUSTOMER_SERVICE\",\"host\":\"127.0.0.1\",\"port\":8080}"
   ```
9. VM: `listener_started` on `:9443`; `kubectl -n fabric-edge get svc connect-agent` → `9443/TCP`.

Inbound hostname (needs Step 5c DNS for real dials):

`demo-echo.3407e407-792a-452d-8bb4-03c54ac34d52.connect.abluva.com:8444`

### Next — Customer → product control-server discovery (PLATFORM_SERVICE)

Customer apps do **not** dial Platform Services directly. Register
`destination_kind: PLATFORM_SERVICE`, then HTTP to the Agent’s local port.
Target path: **`GET /api/v1/control/discovery`** (control-client prefix
`/api/v1/control`).

**Prereq:** Agent Connected / tunnel up; Fabric CP reachable (port-forward or
public `:8080`); `$TOKEN` = `FABRIC_CONTROL_PLANE_TOKEN`.

1. CloudShell — create registration:
   ```bash
   TENANT=3407e407-792a-452d-8bb4-03c54ac34d52
   NS=${TENANT}-5620f907-0281-497d-9098-8c
   kubectl -n "$NS" port-forward svc/fabric-control-plane 8080:8080 &
   sleep 2
   curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -H "X-ABLV-Actor: ops" \
     -X POST "http://127.0.0.1:8080/v1/registrations" \
     -d "{
       \"tenant_id\":\"$TENANT\",
       \"display_name\":\"control-server\",
       \"connectivity_type\":\"SERVICE\",
       \"destination_kind\":\"PLATFORM_SERVICE\",
       \"host\":\"control-server-svc.${NS}.svc.cluster.local\",
       \"port\":5001
     }"
   # note registration id (UUID)
   ```
2. Optional Platform sanity (in-mesh) — `GET /api/v1/control/discovery`:
   ```bash
   TENANT=3407e407-792a-452d-8bb4-03c54ac34d52
   ENV=5620f907-0281-497d-9098-8cfed51f5be1
   PRINCIPAL=kk8529p@abluva.com
   kubectl -n "$NS" exec deploy/control-server -- wget -qO- -T 5 \
     --header="X-ABLV-Tenant-ID: $TENANT" \
     --header="X-ABLV-Environment-ID: $ENV" \
     --header="X-ABLV-Principal: $PRINCIPAL" \
     --header="X-ABLV-ResourceType: catalogue#database" \
     --header="Accept: application/json" \
     http://127.0.0.1:5001/api/v1/control/discovery | head -c 400
   ```
3. VM — resolve Agent listener port for that registration:
   ```bash
   k3s kubectl -n fabric-edge get svc connect-agent \
     -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
   k3s kubectl -n fabric-edge get svc connect-agent -o wide
   # PORT = value for the new reg id (often 9444 if demo-echo already owns 9443)
   ```
4. VM — same discovery call through the tunnel:
   ```bash
   PORT=<from-annotation>
   k3s kubectl -n fabric-edge run t --rm -it --restart=Never --image=busybox:1.36 -- \
     wget -qO- -T 15 \
     --header="X-ABLV-Tenant-ID: 3407e407-792a-452d-8bb4-03c54ac34d52" \
     --header="X-ABLV-Environment-ID: 5620f907-0281-497d-9098-8cfed51f5be1" \
     --header="X-ABLV-Principal: kk8529p@abluva.com" \
     --header="X-ABLV-ResourceType: catalogue#database" \
     --header="Accept: application/json" \
     "http://connect-agent.fabric-edge.svc:${PORT}/api/v1/control/discovery"
   ```
5. Record: registration id + Agent port in **Saved targets** below.

- [x] Registration `c0b6ea35-…` Active; Agent listener `:9446`
- [x] Customer `GET …:9446/api/v1/control/discovery` → `Discovery successful` (catalogue#database)
- [x] Public Fabric CP `:8080` restored (Service NodePort **32528**; NLB `control-plane-8080`)

**Notes:** This is Customer→Platform (Agent outbound), not inbound `:8444`.
Gateway stays Ambient-opted-out; Platform dial to `control-server` uses
Ambient + PERMISSIVE after Gateway exits the tunnel.

### Still open (non-blocking for Agent tunnel + first registration)

- [ ] Step 5c: dns-webhook + Cloudflare NS for `connect.abluva.com` (Platform→Customer inbound dials)
- [ ] HTTPS on public CP (today HTTP `:8080` on NLB — OK for lab; harden later)
- [ ] Bake `runAsUser: 65532` into k3s appliance DaemonSet template
- [ ] Save setup-day0 / bootstrap tokens offline (do not commit)
- [x] Platform→Customer inbound smoke (UUID SNI `:8444` → `tenant-echo-ok`; DNS still optional via `--resolve` / `fabric.abluva.com`)

---

## 7. Token stash (private — do not commit real values)

| Env | Value |
|---|---|
| `FABRIC_CONTROL_PLANE_TOKEN` | |
| `FABRIC_DUAL_CONTROL_TOKEN` | |
| `FABRIC_GATEWAY_CONTROL_TOKEN` | |
| `FABRIC_REVOKE_PUSH_TOKEN` | |
| `DNS_WEBHOOK_TOKEN` | |
| `CERT_EXPIRY_WEBHOOK_URL` | |
| Bootstrap token (Day 1, expires ~7d) | |

---

## 8. Troubleshooting (this env — lessons learned)

| Symptom | Cause | Fix |
|---|---|---|
| `openssl` / Agent: TCP OK to `:8443`, then **`connection reset` / 0 TLS bytes** | NLB backends on **NodePort**, or Ambient redirect on Ghostunnel | NLB → worker **hostPort 8443/8444**; Gateway pods `dataplane-mode=none` + `redirection=disabled`; Service stays **ClusterIP** |
| `fabric-gateway` Service `nodePort=` blank / type ClusterIP after re-apply | Expected — public path is hostPort | Do **not** patch to NodePort for Agent dial |
| NLB health **OK** on wrong port still breaks Agents | Health only proves TCP to that port | Confirm backends are **`:8443` hostPort**, not a random NodePort |
| In-cluster `openssl` → `CN=fabric.abluva.com`, public still RST | NLB/listener/backend mismatch | `oci nlb listener list` + `backend list`; listener `8443` → `ghostunnel-8443` |
| `ErrImagePull` / `platform not found` on VM | Image built on Mac **arm64**; VM is **amd64** | `docker build --platform linux/amd64` + push; `docker buildx imagetools inspect` |
| `CreateContainerConfigError` on connect-agent | Distroless non-root needs UID | Patch DaemonSet `runAsUser: 65532` |
| `tls: certificate signed by unknown authority` after tunnel path fixed | Agent `ca.crt` was **agent-ca** (signs leaves); Gateway cert is **self-signed** | `connect-agent-tls` / `CA_CERT_FILE` = **`gateway.crt`** (`fabric-gateway-tls` → `gateway-cert.pem`) |
| Fetch CA / `GET /v1/ca-bundle` returns `CN=fabric-edge-ca` | `FABRIC_GATEWAY_CERT_FILE` unset or `fabric-gateway-tls` missing in **SaaS** ns | Mirror `fabric-gateway-tls` into SaaS ns; mount `/etc/fabric/gateway-tls`; set `FABRIC_GATEWAY_CERT_FILE`; restart CP. Expect `CN=fabric.abluva.com` |
| `k8s_service_reconcile_failed` / `spec.ports: Required` | No Active registrations yet (empty port list) | Noise until first registration; then Service gets ports |
| `POST /v1/tenants/$TENANT/registrations` → `not_found` | Wrong path | Use **`POST /v1/registrations`** with `tenant_id`, `display_name`, `destination_kind`, `host`, `port` |
| Access `404` / `keys#database` | Wrong Access resource type | `ABLV_ACCESS_DB_RESOURCE_TYPE=control#database` |
| CP `column … does not exist` on ensure | Older DB missing columns | Apply additive migrations under `control-plane/migrations/` |
| `PendingApproval` with tunnel already up | Default `auto_approve_agents=false` | `POST /v1/agents/<id>/approve` — not a network bug |
| Port-forward `connection refused` then later works | Background `kubectl port-forward` not ready / port busy | Wait for `Forwarding from 127.0.0.1:…` before curl/openssl |

**Correct public Agent path (summary):**

```text
Agent → fabric.abluva.com:8443
     → NLB VIP
     → worker hostPort :8443 (Ghostunnel, Ambient disabled on Gateway)
     → unix → fabric-gateway
```

**Correct Agent trust for this PKI:**

```text
Ghostunnel presents self-signed gateway.crt (CN=fabric.abluva.com)
Agent RootCAs = that same gateway.crt
agent-ca.crt = signs Agent leaf CSRs only (CP + Ghostunnel --cacert for clients)
```
