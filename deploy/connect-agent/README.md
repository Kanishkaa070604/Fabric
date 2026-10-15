# Connect Agent (Part A)

**Full setup guide:** [`../secure-agent-net.README.md`](../secure-agent-net.README.md)  
(when published to [secure-agent-net](https://github.com/abluva/secure-agent-net), that file is `README.md`).

This folder is **Part A**. Continue in [`../agent/`](../agent/) only after the Agent is ready  
(Install → **Refresh** shows `CONTROL_SERVER_LISTEN_PORT`, or Customer registrations → **Create** is enabled).

| Part | Where | When |
|------|-------|------|
| **A** (you are here) | `kubernetes/` or `vm/k3s-appliance/` | First — Steps 1–4 |
| **B** | [`../agent/`](../agent/) | After Agent is ready — Steps 1–4 |

---

## Choose your flavor

| Flavor | Directory | Env file | Run |
|--------|-----------|----------|-----|
| **Kubernetes** | [`kubernetes/`](./kubernetes/) | `tenant-start.env` | `./tenant-start.sh ./tenant-start.env` |
| **VM / bare metal** | [`vm/k3s-appliance/`](./vm/k3s-appliance/) | `fabric-edge.env` | `sudo ./install.sh` |

### Quick path (Kubernetes)

1. Clone repo → `cd connect-agent/kubernetes`
2. UI → **CA** → save `ca.crt` here  
3. **Generate token** (auto-fills Install env; if you left the page and see `<BOOTSTRAP_TOKEN>`, Generate again) → save as `tenant-start.env` here  
4. `./tenant-start.sh ./tenant-start.env`  
5. When ready → continue in [`../agent/`](../agent/)

### Quick path (VM)

1. Clone repo → `cd connect-agent/vm/k3s-appliance`
2. UI → **CA** → save `ca.crt` here  
3. **Generate token** (same auto-fill rules) → save as `fabric-edge.env` here  
4. `sudo ./install.sh`  
5. When ready → continue in [`../agent/`](../agent/)

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

Agents dial **out** to the Platform Gateway.

Default identity: `FABRIC_IDENTITY_STORE=kubernetes` — leaf + keys in a per-node Secret.  
The DaemonSet ships a `Service` reconciled by the Agent so apps dial `connect-agent.<namespace>.svc:<port>`.  
Ports start at `FABRIC_LISTEN_BASE_PORT` (default **9443**). After the Agent is ready, UI Install → **Refresh** exposes `CONTROL_SERVER_LISTEN_PORT` for `deploy-agent.sh -p`.

Do **not** apply `networkpolicy-agent-ingress-optional.yaml` on k3s/kube-router by default.

### VM systemd fallback

See [`vm/systemd/`](./vm/systemd/). Prefer [`vm/k3s-appliance/`](./vm/k3s-appliance/) for production VMs.
