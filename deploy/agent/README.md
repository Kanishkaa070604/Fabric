# Launcher (Part B)

**Full setup guide:** [README.md](../secure-agent-net.README.md) at the repo root.

Use this folder **only after** Connect Agent status is **Connected** in the Abluva UI.  
Part A installers (`tenant-start.sh` / `install.sh`) do **not** deploy these files.

| Artifact | Role |
|----------|------|
| [`deploy-agent.sh`](./deploy-agent.sh) | Writes env + applies the launcher |
| [`agent-deployment.yaml`](./agent-deployment.yaml) | Launcher Deployment + `agent-svc:5004` |
| [`deploy-agent.env.example`](./deploy-agent.env.example) | Optional template |

---

## After Connected (UI Steps 1–4)

### 1. Refresh for the listen port

Connect Agent → **Install** → **Refresh** → copy **`CONTROL_SERVER_LISTEN_PORT`**.

### 2. Deploy

From this directory (`agent/`):

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

`-t` / `-e` are in your Install env. `-m` is your Abluva login email. `-p` is from Step 1.

### 3. Customer registrations

UI → **Customer registrations** → host `agent-svc` port `5004`  
(optional `data-privacy-svc:8080`).

Copy the **platform dial** host (`…:8444`). Do not use `agent-svc` in platform resource URLs.

### 4. Register launcher resource

1. **Resources** → **Register Resource**.
2. **Name** — choose a label for this tenant/environment (e.g. `launcher-<tenant-or-env>`).
3. **Type** `agent#https` · **Auth** **Credentials**.
4. On the **Connect Agent** tab, copy the **platform dial target** for `agent-launcher`, then:

```json
{
  "base_url": "https://<paste-exact-host:port-from-Connect-Agent-tab>",
  "endpoint": "api/v1/launcher/create"
}
```

Do not use `agent-svc:5004` here.

### Verify

```bash
kubectl -n <TENANT_NAMESPACE> get pods,svc -l tier=agent
# VM: k3s kubectl -n <TENANT_NAMESPACE> get pods,svc -l tier=agent
```
