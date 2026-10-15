# Connect Agent + launcher — short checklist

**Full tenant guide:** [`../deploy/secure-agent-net.README.md`](../deploy/secure-agent-net.README.md)  
→ published as `README.md` in https://github.com/abluva/secure-agent-net

Do **not** commit `ca.crt`, tokens, or filled env files.

| Part | Folder | When |
|------|--------|------|
| **A** | `connect-agent/` | Steps 1–4 first |
| **B** | `agent/` | After Agent is ready |

---

## Before you start (UI)

1. **Subscriptions** → environment → **Connect Agent**.
2. Flavor: **Kubernetes** or **VM / bare metal**.
3. Node/host count (≥ 1). Optional max tunnels → **Save**.
4. **Generate token** — `BOOTSTRAP_TOKEN` auto-fills in the Install env.  
   If you leave the screen, it becomes `<BOOTSTRAP_TOKEN>` again → **Generate** once more, then download Install.

---

## Part A — Connect Agent (Steps 1–4)

### Step 1 — Get the installer

```bash
git clone https://github.com/abluva/secure-agent-net.git
cd secure-agent-net
```

| Flavor | Directory |
|--------|-----------|
| Kubernetes | `connect-agent/kubernetes/` |
| VM | `connect-agent/vm/k3s-appliance/` |

### Step 2 — Download the CA

UI → **CA** → **Download** → `ca.crt`.

### Step 3 — Save Install env next to the script

After Generate token, **Install** → Download:

| Flavor | Env file name | Same folder must contain |
|--------|---------------|---------------------------|
| Kubernetes | `tenant-start.env` | `tenant-start.sh`, `daemonset.yaml`, NetworkPolicy, `ca.crt` |
| VM | `fabric-edge.env` | `install.sh`, `daemonset.yaml`, NetworkPolicy, `ca.crt` |

If the env still shows `<BOOTSTRAP_TOKEN>`, Generate again, then download.

### Step 4 — Run

**Kubernetes:** `./tenant-start.sh ./tenant-start.env`  
**VM:** `sudo ./install.sh`

### Verify → ready for Part B?

`connect-agent` Running 1/1. No manual Approve. Ready when either:

1. **Install → Refresh** shows `CONTROL_SERVER_LISTEN_PORT`, or  
2. Customer registrations — fill a row and **Create** is enabled.

---

## Part B — After the Agent is ready (Steps 1–4)

1. Install → **Refresh** → `CONTROL_SERVER_LISTEN_PORT`
2. `cd agent` → `./deploy-agent.sh -t … -e … -m … -p …` (add `--vm` / `KUBECTL="k3s kubectl"` on VM)
3. Customer registrations: `agent-svc:5004`
4. **Resources → Register Resource:** name for this tenant; type `agent#https`; auth **Credentials**; `base_url` = `https://` + exact dial host:port from Connect tab (not `agent-svc`)

---

## Ports

| Port | Meaning |
|------|---------|
| `:8443` | Agent → Gateway outbound |
| `:8444` | Platform inbound |
| `:9443+` | Agent listen (Refresh) |
| `:5004` | `agent-svc` registration only |
