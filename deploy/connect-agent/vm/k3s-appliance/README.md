# k3s Appliance Installer

Single-command installer for VM / bare-metal customers. Turns a Linux host
into a Fabric-connected appliance by installing k3s underneath and deploying
the Connect Agent as a DaemonSet inside it.

## Why k3s (even for a single Agent)?

| Without k3s (plain systemd) | With k3s |
|---|---|
| Process-alive restart only | Liveness + readiness probes |
| No resource limits | CPU/memory limits enforced |
| Stop-then-start updates | Rolling zero-downtime updates |
| Separate identity file management | K8s-Secret-based identity (same as full K8s) |
| Different packaging path | Same manifests as K8s customers |

## Usage

Place downloaded **`ca.crt`** and **`fabric-edge.env` in the same directory as
`install.sh`** before running (paths like `CA_FILE=./ca.crt` are relative to
that directory). After Agent Connected, deploy the launcher from
`deploy/agent/` — see [`../../agent/README.md`](../../agent/README.md) and
[`../../../docs/Customer-Connect-Install.md`](../../../docs/Customer-Connect-Install.md).

`--ca-url` points at `GET /v1/ca-bundle` on the control plane — shipped,
unauthenticated by design (a CA certificate is trust-anchor material meant
to be distributed, not a secret; the private key never leaves the
Platform). Use `--ca-file` instead if you'd rather ship the CA cert
pre-baked into the install bundle.

```bash
# Direct install (downloads k3s + deploys Agent):
curl -sSL https://install.fabric.abluva.io | sh -s -- \
  --token=<BOOTSTRAP_TOKEN> \
  --gateway=fabric.platform.example.com:8443 \
  --control-plane=https://cp.platform.example.com \
  --tenant-id=<TENANT_UUID> \
  --ca-url=https://cp.platform.example.com/v1/ca-bundle

# Or from a local copy with an env file:
./install.sh --env-file=./fabric-edge.env

# Custom Agent image:
./install.sh --env-file=./fabric-edge.env --image=registry.example.com/connect-agent:v1.2.3
```

## After Install

```bash
# Status
k3s kubectl -n fabric-edge get pods

# Logs
k3s kubectl -n fabric-edge logs -l app=connect-agent --tail=50

# Approve in UI, then create registrations
# Apps (as pods on this k3s) dial:
#   connect-agent.fabric-edge.svc.cluster.local:<port>
# Port map:
#   k3s kubectl -n fabric-edge get svc connect-agent \
#     -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}'
# Prefer CONTROL_SERVER_LISTEN_PORT from Connect UI Install (Fabric
# control-server.agent_listen_port) after Agent Connected → Refresh.
# Then deploy the launcher:
#   cd ../../../agent
#   KUBECTL="k3s kubectl" ./deploy-agent.sh -t <TENANT_ID> -e <ENV_ID> -m <EMAIL> -p <port> --vm
# (Host-OS apps need NodePort/hostPort — ClusterIP is in-cluster only.)
```

## Uninstall

```bash
/usr/local/bin/k3s-uninstall.sh
```

This removes k3s, its data, and all Fabric components cleanly.

## Manifests (same as Kubernetes)

| File in this directory | Points at |
|---|---|
| [`daemonset.yaml`](./daemonset.yaml) | symlink → [`../../kubernetes/daemonset.yaml`](../../kubernetes/daemonset.yaml) |
| [`networkpolicy-example.yaml`](./networkpolicy-example.yaml) | symlink → [`../../kubernetes/networkpolicy-example.yaml`](../../kubernetes/networkpolicy-example.yaml) |

`install.sh` renders that shared DaemonSet the same way as
`kubernetes/tenant-start.sh` (python3), then sets `FABRIC_SUBSTRATE=vm`.
Do **not** keep a divergent inline YAML in the installer.

## How It Works

1. Installs k3s with `--disable=traefik,servicelb,metrics-server` (minimal
   footprint — we don't need ingress or external load balancers on a
   single-host appliance)
2. Creates namespace `fabric-edge` + CA / bootstrap Secrets
3. Applies shared `daemonset.yaml` (Service + RBAC + DaemonSet, identity store
   `kubernetes`)
4. Applies shared `networkpolicy-example.yaml`
5. Waits for the Connect Agent pod to reach Running state

Launcher (`Deployment/agent`) is **not** part of this installer. After Agent
**Connected**, run [`deploy/agent/deploy-agent.sh`](../../../agent/deploy-agent.sh)
`-t … -e … -m … -p … --vm` (see [`deploy/agent/README.md`](../../../agent/README.md)).

The customer never needs to interact with k3s directly. `k3s kubectl` is
available for debugging, but the normal path is: install → wait until Agent
is **Connected** → deploy launcher → customer registrations
(`agent-svc:5004`) → apps dial `connect-agent.fabric-edge.svc…:<port>`.

## Environment File Format

See `fabric-edge.env.example`. Same variables as the K8s `tenant-start.env`,
just consumed by this installer instead.

## Requirements

- **Linux** host (amd64 or arm64). The appliance installer embeds **k3s**
  (Kubernetes) and deploys the Connect Agent as a DaemonSet — this is **not**
  the plain `systemd/` single-binary Agent path. Linux is required because
  **k3s** needs it (k3s registers a systemd unit under the hood). You still
  get K8s-Secret identity, probes, and rolling updates — same as full K8s.
- Root access (k3s install)
- curl
- Outbound TCP to the Gateway host:**port** in `FABRIC_GATEWAY_ADDRESS`
  (typically **8443**) and HTTPS to `FABRIC_CONTROL_PLANE_URL`
- ~60MB disk for k3s + ~100MB for Agent image

**Canonical E2E (OCI OKE Platform → Linux VM customer):**  
[`docs/Operational-Runbook.md`](../../../../docs/Operational-Runbook.md) →
**End-to-end: OCI (OKE) + Linux VM (k3s appliance)**.
