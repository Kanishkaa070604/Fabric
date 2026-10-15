# k3s OIDC via Fabric inbound — step-by-step test guide

End-to-end guide to enable `kubernetes_oidc` on a **private k3s** customer
cluster when Platform reaches JWKS only through Fabric inbound
(`<CONNECT_ZONE>:8444`).

Follow the sections in order. Each command block is labeled **Cloud Shell**
(Platform kubectl / CP API) or **Customer** (k3s node / customer kubectl).

Set these placeholders to your values before running commands:

| Placeholder | Meaning |
|---|---|
| `<TENANT_ID>` | Connect / customer tenant UUID |
| `<TENANT_NAMESPACE>` | Agent ns: `<TENANT_ID>-<ENVIRONMENT_ID first 26 chars>` |
| `<ENVIRONMENT_ID>` | Customer environment UUID |
| `<AUTH_NS>` | Platform ns where `fabric-control-plane-auth` lives |
| `<PRODUCT_TENANT_ID>` | Product SaaS tenant id (discovery headers) |
| `<PRODUCT_ENVIRONMENT_ID>` | Product SaaS environment id (discovery headers) |
| `<LOGIN_EMAIL>` | Principal email for discovery |
| `<AGENT_LISTEN_PORT>` | From UI Install → Refresh (`CONTROL_SERVER_LISTEN_PORT`) |
| `<CONTROL_PLANE_HOST>` | Control plane host (CP URL `:8080`) |
| `<GATEWAY_INBOUND_HOST>` | Inbound TLS host (e.g. gateway public name) |
| `<CONNECT_ZONE>` | Inbound DNS zone (e.g. `connect.abluva.com`) |
| `ISSUER` | `https://k3s-oidc.<TENANT_ID>.<CONNECT_ZONE>:8444` |

**Prereqs:** Connect Agent is **Connected** for `<TENANT_ID>`; Fabric inbound
`:8444` works for other customer registrations; you have a CP writer token.

**Ports:** `:8444` = Platform inbound (issuer / JWKS dial). Agent discovery
listen ports are `:9443+` from UI Install → **Refresh** after Connected — not 8444.
Connect install first: `deploy/secure-agent-net.README.md` (tenant Part A → Agent ready → Part B).

---

## 0) Cloud Shell — load token and env

```bash
export TENANT="<TENANT_ID>"
export AGENT_NS="<TENANT_NAMESPACE>"
export CONNECT_ZONE="<CONNECT_ZONE>"
export ISSUER="https://k3s-oidc.${TENANT}.${CONNECT_ZONE}:8444"
export CP="http://<CONTROL_PLANE_HOST>:8080"

# Platform ns where fabric-control-plane-auth lives
export AUTH_NS="<AUTH_NS>"

export FABRIC_CONTROL_PLANE_TOKEN="$(
  kubectl -n "$AUTH_NS" get secret fabric-control-plane-auth \
    -o jsonpath='{.data.bearer_token}' | base64 -d
)"
export FABRIC_WRITER_TOKEN="$FABRIC_CONTROL_PLANE_TOKEN"
echo "token length: ${#FABRIC_WRITER_TOKEN}"
echo "ISSUER=$ISSUER"
```

Use **`http://`** for CP on `:8080` (not `https://`).

---

## 1) Cloud Shell — register OIDC destination

```bash
curl -sS -X POST "$CP/v1/registrations" \
  -H "Authorization: Bearer $FABRIC_WRITER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-ABLV-Actor: platform-ops" \
  -d "{
    \"tenant_id\": \"$TENANT\",
    \"display_name\": \"k3s-oidc\",
    \"destination_kind\": \"CUSTOMER_SERVICE\",
    \"connectivity_type\": \"SERVICE\",
    \"host\": \"oidc-jwks-proxy.${AGENT_NS}.svc.cluster.local\",
    \"port\": 8080
  }" | jq '{id,state,host,port,inbound_hostname_friendly,inbound_listen_port,platform_dial_url_friendly}'
```

Save:

```bash
export REG_ID="<id from response>"
```

Confirm:

- `state` = `Active`
- `platform_dial_url_friendly` = `$ISSUER`
- `inbound_listen_port` = `8444`

If you created the registration earlier with `kubernetes.default.svc:443`,
update it instead:

```bash
curl -sS -X POST "$CP/v1/registrations/$REG_ID/update" \
  -H "Authorization: Bearer $FABRIC_WRITER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-ABLV-Actor: platform-ops" \
  -d "{
    \"host\": \"oidc-jwks-proxy.${AGENT_NS}.svc.cluster.local\",
    \"port\": 8080
  }" | jq '{id,state,host,port}'
```

---

## 2) Customer — configure k3s issuer

Issuer must be the **exact** inbound URL, including **`:8444`**.

```bash
export TENANT="<TENANT_ID>"
export CONNECT_ZONE="${CONNECT_ZONE:-<CONNECT_ZONE>}"
export ISSUER="https://k3s-oidc.${TENANT}.${CONNECT_ZONE}:8444"

sudo tee /etc/rancher/k3s/config.yaml >/dev/null <<EOF
kube-apiserver-arg:
  - "anonymous-auth=true"
  - "service-account-issuer=${ISSUER}"
  - "service-account-jwks-uri=${ISSUER}/openid/v1/jwks"
EOF
sudo systemctl restart k3s
kubectl get nodes

kubectl create clusterrolebinding fabric-sa-issuer-discovery \
  --clusterrole=system:service-account-issuer-discovery \
  --group=system:unauthenticated \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl get --raw /.well-known/openid-configuration | jq -r .issuer
```

Must print `$ISSUER`.

---

## 3) Customer — HTTP JWKS proxy (Agent namespace)

Fabric inbound terminates TLS at the Gateway, then forwards **plain HTTP** to
the Agent. Do **not** point the registration at `kubernetes.default.svc:443`
(HTTPS). Use an in-cluster HTTP proxy.

Also use a **headless** Service so DNS returns a pod IP (tenant NetPol often
blocks ClusterIP `:8080` on `10.43.0.0/16`).

```bash
export AGENT_NS="<TENANT_NAMESPACE>"

kubectl -n "$AGENT_NS" apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: oidc-jwks-proxy-nginx
  namespace: ${AGENT_NS}
data:
  default.conf: |
    server {
      listen 0.0.0.0:8080;
      server_name _;
      location = /.well-known/openid-configuration {
        proxy_pass https://kubernetes.default.svc;
        proxy_ssl_verify off;
        proxy_set_header Host kubernetes.default.svc;
      }
      location = /openid/v1/jwks {
        proxy_pass https://kubernetes.default.svc;
        proxy_ssl_verify off;
        proxy_set_header Host kubernetes.default.svc;
      }
      location / { return 404; }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oidc-jwks-proxy
  namespace: ${AGENT_NS}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oidc-jwks-proxy
  template:
    metadata:
      labels:
        app: oidc-jwks-proxy
    spec:
      containers:
        - name: nginx
          image: nginx:1.25-alpine
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: conf
              mountPath: /etc/nginx/conf.d
      volumes:
        - name: conf
          configMap:
            name: oidc-jwks-proxy-nginx
---
apiVersion: v1
kind: Service
metadata:
  name: oidc-jwks-proxy
  namespace: ${AGENT_NS}
spec:
  clusterIP: None
  selector:
    app: oidc-jwks-proxy
  ports:
    - port: 8080
      targetPort: 8080
EOF

kubectl -n "$AGENT_NS" rollout status deploy/oidc-jwks-proxy
```

### 3b) Customer — NetPol allow pod-CIDR :8080 (and Agent listen ports)

Tenant `tenant-namespace-isolation` often allows `10.43.0.0/16` only on
443/6443, which breaks Service/ClusterIP and can interfere with pod dials.
Add:

```bash
kubectl -n "$AGENT_NS" apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-pod-cidr-oidc
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from:
        - ipBlock: {cidr: 10.42.0.0/16}
        - podSelector: {}
      ports:
        - {protocol: TCP, port: 8080}
  egress:
    - to:
        - ipBlock: {cidr: 10.42.0.0/16}
        - podSelector: {}
      ports:
        - {protocol: TCP, port: 8080}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-agent-listen-ports
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from:
        - ipBlock: {cidr: 10.42.0.0/16}
        - podSelector: {}
      ports:
        - {protocol: TCP, port: 9443}
        - {protocol: TCP, port: 9444}
        - {protocol: TCP, port: 9445}
        - {protocol: TCP, port: 9446}
        - {protocol: TCP, port: 9447}
        - {protocol: TCP, port: 9448}
        - {protocol: TCP, port: 9449}
  egress:
    - to:
        - ipBlock: {cidr: 10.42.0.0/16}
        - podSelector: {}
      ports:
        - {protocol: TCP, port: 9443}
        - {protocol: TCP, port: 9444}
        - {protocol: TCP, port: 9445}
        - {protocol: TCP, port: 9446}
        - {protocol: TCP, port: 9447}
        - {protocol: TCP, port: 9448}
        - {protocol: TCP, port: 9449}
EOF
```

If your pod CIDR is not `10.42.0.0/16`, change it (`kubectl get nodes -o wide`
/ CNI docs).

### 3c) Customer — smoke-test proxy in-cluster

```bash
kubectl -n "$AGENT_NS" run curl-oidc --rm -it --restart=Never --image=curlimages/curl:8.5.0 -- \
  curl -sS -m 5 "http://oidc-jwks-proxy:8080/.well-known/openid-configuration" | jq -r .issuer
```

Must equal `$ISSUER`.

---

## 4) Cloud Shell — confirm registration reachable

```bash
sleep 20
curl -sS -H "Authorization: Bearer $FABRIC_WRITER_TOKEN" \
  "$CP/v1/registrations/$REG_ID" | jq '{state,host,port,observed}'
```

Want `reachable: "true"`.

Probe JWKS through inbound (use `-sk` if inbound cert is self-signed):

```bash
curl -sk --http1.1 "$ISSUER/.well-known/openid-configuration" | jq .
curl -sk --http1.1 "$ISSUER/openid/v1/jwks" | jq '.keys|length'
```

---

## 5) Cloud Shell — inbound TLS SAN for this tenant

**Do this for every tenant that uses inbound OIDC.** Gateway fetches JWKS at
`k3s-oidc.<TENANT_ID>.<CONNECT_ZONE>:8444`. Wildcard `*.<CONNECT_ZONE>`
does **not** match that name (extra DNS label). The inbound cert must include:

```text
*.<TENANT_ID>.<CONNECT_ZONE>
```

Skip reissue only if that SAN is already on the live cert. When adding a new
tenant, **keep every existing tenant SAN** — replacing the cert with only the
new name breaks JWKS for older tenants.

### 5a) Check whether this tenant is already covered

```bash
: "${CONNECT_ZONE:?set CONNECT_ZONE}"
echo | openssl s_client -connect <GATEWAY_INBOUND_HOST>:8444 \
  -servername "k3s-oidc.${TENANT}.${CONNECT_ZONE}" \
  2>/dev/null | openssl x509 -noout -ext subjectAltName
```

If the SAN list already has `*.${TENANT}.${CONNECT_ZONE}`, go to §6.
If OpenSSL reports hostname mismatch / name not listed, continue.

### 5b) Reissue — merge existing SANs + this tenant

```bash
cd /tmp
: "${CONNECT_ZONE:?set CONNECT_ZONE}"

kubectl -n fabric-control get secret fabric-gateway-inbound-tls \
  -o jsonpath='{.data.inbound-cert\.pem}' | base64 -d > inbound-old.crt
kubectl -n fabric-control get secret fabric-gateway-inbound-tls \
  -o jsonpath='{.data.inbound-key\.pem}' | base64 -d > inbound.key

# Existing DNS names from current cert, plus base names + this TENANT
{
  openssl x509 -in inbound-old.crt -noout -ext subjectAltName 2>/dev/null \
    | tr ',' '\n' | sed -n 's/.*DNS:\([^ ]*\).*/\1/p'
  echo "${CONNECT_ZONE}"
  echo "*.${CONNECT_ZONE}"
  echo "*.${TENANT}.${CONNECT_ZONE}"
} | sed '/^$/d' | sort -u > /tmp/inbound-sans.txt

SAN_EXT=$(awk '{printf "%sDNS:%s", (NR>1?",":""), $0}' /tmp/inbound-sans.txt)
echo "SAN_EXT=$SAN_EXT"
grep -F "*.${TENANT}.${CONNECT_ZONE}" /tmp/inbound-sans.txt

openssl req -new -key inbound.key \
  -subj "/CN=*.${CONNECT_ZONE}" -out inbound.csr

openssl x509 -req -in inbound.csr -signkey inbound.key -days 365 -out inbound.crt \
  -extfile <(printf "subjectAltName=%s" "$SAN_EXT")

openssl x509 -in inbound.crt -noout -ext subjectAltName
# must list: *.${TENANT}.${CONNECT_ZONE} (and prior inbound-OIDC tenants)

kubectl -n fabric-control create secret generic fabric-gateway-inbound-tls \
  --from-file=inbound-cert.pem=inbound.crt \
  --from-file=inbound-key.pem=inbound.key \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n fabric-control rollout restart deploy/fabric-gateway
kubectl -n fabric-control rollout status deploy/fabric-gateway
```

### 5c) Verify live for this tenant

```bash
echo | openssl s_client -connect <GATEWAY_INBOUND_HOST>:8444 \
  -servername "k3s-oidc.${TENANT}.${CONNECT_ZONE}" \
  2>/dev/null | openssl x509 -noout -ext subjectAltName
```

Must list `*.${TENANT}.${CONNECT_ZONE}` with no hostname mismatch. Without
this step, Gateway `jwks_fetch` fails with TLS / `UNAUTHORIZED` (cert valid for
other tenants only).
---

## 6) Cloud Shell — register workload evidence

CP discovery probe uses the process trust store and often fails on the
self-signed inbound cert (`discovery_failed: fetch failed`). For this path,
set JWKS + CA explicitly and skip the probe:

```bash
openssl s_client -showcerts -connect <GATEWAY_INBOUND_HOST>:8444 \
  -servername "k3s-oidc.${TENANT}.${CONNECT_ZONE}" \
  </dev/null 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/{print}' > /tmp/inbound.crt

export CA_PEM=$(jq -Rs . </tmp/inbound.crt)

curl -sS -X PUT \
  -H "Authorization: Bearer $FABRIC_WRITER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-ABLV-Actor: platform-ops" \
  "$CP/v1/tenants/$TENANT/workload-evidence" \
  -d "{
    \"strategy\": \"kubernetes_oidc\",
    \"oidc_issuer_url\": \"$ISSUER\",
    \"oidc_jwks_uri\": \"$ISSUER/openid/v1/jwks\",
    \"oidc_ca_bundle_pem\": $CA_PEM,
    \"probe_discovery\": false,
    \"oidc_enabled\": true
  }" | jq '{strategy, oidc_enabled, oidc_issuer_url, oidc_jwks_uri, oidc_ca_bundle_pem:(.oidc_ca_bundle_pem!=null)}'
```

Want `oidc_enabled: true` and CA present.

---

## 7) Customer — restart Connect Agent

So projected tokens pick up the new `iss`:

```bash
export AGENT_NS="<TENANT_NAMESPACE>"
kubectl -n "$AGENT_NS" rollout restart ds/connect-agent
kubectl -n "$AGENT_NS" rollout status ds/connect-agent
```

---

## 8) End-to-end test

### 8a) Cloud Shell — watch Gateway

```bash
kubectl -n fabric-control logs -l app=fabric-gateway --all-containers -f \
  | grep --line-buffered -E 'workload_evidence_|UNAUTHORIZED|stream_denied'
```

### 8b) Customer — discovery through Agent

Prefer Agent **pod IP** (avoids ClusterIP NetPol issues). Use the listen port
from UI Install → **Refresh** (`CONTROL_SERVER_LISTEN_PORT`):

```bash
export NS="<TENANT_NAMESPACE>"
export AGENT_LISTEN_PORT="<AGENT_LISTEN_PORT>"
export PRODUCT_TENANT_ID="<PRODUCT_TENANT_ID>"
export PRODUCT_ENVIRONMENT_ID="<PRODUCT_ENVIRONMENT_ID>"
export LOGIN_EMAIL="<LOGIN_EMAIL>"

AGENT_IP=$(kubectl -n "$NS" get pod -l app=connect-agent -o jsonpath='{.items[0].status.podIP}')
BASE=http://${AGENT_IP}:${AGENT_LISTEN_PORT}

kubectl -n "$NS" delete pod disc-test --ignore-not-found --force --grace-period=0
kubectl -n "$NS" run disc-test --rm -it --restart=Never --image=busybox:1.36 -- \
  wget -qO- -T 15 \
  --header="X-ABLV-Tenant-ID: ${PRODUCT_TENANT_ID}" \
  --header="X-ABLV-Environment-ID: ${PRODUCT_ENVIRONMENT_ID}" \
  --header="X-ABLV-Principal: ${LOGIN_EMAIL}" \
  --header="X-ABLV-ResourceType: catalogue#database" \
  --header="Accept: application/json" \
  "${BASE}/api/v1/control/discovery"
```

---

## 9) Pass criteria

| Check | Expected |
|---|---|
| Discovery HTTP body | `"status":"success"` / Discovery successful |
| Gateway log | `workload_evidence_attributed` |
| `evidence_iss` | `$ISSUER` |
| `evidence_aud` | `abluva-connect` |
| `evidence_sa` | `connect-agent` |
| `evidence_ns` | `$AGENT_NS` |

Example success log:

```text
workload_evidence_attributed
  evidence_strategy=kubernetes_oidc
  evidence_iss=https://k3s-oidc.<TENANT_ID>.<CONNECT_ZONE>:8444
  evidence_aud=abluva-connect
  evidence_sa=connect-agent
```

---

## Troubleshooting (known failures)

| Symptom | Cause | Fix |
|---|---|---|
| `Client sent an HTTP request to an HTTPS server` | Registration pointed at apiserver `:443` | Use HTTP JWKS proxy `:8080` |
| `reachable: false` / curl ClusterIP refused | NetPol blocks `10.43.0.0/16` except 443/6443 | Headless Service + pod-CIDR NetPol for 8080 |
| `discovery_failed: fetch failed` on PUT | CP does not trust self-signed inbound cert | `probe_discovery:false` + set `oidc_jwks_uri` + `oidc_ca_bundle_pem` |
| `UNAUTHORIZED` / TLS … cert valid for `*.<OTHER_TENANT_ID>…` not `k3s-oidc.<TENANT_ID>…` | Inbound cert missing this tenant’s SAN | Step 5 — add `*.<TENANT_ID>.<CONNECT_ZONE>`, keep existing SANs, restart Gateway |
| `jwks_fetch` TLS fail / connection errors after new tenant OIDC | Same — new tenant not on inbound cert | Step 5 for that tenant (required on every inbound-OIDC onboarding) |
| Install / Agent fails: `TENANT_NAMESPACE` missing or wrong ns | Env not derived; UI ns is `tenantId-envId[:26]` | Set or derive `TENANT_NAMESPACE` from Connect tenant + environment IDs (same as UI); use `fabric-edge.env` / install env, not a placeholder name |
| `tunnel_dial_failed: x509: certificate signed by unknown authority` | Agent TLS trust has agent CA, not Gateway CA | Put Gateway `ca.crt` / `gateway.crt` into Agent trust (`connect-agent-tls`); Fetch CA / CP bundle must return **Gateway** cert |
| Fetch CA / `/v1/ca-bundle` returns agent signing cert | CP not mounting Gateway TLS for bundle issuance | Mount Gateway cert on control-plane; re-fetch CA into Agent secret |
| Discovery hits wrong port (e.g. UI `9448` vs live `9446`) | Multiple Connect Agent / app installs; registration listen-port remap | Use `fabric.abluva.io/registration-ports` / CP registration `agent_listen_port` for the target app (e.g. control-server); redeploy agent mapping if needed |
| CP `/v1/.../registrations` **500**; Gateway `authz_context_lookup_failed` status=500; discovery connection reset | Control-plane Postgres unreachable (`ETIMEDOUT` to DB) | Restore CP DB connectivity; confirm regs HTTP **200**, then retry discovery |
| Discovery connection reset (OIDC already attributed) | Often DB/authz above, or wrong Agent listen port | Fix Postgres / authz; confirm listen port; then re-test |

---

## Design notes (why this shape)

- Issuer = Fabric inbound friendly URL + **`:8444`** (not bare `:443`).
- Per-tenant hostname: `k3s-oidc.<TENANT_ID>.<CONNECT_ZONE>`.
- Customer cluster stays private; Platform fetches JWKS via existing inbound.
- Inbound TLS SAN must include `*.<TENANT_ID>.<CONNECT_ZONE>` (one label
  under the tenant subdomain), not only `*.<CONNECT_ZONE>`.
- **Per-tenant onboarding:** each new inbound-OIDC tenant needs that SAN added
  to `fabric-gateway-inbound-tls` (merge with existing SANs, then restart
  Gateway). Skip only if the live cert already lists the tenant.
