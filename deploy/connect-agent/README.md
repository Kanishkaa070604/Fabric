# Connect Agent (Part A)

**Full setup guide:** [README.md](../secure-agent-net.README.md) at the repo root  
(when published to [secure-agent-net](https://github.com/abluva/secure-agent-net), that file is `README.md`).

This folder installs the **Connect Agent only**. The launcher is in [`../agent/`](../agent/) — use it only after the UI shows **Connected**.

| Part | Where | When |
|------|-------|------|
| **A** (you are here) | `kubernetes/` or `vm/k3s-appliance/` | First — UI Steps 1–5 |
| **B** | [`../agent/`](../agent/) | After UI is **Connected** — Steps 1–4 |

---

## Choose your flavor

| Flavor | Directory | Run |
|--------|-----------|-----|
| **Kubernetes** (existing cluster) | [`kubernetes/`](./kubernetes/) | `./tenant-start.sh ./tenant-start.env` |
| **VM / bare metal** | [`vm/k3s-appliance/`](./vm/k3s-appliance/) | `sudo ./install.sh` |

Same steps as the UI **Install** env download.

### Quick path (Kubernetes)

1. Clone repo → `cd connect-agent/kubernetes`
2. UI → **CA** → save `ca.crt` here  
3. UI → **Install** → save as `tenant-start.env` here (with `daemonset.yaml`)  
4. Set `BOOTSTRAP_TOKEN`  
5. `./tenant-start.sh ./tenant-start.env`  
6. Wait for UI **Connected** → continue in [`../agent/`](../agent/)

### Quick path (VM)

1. Clone repo → `cd connect-agent/vm/k3s-appliance`
2. UI → **CA** → save `ca.crt` here  
3. UI → **Install** → save as `fabric-edge.env` here  
4. Set `BOOTSTRAP_TOKEN`  
5. `sudo ./install.sh`  
6. Wait for UI **Connected** → continue in [`../agent/`](../agent/)

More detail: [`vm/k3s-appliance/README.md`](./vm/k3s-appliance/README.md).

---

## Other paths (optional)

| Path | What |
|------|------|
| [`vm/systemd/`](./vm/systemd/) | Single-binary VM fallback (prefer k3s appliance) |
| [`ecs/`](./ecs/) | ECS (coming soon) |
| `enable-oidc-*.sh` | OIDC prep on the customer cluster (after Connect is up) |

---

## Reference — ACL packaging

Architecture-Spec §14: customer-local hop ACL templates per substrate.

| Substrate | Artifact | Status |
|---|---|---|
| Kubernetes | [`kubernetes/networkpolicy-example.yaml`](./kubernetes/networkpolicy-example.yaml) | Shipped (applied by installer unless skipped) |
| ECS | [`ecs/security-group.example.json`](./ecs/security-group.example.json) | SG only |
| VM | k3s appliance NetPol / systemd host-firewall examples | Shipped |

### Kubernetes identity & Service (detail)

Agents dial **out** to the Platform Gateway (no inbound MetalLB / Skupper required).

Default identity: `FABRIC_IDENTITY_STORE=kubernetes` — leaf + keys in a per-node Secret (`connect-agent-identity-<node>`). Survives pod deletes and DaemonSet rollouts. Legacy `file` + `hostPath` exists for older installs only.

The DaemonSet ships a `Service` reconciled by the Agent (`FABRIC_K8S_SERVICE_MANAGE_ENABLED=1`) so apps dial `connect-agent.<namespace>.svc:<port>`. Ports start at `FABRIC_LISTEN_BASE_PORT` (default **9443**). After Connected, UI Install → **Refresh** exposes `CONTROL_SERVER_LISTEN_PORT` for the launcher (`deploy-agent.sh -p`).

Do **not** apply `networkpolicy-agent-ingress-optional.yaml` on k3s/kube-router by default — a second NetPol on `app=connect-agent` can REJECT `:9443+`.

Skipping NetworkPolicy does not break the tunnel; it only weakens customer-side isolation. Skipping Service RBAC still allows the first registration via the shipped Service, but further ports may need manual wiring.

### VM systemd fallback

See [`vm/systemd/`](./vm/systemd/) — loopback listen + host-firewall examples. Prefer [`vm/k3s-appliance/`](./vm/k3s-appliance/) for production VMs.
