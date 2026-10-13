# Connect Agent + launcher — customer install steps

Copy/paste task instructions for Subscriptions → Connect Agent.

Do not commit `ca.crt`, bootstrap tokens, or filled env files.

---

1. Open **Subscriptions**. Open this environment. Open the **Connect Agent** tab.

2. Choose **Kubernetes** or **VM / bare metal**. Enter **Node count** (K8s) or **Host count** (VM), at least 1. Optionally set **Max tunnels** (≥ that count; leave blank to use default **50**). If you enter a value, click **Save max tunnels**.

3. Click **Generate token**. Copy and store it. It is shown once and lasts about 7 days. You can generate again; the new token replaces the previous one.

4. Under **CA**, click **Fetch and copy** or **Download**. Save the file as `ca.crt`.

5. Under **Install**, click **Copy** or **Download** (`tenant-start.env` for Kubernetes, `fabric-edge.env` for VM).

6. On a machine that can reach your cluster or VM:
   - `git clone https://github.com/abluva/secure-agent-net.git`
   - Put the downloaded **`ca.crt`** and Install **env file in the same directory as the `.sh` script** you will run. The env file’s `CA_CERT_FILE=./ca.crt` expects `ca.crt` next to that script — not in Downloads.
     - Kubernetes: place both in `secure-agent-net/connect-agent/kubernetes/` (next to `tenant-start.sh`)
     - VM: place both in `secure-agent-net/connect-agent/vm/k3s-appliance/` (next to `install.sh`)
   - Open the env file and set `BOOTSTRAP_TOKEN` if it is not already filled.
   - From that directory:
     - Kubernetes: `chmod +x tenant-start.sh` then `./tenant-start.sh ./tenant-start.env`
     - VM: `chmod +x install.sh` then `sudo ./install.sh` (loads `./fabric-edge.env`)

   This installs the **Connect Agent** only. The **launcher** is deployed in a later step, after the Agent is Connected and the listen port is known.

7. Wait until the Connect Agent is **Connected** (Approve if it shows PendingApproval).

8. Still on **Connect Agent** → **Install** → click **Refresh** and note **`CONTROL_SERVER_LISTEN_PORT`** (or read it from the cluster):

```bash
kubectl -n <tenant-namespace> get svc connect-agent \
  -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
```

   Use the port for PLATFORM registration `display_name=control-server`.

9. Deploy the **launcher** from `secure-agent-net/agent/` (same folder as `deploy-agent.sh` and `agent-deployment.yaml`):

```bash
chmod +x deploy-agent.sh
# Kubernetes:
./deploy-agent.sh -t <TENANT_ID> -e <ENVIRONMENT_ID> -m <LOGIN_EMAIL> -p <CONTROL_SERVER_LISTEN_PORT>
# VM / k3s appliance:
KUBECTL="k3s kubectl" ./deploy-agent.sh -t <TENANT_ID> -e <ENVIRONMENT_ID> -m <LOGIN_EMAIL> -p <CONTROL_SERVER_LISTEN_PORT> --vm
```

   The script writes `deploy-agent.env` (tenant, env, email, port) and applies the launcher (`INFRA_BASE_URL` → `connect-agent:<port>`, `X_ABLV_PRINCIPAL` → email).

10. Stay on **Connect Agent** → **Customer registrations** → **Add registrations**.
   - **agent-launcher**: Host `agent-svc`, Port `5004`
   - **data-privacy**: Host `data-privacy-svc`, Port `8080` (only if you deploy privacy yourself; it is not applied by the installer)
   - VM with processes on the host: use `127.0.0.1` and the same ports. Do not use a URL path.
   - Click **Create** (enabled only when the Agent is Connected).
   - After success, copy the platform dial target from the list, for example:  
     `agent-launcher: Active → agent-launcher.<tenant-id>.connect.abluva.com:8444`  
     Do **not** put form host/port (`agent-svc:5004`) in platform resource config.

11. Open **Resources** → **Register Resource** (create launcher resource).
   - Resource type: `agent#https`
   - Authentication: **Credentials**
   - From the Connect Agent tab **agent-launcher** line, set:

```json
{
  "base_url": "https://agent-launcher.<tenant-id>.connect.abluva.com:8444",
  "endpoint": "api/v1/launcher/create"
}
```

   (`base_url` = `https://` + the `host:port` shown on the Connect tab. Full path: `{base_url}/api/v1/launcher/create`.)

   Click **Create Resource**.

12. Mark this task complete.

For more detailed steps, see [`deploy/secure-agent-net.README.md`](../deploy/secure-agent-net.README.md) and the public installer repo: https://github.com/abluva/secure-agent-net
