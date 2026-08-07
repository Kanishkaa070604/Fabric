# Level-3 Implementation Tickets

## Purpose of this file

This is a **work-breakdown / ticket backlog**, not architecture.

It turns Spec §14 resolutions and L2 “remaining before build” items into trackable tickets (IDs, deliverables, build order). **It does not define pathways, ADRs, or hop chains.** If this file disagrees with `Architecture-Spec.docx` or `L2-Design.docx`, those Word docs win.

See `docs/README.md` for the full document map and frozen vocabulary.

Source of decisions (authority order):
1. `Architecture-Spec.docx` **§14 Risk Register — v1 Resolutions** (end of that Word doc)
2. `Architecture-Resolutions.md` (same decisions, readable in markdown)
3. Supporting detail in `L2-Design.docx`, `Developer-Reference.md` (+ `.docx` export),
   `Operational-Runbook.md`, `PRODUCTION-READINESS.md` (locked D1–D8)

> `Architecture-Resolutions.md` is the readable companion (decision register + Spec vs repo-only prose). The normative §14 text still lives in `Architecture-Spec.docx` — open that Word doc and scroll to **14. Risk Register — v1 Resolutions** when you need the Spec’s own wording. Pre-L3 Word skeleton archived as `Developer-Reference.pre-l3-skeleton.docx` — do not use for packaging.

---

## Implementation honesty (status vs code)

Last verified against code + unit tests + full local smoke suite on **2026-07-27**
(`npm test` / `tsc`, `go test -race` gateway+agent, `smoke.sh`,
`smoke-lifecycle.sh`, `smoke-k3d-tenant.sh`, `smoke-k8s-service.sh`,
`smoke-ambient.sh`, `smoke-dns-lease.sh` — see `Validation-Plan.md` Results).
Earlier honesty baseline: 2026-07-25. This table must never say "Done" unless the
code and a passing test/smoke both exist — that was the specific failure mode
that eroded trust before this pass.

**2026-07-24 second pass:** re-read `Architecture-Spec.docx` + `L2-Design.docx` in full (all paragraphs
and all 11 + 24 tables, not summaries) and traced every pathway (A1–A4/B1–B4) and every Part H failure
scenario against the running code line-by-line. Three real gaps were found; all three are fixed as of
this pass (rows below) — `L3-GW-06` (Registration Update) was the last one and is now **Done**.

**2026-07-25 bug-finding pass:** targeted review (not spec-vs-code this time) for race conditions,
pooling inaccuracies, memory leaks, and transport-pathway bugs — including simulating B3 against an
OCI-managed-Postgres-shaped destination and B2/B4 against an OpenSearch-shaped one. 9 real bugs found
across Gateway, Connect Agent, and control-plane; **all 9 fixed in this pass**, each with a green
`go test -race ./...` (gateway) / `go test ./...` (connect-agent) / `npm test` (control-plane) run
after its fix. One adjacent (not a regression, not in the original 9) limitation was newly surfaced
while fixing #4 below and is tracked as `L3-DNS-02` in §B rather than silently fixed, since fixing it
for real is a bigger scope item (leader election) than this pass's bug fixes. Full list:

| # | Severity | Bug | Fix |
|---|---|---|---|
| 1 | Critical | Every `relay()`/forwarding loop (`gateway/internal/session/handler.go`, `gateway/internal/pinbound/inbound.go`, `connect-agent/internal/listener/listener.go`, `connect-agent/internal/inbound/inbound.go`) returned as soon as the *first* of its two `io.Copy` directions saw EOF, letting the caller's deferred full `Close()` on both ends fire immediately and truncate whatever the *other* direction was still mid-flight sending. Real risk for exactly the pathways this pass simulated: a Postgres response finishing after the client's last query write, or an OpenSearch bulk/chunked response outliving the request write | All four now wait for **both** directions to finish, half-closing (`CloseWrite`, or plain `Close()` for `*yamux.Stream` — which yamux itself treats as a graceful local-close per its own `Read()` semantics) the destination of whichever direction finishes first, so the other keeps draining to its own natural EOF |
| 2 | High | Gateway's `Authorizer.AuthorizeStream` fanned one control-plane decision out into 6–7 separate `/v1/internal/authz-context` HTTP round trips (`IsRevoked`, `TenantSuspended`, `GetQuotaLimits` ×2, `GetRegistration`, `ListEligibleAgents`, plus a separate `AgentApproval` call from `handler.go`) even though that endpoint already returns every one of those fields in a single response. ~7x's control-plane load per `StreamOpen`/inbound-dial, and Sequelize's unconfigured pool (`max: 5`) had no headroom to absorb it | Added `Store.FetchAuthzContext` (single call) + `authorize.AuthzContext`; `AuthorizeStream`/`AuthorizeInbound`/`ReserveStream` now share one fetch per decision. Also gave `Sequelize` a real, configurable pool (`FABRIC_DB_POOL_MAX`, default 20) instead of the library default. Bonus fix found while collapsing this: a `FetchAuthzContext` transport failure now maps to `RETRY_LATER` (`authorize.ErrLookupFailed`) instead of being misreported as `UNAUTHORIZED` |
| 3 | High | `gateway/internal/session/handler.go`'s `ServeConn`: `agentID`, `tenantID`, and `ctx` were plain closed-over locals, written by the main goroutine (accept-time bind + `tryBind`'s poll path) and read every tick by the heartbeat goroutine with no synchronization — a data race on `ctx` (an interface value) can crash the process outright on a torn read, not just observe a stale value | Introduced `boundIdentity` (mutex-guarded triple); all reads/writes go through `.get()`/`.set()` |
| 4 | Medium | `control-plane/src/dns/reconciler.ts`: `setInterval` fired `tick()` on a fixed wall-clock schedule with no await, so a slow tick (DB scan + provider round trip) could still be running when the next timer fired, causing overlapping ticks — self-inflicted DB load, and for `FileDnsProvider` specifically, no ordering guarantee on which overlapping tick's atomic rename lands last (could revert to stale data) | Added a `tickRunning` guard: an in-flight tick is never joined by a second one; a tick that fires while the previous is still running is skipped (self-heals next tick) instead of queued. **Adjacent limitation surfaced, not fixed here:** this only serializes ticks *within one control-plane process* — running `FABRIC_DNS_PROVIDER=file` across multiple control-plane replicas writing the same path still has no cross-process ordering guarantee. Tracked as `L3-DNS-02` |
| 5 | Medium | `control-plane/src/http/server.ts`'s `readBody` accumulated request-body chunks with no size cap — any POST endpoint (there are ~10) was an unauthenticated-body-size OOM vector | Added `MAX_BODY_BYTES` (default 1MB, `FABRIC_HTTP_MAX_BODY_BYTES`); over-cap requests get `req.destroy()` + a new `PayloadTooLargeError` mapped to HTTP 413, not counted toward the endpoint's normal 500 path |
| 6 | Medium | `ablv_tenant_connect.revoked_cert_fingerprints` (JSONB array) grew by one entry on every certificate rotation/revocation forever, with no pruning, and was linearly `.includes()`-scanned on every `authz-context` read (i.e. every `StreamOpen`) — a tenant that ages and rotates certs over months/years degrades this hot-path check | Added `addRevokedFingerprint` (shared by `memory.ts` and `sequelize.ts`) capping the list to the most recent `MAX_REVOKED_CERT_FINGERPRINTS` (500) entries, dropping the oldest first — safe because an expired cert can never pass Ghostunnel's mTLS handshake to reach this check anyway. Tested: `control-plane/test/revoked_fingerprints.test.ts` |
| 7 | Low | `ServeConn`'s `AcceptStream` producer goroutine sent onto a capacity-1 channel with no way to abort; if `ServeConn` returned (e.g. `tryBind` denies the tunnel) right after the goroutine got a stream but before the main loop could receive it, that goroutine — and the yamux stream it held — leaked until the whole session eventually died | Added an `acceptDone` channel; the producer's send is now a `select` against it, closing/dropping its held stream and returning immediately if `ServeConn` has already exited |
| 8 | Low | `PlatformConnectorAdapter`/`DirectEndpointAdapter` (B3/A2 dials to OCI-managed-Postgres-shaped and other platform destinations) had no explicit dial timeout — a network black-hole (dropped SYN, no RST) could hang the dial on the OS-level default, holding an already-quota-reserved stream slot and goroutine open indefinitely | Added `DialTimeout` (default 10s, `FABRIC_DESTINATION_DIAL_TIMEOUT`) to both adapters, wrapping the dial context |
| 9 | Low | `connect-agent/internal/watch/watch.go`'s `syncListeners`: canceling a removed registration's listener context only *starts* its teardown; if a new registration was assigned that same now-"free" port in the same sync cycle, `net.Listen` could race the old socket's actual close and transiently fail with "address already in use" (self-healing after the ~1s retry backoff, but a real availability blip) | `listenerHandle` now carries a `stopped` channel closed only after the listener goroutine (and thus its `net.Listener.Close()`) has actually returned; `syncListeners` waits on it (bounded to 2s) before freeing/reassigning a port |

**2026-07-25 second bug-finding pass:** a separate written review (`bug`, not spec-vs-code) covering the
same three components independently re-confirmed items 1–3 above (half-close relay, authz-context
fan-out, `ctx`/`agentID`/`tenantID` race) and item 9 (port-reuse race, same fix already in place) — no
new action needed on those, already fixed above. It surfaced 4 findings genuinely new to this pass, not
covered by the first 9; **all 4 resolved**, again each with a green `npm test` (control-plane) /
`go build && go vet` (connect-agent) run after its fix:

| # | Severity | Bug | Fix |
|---|---|---|---|
| 10 | High | `control-plane/src/dns/webhookProvider.ts`'s `applied` map (the "what's live" set the upsert/delete diff is computed against) was in-process memory only. Across any routine control-plane restart, it reset to empty — a registration deleted while the process happened to be down produced no entry in the fresh `desired` set *and* no entry in the now-empty `applied` map, so the diff saw no discrepancy and never issued the `delete` call. The stale DNS record was left live indefinitely with no error, alert, or retry to ever catch it | `WebhookDnsProvider` now takes an optional `statePath` (wired to `FABRIC_DNS_WEBHOOK_STATE_PATH`, default `/var/run/fabric/dns-webhook-state.json`); `applied` is loaded from it at construction and durably persisted (atomic temp+rename, same pattern as `FileDnsProvider`) after every reconcile tick that changed anything. Unset `statePath` keeps the prior in-memory-only behavior (used by tests that don't care about restart survival). Tested: `control-plane/test/dns_reconciler.test.ts` (persists across a simulated restart; explicit no-`statePath` unchanged-behavior case). **This fixes single-process restart survival only — it does not make `WebhookDnsProvider` multi-replica-safe; that's a separate, real gap folded into `L3-DNS-02` below after independent review caught it** |
| 11 | Low (confirmed, tiny) | `memory.ts`'s `degradeStaleAgents` degraded an agent whose heartbeat was *exactly* at the staleness cutoff (`hb > cutoff ? skip : degrade`, i.e. `hb <= cutoff` degrades); `sequelize.ts`'s equivalent SQL used `Op.lt: cutoff` (strictly less than only) — a genuine, if astronomically low-probability (exact-millisecond-match), divergence between the two stores' behavior at that one instant, exactly the class of risk the review flagged even though it hadn't pinned down a concrete input where they disagreed | Extracted the rule into one pure function, `isAgentStale` (`control-plane/src/store/types.ts`), now the sole implementation `memory.ts` calls; `sequelize.ts`'s SQL changed to `Op.lte` to match it exactly, with a comment pointing back at `isAgentStale` as the definition it must track (SQL can't call the JS function directly, so this is a doc-comment-enforced invariant, not a shared-code one). New `control-plane/test/agent_staleness.test.ts` locks down the boundary (exact cutoff, ±1ms, null-heartbeat fallback, non-`Connected` states, deleted) so a future edit to either side has something concrete to fail against |
| 12 | Low | `connect-agent/cmd/connect-agent/main.go`: `certFP` was fingerprinted once at startup and only ever used for the `agent_running` log line thereafter. `tunnel.Dial` itself correctly reloads the certificate from disk on every dial (a mid-life rotation *is* picked up functionally), but every log line after a rotation kept reporting the original, now-stale fingerprint — actively misleading during an incident, since the Gateway logs its fingerprint live off the wire on every connection and an investigator cross-referencing the Agent's own logs would be looking at the wrong value | `certFP` is now recomputed from disk right after every successful `tunnel.Dial`, immediately before the `agent_running` log line, so it always reflects whichever certificate just authenticated the current tunnel |
| 13 | Info / hardening, not a confirmed bug | `control-plane/src/gatewayPush.ts`'s `FABRIC_GATEWAY_PUSH_URLS` is a static list — the review flagged (correctly, as an open question rather than a defect) that this silently goes stale across a rolling restart or scale event of the Gateway fleet if that's what it's actually configured with in a given deployment; this repo can't determine which topology any given deployment uses | Added an **additive, opt-in** alternative rather than guessing at anyone's actual topology: `FABRIC_GATEWAY_PUSH_DNS_NAMES` (e.g. a Kubernetes headless Service name) is re-resolved via `dns.lookup(..., {all:true})` on every push, so fleet membership is always current with no manual list maintenance; combinable with the existing static `urls`, deduped. Static-list-only deployments are entirely unaffected (default behavior unchanged). Tested: `control-plane/test/gateway_push.test.ts` |

**2026-07-25 third pass** (Kubernetes-specific, from a review of Connect Agent
DaemonSet packaging against `watch.go`'s actual dynamic per-registration port
allocation): 2 more real, related findings, both fixed:

| # | Severity | Bug | Fix |
|---|---|---|---|
| 14 | High | The Agent already opens one listener per Active registration (`watch.go`'s `syncListeners`, base port + N), but nothing turned that into something a customer app could actually dial by a stable name once a tenant had more than one registration: `deploy/connect-agent/daemonset.yaml` (production) shipped **no Service manifest at all**, and the one Service that did exist anywhere (`deploy/local/k3d/connect-agent.yaml`) was a single-registration smoke-test fixture, not a general mechanism. Confirmed no code anywhere (control-plane included) created/updated/deleted a Kubernetes Service. **Corrected scope from the original finding:** the fix cannot live in the control-plane's "Config Controller" as first proposed — the control-plane is Platform-side and has no network path into a customer's cluster at all (Agent↔Platform is outbound-only, ADR-001) — it has to live in the Agent itself, which already runs in-cluster with its own ServiceAccount | New `connect-agent/internal/k8ssvc` (a minimal, dependency-free in-cluster REST client — deliberately not `k8s.io/client-go`, whose dependency tree is large relative to the one operation needed) + `internal/watch/service.go`'s `buildDesiredService`/`reconcileService`, wired into `Manager.tick()` right after `syncListeners`. Every poll interval, reconciles **one shared Service** (not one per registration — fewer objects, same "full desired state each tick" shape as the DNS reconciler) whose port list always exactly matches the Agent's own current registrations; a `fabric.abluva.io/registration-ports` annotation exposes the full registration-ID→port mapping for discoverability (named Service ports are capped at 15 chars, too short for a UUID). Opt-in (`FABRIC_K8S_SERVICE_MANAGE_ENABLED`, default off) + new RBAC (`Role`/`RoleBinding`, `get`/`create`/`patch` on `Service` only) shipped in `daemonset.yaml`, same "residual risk if skipped" posture as the NetworkPolicy ACL template — omitting it doesn't break the tunnel/StreamOpen path, it just leaves routing beyond the first registration for the customer to wire some other way. Tested: `connect-agent/internal/k8ssvc/client_test.go` (patch/create/create-race/error paths against a fake API server), `connect-agent/internal/watch/service_test.go` (desired-state construction, port-name collisions, annotation contents, determinism) |
| 15 | High | Neither Service that existed (the new one from #14, nor the pre-existing local smoke one) set `internalTrafficPolicy: Local`. This isn't cosmetic: the Agent is a DaemonSet, and `syncListeners`' port assignment is sticky/incremental per node ("keep existing; new registrations get the lowest free port"), not a pure function of the current registration set — two nodes that observed the same registration churn in different order/timing can legitimately assign the SAME registration ID to a DIFFERENT physical port. Without `Local`, a plain Service can load-balance a connection to a node whose port↔registration mapping doesn't match the caller's intent, silently connecting to the wrong destination rather than just being slower. Confirmed this class of bug is Kubernetes-DaemonSet-specific: VM (loopback-only, one Agent process per host) and ECS (`awsvpc` shared network namespace, sidecar-local dial) substrates have no equivalent gap, since app and Agent are never on different nodes in either | `buildDesiredService` always sets `spec.internalTrafficPolicy = "Local"`, not conditionally; also added directly to the pre-existing `deploy/local/k3d/connect-agent.yaml` Service (a currently-harmless no-op there, single-replica `Deployment`, but kept for consistency so copying that file as a DaemonSet starting point doesn't silently drop it). Locked down by `TestBuildDesiredService_OnePortPerRegistration`'s explicit assertion |

**2026-07-25 fourth pass** (quota idle-tenant leak + state-machine / substrate /
DNS-coordination review):

| # | Severity | Bug | Fix |
|---|---|---|---|
| 16 | Low (slow unbounded growth) | `gateway/internal/quota/quota.go`'s `opens` map (sliding 1s stream-open rate window) never `delete()`d a tenant entry after that tenant went quiet. `ReleaseTunnel` and the stream-count releaser both correctly `delete()` on zero; `opens` was the one map in the same file that didn't. A tenant that opened ≥1 stream and then stopped left its last (non-empty) entry for the Gateway process lifetime — growth unbounded in *cumulative* distinct tenants, not current active ones. The tempting one-liner (`if len(kept)==0 { delete }` after `append(kept, now)`) is a **false alarm / dead code**: `kept` always gains `now` before store, so that branch never fires. The real leak is idle tenants never being revisited | Added `SweepIdleOpens` (deletes any entry whose newest timestamp is older than the 1s rate window) + `RunOpensSweep` (30s ticker from `gateway/cmd/gateway/main.go`, same shape as `ReconcileSecurity` / `ReconcileRegistrationDrain`). Tested: `gateway/internal/quota/sweep_test.go` |

Consolidated: **16 real defects found across four review passes, all 16 fixed in
code** where a small fix was enough. `L3-DNS-02` and `L3-REG-01` (below) are
now **Done** with opt-in / no-surprise defaults — existing production
conventions keep working until you deliberately switch.

| Area | Status | Notes |
|---|---|---|
| L3-STORE-01 / heartbeat / G-BOOT-1 / selection core | **Done** | Gateway `authorize` package now has unit tests (`authorize_test.go`) covering fail-closed unknown-kind, quota sentinel mapping, agent tie-break, inbound rejection of non-`CUSTOMER_*` |
| L3-GW-02 quotas (rate vs concurrent) | **Done** | Distinct `quota.ErrRateExceeded` / `quota.ErrConcurrentExceeded` sentinels; mapped to `RETRY_LATER` vs `UNAUTHORIZED` on the wire (`gateway/internal/session/handler.go:mapAuthzError`) |
| L3-GW-04 in-flight stream drain (L2 §G.3 rows 1/3) | **Done** (this pass) | Was a real gap: `ReconcileSecurity` only ever force-closed the *security*-cause rows of §G.3's table. Nothing enforced rows 1 ("Registration → Deleting: drain, then force-close after a bounded grace window") or 3 ("Tenant Suspended billing: drain, same as routine deletion") — a deleted registration's or billing-suspended tenant's streams could stay open forever. Fixed: new `StreamRegistry` tracks live streams by `(tenant_id, registration_id)`; `Handler.ReconcileRegistrationDrain` force-closes them (registration-scoped, not the whole tunnel) once non-`Active`/non-`Updating` for `FABRIC_REGISTRATION_DRAIN_GRACE` (default 3m); billing-suspended tenants get the same grace-then-`CloseByTenant`. `Updating` (row 2) is deliberately left untouched. Tested (`gateway/internal/session/drain_test.go`) |
| L3-GW-05 Gateway graceful shutdown (Level 1 §12 / L2 §H.2) | **Done** (this pass) | Was a real gap: `SIGTERM` only called `context.cancel()`, which nothing actually listened for — the accept loop kept accepting, new streams kept dispatching, and the process exited immediately with in-flight relays cut off mid-byte, harsher than the Runtime Contract's "stops accepting new work and allows in-flight work to complete or drain." Fixed: `SIGTERM`/`SIGINT` now (1) closes the listener (no new tunnels), (2) sets a draining flag so already-open tunnels refuse *new* streams, (3) waits up to `FABRIC_SHUTDOWN_GRACE` (default 25s) for in-flight relays to finish, then exits. Existing tunnels are not force-closed — Agents reconnect on their own backoff once the process actually exits, per L2 §H.2 |
| L3-MESH-01 Ambient packaging | **Done** (runtime verified 2026-07-25) | `smoke-ambient.sh` on `k3d-fabric-platform`: ztunnel Ready; A1 HTTP + B1 TCP bodies OK; ztunnel access log shows HBONE (`dst.addr=…:15008`, SPIFFE identities). Optional waypoint L7 skipped (Gateway API CRDs absent) — L4 path does not need waypoint |
| G-A3-1 prod DNS | **Done** (reconciler) / **ops-integration open** | `control-plane/src/dns/reconciler.ts` reconciles Active `CUSTOMER_*` registrations → desired records every tick (tested: `test/dns_reconciler.test.ts`). Ships two providers: `file` (JSON snapshot for an external CoreDNS sync, same shape as local dev) and `webhook` (upsert/delete POSTs). Wiring the webhook to a *specific* cloud DNS API (Route53/Cloud DNS/etc.) is intentionally left to ops — the architecture docs never name a provider |
| L3-CTL-01 | **Partial** — **1a Done**; 1b/1c open | Scoped Agent API token + allowlist. Day‑N credential *distribution* is **G-CRED-1 / `L3-CRED-01`**, not a CTL UX footnote |
| L3-CRED-01 | **Done** (implements **G-CRED-1**) | `POST /v1/agents/:id/api-token/current` (leaf PoP) + **D1 reuse** of fresh bearer + prior-hash overlap on mint; Agent `cptoken` file + **1h** refresh (D5); CP `FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL` **off for v1 (D4-A)**. Proof: `agent_api_token_pull.test.ts` + tenant smoke `agent_api_token_pulled` (2026-07-27) |
| L3-PKI-01 | **Done** (no Ghostunnel CRL — by design) | Issue/revoke/rotate + expiry scan job (`startCertExpiryScanJob`: `agent_cert_expiry_warning` + optional webhook). Rotate: `POST /v1/agents/:id/rotate` + `FABRIC_AGENT_ROTATE=1` |
| L3-GW-07 | **Done** | Ghostunnel `--shutdown-timeout` aligned with Gateway grace (manifests) |
| L3-OPS-01 | **Partial** — code + Terraform **Done**; apply NLB in OCI still Platform Day 0 | Service + push :9090 + `deploy/platform/oci/nlb/` Terraform (TCP, PPv2 off → :8443) |
| L3-ACL-01..03 | **Done** (K8s/VM) / **Partial** (ECS) | K8s NetworkPolicy + Service reconciler; VM systemd/firewall; ECS SG example only. ECS task-def still blocked on `L3-POC-ECS` (`L3-AGT-02` multi-instance identity is Done) |
| L3-AGT-02 | **Done** | Multi-redeem bootstrap + CSR-in-enroll + CA-only Secret + **K8s Secret store** (`FABRIC_IDENTITY_STORE=kubernetes`, production default; legacy `hostPath` via `FABRIC_IDENTITY_STORE=file`); see ticket below |
| Suspend cause (billing drain vs security force-close) — part of L3-GW-03 | **Done** | L2 §G.3; `suspended_cause` column + cause-aware force-close in `ReconcileSecurity`/`handleStream`, tested in `memory_store.test.ts` |
| Revoke cause (decommission drain vs security force-close) — part of L3-PKI-01 | **Done** | L2 §D.3; `revoked_cert_causes` + cause-aware force-close, tested |
| Strict substrate binding | **Done** | Spec §10.1 optional check; enrollment rejects substrate-fingerprint mismatch when enabled, tested |
| `protocol_version` enforcement | **Done** | L2 §J.4; Gateway rejects out-of-range versions before authz runs |
| `StreamOpenResult` wire enum | **Done** | Matches L2 §J.3 exactly (`ACCEPTED/UNAUTHORIZED/NOT_FOUND/DESTINATION_UNAVAILABLE/RETRY_LATER`); `PENDING_APPROVAL` removed from the wire enum (`reserved 6`), mapped to `UNAUTHORIZED` + reason string instead |

## A. Doc / product copy (small, no new architecture)

| ID | Ticket | Why | Deliverable |
|---|---|---|---|
| L3-DOC-01 | Customer-facing tls_mode / plaintext notice | §14 item 6 | UI/onboarding copy + docs snippet: Gateway sees plaintext when app/in-band TLS is absent |
| L3-DOC-02 | Onboarding residual-risk acknowledgment for skipped ACLs | §14 item 1 | UI checkbox/warning when customer skips NetworkPolicy/SG templates |
| L3-DOC-03 | Hairpin / data-residency disclosure | §14 item 2 | Customer doc: B2 always traverses Platform in v1 |
| L3-DOC-04 | Tenant-app UI checklist (mesh companions) | Ops + L3-REG-01 / L3-AGT-02 / quotas | **Done** as backlog doc: `docs/Tenant-App-UI-Checklist.md` aligned with Runbook (Platform Day 0 = scripts; Tenant Day 1 = UI + install manifests; Day‑N = UI-first) + background-jobs non-goals. Pathway proof: `docs/Validation-Plan.md`. Implementation is in the tenant app, not this repo |

---

## B. New implementation work from resolutions (real scope increase)

These are **new** relative to the pre-resolution architecture. They do increase build work.

| ID | Ticket | Source | Status | Work estimate shape | Deliverables |
|---|---|---|---|---|---|
| L3-ACL-01 | Kubernetes NetworkPolicy templates in install bundle | §14.1 / Resolutions item 1 | **Done** | New packaging artifact | `deploy/connect-agent/` (K8s); `NetworkPolicy` allowing dial to Agent listeners only from labeled consumers; port range documented as `FABRIC_LISTEN_BASE_PORT..+N-1` (not a fixed pair), matching the ECS SG example's parameterization. Getting an app to actually *reach* the Agent by name in the first place (not just be allowed to once it does) is the separate Service-reconciler fix, third bug-finding pass items 14–15 above |
| L3-ACL-02 | ECS security-group / task-networking templates | §14.1 / item 1 + item 7 | **Partial** | New packaging artifact | `deploy/connect-agent/ecs/security-group.example.json` shipped; full task definition deferred to `L3-POC-ECS` (see its README) |
| L3-ACL-03 | VM host-firewall + loopback listen defaults | §14.1 / item 7 | **Done** | New packaging artifact | `deploy/connect-agent/systemd/`: unit listening `127.0.0.1`; nftables/ufw examples; `hosts-writer.sh` |
| L3-AGT-01 | Agent TCP reachability probes + `reachable` observed field | §14.3 | **Done** | Agent + schema | `connect-agent/internal/watch`; reports `true\|false\|unknown` (timeouts/cancel now correctly report `unknown`, not silently omitted) |
| L3-GW-01 | Connect Agent Adapter selection algorithm | §14.3 | **Done** | Gateway | `authorize.pickAgent` + `ListEligibleAgents`; tie-break lowest stream count; else `DESTINATION_UNAVAILABLE`; tested |
| L3-BOOT-01 | Enrollment `PendingApproval` gate | §14.4 | **Done** | Gateway + Controller + UI | StreamOpen refused until approved (`UNAUTHORIZED` + reason, not a separate wire outcome); optional strict substrate binding shipped. No UI in this repo (backend-only) |
| L3-PKI-01 | Cert lifecycle: issue / rotate / revoke / push / expiry alert | §14.5 | **Done** | Certificate Controller + Gateway + Agent | **Issue / revoke / rotate:** Done. **Expiry scan:** `control-plane/src/jobs/certExpiryScan.ts` (default every `6h`, warn within `48h`; `FABRIC_CERT_EXPIRY_SCAN_INTERVAL=0` disables; optional `FABRIC_CERT_EXPIRY_WEBHOOK_URL`). Logs `agent_cert_expiry_warning`; safety net only — auto-rotation (D3-AUTO) is the primary mechanism. Tested: `test/cert_expiry_scan.test.ts`. No Ghostunnel CRL (by design). |
| L3-GW-02 | Per-tenant Gateway quotas | §14.8 | **Done** | Gateway + config | Concurrent tunnels/streams + stream-open rate; distinct sentinel errors; `POST /v1/tenants/:id/quotas`; tested |
| L3-CTL-01 | Registration Store write authn + dual-control | §14.9 | **Partial** | Controllers + Store + IAM | **Done (1a):** scoped Agent API token API + allowlist; writer bearer for Gateway/admin; dual-control. Tested + k3d smoke. Token is not redundant with the leaf (enroll/REST ≠ Ghostunnel) — see G-CRED-1. **Open (1b/1c):** mTLS/JWT writers; mass-change alerts. **Distribution/refresh of the Agent token is not this ticket** — see `L3-CRED-01` / G-CRED-1 |
| L3-CRED-01 | Agent credential pull (bearer + future Agent secrets) | **G-CRED-1** (`Architecture-Resolutions.md`) | **Done** | Control plane + Agent + install | **Shipped (deliberately minimal):** app-layer PoP (not CP mTLS); Agent presents leaf PEM on pull (not stored in DB — fingerprint-only stays); re-issue + prior-hash overlap; **D1 reuse-if-fresh** so N DaemonSet instances do not mint every hour; Agent file + **1h** refresh (D5); CP rotate job **off** (D4-A). Bootstrap = only out-of-band human step. Tested: `agent_api_token_pull.test.ts`. Ops/UI: Runbook + Checklist §0. **Not doing:** second mTLS listener; storing leaf PEM/pubkey in Postgres |
| L3-GW-03 | Emergency revoke/suspend independent of Agent generation | §14.11 | **Done** | Gateway | `ReconcileSecurity` + per-stream cause check force-close security suspends/revokes regardless of Agent staleness; tested |
| L3-MESH-01 | Platform Ambient packaging (ztunnel + optional waypoint) | Spec §5.4 / §8 | **Done** (L4 verified) | Deploy + Runbook | `deploy/platform/ambient/` + `smoke-ambient.sh` on `k3d-fabric-platform` (2026-07-25): ztunnel Ready; A1 `fabric-a1-ambient-ok`; B1 `fabric-b1-ambient-ok`; ztunnel access log HBONE to `:15008` with SPIFFE. Never install on Customer Agent clusters. Waypoint L7 optional and **not** required for A1 L4 / B1; smoke waypoint step failed only on missing Gateway API CRDs (ignored with `|| true`) |
| L3-GW-04 | In-flight stream drain on Registration Deleting / billing-suspend | L2 §G.3 rows 1, 3 | **Done** | Gateway | `gateway/internal/session/streams.go` (`StreamRegistry`) + `Handler.ReconcileRegistrationDrain`; grace window `FABRIC_REGISTRATION_DRAIN_GRACE` (default 3m); tested |
| L3-GW-05 | Gateway graceful shutdown | Level 1 §12, L2 §H.2 | **Done** | Gateway | `SIGTERM` stops new tunnels + new streams, waits `FABRIC_SHUTDOWN_GRACE` (default 25s) for in-flight relays, then exits |
| L3-GW-06 | Registration Update apply / rollback-on-failure | L2 §A.2, §G.5, §F.3 | **Done** (this pass) | Control plane | Added `POST /v1/registrations/:id/update` (`control-plane/src/http/server.ts`) + `FabricStore.updateRegistration` in both `memory.ts` and `sequelize.ts`. Only legal from `Active`; drives `Active → Updating → Active`, bumping `generation` like any other desired-state change (§D.5). On any failure (bad host/port, name conflict, apply error) the row is restored to its prior last-known-good `display_name`/`host`/`port` and lands back on `Active`, per §G.5 — `MemoryStore` does this with an explicit catch-and-restore, `SequelizeStore` does the whole cycle inside one DB transaction so a failure rolls back atomically and no concurrent reader ever observes a half-applied row. Existing in-flight streams are untouched either way (Gateway never re-reads a Registration mid-stream, so §G.3 row 2 was already correct by construction). Tested: `control-plane/test/memory_store.test.ts` (apply, host/port-missing rollback, non-Active rejection, name-conflict rejection) |
| L3-DNS-02 | DNS reconciler multi-replica write coordination (**both** providers, not just `file`) | Surfaced 2026-07-25 bug-finding pass (item 4); scope broadened after webhook multi-replica review | **Done** (Lease is the **production default**) | Control plane / ops | **Production path (no operator choice):** `deploy/control-plane/deployment.yaml` — one Deployment `replicas: 2+`, reconcile enabled on all, Lease election on (`FABRIC_DNS_LEADER_ELECTION=1` and binary default when reconcile is on **and** in-cluster). Only the holder ticks; standbys serve API; fail closed without SA. **Escape hatch only:** `deployment-split-reconciler.yaml` with explicit `FABRIC_DNS_LEADER_ELECTION=0` + reconciler `replicas: 1`. Local/compose (not in-cluster) keeps election off automatically. Do not mix manifests. Tested: `test/dns_reconciler.test.ts` + `resolveLeaderElection` defaults. **E2E:** `smoke-dns-lease.sh` — deploy 2 replicas, observe holder, delete holder pod, assert a *different* pod acquires the Lease. |
| L3-REG-01 | `Failed` registration retry (`Failed → Validating`) | Surfaced 2026-07-25 fourth pass | **Done** (retry is the **production recovery path**) | Control plane | `POST /v1/registrations/:id/retry` + `FabricStore.retryRegistration`. Production default for a Failed registration is retry-in-place, not delete+recreate (Runbook table). Create/update failure modes deliberately unchanged (§G.5 still restores Active). Tested: `test/memory_store.test.ts`. |
| L3-AGT-02 | Per-tenant bootstrap token + shared leaf cert vs N Agent instances (DaemonSet / ECS sidecar) | Surfaced in `bug` (2026-07-25); blocked multi-node K8s and multi-task ECS | **Done** | Control plane + Agent + install | **Shipped:** Phase A — `consumeBootstrapToken` validates hash/expiry without nulling (memory + sequelize); bootstrap API note + `bootstrap_expires_at`; `bootstrap_token_redeemed` audit log; revoke still early-kill. Phase B — `csr_pem` on `POST /v1/agents/enroll` → openssl sign via `FABRIC_AGENT_CA_*` → `certificate_pem` + per-instance fingerprint; Agent generates key/CSR when local leaf missing, writes leaf to `FABRIC_AGENT_CERT_DIR`, trusts `FABRIC_AGENT_CA_FILE`; skips re-enroll when leaf+agent-id already present (avoids multi-redeem minting duplicate rows on restart). Install: DaemonSet/k3d Secret = **CA-only** + identity on **K8s Secret store** (`FABRIC_IDENTITY_STORE=kubernetes`, production default) or **`hostPath`** `/var/lib/abluva/connect-agent/<ns>` (legacy `FABRIC_IDENTITY_STORE=file`) (**D2-A** — survives DaemonSet image rollout; do **not** use `emptyDir` as sole store in production). Cert-loss: re-bootstrap if window open else fail closed. `max_tunnels` default unchanged (50). Fingerprint-only enroll retained for api-smoke / pre-minted local leaves. Tested: `memory_store.test.ts` multi-redeem, `issue_leaf.test.ts`. k3d day-1c reuses one bootstrap window for agent-2 (**emptyDir** only on smoke agent-2 to prove wipe→re-enroll). `L3-POC-ECS` / ECS GA still open for packaging PoC. |
| L3-GW-07 | Ghostunnel shutdown-timeout ↔ Gateway grace | Production-readiness review (SIGKILL mid-drain) | **Done** | Deploy | `--shutdown-timeout=25s` on Ghostunnel + `FABRIC_SHUTDOWN_GRACE=25s` + `terminationGracePeriodSeconds: 45` in `deploy/gateway/deployment.yaml`; compose Ghostunnel aligned. Runbook already documented the two-timer hazard. |
| L3-OPS-01 | Gateway ClusterIP Service + OCI NLB / push URL ops contract | Production-readiness review | **Partial** (ops apply) | Deploy + Platform Day 0 | **Shipped:** `Service/fabric-gateway` + revoke :9090; CP push env; Terraform `deploy/platform/oci/nlb/` (NLB TCP, `is_ppv2enabled=false` → Ghostunnel :8443; output `fabric_gateway_address` for Agent snippet). Customer pass-as-is: `deploy/connect-agent/tenant-start.sh`. **Open (ops):** `terraform apply` in your compartment + DNS to VIP. Runbook Step 5b + `PRODUCTION-READINESS.md` |

**Does not add Agent privilege or a second authz plane** — ACLs are customer-side network templates; Gateway remains sole identity/registration authz (ADR-002/007). Ambient is Platform-only reuse of Istio (ztunnel required; waypoint optional L7 for Services).

### Docs that still need follow-through (not done as full artifacts yet)

| Doc / area | What’s still missing beyond the prose resolution |
|---|---|
| Install bundle: ECS task def | `deploy/connect-agent/ecs/` has the security-group template only; full Fargate task definition blocked on `L3-POC-ECS` |
| Platform Controller UI | No UI exists in this repo at all (backend-only): PendingApproval screen, ACL-skip warning, plaintext/hairpin copy, suspend/revoke-cause picker are all unimplemented product surface, not just docs — see `Tenant-App-UI-Checklist.md` |
| Controllers (mTLS writers) | `L3-CTL-01` 1b/1c — scoped Agent token **Done** (1a); mTLS/JWT writers + mass-change alerts still open |
| Agent credential Day‑N distribution | **`L3-CRED-01` / G-CRED-1** — **Done** in code (incl. D1 reuse + D5 1h); no seed needed (Agent derives bearer from leaf PoP) |
| Connectivity / Developer narrative | **Done** (2026-07-27): `Connectivity-Technical-Guide.md` rolled up; `Developer-Reference.md` rewritten; `network-product-guide.md` is a pointer only |
| G-A3-1 DNS ↔ real DNS API | `control-plane/src/dns/reconciler.ts` reconciles correctly; nothing in this repo calls a live Route53/Cloud DNS/etc. API — ops must implement the webhook receiver (or consume the `file` provider's JSON) against their actual DNS backend |
| Gateway front (OCI NLB) + push URLs | `L3-OPS-01` — ClusterIP + push :9090 + Terraform `deploy/platform/oci/nlb/`; `terraform apply` is Platform Day 0 (see `PRODUCTION-READINESS.md`) |
| Customer runbooks | Troubleshooting for `DESTINATION_UNAVAILABLE`, quota denials, PendingApproval — covered in `Operational-Runbook.md` Troubleshooting, not a separate customer-facing doc |
| Production readiness POV | Single doc: `docs/PRODUCTION-READINESS.md` (locked D1–D8 + ship bar; not a second tracker) |
| Validation Results | Keep `Validation-Plan.md` Results honest after every run (refreshed 2026-07-27) |

Accepted invariants that **do not** add product features (doc-only): B2 hairpin, RESOURCE `intended_consumers` informational, no customer credential storage in Registration.

---

## C. Pre-existing Level-3 picks (not from §14 — already open before the review)

These were already listed in `L2-Design.docx` → **Remaining Items Before Development Starts**. They are **implementation choices**, not unresolved architecture risks.

### L3-STORE-01 — Registration storage technology

**Status:** Spec frozen in `Level-3-Store-OIDC-Spec.md` + pathway/Ghostunnel locks in `Architecture-Resolutions.md`.

**Locked:** Platform Postgres via **Sequelize**; tables `ablv_tenant_connect`, `ablv_registrations`, `ablv_agents`; FK to `ablv_tenants(tenant_id)`; plain UUIDs; audit columns on-row; DB creds from Access API; Ghostunnel as binary front with unix + PROXY tls-full; Spec §8 pathways (A1–A4 / B1–B4) with waypoint optional L7 on Services only; A3/B4 G-A3-1 inbound DNS; A4 in v1; K8s-first (ECS later).

**Still blocked before coding:** Access API response JSON samples (R1/R2).

### L3-BOOT-SCALE-01 — Post-expiry bootstrap for new Agent identities (open)

**Status:** **Open** — ops hole documented 2026-08-05.

**Problem:** A brand-new Agent identity (new node / new task with empty
identity store) can enroll only while a **live bootstrap token** exists.
After `bootstrap_expires_at`, scale-out requires: issue bootstrap again →
put token into the customer install Secret → restart/roll Agents that need
first enroll → (if `auto_approve_agents=false`) Approve each. Redistributing
bootstrap for routine node growth is not an acceptable default ops flow.

**When the painful path is intentional:** high-security / fixed fleets that
**turn auto-approve off** and keep a short bootstrap window — new joins are
deliberately gated (new bootstrap + human Approve). That is a product
choice for locked environments, not the default.

**Mitigations today (partial):**
- Default **`auto_approve_agents=true`** removes the Approve step for scale-out.
- Keep bootstrap window open for the planned scale period (multi-redeem).
- Identity on K8s Secret survives **pod restart** on the same node (no re-enroll).

**Still missing (future work):** a Day‑N join path that does not require
pasting a new bootstrap into the customer Secret for every post-expiry new
node (e.g. longer-lived install credential, cluster attestation enroll, or
Platform-mediated join). Until then, treat re-bootstrap+redistribute as the
known fallback and document it honestly in Runbook / UI.

---

**Status:** **Implemented (attribution path)** 2026-08-05 — pluggable
`workload_evidence_strategy` (`none` \| `kubernetes_oidc` \| `ecs_task_identity`);
CP `GET/PUT /v1/tenants/:id/workload-evidence` + discovery probe; authz-context
`evidence_trust`; Gateway JWKS RS256 verifier (absent OK; bad token reject);
enable scripts for EKS/RKE2/**k3s**; DaemonSet projected token mount (Agent SA).
Still **attribution only** (§6.2) — not allowlist authz.

**Follow-ups:** ECS strategy verifier; richer caller-SA for shared DaemonSet
(sidecar / dialer-injected token); scheduled JWKS re-probe job; UI issuer
form (checklist §3b).


---

## D. Blocking PoCs (unchanged class)

| ID | PoC | Pass criteria |
|---|---|---|
| L3-POC-ECS | ECS idle + recycle | Tunnel survives >350s idle on yamux keepalive; clean reconnect after forced Fargate recycle |
| L3-POC-GT | Ghostunnel fit | mTLS terminate → **decrypted TCP** handed to yamux + StreamOpen broker; plus multi-tenant cert reject/rotate cases |

---

## E. Deferred work snapshot (certs / OIDC / auth / Istio) — current truth

Use this table instead of older “deferred” notes that still say CSR/issue is unbuilt.

| Area | Piece | Status | Notes |
|---|---|---|---|
| **PKI** | Issue (CSR → leaf) | **Done** (`L3-AGT-02`) | Per-instance CSR in `enroll()`; CA-only shared Secret. Do not implement shared-leaf mount. |
| **PKI** | Rotate | **Done** | Auto-rotation via `certlife.StartLoop` (D3-AUTO), **always on**; manual `FABRIC_AGENT_ROTATE=1` for emergency only |
| **PKI** | Short-lived TTL | **Done** | `FABRIC_AGENT_CERT_DAYS=7` (was 825); plan 7d → 24h |
| **Identity** | SPIFFE SAN | **Done** | `spiffe://fabric.abluva.io/tenant/<tid>/agent` in leaf cert (D9) |
| **Identity** | `identity.Store` interface | **Done** | `internal/identity`; `file` + `k8ssecret` implementations; supersedes hostPath-only D2 (see PRODUCTION-READINESS.md D2-NEW) |
| **Identity** | `enroll.Method` interface | **Done** | `internal/enroll`; `enroll/bootstrap` (token) ships; extension point for cloud attestation (D11) |
| **Substrate** | Packaging strategy | **Done** | D10: `tenant-start.sh` (K8s, Helm planned not shipped) / k3s appliance (VM, recommended) / task def (ECS, blocked on PoC) / compose (Docker) |
| **PKI** | Revoke + push | **Done** | `revoke-cert` + `/internal/revoke` + Gateway poll; smoked |
| **PKI** | Expiry / CRL refresh jobs | **Done** (alert job; no CRL) | `certExpiryScan` consumes `cert_not_after`; Ghostunnel CRL still non-goal |
| **OIDC** | Customer enable + CRUD + Gateway verify + JWKS probe | **Done (attribution)** (`L3-EVID-01`) | Strategy + PUT API + Gateway verify; ECS later; UI §3b |
| **Auth** | Bearer + dual-control | **Interim Done** | High-risk routes |
| **Auth** | Scoped Agent token (API) | **Done** (`L3-CTL-01a`) | `…/agent-api-token` |
| **Auth** | Agent credential pull (bearer file + leaf-auth refresh) | **Done** (`L3-CRED-01` / **G-CRED-1**) | No seed; pull from Day-1 onward |
| **Auth** | mTLS/JWT writers + alerts | **Open** (`L3-CTL-01` 1b/1c) | After 1a; not a live exposure once Agent token is scoped |
| **Istio** | Ambient ztunnel (A1/B1 L4) | **Done** (`L3-MESH-01`) | Verified on `k3d-fabric-platform` |
| **Istio** | G-A2-1 ServiceEntry / host DNS | Platform ops | Not Agent path |
| **Istio** | G-A3-1 per-tenant inbound DNS | **Reconciler Done**; cloud DNS webhook ops-open | `dns/reconciler.ts` |
| **Istio** | Waypoint | Optional L7 | Not required for B1/B4; A1 L4 works without it |

### Open items — go-live vs defer (external review, 2026-07-26)

None of the remaining **code** items are trust-boundary blockers (those closed with AGT-02 / CTL-01a / rotate / GW-07 / bug passes). Classify before scheduling:

| Open item | Blocks safe v1 code? | Before go-live? | Why |
|---|---|---|---|
| **L3-CRED-01** / **G-CRED-1** | ~~Was product gate~~ | **Done** (reconfirmed 2026-07-27 tenant smoke + unit) | PoP + reuse + 1h refresh |
| **L3-OPS-01** NLB + push DNS | No (code + TF shipped) | **Yes — `terraform apply` + DNS** | Production needs *some* L4 front; decision locked in `PRODUCTION-READINESS.md` |
| **L3-PKI-01** expiry scan | **Done** (job on by default) | Optional webhook sink | Fail-closed on expiry still applies; job is on-call warning — create `fabric-cert-expiry-webhook` Secret when ready |
| **L3-MESH-01** Ambient verify | No | ~~Was~~ **Done** on laptop Platform k3d (reconfirmed 2026-07-27) | Re-run once on real Platform cluster at cutover |
| **L3-CTL-01** 1b/1c | No | Defer | Hardening / visibility |
| **L3-BOOT-SCALE-01** post-expiry bootstrap scale-out | No (workaround: open window / re-issue) | Prefer fix before large fleets | New identity after bootstrap expiry needs redistributed token; auto-approve≠bootstrap |
| **L3-EVID-01** OIDC | ~~Open~~ **Done (attribution)** | Optional before go-live | Strategy API + Gateway verify shipped; ECS / caller-SA dialer later |
| **L3-POC-ECS** / ACL-02 | No | Post K8s GA | Substrate not in v1 |
| **L3-STORE-01** Access samples | No | External | Blocks nothing functional in this repo |
| **D2 hostPath survival smoke** | No (DaemonSet shipped) | Recommended before fleet GA | Explicit “rollout keeps agent_id” assert still nice-to-have in Validation-Plan |

---

## Suggested build order

**Historical (mostly landed).** Remaining open work, recommended order:

1. ~~Core slice + AGT-02 + CTL-01a + PKI rotate + GW-07 + MESH-01 + CRED-01~~ — **Done**
2. **L3-OPS-01** — Platform Day 0: `deploy/platform/oci/nlb` apply + DNS; push stays in-cluster `:9090`
3. **L3-PKI-01** — expiry scan shipped; wire `FABRIC_CERT_EXPIRY_WEBHOOK_URL` / Secret if you want pager sink
4. Keep **Validation-Plan** Results honest after every run (**refreshed 2026-07-27**)
5. **L3-CTL-01** 1b mTLS/JWT writers; 1c mass-change alerts
6. **L3-EVID-01** OIDC
7. **L3-POC-ECS** / ACL-02; **L3-DOC-01..03** UI copy (tenant app)
8. Re-run Ambient verify on the **real** Platform cluster at cutover
9. Optional: dedicated hostPath identity-survival smoke (DaemonSet rollout keeps `agent_id`)

---

## Traceability cheat sheet

| Resolutions.md / §14 # | Ticket(s) |
|---|---|
| 1 Local hop | L3-ACL-01..03, L3-DOC-02 |
| 2 Hairpin | L3-DOC-03 (accept; no feature) |
| 3 Agent selection | L3-AGT-01, L3-GW-01 |
| 4 Bootstrap | L3-BOOT-01 |
| 5 Revocation | L3-PKI-01 |
| 6 Plaintext | L3-DOC-01 |
| 7 Non-K8s routing | L3-ACL-02, L3-ACL-03 |
| 8 Quotas | L3-GW-02 |
| 9 Controller blast radius | L3-CTL-01 |
| G-CRED-1 Agent credential pull | L3-CRED-01 |
| 10 Credentials interim | none (accept; omit credential fields from Registration write path) |
| 11 Emergency vs stale | L3-GW-03 |
| 12 RESOURCE consumers | none (accept; do not enforce `intended_consumers`) |
| GT Ghostunnel | L3-POC-GT |
| G-MESH-1 Ambient | L3-MESH-01 |
| L2 pre-existing | L3-STORE-01, L3-EVID-01, L3-POC-ECS |
| L2 §G.3 rows 1/3 (drain grace) | L3-GW-04 |
| Level 1 §12 / L2 §H.2 (graceful shutdown) | L3-GW-05 |
| L2 §G.5 / §F.3 (Registration Update) | L3-GW-06 |
| 2026-07-25 bug-finding pass (items 1–3, 5–9) | Fixed directly in Gateway/Connect Agent/control-plane code, no new ticket (see pass summary above) |
| 2026-07-25 bug-finding pass (item 4, multi-replica DNS file writes) | L3-DNS-02 |
| 2026-07-25 second bug-finding pass (items 10–13) | Fixed directly in control-plane/Connect Agent code, no new ticket (see second pass summary above) |
| 2026-07-25 third bug-finding pass (items 14–15, K8s Service routing + `internalTrafficPolicy`) | Fixed directly in Connect Agent code + `deploy/connect-agent/` manifests, no new ticket (see third pass summary above); folded into `L3-ACL-01`'s deliverable list |
| 2026-07-25 fourth pass (item 16, quota `opens` idle-tenant leak) | Fixed directly in Gateway `quota` package + `main.go` sweep ticker |
| 2026-07-25 fourth pass (`Failed` retry / dead transitions) | L3-REG-01 (**Done** — production recovery path is retry) |
| L3-DNS-02 | **Done** — Lease is production default (`deployment.yaml`); split is escape hatch only |
| Multi-instance enroll / shared leaf cert (DaemonSet + ECS) | L3-AGT-02 (**Done** — ECS GA still waits on `L3-POC-ECS`) |

---

## Deferred: L3-STORE-REFACTOR — Collapse dual FabricStore implementations into shared-core + thin adapters

**Status:** Deferred (2026-07-28). Narrow extraction of the highest-risk hot path (`filterEligibleAgents`) done; full refactor parked.

**What was done now (narrow, shipped):**
- `filterEligibleAgents()` extracted as a pure function in `store/types.ts` — the eligible-agent filter+sort logic (revoked-FP exclusion, tunnel-ready gate, probe-grace window, reachable scoring) that was duplicated inline in both `memory.ts` and `sequelize.ts`'s `authzContext`. Both stores now call the same function after fetching their own candidate list. This closes the drift risk for the single highest-traffic, highest-correctness-impact code path.
- `matchAgentByFp` (memory) / `matchAgentByFpWhere` (sequelize) similarly centralized the prior-FP-overlap lookup logic, fixing the class of bug that caused the original P0 (authzContext not honoring prior-FP).

**What's still duplicated (lower risk, deferred):**
- `enrollAgent`: memory iterates agents for FP-conflict check; sequelize uses a SQL findOne. Same logic, different mechanics.
- `rotateAgentCert`: overlap-window bookkeeping + conflict check.
- `reportTunnel`: state-machine transitions (up/down/heartbeat) — identical logic, one does `this.transitionAgent(...)`, other does `this.transitionAgentTx(... t)`.
- `createRegistration` / `updateRegistration` / `retryRegistration`: advance/rollback state machine.
- Minor: `agentReportedUnreachable()` (sequelize has a named helper; memory inlines the same check) — now moot because both delegate to `filterEligibleAgents`.

**Why it's deferred, not rejected:**
- Sequelize methods wrap logic *inside* `sequelize.transaction(async (t) => {...})` for atomicity. Extracting shared "business logic" out of those transactional closures requires either (a) passing the transaction through as a parameter to every shared function (leaks Sequelize into the shared core) or (b) restructuring into a Unit of Work / Repository pattern where the DB-specific layer provides primitives and the shared core orchestrates — a meaningfully larger design change than the narrow extractions already done.
- Memory.ts exists specifically as a lightweight test double. Over-abstracting it adds structural complexity for a system where only *one* live DB backend actually runs in production (SequelizeStore); the memory store only runs in unit tests and `FABRIC_STORE=memory` local compose smoke.
- The code that's still duplicated (enroll, rotate, reportTunnel state machine) has NOT shown the same drift-bug pattern as the two paths that were centralized — there's no evidence of a real correctness gap in those methods today, only a style/DRY concern.

**When to revive:**
- If a second concrete drift bug appears in one of the still-duplicated methods (same class as the original P0: one store's copy gets a fix the other doesn't).
- If a third FabricStore backend is ever added (e.g. DynamoDB for a multi-cloud story) — at that point, three copies of reportTunnel would cross the "can't maintain" line.
- If the team has a sprint specifically aimed at test architecture / store abstraction.

**Approach when revived:**
1. Define a `StorePrimitives` interface with methods like `findAgent(id)`, `findAgents(where)`, `updateAgent(id, patch)`, `createAgent(data)` — the minimal data-access surface both stores share.
2. Extract a `StoreLogic` layer that orchestrates enrollment, rotation, tunnel reporting, and authzContext using only `StorePrimitives` — no direct Sequelize or Map access.
3. `MemoryStore` becomes a thin `StorePrimitives` impl (Map lookups); `SequelizeStore` wraps its transactional queries behind the same interface.
4. The existing test suite (83+ tests) serves as the regression gate — no behavior should change.

**Estimated effort:** 2–4 days for the full refactor, primarily in step 2 (disentangling transactional boundaries from business logic). Risk is moderate — touching every store method risks introducing new bugs in working, tested code for a payoff that's primarily maintainability, not correctness.
