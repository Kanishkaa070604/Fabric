# k3d as tenant cluster, laptop docker-compose as platform

Dedicated light k3d cluster **`fabric-edge`** (default `K3D_CLUSTER=fabric-edge`)
runs the **Connect Agent**. The old `secure-ai-plane` cluster is **removed** —
do not recreate it for Fabric (it carried unrelated heavy workloads).

The host docker-compose stack is the **platform** (control-plane, Gateway, Ghostunnel, Postgres).

From inside this k3d (Docker Desktop), the host is reached as **`host.docker.internal`**
(ports `18080` / `18443` published by compose). Override with `FABRIC_K3D_HOST` if needed.

**Ops / UI alignment:** Platform Day 0 is scripts-only; Tenant Day 1 mixes UI
(control-plane) + manifests (Agent install); Day‑N is UI-first. See
`docs/Operational-Runbook.md` and `docs/Tenant-App-UI-Checklist.md`.  
**Full pathway matrix + harness-vs-prod notes:** `docs/Validation-Plan.md`.

## One-time cluster

```bash
k3d cluster create fabric-edge --servers 1 --agents 0 --kubeconfig-update-default
```

## Run

```bash
cd deploy/local/k3d
# Rebuild control-plane if you need CSR signing (L3-AGT-02): needs openssl + ca.key mount
(cd .. && docker compose build control-plane && docker compose up -d)
K3D_CLUSTER=fabric-edge FABRIC_TENANT_KUBE_CONTEXT=k3d-fabric-edge ./smoke-k3d-tenant.sh
```

What it proves (Tenant Day 1 / Day‑N):

1. k3d pod reaches host control-plane
2. Agent enrolls (CSR-in-enroll); tunnel up while `PendingApproval`
3. StreamOpen **denied** until approve (G-BOOT-1)
4. Approve → `Connected`; Gateway `agent_tunnel_accepted`; Postgres `ablv_agents.state`
5. StreamOpen **accepted** PLATFORM_SERVICE → DIRECT_ENDPOINT → host echo
6. CUSTOMER_SERVICE + `observed` reachable false → `DESTINATION_UNAVAILABLE`; true → CONNECT_AGENT hairpin + Agent inbound dial
7. **L3-AGT-02:** restore bootstrap token → second Agent on **same** window + **CA-only** Secret → two agent ids / two fingerprints → selection dials agent2; ECS-like pod delete re-enrolls; bootstrap **revoke** blocks further enroll
8. **L3-REG-01:** force `Failed` → `POST …/retry` → Active + generation bump; retry on Active rejected
9. **G-A3-1 inbound via CoreDNS:** dig `@127.0.0.1 -p 15353` → TLS SNI → CONNECT_AGENT
10. **Quotas:** `max_concurrent_streams=1` denies second open; `max_tunnels=1` denies extra tunnel
11. **Auth:** bearer required; dual-control for suspend/revoke/delete
12. **Degraded:** stale heartbeat → Degraded; heartbeat recovers Connected
13. Tenant suspend → deny; unsuspend → ok
14. Registration delete → deny; recreate + restart → ok
15. Pod restart reconnect → StreamOpen ok
16. Cert revoke → deny + force-close / agent reconnect recovery

Defaults (production-like):

- Keeps Postgres volume (`FABRIC_SMOKE_WIPE_DB=0`). Set `FABRIC_SMOKE_WIPE_DB=1` for a clean wipe.
- Fresh `FABRIC_SMOKE_TENANT_ID` UUID each run (avoids stale Connected agents across runs).
- Compose sets `FABRIC_CONTROL_PLANE_TOKEN` / `FABRIC_DUAL_CONTROL_TOKEN`, Agent CA files, and CoreDNS on `:15353`.

## Ambient / ztunnel (not in default smoke)

Default smoke platform is **docker-compose** — no Istio Ambient. That is enough for Gateway+Agent pathways (A2/A3/A4/B2/B3-style).

ztunnel is still **required in production** on the Platform Kubernetes cluster (A1, A2 after GW, A3 before GW, B1, B4). See:

- `deploy/platform/ambient/` — install / enroll / waypoint / verify
- `docs/Operational-Runbook.md` Step 7
- Optional local Platform K8s: `deploy/local/k3d/ambient/`
- Validation matrix C/D: `docs/Validation-Plan.md`

Never install Ambient on the tenant/Agent k3d cluster.

## Gaps that need a different harness

| Item | Where |
|---|---|
| DNS Lease election (in-cluster CP) | Platform k3d/OKE with `deploy/control-plane/deployment.yaml` |
| Agent Service reconciler multi-port | Drop `FABRIC_SMOKE_*`, set `FABRIC_K8S_SERVICE_MANAGE_ENABLED=1`, two Active regs |
| Quota `opens` sweep | `cd gateway && go test ./internal/quota` |
| Live Access API B1 secrets | Staging |
| ECS Fargate idle/recycle | `L3-POC-ECS` after Matrix A is green |

## Cleanup

```bash
kubectl delete ns fabric-edge
cd .. && docker compose down
rm -f /tmp/fabric-k3d-echo.pid
```
