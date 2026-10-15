# VM / bare metal — k3s appliance (Part A)

**Full setup guide:** [`../../../secure-agent-net.README.md`](../../../secure-agent-net.README.md)

Same **Part A Steps 1–4** as the UI `fabric-edge.env` comments.  
Part B is in [`../../../agent/`](../../../agent/) — after the Agent is ready.

| Without k3s | With this appliance |
|-------------|---------------------|
| Process restart only | Liveness + readiness |
| No resource limits | CPU/memory limits |
| Different packaging | Same DaemonSet as Kubernetes |

---

## Part A — Steps 1–4

1. **Get installer** — you are in `connect-agent/vm/k3s-appliance/`.
2. **CA** → Download → save `ca.crt` here.
3. **Generate token** (auto-fills Install env; if you left the page and see `<BOOTSTRAP_TOKEN>`, Generate again) → save as `fabric-edge.env` here with `install.sh`, `daemonset.yaml`, `ca.crt`.
4. Run:

```bash
chmod +x install.sh
sudo ./install.sh
# or: sudo ./install.sh ./fabric-edge.env
```

### Verify

```bash
k3s kubectl -n <TENANT_NAMESPACE> get pods
```

Expect `connect-agent` **Running 1/1**.

Ready for Part B when **Install → Refresh** shows `CONTROL_SERVER_LISTEN_PORT`, or  
**Customer registrations → Create** is enabled.

---

## Part B — After the Agent is ready (Steps 1–4)

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
4. Resources → Register Resource: name for this tenant; `agent#https`; `base_url` from Connect-tab dial (not `agent-svc`)

---

## Uninstall

```bash
/usr/local/bin/k3s-uninstall.sh
```
