# Customer-side launcher (`Deployment/agent`)

Apply **after** the Connect Agent is installed and **Connected**. Pass four
values from the Connect UI: tenant id, environment id, login email, listen port.

| Artifact | Role |
|---|---|
| [`agent-deployment.yaml`](./agent-deployment.yaml) | Launcher + `agent-svc:5004` |
| [`deploy-agent.sh`](./deploy-agent.sh) | Writes env + `kubectl apply` |
| [`deploy-agent.env.example`](./deploy-agent.env.example) | Optional env template |

Connect Agent installers **do not** deploy this launcher.

## Before you run

1. Connect Agent shows **Connected**.
2. Get **`CONTROL_SERVER_LISTEN_PORT`** — Install → **Refresh**, or:

```bash
kubectl -n <tenant-ns> get svc connect-agent \
  -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
```

(Use the port for PLATFORM reg `display_name=control-server`.)

## Deploy (Kubernetes)

```bash
cd deploy/agent
chmod +x deploy-agent.sh
./deploy-agent.sh \
  -t <TENANT_ID> \
  -e <ENVIRONMENT_ID> \
  -m <LOGIN_EMAIL> \
  -p <CONTROL_SERVER_LISTEN_PORT>
```

The script:

1. Derives `TENANT_NAMESPACE` = `<tenantId>-<envId first 26 chars>` (same as UI)
2. Writes `deploy-agent.env` (tenant, env, email, port)
3. Applies YAML with `INFRA_BASE_URL` → `connect-agent:<port>` and `X_ABLV_PRINCIPAL=<email>`

## Deploy (VM / k3s appliance)

```bash
cd deploy/agent
KUBECTL="k3s kubectl" ./deploy-agent.sh \
  -t <TENANT_ID> \
  -e <ENVIRONMENT_ID> \
  -m <LOGIN_EMAIL> \
  -p <CONTROL_SERVER_LISTEN_PORT> \
  --vm
```

`--vm` sets namespace to `fabric-edge`.

Full customer task text: [`docs/Customer-Connect-Install.md`](../../docs/Customer-Connect-Install.md).

## Check

```bash
kubectl -n <tenant-ns> get pods,svc -l tier=agent
```
