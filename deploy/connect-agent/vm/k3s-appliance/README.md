# VM / bare metal — k3s appliance (Part A)

**Full setup guide:** [README.md](../../../secure-agent-net.README.md) at the repo root.

Same **Part A Steps 1–5** as the UI `fabric-edge.env` comments.  
Part B (launcher) is in [`../../../agent/`](../../../agent/) — only after UI is **Connected**.

| Without k3s | With this appliance |
|-------------|---------------------|
| Process restart only | Liveness + readiness |
| No resource limits | CPU/memory limits |
| Different packaging | Same DaemonSet as Kubernetes |

---

## Part A — Steps 1–5

1. **Get installer** — you are in `connect-agent/vm/k3s-appliance/`.
2. **CA** → Download → save `ca.crt` here (Gateway CA).
3. **Install** → save as `fabric-edge.env` here (next to `install.sh`, `daemonset.yaml`, `ca.crt`).
4. Set **`BOOTSTRAP_TOKEN`** (from Generate token).
5. Run:

```bash
chmod +x install.sh
sudo ./install.sh
# or: sudo ./install.sh ./fabric-edge.env
```

Optional: `--image=…`, `--ca-url=https://<control-plane>/v1/ca-bundle`.

### Verify

```bash
k3s kubectl -n <TENANT_NAMESPACE> get pods
```

Expect `connect-agent` **Running 1/1**.  
UI: **Approve** if needed → wait for **Connected**. **Stop until Connected.**

---

## Part B — After Connected (Steps 1–4)

1. Install → **Refresh** → copy `CONTROL_SERVER_LISTEN_PORT`
2. Deploy launcher:

```bash
cd ../../../agent
KUBECTL="k3s kubectl" ./deploy-agent.sh \
  -t <TENANT_ID> \
  -e <ENVIRONMENT_ID> \
  -m <LOGIN_EMAIL> \
  -p <CONTROL_SERVER_LISTEN_PORT> \
  --vm
```

3. Customer registrations → `agent-svc:5004`
4. Resources → Register Resource: choose a **name** for this tenant; type `agent#https`; `base_url` = `https://` + dial host:port from the Connect Agent tab (not `agent-svc`)

---

## Uninstall

```bash
/usr/local/bin/k3s-uninstall.sh
```
