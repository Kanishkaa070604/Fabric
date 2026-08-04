# Abluva Fabric — Connectivity Platform

Config-driven, modular implementation of the Hybrid SaaS connectivity architecture.

## Docs (source of truth)

| Doc | Role |
|---|---|
| `docs/Architecture-Spec.docx` | L1 architecture |
| `docs/L2-Design.docx` | Operational model / state machines |
| `docs/Architecture-Resolutions.md` | Locked decisions (pathways, Ghostunnel, approvals) |
| `docs/Level-3-Store-OIDC-Spec.md` | Postgres + OIDC + Access API |
| `docs/Level-3-Tickets.md` | Build tickets |
| `docs/Operational-Runbook.md` | Day-0/1/N with **verification checks** |

## Layout

```text
connect-agent/          # Go — customer-side transport only (ADR-007)
gateway/                # Go — Ghostunnel sidecar + dispatch (authz sole point)
control-plane/          # TypeScript + Sequelize — Controllers / APIs
connectivity-proto/     # Shared StreamOpen contract
deploy/                 # Manifests, Ghostunnel config, install-bundle templates
docs/                   # Architecture + runbook
```

## Design rules

- **Config-driven:** table names, prefixes, Access URL, vault prefix, audiences — no hard-coded env secrets.
- **Secrets:** Access API → OCI (`keys#database`, `data-privacy#secrets-manager`). Stubbed until R1/R2 response samples.
- **Pluggable:** Destination Adapters, evidence verifiers, Access client behind interfaces.
- **Logging:** structured JSON with `layer`, `component`, `tenant_id`, `registration_id`, `agent_id`, `stream_id`, `correlation_id` on every hop.

## Status

Scaffold + runbook first. Access client returns `ErrNotConfigured` until R1/R2 are provided.
