# Place verified scripts here after they pass once.

Ops vs UI split: Platform Day 0 = scripts; Tenant Day 1 = UI + install
manifests; Day‑N = UI-first. See `docs/Operational-Runbook.md`,
`docs/Tenant-App-UI-Checklist.md`, and the pathway matrix in
`docs/Validation-Plan.md`.

| Script | Purpose |
|---|---|
| [`api-smoke.sh`](./api-smoke.sh) | Control-plane enroll / G-BOOT-1 / approve / registration |
| [`../local/smoke.sh`](../local/smoke.sh) | Postgres SequelizeStore + Ghostunnel v1.11.1 mTLS identity |
| [`../local/smoke-lifecycle.sh`](../local/smoke-lifecycle.sh) | Retired force-close + Gateway SIGTERM drain |
| [`../local/k3d/smoke-k3d-tenant.sh`](../local/k3d/smoke-k3d-tenant.sh) | Tenant k3d ↔ compose: AGT-02, Failed retry, pathways, Day‑N |
| [`../local/k3d/ambient/`](../local/k3d/ambient/) | Platform Ambient A1/B1 local smoke |
| [`../platform/ambient/`](../platform/ambient/) | Platform Istio Ambient (ztunnel required; waypoint optional) |
| [`../connect-agent/`](../connect-agent/) | Per-substrate ACL packaging: K8s NetworkPolicy, ECS security group, VM systemd + host-firewall (L3-ACL-01..03) |
