# Launcher (Part B)

**Full setup guide:** [`../secure-agent-net.README.md`](../secure-agent-net.README.md)

Use this folder **only after** the Agent is ready  
(Install → **Refresh** shows `CONTROL_SERVER_LISTEN_PORT`, or Customer registrations → **Create** is enabled).

| Artifact | Role |
|----------|------|
| [`deploy-agent.sh`](./deploy-agent.sh) | Writes env + applies the launcher |
| [`agent-deployment.yaml`](./agent-deployment.yaml) | Launcher Deployment + `agent-svc:5004` |
| [`deploy-agent.env.example`](./deploy-agent.env.example) | Optional template |

---

## After the Agent is ready (Steps 1–4)

### 1. Refresh for the listen port

Connect Agent → **Install** → **Refresh** → copy **`CONTROL_SERVER_LISTEN_PORT`**.

### 2. Deploy

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

### 3. Customer registrations

UI → host `agent-svc` port `5004`. Copy the **platform dial** (`…:8444`).

### 4. Register launcher resource

**Resources** → name for this tenant → type `agent#https` → Credentials →  
`base_url` = `https://` + exact dial from the Connect tab (not `agent-svc`).

### Verify

```bash
kubectl -n <TENANT_NAMESPACE> get pods,svc -l tier=agent
```
