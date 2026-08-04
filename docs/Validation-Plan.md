# Validation plan — Fabric pathways (k3d + compose + Ambient)

Goal: exercise real pathways on the laptop harness. Status = **script exit
codes only** (use `bash` + `set -o pipefail` when piping to `tee` — otherwise
`tee` can hide a failed smoke).

Pairs with: `Operational-Runbook.md`, `Connectivity-Technical-Guide.md`,
`Developer-Reference.md`, `Tenant-App-UI-Checklist.md`, `Level-3-Tickets.md`,
and `PRODUCTION-READINESS.md` (locked D1–D8 + ship bar). Update this Results
table after each run — ticket **Done** claims require smoke/test proof.

---

## Clusters (light footprint)

| Cluster / stack | Role | Smokes |
|---|---|---|
| host `deploy/local` compose | Platform CP + Gateway + Ghostunnel | `smoke.sh`, `smoke-lifecycle.sh` |
| `k3d-fabric-edge` | **Tenant** (Connect Agent only) | `smoke-k3d-tenant.sh`, `smoke-k8s-service.sh` |
| `k3d-fabric-platform` | **Platform** Ambient / ztunnel | `smoke-ambient.sh`, `smoke-dns-lease.sh` |

**Removed:** `k3d-secure-ai-plane` (heavy unrelated product stack). Do not recreate it
for Fabric validation.

```bash
# One-time (or after wipe)
k3d cluster create fabric-edge --servers 1 --agents 0 --kubeconfig-update-default
k3d cluster create fabric-platform --servers 1 --agents 0 --kubeconfig-update-default   # Ambient
```

Pin tenant smokes: `K3D_CLUSTER=fabric-edge` (default) /
`FABRIC_TENANT_KUBE_CONTEXT=k3d-fabric-edge`. Never reuse Ambient’s `KUBE_CONTEXT`
for Agent.

On a laptop: **stop** the unused cluster while the other suite runs (platform
while tenant smoke; tenant while Ambient/DNS) if apiserver / Docker CPU flakes.

---

## Results (update after every run)

| Harness | Status | Covers |
|---|---|---|
| Control-plane `npm test` + `tsc` | **PASS** (2026-07-27) — 72 tests / 16 suites | Unit + types |
| Gateway `go test -race ./...` | **PASS** (2026-07-27) | authorize, pinbound, quota, session, terminate |
| Connect-agent `go test -race ./...` | **PASS** (2026-07-27) | k8ssvc, watch, … |
| `smoke.sh` | **E2E PASS** (2026-07-27, post-refactor confirmed) | Ghostunnel + PROXY + SequelizeStore + certExpiryScan new defaults (6h/48h) |
| `smoke-lifecycle.sh` | **E2E PASS** (2026-07-27) | Retire + SIGTERM drain |
| `smoke-k3d-tenant.sh` | **E2E PASS** (2026-07-27) — full day-0/1/N; saw `agent_api_token_pulled` + 1h refresh; cert rotate OK after Ready-pod poll fix | Day-0/1/N, AGT-02, Agent API seed+pull+reuse, cert rotate, DNS, quotas, revoke |
| `smoke-k8s-service.sh` | **E2E PASS** (2026-07-27) | Service ports for 2 regs |
| `smoke-ambient.sh` | **E2E PASS** (2026-07-27) — A1/B1 after ztunnel/workload recycle post cluster-start; waypoint CRDs absent (L7 optional) | A1/B1 ztunnel L4 |
| `smoke-dns-lease.sh` | **E2E PASS** (2026-07-27) — wait for live holder pod before delete | Lease failover |
| Cert auto-rotation unit coverage | **PASS** (2026-07-27) — `certlife_test.go`: fresh cert skips rotation, past-threshold triggers rotation via fake CP server, `RotateLeaf` persists through `identity.Store`, `Enabled()`/`ParseCheckInterval()` defaults | D3-AUTO trigger logic, `identity.Store` integration |
| `identity.Store` unit coverage | **PASS** (2026-07-27) — `identity/file/file_test.go` (round-trip, cert-loss `ErrNoIdentity`, stable `Paths()`), `identity/k8ssecret/k8ssecret_test.go` (cold-cache fallback to Secret, merge-patch never clobbers unrelated keys, per-node naming) | `identity.Store` interface, both shipped implementations |
| `enroll.Method` / enroll unit coverage | **PASS** (2026-07-27) — `enroll/bootstrap/bootstrap_test.go` (Credentials, shared `Enroll()` HTTP call, CSR generation) | `enroll.Method` interface, bootstrap-token implementation |
| `ensureIdentity` regression coverage | **PASS** (2026-07-27) — `cmd/connect-agent/main_test.go`: pre-minted cert binds by fingerprint (not CSR) — direct regression test for `smoke-lifecycle.sh`'s scenario; fresh install generates CSR; existing identity skips enroll; fail-closed with no cert and no enroll method | The exact `smoke-lifecycle.sh` fingerprint-bind path that a naive "always generate a CSR" rewrite would have broken |
| `smoke-lifecycle.sh` | **E2E PASS** (2026-07-28, post-refactor) — both scenarios green: Scenario 1 (Retired force-close + fingerprint-bind) PASS, Scenario 2 (SIGTERM drain) PASS after harness fix (stop_grace_period + graceful assertion for code=000 Docker kill race) | Retire + SIGTERM drain |
| `smoke-k3d-tenant.sh` re-run against refactored Agent | **NOT COMPLETED** (2026-07-28) — k3d image import (`docker save` → containerd) hangs under Docker Desktop macOS resource pressure on this machine. The script reaches "build + import connect-agent:local" then stalls for 10+ minutes at the tarball import step. Infrastructure constraint, not a code issue. **Must re-run on a machine with faster Docker I/O before shipping.** All code paths this test exercises are unit-tested (main_test.go) and the simpler compose tests (smoke.sh, smoke-lifecycle.sh) that use the same Agent binary both pass. |

**Harness fixes landed while validating (2026-07-27):**

- `smoke-k3d-tenant.sh` — poll Ready pod for `cert_rotated` (avoid terminating twin).
- `smoke-dns-lease.sh` — require Lease `holderIdentity` to match a live pod before delete.

**Ghostunnel CRL:** **By design** — not a product need (Gateway revoke only).

**Not local:** ECS GA, live OCI NLB `terraform apply`, live Access B1 secrets, dedicated Secret-store identity-survival smoke (recommended — prove DaemonSet rollout keeps `agent_id` via K8s Secret without re-approve).

---

## 0) Smoke edits vs production — what is real, what is harness-only

Smoke scripts **must not** teach production to lie. Split:

### Harness-only (OK — not production code)

| Smoke workaround | Why it is not a product stub |
|---|---|
| `FABRIC_SMOKE_*` listener / observed override | Explicitly documented as smoke-only; Agent production path uses watch.Manager |
| `hostAliases` + `REPLACE_HOST_GW_IP` | Laptop DNS quirk (k3d → Docker Desktop host). Prod uses real DNS / VPC |
| `FABRIC_TENANT_KUBE_CONTEXT` pin | CI/laptop multi-cluster footgun; prod has one kubeconfig per cluster |
| `FABRIC_SMOKE_SKIP_PLATFORM` / `FABRIC_SMOKE_SKIP_AGENT_BUILD` | Laptop reuse of already-up compose / imported image; prod always rebuilds/redeploys deliberately |
| Compose bearer `fabric-local-dev-token` | Local auth stand-in; prod uses real tokens/secrets |
| `ABLV_ACCESS_URL=http://127.0.0.1:9/...` | Intentionally dead Access stub for local B1 secrets — **known gap**, staging must use real Access |
| SQL `UPDATE … state='Failed'` then `POST …/retry` | Forces Failed edge with no HTTP transition API — tests retry path; prod Failed comes from real probe/update failures |
| `hostPath` for agent-1 smoke identity | **Harness-only** — smoke uses `hostPath` for simplicity (local k3d, no real Secret RBAC). Production default is `FABRIC_IDENTITY_STORE=kubernetes` (per-node K8s Secret). Agent-2 in smoke keeps `emptyDir` on purpose so day-1c can still prove wipe → re-enroll |

### Real product signals the smoke failures taught us (do not “paper over” in prod)

| Failure we hit | Production lesson |
|---|---|
| Wrong kubectl context → Agent on Platform cluster | Ops must never install Connect Agent on Platform Ambient cluster (Runbook) |
| Missing `control_plane_token` in Secret | Secret key holds the **scoped Agent API token** (`POST …/agent-api-token`), not the writer bearer. Required whenever CP auth is on (L3-CTL-01a) |
| Agents list is `{agents:[…]}` not a bare array | Client/UI must use the documented API shape |
| API CPU starve / TLS timeouts under load | Size Platform/tenant nodes; don’t co-locate heavy unrelated workloads with Agent tests. On laptop: stop `k3d-fabric-platform` while running `smoke-k3d-tenant.sh` if apiserver OpenAPI/port-forward flakes |
| CP recreate race (`smoke.sh` exit 7) | Readiness probes / wait-for-healthy before traffic (compose + K8s) |
| Ambient A1 timeout right after `k3d cluster start` | Recycle ztunnel + workload Deployments before blaming product; HBONE needs healthy dataplane after stop/start |
| Docker buildx hung after successful image export | Import already-built `connect-agent:local` with `k3d image import`; use skip flags if needed |

**Rule:** if a fix would change Gateway/Agent/CP *behavior* to make a flaky laptop pass, reject it. Prefer fixing manifests, docs, readiness, or the harness.

---

## 1) Config: comments + sensible defaults

Production defaults live in:

- `deploy/control-plane/deployment.yaml` (DNS reconcile + Lease on; cert-expiry scan; heartbeat 90s)
- `deploy/gateway/deployment.yaml` (replicas 2; drain grace 3m; Ghostunnel shutdown aligned)
- `deploy/connect-agent/daemonset.yaml` (CA-only Secret; **K8s Secret identity** `FABRIC_IDENTITY_STORE=kubernetes`; Service manage; token refresh 1h)
- `deploy/local/docker-compose.yml` (local only — tokens, Access stub)

Expectations:

- Unset env → safe default or **fail closed** (e.g. DNS Lease refuses to start without SA).
- Local compose may set explicit tokens; production pulls from Secrets.
- Comment every non-obvious `FABRIC_*` in compose/manifests (why it exists, prod vs local).
- CP `FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL` stays **off** for v1 (D4-A) — Agents self-refresh.

Gaps to watch: Access URL stub in compose must never ship to prod manifests.

---

## 2) Logging + failure handling (multi-layer)

Structured logs exist with `layer` / `component` / correlation where wired:

| Layer | Examples |
|---|---|
| CP | `agent_enrolled`, `bootstrap_token_redeemed`, `agent_api_token_reused`, `dns_reconcile_tick_failed`, `http_handler_error` |
| Gateway | `agent_tunnel_accepted`, `stream_accepted`, `tunnel_force_close`, revoke push |
| Agent | `enroll_submitted`, `agent_api_token_pulled`, `tunnel_ready`, `tunnel_disconnected`, `listener_started`, reconnect backoff |

**Still hard in incidents** unless operators correlate:

1. Tenant + agent_id + registration_id + cert_fp across CP ↔ Gateway ↔ Agent
2. Distinguish **UNAUTHORIZED** vs **RETRY_LATER** vs dial timeout
3. DNS: leader identity + tick skip vs webhook HTTP failure

Smoke proves *effects*; it does not replace a runbook of “which log line on which component.” Prefer improving **stable msg keys** over adding noise. Ops narrative: `Operational-Runbook.md` Troubleshooting.

---

## 3) DB state / rows — what smoke already asserts

`smoke-k3d-tenant.sh` hits Postgres (`db_q` / `assert_db_*`), not only HTTP:

| Check | Table / field |
|---|---|
| Agent Connected after approve | `ablv_agents.state` |
| Agent row count / two Connected | `ablv_agents` |
| Observed reachable true/false | `ablv_registrations.observed` JSON |
| Failed → retry | force `state='Failed'`, then API → Active + generation |
| Degraded ↔ Connected | `last_heartbeat_at` age → watchdog |
| Cert revoke persisted | `ablv_tenant_connect.revoked_cert_fingerprints ? fp` |

**Not fully asserted in smoke (gaps):** registration soft-delete `deleted_at`, suspend flags on tenant row after API, DNS file contents vs DB Active set byte-for-byte, audit columns `updated_by`, DaemonSet Secret-store identity survival across image rollout (recommended follow-up smoke — prove `agent_id` persists in K8s Secret after image rollout without re-approve). Prefer adding asserts over trusting HTTP alone when Day‑N mutates state.

---

## Reconfirm (full laptop suite)

```bash
# Prefer bash for PIPESTATUS / pipefail when using tee
cd deploy/local && FABRIC_CONTROL_PLANE_TOKEN=fabric-local-dev-token ./smoke.sh && ./smoke-lifecycle.sh

# Free platform cluster CPU if needed: k3d cluster stop fabric-platform
cd k3d
K3D_CLUSTER=fabric-edge FABRIC_TENANT_KUBE_CONTEXT=k3d-fabric-edge \
  FABRIC_K3D_HOST=host.docker.internal ./smoke-k3d-tenant.sh
FABRIC_TENANT_KUBE_CONTEXT=k3d-fabric-edge ./smoke-k8s-service.sh

# Free tenant cluster CPU if needed: k3d cluster stop fabric-edge
k3d cluster start fabric-platform
export KUBE_CONTEXT=k3d-fabric-platform
./ambient/smoke-ambient.sh    # FABRIC_AMBIENT_WAYPOINT=0 if Gateway CRDs absent
./smoke-dns-lease.sh
```

Sign-off: `Operational-Runbook.md` → Sign-off sheet.
