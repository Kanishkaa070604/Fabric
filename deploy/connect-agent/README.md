# Connect Agent install bundle — per-substrate ACL packaging (L3-ACL-01..03)

Architecture-Spec §14 item 1 ("customer-local hop ACL packaging") and item 7
("non-Kubernetes routing... not K8s-only") require real network-ACL templates
for every substrate the Agent runs on, not just the Kubernetes example this
directory originally shipped with. Status of each:

| Substrate | Ticket | ACL artifact | Status |
|---|---|---|---|
| Kubernetes | L3-ACL-01 | [`networkpolicy-example.yaml`](./networkpolicy-example.yaml) | Shipped |
| ECS | L3-ACL-02 | [`ecs/security-group.example.json`](./ecs/security-group.example.json) | Shipped (SG only — full task definition blocked on L3-POC-ECS, see [`ecs/README.md`](./ecs/README.md)) |
| VM / bare-metal | L3-ACL-03 | [`k3s-appliance/`](./k3s-appliance/) (recommended) or [`systemd/`](./systemd/) | **Shipped** — prefer k3s appliance (probes, limits, Secret identity). Runbook E2E: OCI + k3s |

## Kubernetes

**Customer pass-as-is installer:** [`tenant-start.sh`](./tenant-start.sh) +
[`tenant-start.env.example`](./tenant-start.env.example). Fill Day‑1 values
from the Connect UI (including Platform NLB as `FABRIC_GATEWAY_ADDRESS`), then
`./tenant-start.sh ./tenant-start.env`. This is Fabric equivalent of
[secure-agent-net `tenant-start.sh`](https://github.com/abluva-research/secure-agent-net/blob/main/agent/tenant-start.sh)
in *role* only — Fabric Agents dial **out** to the Platform NLB; there is no
Skupper site, MetalLB, or AccessToken redeem on the customer cluster.

**Identity (D2-NEW, shipped default):** the DaemonSet sets
`FABRIC_IDENTITY_STORE=kubernetes`, which persists the Agent's leaf cert,
private key, agent-id, and pulled API bearer in a **per-node Kubernetes
Secret** (`connect-agent-identity-<node-name>`). Identity survives pod
deletes, DaemonSet image rollouts, and node drains — no `hostPath`, no PSA
exception, no node-filesystem dependency. The local `emptyDir` mount at
`/var/run/abluva` is a **cache** only; the Secret is the source of truth.

Legacy fallback: `FABRIC_IDENTITY_STORE=file` (+ `hostPath` volume) is still
supported for clusters that were installed before D2-NEW shipped. New
installs should not use it — the Secret store is strictly better (same
survival guarantees without touching the node filesystem).

Templates underneath: `daemonset.yaml` + `networkpolicy-example.yaml`. The Agent
binds `0.0.0.0` inside its own pod network namespace (there is no loopback
boundary between pods to rely on); `networkpolicy-example.yaml` is the ACL,
restricting which pods may dial it.

The Agent opens one listener per Active registration starting at
`FABRIC_LISTEN_BASE_PORT` (default 9443), not a fixed pair of ports — widen the
policy's `endPort` (or list this tenant's actual registration count) to cover
`FABRIC_LISTEN_BASE_PORT .. FABRIC_LISTEN_BASE_PORT+N-1`. Same range concept the
ECS security-group example below parameterizes.

**Getting a customer app to that listener at all.** The ACL above only says
*who* may dial the Agent; it doesn't create anything a customer app can
actually dial by name. `daemonset.yaml` ships a `Service` for exactly that,
kept in sync by the Agent itself (`FABRIC_K8S_SERVICE_MANAGE_ENABLED=1`,
`connect-agent/internal/k8ssvc` + `internal/watch/service.go`) — not by the
control-plane, which is Platform-side and has no network path into this
cluster at all (Agent↔Platform is outbound-only). Every poll interval, the
Agent reconciles that one Service's port list to exactly match its own
current Active registrations, one port each, so a second/third/Nth
registration is reachable the same way the first one is:
`connect-agent.<namespace>.svc.cluster.local:<port>`. Two things worth
knowing:

- The Service always sets `internalTrafficPolicy: Local`, not optional —
  the Agent is a DaemonSet, and two nodes' Agent instances can legitimately
  assign the SAME registration a DIFFERENT port if they observed
  registration churn in different order/timing (ports are sticky/
  incremental per node, not a pure function of the current registration
  set — see `syncListeners`'s doc comment in `watch.go`). Without `Local`,
  a plain Service could route a connection to the wrong node's mapping.
- Which port belongs to which registration is discoverable without
  reading Agent logs: the Service carries a
  `fabric.abluva.io/registration-ports` annotation, a JSON map of full
  registration ID → port, e.g. `kubectl get svc connect-agent -o
  jsonpath='{.metadata.annotations}'`.

This requires the RBAC `daemonset.yaml` also ships (`Role`/`RoleBinding`,
scoped to `get`/`create`/`patch` on `Service` in this one namespace only) —
opt-in like the NetworkPolicy ACL, and with the same "residual risk if
skipped" posture below: omitting it doesn't break the tunnel/StreamOpen
path at all, it just means routing beyond the first registration is the
customer's own responsibility to wire (e.g. hand-writing a Service per
registration, or a customer-side controller).

## VM / bare-metal (`systemd/`)

Developer-Reference: the Agent "listens on loopback by default (`127.0.0.1`)... Host-firewall
templates in the install bundle must deny non-local dial to Agent ports."

- [`connect-agent.service`](./systemd/connect-agent.service) + [`connect-agent.env.example`](./systemd/connect-agent.env.example) — the unit; sets `FABRIC_LISTEN_HOST=127.0.0.1`.
- [`host-firewall-nftables.example.sh`](./systemd/host-firewall-nftables.example.sh) / [`host-firewall-ufw.example.sh`](./systemd/host-firewall-ufw.example.sh) — defense in depth: deny any non-loopback dial to Agent ports even if the loopback default is ever overridden.
- [`hosts-writer.sh`](./systemd/hosts-writer.sh) — optional `/etc/hosts` mapping so apps keep ordinary DNS names instead of hardcoding `127.0.0.1:<port>`.

## ECS

See [`ecs/README.md`](./ecs/README.md) — security-group template ships now; the full
task definition is intentionally still blocked on the L3-POC-ECS idle/recycle PoC.

## Residual risk if a customer skips these (L3-DOC-02)

Skipping the NetworkPolicy/SG/host-firewall step does not break connectivity — the
Agent still works — but it means **any** pod/task/process on that host or in that
namespace can dial the Agent's local listener ports directly, bypassing the intended
"only this workload may reach the Agent" boundary. The Gateway's own registration-level
authorization (ADR-002/007) is unaffected either way; this is purely a customer-side
network-hygiene control the Agent architecture assumes will be applied, not a second
authorization plane.

Skipping the Kubernetes Service RBAC (above) is a different kind of risk, not a
security one: connectivity for the tenant's *first* registration still works fine
(the placeholder Service `daemonset.yaml` ships covers it), but the Agent's
`k8s_service_reconcile_failed` log line will fire every poll interval, and any
registration beyond the first has no shipped way to become reachable by name at
all — the customer would need to hand-write additional Service objects (or their
own controller) to reach them.
