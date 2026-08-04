# Platform Ambient (ztunnel + optional waypoint)

**Required Platform-side mesh** for Architecture-Spec §5.4 / §8 pathways that use ztunnel
(A1, A2 after Gateway, A3 before Gateway, B1, B4).

| Component | Role | Pathways |
|---|---|---|
| **ztunnel** (DaemonSet, `ambient-plane`) | L4 mTLS / transparent interception | A1, A2, A3, B1, B4 |
| **istio-cni** | Node interception without app privileges | all Ambient namespaces |
| **waypoint** (optional, per namespace) | L7 HTTP/gRPC retries, timeouts, circuit breaking | A1, A2, A3 only — **never** B1–B4 |
| **istiod** | Ambient control plane | Platform |

**Never** install Ambient / ztunnel / waypoint in Customer Environments (ADR-001).

## What this directory ships

| File | Purpose |
|---|---|
| `install-ambient.sh` | Fresh install (`istioctl` ambient profile); portable macOS + Linux/arm64; auto-sets k3s CNI paths |
| `enroll-namespaces.sh` | Label Platform namespaces for Ambient dataplane |
| `waypoint-apply.sh` | Optional waypoint for Service namespaces (L7) |
| `verify-ambient.sh` | Day-0 / day-n health checks |
| `namespace-labels.example.yaml` | Example labels + comments |
| `waypoint.example.yaml` | Example waypoint Gateway (Gateway API) |
| `psa-ambient-plane.example.yaml` | Privileged PSA scoped to `ambient-plane` only |

## Day-0 install (platform cluster)

```bash
# Pin version if your platform standard requires it:
#   export ISTIO_VERSION=1.24.2
./deploy/platform/ambient/install-ambient.sh

# Enroll namespaces that host Platform Services, Gateway, and Platform Connectors:
./deploy/platform/ambient/enroll-namespaces.sh fabric-control 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c

# Optional L7 for Service namespaces (skip pure batch/cron):
./deploy/platform/ambient/waypoint-apply.sh 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c

./deploy/platform/ambient/verify-ambient.sh
```

Full operator narrative: `docs/Operational-Runbook.md` Step 7.

## Pathway → Ambient mapping

| Pathway | ztunnel? | waypoint? |
|---|---|---|
| A1 Platform Service → Platform Service | Yes | Optional L7 |
| A2 … → Gateway → Platform Service | Yes (after Gateway) | Optional L7 |
| A3 Platform Service → … → Gateway | Yes (before Gateway) | Optional L7 |
| A4 / B2 / B3 | No | No |
| B1 Platform Service → Platform Resource | Yes | **No** |
| B4 Platform Service → … → Gateway | Yes | **No** |

## Hardening (Spec §5.4.1)

- Privileged PSA **only** for `ambient-plane` (ztunnel + CNI).
- All other Platform namespaces: restricted PSA.
- Drop unnecessary capabilities on non-ztunnel containers; treat `ambient-plane` as a distinct security zone.

## Local / laptop

Default `deploy/local` docker-compose + k3d smoke proves **Gateway + Agent** paths only.
Ambient requires a real Platform Kubernetes cluster (or optional k3d — see `deploy/local/k3d/ambient/`).
