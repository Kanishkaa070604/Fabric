# Connect Agent + launcher — short checklist

**Full tenant guide (public repo README):** [`../deploy/secure-agent-net.README.md`](../deploy/secure-agent-net.README.md)  
→ published as `README.md` in https://github.com/abluva/secure-agent-net

Same Steps as the UI Install env. Do **not** commit `ca.crt`, tokens, or filled env files.

| Part | Folder | When |
|------|--------|------|
| **A** | `connect-agent/` | Steps 1–5 first |
| **B** | `agent/` | Only after UI is **Connected** |

---

## Before you start (UI)

1. **Subscriptions** → environment → **Connect Agent**.
2. Flavor: **Kubernetes** or **VM / bare metal**.
3. Node/host count (≥ 1). Optional max tunnels → **Save**.
4. **Generate token** (shown once; ~7 days).

---

## Part A — Connect Agent (Steps 1–5)

### Step 1 — Get the installer

```bash
git clone https://github.com/abluva/secure-agent-net.git
cd secure-agent-net
```

| Flavor | Directory |
|--------|-----------|
| Kubernetes | `connect-agent/kubernetes/` |
| VM | `connect-agent/vm/k3s-appliance/` |

### Step 2 — Download Gateway CA

UI → **CA** → **Download** → `ca.crt` (Gateway CA, not Agent signing CA).

### Step 3 — Save Install env next to the script

| Flavor | Env file | Same folder as |
|--------|----------|----------------|
| Kubernetes | `tenant-start.env` | `tenant-start.sh` + YAML + `ca.crt` |
| VM | `fabric-edge.env` | `install.sh` + YAML + `ca.crt` |

### Step 4 — Set `BOOTSTRAP_TOKEN`

### Step 5 — Run

**Kubernetes:** `./tenant-start.sh ./tenant-start.env`  
**VM:** `sudo ./install.sh`

### Verify → wait for Connected

`connect-agent` Running 1/1 → UI **Connected**. **Stop until Connected.**

---

## Part B — After Connected (Steps 1–4)

1. Install → **Refresh** → `CONTROL_SERVER_LISTEN_PORT`
2. `cd agent` → `./deploy-agent.sh -t … -e … -m … -p …` (add `--vm` / `KUBECTL="k3s kubectl"` on VM)
3. Customer registrations: `agent-svc:5004`
4. **Resources → Register Resource:** pick a clear **name** for this tenant; type `agent#https`; auth **Credentials**; set `base_url` to `https://` + the **exact** platform dial host:port from the Connect Agent tab (agent-launcher row) — not `agent-svc`

---

## Ports

| Port | Meaning |
|------|---------|
| `:8443` | Agent → Gateway outbound |
| `:8444` | Platform inbound |
| `:9443+` | Agent listen (Refresh) |
| `:5004` | `agent-svc` registration only |
