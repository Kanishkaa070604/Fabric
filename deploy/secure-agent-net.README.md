# Tenant Cluster Setup Guide

## Overview

Connect your Kubernetes cluster (or Linux VM) to the Abluva platform in minutes. This guide walks you through generating a bootstrap token from the platform UI, installing the Connect Agent, then deploying the launcher once the control-server listen port is known.

Copy/paste task checklist: [`docs/Customer-Connect-Install.md`](../docs/Customer-Connect-Install.md).

Do not commit `ca.crt`, bootstrap tokens, or filled env files.

---

## Step 1: Generate Token

1. Log in to the **Abluva Tenant App**
2. Open **Subscriptions**, open this subscription, go to the **Connect Agent** step (after Assign SKUs, Environments, Membership)
3. Choose **Flavor** — **Kubernetes** or **VM / bare metal**
4. Set **Node count** (Kubernetes) or **Host count** (VM) — at least `1`
5. Optionally set **Max tunnels** (≥ the count; blank defaults to `50`) and click **Save max tunnels**
6. Click **Generate token**, then **Copy**

> **Note**: The token is shown only once and lasts about 7 days. Generating again replaces the previous token. Complete the setup promptly after generating it.

---

## Step 2: Get CA, Install File, Namespace, Tenant ID, and Environment ID

On the same **Connect Agent** step:

### CA certificate
1. Click **Fetch and copy** or **Download**
2. Save as `ca.crt`

This must be the **Gateway server cert** (`CN=fabric.abluva.com` from `GET /v1/ca-bundle`), **not** `fabric-edge-ca` / Agent CA. Wrong CA → Agent `tls: certificate signed by unknown authority` on `:8443`.

### Install file
1. Click **Copy** or **Download** under **Install**
2. Save as `tenant-start.env` (Kubernetes) or `fabric-edge.env` (VM)

That file already includes gateway address, control-plane URL, namespace, tenant ID, environment ID, and a place for the bootstrap token.

### Namespace, Tenant ID, Environment ID
Confirm these from the Install file (or the Environments / Tenants pages if you need them elsewhere):

- **Namespace** — `TENANT_NAMESPACE` (same for Kubernetes and VM appliance)
- **Tenant ID** — `TENANT_ID`
- **Environment ID** — `ENVIRONMENT_ID`

Save these values — you'll need them for verification and resource registration.

---

## Step 3: Prerequisites

Ensure the following on the machine where you'll run the setup:

- [ ] **Kubernetes cluster** with access to create namespaces, Secrets, DaemonSets, Deployments, Services, Roles, and NetworkPolicies (Kubernetes path)
- [ ] **kubectl** installed and configured (Kubernetes), or a Linux host for the VM appliance
- [ ] **python3** (Kubernetes installer)
- [ ] **Network connectivity** — nodes must reach the Abluva platform gateway (`FABRIC_GATEWAY_ADDRESS`, typically TCP **8443**) and control plane (`FABRIC_CONTROL_PLANE_URL`, typically HTTPS **443**)
- [ ] **`ca.crt`** from Step 2
- [ ] **Install env file** from Step 2 (`tenant-start.env` or `fabric-edge.env`) with `BOOTSTRAP_TOKEN` set

---

## Step 4: Clone the Setup Repository

```bash
git clone https://github.com/abluva/secure-agent-net.git
cd secure-agent-net
```

Layout used by this guide:

```
connect-agent/kubernetes/          tenant-start.sh   (Connect Agent only)
connect-agent/vm/k3s-appliance/    install.sh        (Connect Agent only)
agent/deploy-agent.sh              launcher + agent-svc (after Connected)
agent/agent-deployment.yaml
```

---

## Step 5: Run the Connect Agent Installer

**Important:** place the downloaded **`ca.crt`** and Install **env file in the same directory as the `.sh` script** you will run. Both K8s and VM env files use `CA_CERT_FILE=./ca.crt`, resolved relative to that directory (not your Downloads folder).

| Flavor | Put `ca.crt` + env here (next to the script) |
|---|---|
| Kubernetes | `connect-agent/kubernetes/` → `tenant-start.sh` + `tenant-start.env` |
| VM / bare metal | `connect-agent/vm/k3s-appliance/` → `install.sh` + `fabric-edge.env` |

Set `BOOTSTRAP_TOKEN` in the env file if it is not already filled. Then run the script **from that directory**.

### Kubernetes

```bash
cd connect-agent/kubernetes
# ca.crt and tenant-start.env must be in this directory
chmod +x tenant-start.sh
./tenant-start.sh ./tenant-start.env
```

### VM / bare metal

```bash
cd connect-agent/vm/k3s-appliance
# ca.crt and fabric-edge.env must be in this directory
chmod +x install.sh
sudo ./install.sh
```

### What this script does

| Step | Action | Notes |
|------|--------|-------|
| 1 | Create tenant namespace | Label `abluva.io/tenant=true` (Kubernetes). VM appliance uses `fabric-edge`. |
| 2 | Create secrets | CA + bootstrap material for the Connect Agent |
| 3 | Deploy Connect Agent | DaemonSet — Agent dials **out** to the platform gateway and control plane |
| 4 | Apply NetworkPolicy | Same-ns + Abluva SaaS ns; opt-in cross-tenant with `abluva.io/cross-tenant=true` |
| 5 | Wait for Agent | Waits until `daemonset/connect-agent` is ready |

The **launcher** is not deployed here — that needs `CONTROL_SERVER_LISTEN_PORT` (Step 7).

---

## Step 6: Verify Connect Agent

### Kubernetes

```bash
NAMESPACE=<your-tenant-namespace>

kubectl get pods -n $NAMESPACE
kubectl get daemonset connect-agent -n $NAMESPACE
```

### VM / bare metal

```bash
k3s kubectl -n fabric-edge get pods
```

In the Abluva app, confirm the Agent shows **Connected** on the **Connect Agent** step (Approve if PendingApproval).

---

## Step 7: Deploy the launcher

After **Connected**, you need four values:

| Input | Source |
|---|---|
| Tenant ID | Install env / Tenants page |
| Environment ID | Install env / Environments |
| Login email | Your Abluva login (→ `X_ABLV_PRINCIPAL`) |
| Port | Install → **Refresh** (`CONTROL_SERVER_LISTEN_PORT`), or svc annotation below |

```bash
kubectl -n "$TENANT_NAMESPACE" get svc connect-agent \
  -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
# use the port for PLATFORM reg display_name=control-server
```

### Kubernetes

```bash
cd agent
chmod +x deploy-agent.sh
./deploy-agent.sh -t <TENANT_ID> -e <ENVIRONMENT_ID> -m <LOGIN_EMAIL> -p <PORT>
```

The script derives the namespace, writes `deploy-agent.env`, and applies the launcher.

### VM / bare metal

```bash
cd agent
KUBECTL="k3s kubectl" ./deploy-agent.sh -t <TENANT_ID> -e <ENVIRONMENT_ID> -m <LOGIN_EMAIL> -p <PORT> --vm
```

Verify:

```bash
kubectl -n <tenant-ns> get pods,svc -l tier=agent
# VM: k3s kubectl -n fabric-edge get pods,svc -l tier=agent
```

See [`agent/README.md`](./agent/README.md).

---

## Step 8: Customer Registrations

Back on **Connect Agent** → **Customer registrations** → **Add registrations**.

| Row | Host | Port |
|---|---|---|
| launcher | `agent-svc` | `5004` |
| data-privacy (optional) | `data-privacy-svc` | `8080` |

**Create** stays disabled until an Agent is Connected. After a successful create, the page lists each registration as:

```text
agent-launcher: Active → agent-launcher.<tenant-id>.connect.abluva.com:8444
data-privacy: Active → data-privacy.<tenant-id>.connect.abluva.com:8444
```

That `host:port` is what **platform** apps use (Gateway inbound). Prefix with `https://` when you need a base URL. Do **not** put the form values (`agent-svc:5004`) in platform resource config — those are only for the Connect Agent inside the customer cluster.

---

## Step 9: Register Resource in Platform (launcher create)

(Requires Step 7 launcher deployed and Step 8 registration created.)

After customer registrations succeed on the **Connect Agent** tab:

1. Copy the **agent-launcher** line’s `host:port` from that tab  
   (e.g. `agent-launcher.<tenant-id>.connect.abluva.com:8444`)
2. Navigate to **Resources** → **Register Resource** (or Create launcher resource)
3. Give a **Resource Name** (e.g. `agent-launcher`)
4. Choose Resource Type: `agent#https` (or your launcher type)
5. Authentication: **Credentials**
6. Set:

| Field | Value |
|---|---|
| **base_url** | `https://` + host:port from Connect Agent tab |
| **endpoint** | `api/v1/launcher/create` |

Example (replace with your tenant’s host:port from the Connect tab):

```json
{
  "base_url": "https://agent-launcher.5d5fcf62-9efa-48d1-9132-e3becf4436e5.connect.abluva.com:8444",
  "endpoint": "api/v1/launcher/create"
}
```

Full dial path for create: `{base_url}/{endpoint}` →  
`https://agent-launcher.<tenant-id>.connect.abluva.com:8444/api/v1/launcher/create`

7. Click **Create Resource**

For other customer services (e.g. data-privacy), use the matching `host:port` from the Connect tab as `base_url` (`https://host:port`) and set the product endpoint path as needed.

---

## Service Endpoint Available

| Where | Service | Address | Purpose |
|-------|---------|---------|---------|
| **Platform → customer** | Launcher | `https://agent-launcher.<tenant-id>.connect.abluva.com:8444` (+ path) | From Connect Agent tab after reg create |
| **Customer cluster only** | Launcher | `http://agent-svc.<namespace>.svc.cluster.local:5004` | Agent dial target — not for platform resources |
| **Customer → platform** | Connect Agent | `connect-agent.<namespace>.svc.cluster.local:<port>` | Local listeners for Active PLATFORM registrations |

---

## Troubleshooting

For errors after `tenant-start.sh` / `install.sh`, start here. Replace `$NS` with your
`TENANT_NAMESPACE` (or `fabric-edge` on the VM appliance).

```bash
kubectl -n "$NS" get pods
kubectl -n "$NS" describe pod -l app=connect-agent | tail -40
kubectl -n "$NS" logs -l app=connect-agent --tail=80
kubectl -n "$NS" describe pod -l tier=agent | tail -40
```

### Create registrations stays disabled / Create greyed out

**Cause**: Connect Agent is not **Connected** yet (still Connecting, PendingApproval, or enroll failed).

**Fix**:
1. `kubectl -n "$NS" get pods` — `connect-agent` must be Running 1/1.
2. In UI → Connect Agent: **Approve** if PendingApproval; wait for **Connected**.
3. Then **Add customer registrations** → fill host/port → **Create**.

### `ImagePullBackOff` / `ErrImagePull` — wrong CPU architecture

**Symptom**: `no match for platform in manifest` or `no matching manifest for linux/amd64`.

**Cause**: Image was built on Apple Silicon (arm64) but the customer node is **amd64** (typical VM/k3s).

**Fix**: Rebuild and push with an explicit platform, then delete the pod:

```bash
docker buildx build --platform linux/amd64 -t phx.ocir.io/axsfgj15p1je/connect-agent:v2 \
  -f deploy/local/Dockerfile.connect-agent --push <fabric-repo-root>
docker buildx imagetools inspect phx.ocir.io/axsfgj15p1je/connect-agent:v2 | grep -i platform
# must show linux/amd64

kubectl -n "$NS" delete pod -l app=connect-agent
```

Same for launcher (`phx.ocir.io/axsfgj15p1je/launcher:<tag>`). A plain `docker build` on a Mac
defaults to **arm64** — do **not** use that for customer VMs.

### `ImagePullBackOff` — tag not found / unauthorized

**Symptom**: `manifest unknown` or `pull access denied`.

**Fix**: Confirm the tag exists in OCIR; use a known-good tag (e.g. `launcher:3`); add an
`imagePullSecrets` / `ocir-secret` in `$NS` if the repo is private.

### Connect Agent CrashLoop — `identity_unavailable` / enroll timeout

**Symptom** (logs):
`Post "http://fabric.abluva.com:8080/v1/agents/enroll": context deadline exceeded`

**Cause**: Customer node cannot reach public Fabric control plane **:8080** (NLB / NSG /
Service type). Gateway **:8443** can still work.

**Check from the customer host**:

```bash
nc -zv fabric.abluva.com 8443    # should succeed
nc -zv fabric.abluva.com 8080    # must succeed for enroll
curl -sf --max-time 5 http://fabric.abluva.com:8080/healthz
```

**Platform fix** (ops): `fabric-control-plane` Service must be **NodePort** (pinned
`32528` in `deploy/control-plane/deployment.yaml`), NLB listener **TCP 8080** → that
NodePort, NSG/SL allow 8080. ClusterIP-only Service breaks public Agent enroll.

### Connect Agent CrashLoop — bad bootstrap / CA

**Cause**: Wrong or expired `BOOTSTRAP_TOKEN`, or `ca.crt` is not the Gateway trust CA.

**Fix**: Re-download CA + generate a new token on the Connect Agent tab; update
`tenant-start.env` / Secrets; re-run the installer.

### `git pull` blocked by local edits

**Symptom**: `Your local changes to the following files would be overwritten by merge`.

**Fix** (keep remote versions):

```bash
git checkout -- connect-agent/kubernetes/tenant-start.sh agent/agent-deployment.yaml
git pull
```

### Launcher Running but cannot reach control-server

**Cause**: `INFRA_BASE_URL` still has `<control-server-listen-port>`, or wrong port.

**Fix**:
1. Prefer Connect UI Install → **Refresh** after Agent Connected →
   `CONTROL_SERVER_LISTEN_PORT` (Fabric `control-server.agent_listen_port`).
2. Or from the cluster:
   ```bash
   kubectl -n "$NS" get svc connect-agent \
     -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
   ```
   Use the port for PLATFORM reg `display_name=control-server`, then re-run
   `agent/deploy-agent.sh -t … -e … -p <port>` (or patch Deployment/agent
   `INFRA_BASE_URL`).

Do **not** use `http://control-server-svc.<saas-ns>.svc…` from the customer cluster.

### Registration Create fails / Platform dial `destination_unavailable`

**Cause**: Wrong host (used display name instead of Service name), Service missing, or
Agent not Connected / probe not reachable.

**Fix**: Register `agent-launcher` with `host=agent-svc` `port=5004` only after
`agent-svc` exists. Wait for Connect status Connected; confirm
`observed.reachable=true` before relying on Platform→Customer dials.

### Platform resource / launcher create hangs

**Cause**: Resource `base_url` used in-cluster `agent-svc` instead of the Connect-tab
`host:port` (`*.connect.abluva.com:8444`), or inbound **:8444** / NetPol blocked.

**Fix**: Use `https://` + host:port from the Connect tab after Create; endpoint
`api/v1/launcher/create`. Confirm Gateway inbound path from platform ops if needed.

### Cloud Shell cannot curl `fabric.abluva.com:8080`

**Cause**: Public NLB :8080 not reachable from Cloud Shell (NSG) — normal in some setups.

**Fix**: Use in-cluster access:
`kubectl -n <saas-ns> port-forward svc/fabric-control-plane 8080:8080`
or `kubectl exec` from a pod in that namespace.

---

## Support

If you encounter issues not covered above, contact Abluva support with:
`kubectl -n "$NS" get pods`, Connect Agent logs, and the Install env (redact tokens).
