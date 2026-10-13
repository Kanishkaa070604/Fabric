# k3s OIDC via Fabric inbound — step-by-step test guide

End-to-end guide to enable `kubernetes_oidc` on a **private k3s** customer
cluster when Platform reaches JWKS only through Fabric inbound
(`connect.abluva.com:8444`).

Follow the sections in order. Each command block is labeled **Cloud Shell**
(Platform kubectl / CP API) or **Customer** (k3s node / customer kubectl).

Replace placeholders if your IDs differ:

| Placeholder | Example used in this guide |
|---|---|
| `TENANT` | `5d5fcf62-9efa-48d1-9132-e3becf4436e5` |
| `AGENT_NS` | `5d5fcf62-9efa-48d1-9132-e3becf4436e5-e477fc9f-b9cc-4c04-b9ad-29` |
| `CP` | `http://fabric.abluva.com:8080` |
| `ISSUER` | `https://k3s-oidc.<TENANT>.connect.abluva.com:8444` |
| Product tenant / env (discovery headers) | `3407e407-…` / `5620f907-…` |

**Prereqs:** Connect Agent is **Connected** for `TENANT`; Fabric inbound
`:8444` works for other customer registrations; you have a CP writer token.

---

## 0) Cloud Shell — load token and env

```bash
export TENANT="5d5fcf62-9efa-48d1-9132-e3becf4436e5"
export AGENT_NS="5d5fcf62-9efa-48d1-9132-e3becf4436e5-e477fc9f-b9cc-4c04-b9ad-29"
export ISSUER="https://k3s-oidc.${TENANT}.connect.abluva.com:8444"
export CP="http://fabric.abluva.com:8080"

# SaaS / control-plane auth secret namespace (where fabric-control-plane-auth lives)
export AUTH_NS="3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c"

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
export TENANT="5d5fcf62-9efa-48d1-9132-e3becf4436e5"
export ISSUER="https://k3s-oidc.${TENANT}.connect.abluva.com:8444"

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
export AGENT_NS="5d5fcf62-9efa-48d1-9132-e3becf4436e5-e477fc9f-b9cc-4c04-b9ad-29"

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

Wildcard `*.connect.abluva.com` does **not** match
`k3s-oidc.<tenant_id>.connect.abluva.com`. The inbound cert must include:

```text
*.<TENANT>.connect.abluva.com
```

```bash
cd /tmp
TENANT_A=3407e407-792a-452d-8bb4-03c54ac34d52
TENANT_B=5d5fcf62-9efa-48d1-9132-e3becf4436e5

kubectl -n fabric-control get secret fabric-gateway-inbound-tls \
  -o jsonpath='{.data.inbound-key\.pem}' | base64 -d > inbound.key

openssl req -new -key inbound.key \
  -subj "/CN=*.connect.abluva.com" -out inbound.csr

openssl x509 -req -in inbound.csr -signkey inbound.key -days 365 -out inbound.crt \
  -extfile <(printf "subjectAltName=DNS:*.connect.abluva.com,DNS:*.${TENANT_A}.connect.abluva.com,DNS:*.${TENANT_B}.connect.abluva.com,DNS:connect.abluva.com")

openssl x509 -in inbound.crt -noout -ext subjectAltName
# must list: *.5d5fcf62-9efa-48d1-9132-e3becf4436e5.connect.abluva.com

kubectl -n fabric-control create secret generic fabric-gateway-inbound-tls \
  --from-file=inbound-cert.pem=inbound.crt \
  --from-file=inbound-key.pem=inbound.key \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n fabric-control rollout restart deploy/fabric-gateway
kubectl -n fabric-control rollout status deploy/fabric-gateway
```

Verify live:

```bash
echo | openssl s_client -connect fabric.abluva.com:8444 \
  -servername "k3s-oidc.${TENANT_B}.connect.abluva.com" \
  2>/dev/null | openssl x509 -noout -ext subjectAltName
```

---

## 6) Cloud Shell — register workload evidence

CP discovery probe uses the process trust store and often fails on the
self-signed inbound cert (`discovery_failed: fetch failed`). For this path,
set JWKS + CA explicitly and skip the probe:

```bash
openssl s_client -showcerts -connect fabric.abluva.com:8444 \
  -servername "k3s-oidc.${TENANT}.connect.abluva.com" \
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
export AGENT_NS="5d5fcf62-9efa-48d1-9132-e3becf4436e5-e477fc9f-b9cc-4c04-b9ad-29"
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

### 8b) Customer — discovery through Agent (:9444)

Prefer Agent **pod IP** (avoids ClusterIP NetPol issues):

```bash
NS=5d5fcf62-9efa-48d1-9132-e3becf4436e5-e477fc9f-b9cc-4c04-b9ad-29
AGENT_IP=$(kubectl -n "$NS" get pod -l app=connect-agent -o jsonpath='{.items[0].status.podIP}')
BASE=http://${AGENT_IP}:9444

kubectl -n "$NS" delete pod disc-test --ignore-not-found --force --grace-period=0
kubectl -n "$NS" run disc-test --rm -it --restart=Never --image=busybox:1.36 -- \
  wget -qO- -T 15 \
  --header="X-ABLV-Tenant-ID: 3407e407-792a-452d-8bb4-03c54ac34d52" \
  --header="X-ABLV-Environment-ID: 5620f907-0281-497d-9098-8cfed51f5be1" \
  --header="X-ABLV-Principal: kanishkaa070604@gmail.com" \
  --header="X-ABLV-ResourceType: catalogue#database" \
  --header="Accept: application/json" \
  "${BASE}/api/v1/control/discovery"
```

Adjust `:9444` if `fabric.abluva.io/registration-ports` maps control-server
elsewhere.

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
  evidence_iss=https://k3s-oidc.<TENANT>.connect.abluva.com:8444
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
| `UNAUTHORIZED` … cert valid for `*.3407e407…` not `k3s-oidc.5d5fcf62…` | Inbound cert missing `*.<TENANT>.connect.abluva.com` | Regenerate inbound cert (step 5) |
| Discovery connection reset | Wrong Agent listen port or evidence deny | Check registration-ports; fix SAN / JWKS |

---

## Design notes (why this shape)

- Issuer = Fabric inbound friendly URL + **`:8444`** (not bare `:443`).
- Per-tenant hostname: `k3s-oidc.<tenant_id>.connect.abluva.com`.
- Customer cluster stays private; Platform fetches JWKS via existing inbound.
- Inbound TLS SAN must include `*.<tenant_id>.connect.abluva.com` (one label
  under the tenant subdomain), not only `*.connect.abluva.com`.
