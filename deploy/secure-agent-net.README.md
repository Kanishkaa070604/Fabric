# Tenant Cluster Setup Guide

## Overview

Connect your Kubernetes cluster (or Linux VM) to the Abluva platform in minutes. This guide walks you through generating a bootstrap token from the platform UI and running a single script to set up the secure connection and launcher.

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

### Install file
1. Click **Copy** or **Download** under **Install**
2. Save as `tenant-start.env` (Kubernetes) or `fabric-edge.env` (VM)

That file already includes gateway address, control-plane URL, namespace, tenant ID, environment ID, and a place for the bootstrap token.

### Namespace, Tenant ID, Environment ID
Confirm these from the Install file (or the Environments / Tenants pages if you need them elsewhere):

- **Namespace** — `TENANT_NAMESPACE` (Kubernetes) or `fabric-edge` (VM appliance)
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
connect-agent/kubernetes/          tenant-start.sh
connect-agent/vm/k3s-appliance/    install.sh
agent/agent-deployment.yaml        launcher + agent-svc
```

---

## Step 5: Configure Agent Deployment

`agent/agent-deployment.yaml` uses placeholders. The installer replaces:

- `<tenant-namespace>` ← `TENANT_NAMESPACE`
- `<tenantId>` ← `TENANT_ID`
- `<envid>` ← `ENVIRONMENT_ID`
- `<control-server-listen-port>` ← `CONTROL_SERVER_LISTEN_PORT` (when set)

**Customer→Platform base URL** (launcher `INFRA_BASE_URL`):

```text
http://connect-agent.<tenant-namespace>.svc.cluster.local:<control-server-listen-port>
```

Do **not** use `http://control-server-svc.<saas-ns>.svc.cluster.local:5001` from the tenant cluster — that DNS does not resolve there.

### How `CONTROL_SERVER_LISTEN_PORT` is filled

1. Connect Agent opens one StreamOpen listener per Active registration (base **9443+**).
2. Agent POSTs `listen_port` on `POST /v1/registrations/:id/observed` (Connect Agent image that includes listen-port reporting).
3. Fabric exposes it on registrations as **`agent_listen_port`**.
4. Abluva Connect **Install** snippet reads the PLATFORM reg `display_name=control-server` and, when known, writes `CONTROL_SERVER_LISTEN_PORT=<port>` into the downloadable env. Click **Refresh** after the Agent is **Connected**.

Until that lands, the env line is commented / omitted and the launcher keeps the placeholder — set it manually (below) or re-download after Refresh, then re-run the installer or patch `Deployment/agent` `INFRA_BASE_URL`.

**From Fabric (Platform):**

```bash
# After Agent reported; look for control-server.agent_listen_port
curl -sS -H "Authorization: Bearer $TOKEN" -H "X-ABLV-Actor: ops" \
  "http://127.0.0.1:8080/v1/tenants/${TENANT_ID}/registrations" \
| jq '.registrations[] | select(.display_name=="control-server") | {id, agent_listen_port}'
```

**From the customer cluster (same port):**

```bash
kubectl -n "$TENANT_NAMESPACE" get svc connect-agent \
  -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
# JSON: {"<reg-uuid>":9444,...} — use the UUID of display_name=control-server
```

```bash
CONTROL_SERVER_LISTEN_PORT=9444   # example — your control-server agent_listen_port
```

**Before running the script**, edit `agent/agent-deployment.yaml` and set **`X_ABLV_PRINCIPAL`** to your login email (this becomes the `X-ABLV-Principal` header on launcher → control-server calls).

```yaml
- name: X_ABLV_PRINCIPAL
  value: "you@yourcompany.com"   # your email — required
- name: X_ABLV_PRINCIPAL_ROLE
  value: "tenant-admin"          # keep unless your role differs
```

SaaS tenant/environment IDs in the YAML stay as platform constants. You do not paste a SaaS API key into the launcher YAML.

**Privacy / other launch agents** use the same pattern (`deploy/privacy/`):

| Env | Fabric URL |
|---|---|
| control-server | `http://connect-agent.<ns>.svc:<control-server-listen-port>/…` |
| unified-access | `http://connect-agent.<ns>.svc:<unified-access-listen-port>` |

Put `ca.crt` and the Install env file next to the script you will run (Step 6). Ensure `BOOTSTRAP_TOKEN` and `ENVIRONMENT_ID` are set in the env file.

---

## Step 6: Run the Setup Script

### Kubernetes

```bash
cd connect-agent/kubernetes
# ca.crt and tenant-start.env in this directory
chmod +x tenant-start.sh
./tenant-start.sh ./tenant-start.env
```

### VM / bare metal

```bash
cd connect-agent/vm/k3s-appliance
# ca.crt and fabric-edge.env in this directory
chmod +x install.sh
sudo ./install.sh --env-file=./fabric-edge.env
```

---

## What the Script Does

| Step | Action | Notes |
|------|--------|-------|
| 1 | Create tenant namespace | Label `abluva.io/tenant=true` (Kubernetes). VM appliance uses `fabric-edge`. |
| 2 | Create secrets | CA + bootstrap material for the Connect Agent |
| 3 | Deploy Connect Agent | DaemonSet — Agent dials **out** to the platform gateway and control plane (no Skupper site, MetalLB, or link-token redeem) |
| 4 | Deploy launcher | Applies `agent/agent-deployment.yaml` → `Deployment/agent` + `Service/agent-svc:5004` (must have set `X_ABLV_PRINCIPAL` email in Step 5) |
| 5 | Apply NetworkPolicy | Same-ns + Abluva SaaS ns; opt-in cross-tenant with `abluva.io/cross-tenant=true` |
| 6 | Wait for Agent | Waits until `daemonset/connect-agent` is ready |

---

## Step 7: Verify Setup

### Kubernetes

```bash
NAMESPACE=<your-tenant-namespace>

kubectl get pods -n $NAMESPACE
kubectl get daemonset connect-agent -n $NAMESPACE
kubectl get svc agent-svc -n $NAMESPACE
```

### VM / bare metal

```bash
k3s kubectl -n fabric-edge get pods
k3s kubectl -n fabric-edge get svc agent-svc
```

In the Abluva app, confirm the Agent shows **Connected** on the **Connect Agent** step before creating registrations.

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

### Create registrations stays disabled

**Cause**: No Agent is Connected yet.

**Fix**: Wait until Step 7 shows Connected pods / Connected status in the UI, then retry **Create**.

### Agent pods CrashLoop or Pending

**Cause**: Missing bootstrap token, wrong CA, or nodes cannot reach the platform gateway / control plane.

**Fix**: Confirm `BOOTSTRAP_TOKEN` and `ca.crt`, and that `FABRIC_GATEWAY_ADDRESS` / `FABRIC_CONTROL_PLANE_URL` from the Install file are reachable from the cluster nodes.

### Launcher cannot reach control-server

**Cause**: `INFRA_BASE_URL` still points at SaaS in-cluster DNS, or wrong Connect Agent listener port.

**Fix**: Use `http://connect-agent.<ns>.svc.cluster.local:<port>` where `<port>` is the `control-server` PLATFORM registration listener from the `connect-agent` Service annotation. Patch the Deployment if the port was unknown at install time.

### Agent image pull error

**Cause**: Your cluster can't reach the container registry.

**Fix**: Contact Abluva support for alternative image delivery or configure registry trust.

### Request hangs (timeout)

**Cause**: Egress blocked to the platform NLB or control plane, or NetworkPolicy too tight for your workload path.

**Fix**: Verify outbound TCP to gateway **8443** and control-plane HTTPS. Contact Abluva support if platform-side ACLs are suspected.

---

## Support

If you encounter issues, contact Abluva support.
