# Abluva Fabric — Connectivity Platform

Config-driven Hybrid SaaS connectivity: Connect Agent, Gateway (Ghostunnel),
Fabric control plane, Ambient/deploy manifests.

## Docs

| Doc | Role |
|---|---|
| `docs/Architecture-Resolutions.md` | Locked decisions |
| `docs/Operational-Runbook.md` | Day-0/1/N + verification |
| `docs/Day0-OCI-Secrets-Checklist.md` | OCI Day-0 checklist |
| `docs/Validation-Plan.md` | Unit + smoke harness matrix |
| `docs/Tenant-App-UI-Checklist.md` | Tenant UI companion surfaces |

## Layout

```text
connect-agent/          # Go — customer-side transport
gateway/                # Go — Ghostunnel + dispatch (authz)
control-plane/          # TypeScript — enroll / authz / registrations
connectivity-proto/     # Shared StreamOpen contract
deploy/                 # Platform + Agent manifests, Ambient, local smokes
docs/                   # Architecture + runbook
```

Secure Pack / `securepack-lease` is **not** in this tree (networking-focused upload).

## Design rules

- **Config-driven:** table names, prefixes, Access URL — no hard-coded prod secrets.
- **Secrets:** Access API for DB/vault; Day-0 secrets via setup scripts.
- **Gateway Ambient opt-out:** Ghostunnel hostPort; SaaS mesh uses PeerAuthentication PERMISSIVE.
- **Logging:** structured JSON with `tenant_id`, `registration_id`, `agent_id`, `stream_id`.
