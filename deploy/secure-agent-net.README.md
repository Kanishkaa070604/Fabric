# Abluva Connect — Tenant Setup Guide

This is the **README for [secure-agent-net](https://github.com/abluva/secure-agent-net)**.  
It matches the numbered steps in the Abluva UI: **Subscriptions → environment → Connect Agent → Install**.

Do the steps **in order**. Finish **Part A** and wait until the UI shows **Connected** before **Part B**.

| Part | Folder | What you install | When |
|------|--------|------------------|------|
| **A** | [`connect-agent/`](./connect-agent/) | Connect Agent | Steps 1–5 |
| **B** | [`agent/`](./agent/) | Launcher + UI registrations | Only after **Connected** |

Do **not** commit `ca.crt`, bootstrap tokens, or filled env files.

---

## What’s in this repo

```
secure-agent-net/
├── README.md                 ← this guide
├── connect-agent/            ← Part A (Connect Agent installer)
│   ├── kubernetes/            ← existing cluster: tenant-start.sh
│   └── vm/k3s-appliance/     ← VM / bare metal: install.sh
└── agent/                    ← Part B (launcher): deploy-agent.sh
```

The **Install** env you download from the UI has the **same Step numbers** as this guide.

---

## Before you start

### In the Abluva UI

1. Open **Subscriptions** → your environment → **Connect Agent**.
2. Choose flavor: **Kubernetes** or **VM / bare metal**.
3. Set **Node count** / **Host count** (≥ 1). Optional: **Max tunnels** → **Save**.
4. Click **Generate token** (shown once; ~7 days). The Install env fills `BOOTSTRAP_TOKEN` automatically after this.

### On your side

| Need | Kubernetes | VM |
|------|------------|----|
| Tools | `kubectl`, `python3`, `git` | `sudo`, `python3`, `git` |
| Network | Reach Gateway **:8443** and the control plane URL in the Install env | Same |
| Access | Can create namespaces, secrets, DaemonSets | Root on the host |

Pick **one** flavor and use it for every step below.

---

## Part A — Connect Agent (Steps 1–5)

Installs the tunnel agent only. It does **not** deploy the launcher.

### Step 1 — Get the installer

```bash
git clone https://github.com/abluva/secure-agent-net.git
cd secure-agent-net
```

| Your flavor | Go here |
|-------------|---------|
| Kubernetes | `connect-agent/kubernetes/` |
| VM / bare metal | `connect-agent/vm/k3s-appliance/` |

### Step 2 — Download the CA

1. UI → **CA** → **Download** (or Fetch and copy).
2. Save as **`ca.crt`**.

### Step 3 — Save the Install env next to the script

1. Generate the token first (Before you start), then UI → **Install** → **Download** (or Copy).  
   `BOOTSTRAP_TOKEN` is already filled in that file — you do not paste it by hand.
2. Save with the correct name, **in the same folder** as the script:

| Flavor | Env file | Same folder must contain |
|--------|----------|---------------------------|
| Kubernetes | `tenant-start.env` | `tenant-start.sh`, `daemonset.yaml`, NetworkPolicy, **`ca.crt`** |
| VM | `fabric-edge.env` | `install.sh`, `daemonset.yaml`, NetworkPolicy, **`ca.crt`** |

`CA_CERT_FILE=./ca.crt` is relative to **that** folder — not your Downloads folder.

### Step 4 — Confirm `BOOTSTRAP_TOKEN` is set

Open the env file and confirm `BOOTSTRAP_TOKEN` is a real value (not `<BOOTSTRAP_TOKEN>`).  
If you downloaded Install **before** Generate token, generate the token and download Install again.

### Step 5 — Run the installer

**Kubernetes**

```bash
cd connect-agent/kubernetes
chmod +x tenant-start.sh
./tenant-start.sh ./tenant-start.env
```

**VM**

```bash
cd connect-agent/vm/k3s-appliance
chmod +x install.sh
sudo ./install.sh
```

### Verify Part A — then wait for Connected

Your namespace is `TENANT_NAMESPACE` in the env file, or:

`<TENANT_ID>-<first 26 characters of ENVIRONMENT_ID>`

```bash
# Kubernetes
kubectl -n <TENANT_NAMESPACE> get pods

# VM
k3s kubectl -n <TENANT_NAMESPACE> get pods
```

Expect: `connect-agent` → **Running 1/1**.

In the UI, wait until status is **Connected**.

**Do not start Part B until the UI shows Connected.**

---

## Part B — After Connected (Steps 1–4)

Only when Connect Agent status is **Connected**.

### Step 1 — Get `CONTROL_SERVER_LISTEN_PORT`

1. Connect Agent → **Install** → **Refresh**.
2. Copy **`CONTROL_SERVER_LISTEN_PORT`**.
3. Pass it as `-p` in the next step.

### Step 2 — Deploy the launcher

From the **repo root** (recommended):

```bash
cd agent
```

Or from the installer folder:

| You are in | Run |
|------------|-----|
| `connect-agent/kubernetes/` | `cd ../../agent` |
| `connect-agent/vm/k3s-appliance/` | `cd ../../../agent` |

**Kubernetes**

```bash
chmod +x deploy-agent.sh
./deploy-agent.sh \
  -t <TENANT_ID> \
  -e <ENVIRONMENT_ID> \
  -m <LOGIN_EMAIL> \
  -p <CONTROL_SERVER_LISTEN_PORT>
```

**VM**

```bash
chmod +x deploy-agent.sh
KUBECTL="k3s kubectl" ./deploy-agent.sh \
  -t <TENANT_ID> \
  -e <ENVIRONMENT_ID> \
  -m <LOGIN_EMAIL> \
  -p <CONTROL_SERVER_LISTEN_PORT> \
  --vm
```

- `-m` = your Abluva login email  
- `-p` = port from Step 1  
- Values for `-t` / `-e` are in your Install env file  

Check:

```bash
# Kubernetes
kubectl -n <TENANT_NAMESPACE> get pods,svc -l tier=agent

# VM
k3s kubectl -n <TENANT_NAMESPACE> get pods,svc -l tier=agent
```

Expect a Running agent pod and Service **`agent-svc`** on port **5004**.

### Step 3 — Add customer registrations

1. Connect Agent → **Customer registrations** → **Add**.
2. Use the **Service name** (not a display label):

| Name | Host | Port |
|------|------|------|
| agent-launcher | `agent-svc` | `5004` |
| data-privacy (optional) | `data-privacy-svc` | `8080` |

3. Click **Create** (only when Agent is Connected).
4. Copy the **platform dial target** shown after create (host in your Connect zone, port **8444**).

Platform uses that dial target.  
**Do not** put `agent-svc:5004` into a platform resource URL.

### Step 4 — Register the launcher resource

Do this in the Abluva UI (**Resources**), using the dial target from the **Connect Agent** tab (Step 3).

1. Open **Resources** → **Register Resource**.
2. **Name** — choose a name you will recognize for this tenant/environment  
   (example: `launcher-<your-tenant-or-env-name>`). This is only a label in the UI.
3. **Type** — `agent#https`.
4. **Auth** — **Credentials**.
5. **Config** — go back to **Subscriptions → Connect Agent → Customer registrations**.  
   Find the **agent-launcher** row. Copy the **platform dial target** shown on that page  
   (it looks like `agent-launcher.<your-tenant-id>.connect.….com:8444`).

   Build `base_url` as `https://` + **that exact host:port** (do not invent it; do not use `agent-svc`):

```json
{
  "base_url": "https://<paste-exact-host:port-from-Connect-Agent-tab>",
  "endpoint": "api/v1/launcher/create"
}
```

   Example shape only (your host comes from the page):

```json
{
  "base_url": "https://agent-launcher.<TENANT_ID>.connect.abluva.com:8444",
  "endpoint": "api/v1/launcher/create"
}
```

6. Click **Create Resource**.

---

## Done

- [ ] `connect-agent` pod Running 1/1  
- [ ] UI status **Connected**  
- [ ] Launcher Running; `agent-svc:5004` exists  
- [ ] Customer registration for `agent-svc` / `5004`  
- [ ] Resource named for this tenant; `base_url` = Connect-tab dial **`:8444`**, not `agent-svc`

---

## Ports (do not mix)

| Port | Used for |
|------|----------|
| **8443** | Your Agent → Abluva Gateway (outbound tunnel) |
| **8444** | Abluva platform → your services (inbound DNS) |
| **9443+** | Listen ports in your cluster (Install → **Refresh**) |
| **5004** | In-cluster `agent-svc` — registration host/port only |

---

## Troubleshooting

```bash
kubectl -n <TENANT_NAMESPACE> get pods
kubectl -n <TENANT_NAMESPACE> logs -l app=connect-agent --tail=80
kubectl -n <TENANT_NAMESPACE> get pods,svc -l tier=agent
```

(VM: use `k3s kubectl` instead of `kubectl`.)

| Problem | What to do |
|---------|------------|
| Create registration greyed out | Wait until UI status is **Connected** |
| `connect-agent` not Running | New **CA** + new **token** → update env → re-run Part A Step 5. Check reachability to Gateway **:8443** and the control plane URL |
| Launcher cannot reach control-server | Install → **Refresh** for a real port → re-run `deploy-agent.sh` with that `-p` |
| Platform dial / resource hangs | Resource URL must be Connect-tab dial **`:8444`**, not `agent-svc:5004` |

Support: send `kubectl -n <TENANT_NAMESPACE> get pods`, Connect Agent logs (redact secrets), and Install env **without** tokens.
