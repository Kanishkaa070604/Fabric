# Local smoke stack

This directory runs a laptop-friendly Fabric slice:

1. Postgres with stub `ablv_tenants` + Fabric tables  
2. Control plane with **SequelizeStore** (`FABRIC_STORE=postgres`, `FABRIC_DATABASE_URL`)  
3. Gateway + **Ghostunnel v1.11.1-distroless** with `--proxy-protocol-mode=tls-full`

## Quick start

```bash
cd deploy/local
chmod +x gen-certs.sh smoke.sh
./smoke.sh
```

What `smoke.sh` checks:

- Control plane `/healthz`
- `deploy/scripts/api-smoke.sh` against Postgres-backed APIs (enroll / G-BOOT-1 / approve / registration)
- mTLS client dial to Ghostunnel on `127.0.0.1:18443`
- Gateway logs contain `agent_tunnel_accepted` and the Agent certificate SHA-256 fingerprint

Tear down:

```bash
docker compose down -v
```

## Notes

- Works on **macOS and Linux** (incl. OCI aarch64). Shared helpers: `deploy/local/lib.sh` (`cert_sha256`, host aliases). Compose adds `host.docker.internal:host-gateway` so Gateway can dial host ports on Linux Engine; k3d Agent manifests use `host.k3d.internal`.
- `FABRIC_ENSURE_SAAS_TENANT=1` inserts stub rows into `ablv_tenants` for local FK satisfaction. Do **not** enable that in production SaaS databases.
- Production control plane should use Access API (`keys#database`) and leave `FABRIC_DATABASE_URL` unset.
- Ghostunnel must stay on **≥ v1.10.0** for `--proxy-protocol-mode=tls-full`.

## Other smokes

| Script | Proves |
|---|---|
| `./smoke.sh` | compose API + Ghostunnel dial |
| `./smoke-lifecycle.sh` | Retired-agent force-close + Gateway SIGTERM drain under live load |
| `k3d/smoke-k3d-tenant.sh` | customer k3d ↔ host platform (A2/A3/A4/B3, quotas, suspend, revoke) |
| `k3d/ambient/smoke-ambient.sh` | Platform-only A1/B1 via ztunnel (+ optional waypoint) |
