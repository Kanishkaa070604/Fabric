# Architecture Resolutions (v1)

This document records the decisions this codebase made to fill in the gaps
`Architecture-Spec.docx` deliberately left open — plus a small number of
decisions that go slightly beyond the Spec (an extra approval checkpoint,
specific quota defaults) because they were needed to actually ship a v1.

**How to read this alongside the Spec:** `Architecture-Spec.docx` (especially
§5.4 Ambient, §7–§8 pathways, §14 Risk Register) is the frozen architecture —
component roles, trust boundaries, the eight pathway hop chains. Nothing
below is allowed to contradict it or invent an alternate hop order. Where a
decision here is a genuine resolution of something the Spec named as open,
that's marked explicitly. Where a decision is this codebase's own addition
on top of the Spec, that's marked too — the two are different in kind, and
conflating them (treating an implementation choice as if the Spec had
already mandated it) is exactly the confusion this document exists to
prevent.

Every decision below conforms to ADR-002 (Gateway is the sole authorization
point), ADR-007 (the Connect Agent never authorizes), and constraints C1–C2
and §1.4 of the Spec.

Related documents: frozen vocabulary and document map (`docs/README.md`),
Level-3 store/OIDC detail (`Level-3-Store-OIDC-Spec.md`), the ticket backlog
(`Level-3-Tickets.md`), day-to-day operations (`Operational-Runbook.md`),
and the conceptual walkthrough of how all of this fits together
(`Connectivity-Technical-Guide.md`).

---

## Decision register (quick index)

Short IDs below are this repository's ops/code labels. Prefer Spec section
numbers when citing architecture; use the short ID when pointing at
automation, tickets, or runbook steps.

| # / ID | Topic | Decision | Kind |
|---|---|---|---|
| R4 | Identity | R4a tenant mTLS day one; R4b workload identity deferred | Doc |
| §6.2 | Evidence | Attribution/audit only in v1 — never authz | Doc |
| 1 | Customer-local hop | Mandatory ACL templates in install bundle | Control |
| 2 | B2 hairpin | Accepted v1 invariant | Accept |
| 3 | Agent selection | Reachability-aware among Connected / Degraded agents | Design |
| 4 | Bootstrap | PendingApproval; StreamOpen gated (see G-BOOT-1) | Design |
| 5 | Revocation | Controller push + fingerprint list; security force-close | Design |
| 6 | Gateway plaintext | Customer-facing `tls_mode` property | Doc |
| 7 | Non-K8s routing | ECS later; VM loopback when needed | Design |
| 8 | Gateway quotas | Per-tenant tunnel/stream/rate limits | Design |
| 9 | Controller blast radius | Least privilege + dual-control high-risk | Design |
| 10 | Resource credentials | Not in Registration; customer apps keep own secrets; **platform** secrets via Access API (Spec §14 item 10) | Accept + Design |
| 11 | Stale vs emergency | Security path independent of Agent generation | Design |
| 12 | RESOURCE consumers | Informational until R4b | Accept |
| Adapter map | `destination_kind` → Destination Adapter | Spec §5.2: `CUSTOMER_*`→Connect Agent; `PLATFORM_RESOURCE`→Platform Connector; `PLATFORM_SERVICE`→Direct Endpoint (post-authz Fabric dial) | Design (now in Spec) |
| G-A3-1 | Platform→Customer inbound addressing | Spec §8.3 / §8.8 / §14 A3/B4 note: per-tenant Gateway inbound + per-reg DNS/SNI; **distinct from** §14 item 3 (Agent selection) | Design (now in Spec) |
| G-MESH-1 | Platform Ambient | **ztunnel required** (A1/A2/A3/B1/B4); waypoint optional L7 (A1/A2/A3); package `deploy/platform/ambient/` | Design |
| G-BOOT-1 | Bootstrap channel | Same mTLS tunnel; StreamOpen refused until approved | Design |
| G-CRED-1 | Agent credential distribution | **Agent pulls** current credentials from CP over outbound HTTPS; no per-instance human Secret/env updates after Day‑1 bootstrap | Design |
| G-A4-1 | Customer→Customer Service | **Supported in v1** | Scope |
| G-A2-1 | Platform service destination | Mesh DNS in `host` (Istio ServiceEntry/DNS) | Design |
| GT | Ghostunnel | **Gateway pod only** (not Agent); `--allow-all` + CA; unix + PROXY tls-full; **no OPA** | Design |
| Approve | Enrollment approval | **Tenant admin** in UI; SaaS break-glass; or `auto_approve_agents` | Design |
| ORM | Control-plane DB | **Sequelize** (TS); schema portable if ORM changes | Impl |
| T1 | Tenant table | **`ablv_tenants`**, PK/FK column **`tenant_id`** | Impl |
| S1–S3 | Vault / bootstrap / platform ids | Prefix `ablv-fabric` (config); bootstrap hash in PG; platform tenant/env in config | Impl |
| D3-AUTO | Cert auto-rotation | 7d TTL + Agent loop rotates at 50% life; **always on** (`FABRIC_CERT_AUTO_ROTATE=0` to disable) | Design |
| D2-NEW | Identity storage | `identity.Store` interface; `file` + `k8ssecret` (per-node Secret) implementations; supersedes hostPath-only D2 | Design |
| D11 | Join method | `enroll.Method` interface; `enroll/bootstrap` (token) ships; extension point for cloud attestation | Design |
| D9 | SAN identity | SPIFFE URI `spiffe://fabric.abluva.io/tenant/<tid>/agent` in leaf SAN | Design |
| D10 | Substrate | k3s appliance (shipped installer) is the recommended default for VM/bare-metal; systemd is the simplest-case fallback; K8s uses `tenant-start.sh` (Helm planned); ECS task def; Docker compose | Done |
| L4-MULTI-REGION | Multi-region Gateway | Active/standby → active/active → geo-aware (post-v1) | Future |
| L4-CLOUD-JOIN | Cloud-native join | OCI/AWS/GCP attestation replaces bootstrap token (post-v1) | Future |

---

## Part 1 — Identity and trust: what's decided, what's deferred

**Tenant identity is the only hard security boundary in v1** — a mutual-TLS
certificate scoped to one tenant, checked on every connection. Full
per-workload identity (something SPIFFE-equivalent) is explicitly deferred,
not built, and workload evidence — where a substrate happens to supply it —
is recorded for attribution and audit only. It is never, under any
circumstance, a factor in whether the Gateway authorizes a stream. This
matches Spec §6.2 exactly and isn't a repo-specific addition.

**Where destination kinds map to a Destination Adapter** is now written
directly into the Spec itself (§5.2), not left as a separate repo
convention: `CUSTOMER_*` destinations go through the Connect Agent adapter,
`PLATFORM_RESOURCE` goes through the Platform Connector, and
`PLATFORM_SERVICE` goes through a direct Fabric dial (internally named
`DIRECT_ENDPOINT`) once the Gateway has already authorized the stream.

**Resource credentials never live in a Registration.** A Registration only
ever records *where* something is reachable, never *how to log into it*
(Spec §14 item 10). For a customer-owned database, the customer's own
application keeps its own credentials — Fabric only ever provides the
network path. For a Platform-owned resource, credentials come from the
Access API instead; the specific request/response shapes for that live in
`Level-3-Store-OIDC-Spec.md`, not here.

**Customer-local hop ACLs (Spec §14 item 1).** The install bundle ships
mandatory ACL templates (Kubernetes NetworkPolicy; VM firewall + systemd
helpers). The Connect Agent still never authorizes — the templates only
constrain which local peers may reach the Agent's listeners.

---

## Part 2 — The eight pathways: what's genuinely Spec, what this codebase added

All eight of `Architecture-Spec.docx` §8's pathways are in v1's product
scope, and every hop chain below is transcribed directly from the Spec —
nothing here invents a different tool ordering. What follows is organized
by the two things that actually vary pathway to pathway: whether the
Gateway is involved at all, and whether waypoint can ever apply. (waypoint
is optional Platform-side L7 for Service traffic only — it never appears
anywhere on a Resource pathway, full stop.)

### Service connectivity

| Pathway | Hop chain (verbatim from Spec §8) | Gateway? | waypoint? | v1 notes |
|---|---|---|---|---|
| A1 — Platform → Platform service | Platform Service → ztunnel → [optional waypoint] → ztunnel → Platform Service | No | Yes, optional | Ambient only; no Agent |
| A2 — Customer → Platform service | Customer Service → Agent → tunnel → Gateway → ztunnel → [optional waypoint] → Platform Service | Yes | Yes, optional, after Gateway | Spec §5.2 Direct Endpoint (`PLATFORM_SERVICE`); G-A2-1 mesh DNS in `host` |
| A3 — Platform → Customer service | Platform Service → [optional waypoint] → ztunnel → Gateway → tunnel → Agent → Customer Service | Yes | Yes, optional, before Gateway | Spec §8.3 addressing (ops label G-A3-1) |
| A4 — Customer → Customer service | Customer Service → Agent → tunnel → Gateway → tunnel → Agent → Customer Service | Yes | Never | Hairpin; G-A4-1 in v1 |

A4 (Customer-to-Customer) is explicitly in v1 scope, not a future item — it
hairpins through the Gateway the same way B2 does below, and the origin
Agent needs its own local listener for that registration, the same pattern
already used for B2's `CUSTOMER_RESOURCE` listeners (Spec §8.4 / §8.6).

### Resource connectivity

| Pathway | Hop chain (verbatim from Spec §8) | Gateway? | waypoint? | v1 notes |
|---|---|---|---|---|
| B1 — Platform → Platform resource | Platform Service → ztunnel → Platform Connector → Platform Resource | No | Never | Spec §8.5; platform secrets via Access API (§14 item 10) |
| B2 — Customer → Customer resource | Customer Service → Agent → tunnel → Gateway → Agent Adapter → tunnel → Agent → Customer Resource | Yes | Never | Hairpin invariant (Part 4) |
| B3 — Customer → Platform resource | Customer Service → Agent → tunnel → Gateway → Platform Connector → Platform Resource | Yes | Never | No ztunnel on Spec chain |
| B4 — Platform → Customer resource | Platform Service → ztunnel → Gateway → Agent Adapter → tunnel → Agent → Customer Resource | Yes | Never | Spec §8.8 addressing (same G-A3-1 as A3); TCP |

**ECS is out of scope for now.** K8s (RKE2 and EKS) ships first; ECS
support and its idle-connection validation work are deferred, tracked
separately.

**Substrate asymmetry (why ECS cannot copy the K8s DaemonSet model).** On
Kubernetes the Agent is a DaemonSet (one per node) plus a Service with
`internalTrafficPolicy: Local`, because pods on a node share the node but
*not* a network namespace — a customer app pod and the Agent pod are
different network identities, so cluster DNS + Local routing is required.
On ECS `awsvpc`, the unit that shares a network namespace is the *task*,
not the node: containers in one task share an IP and reach each other on
`127.0.0.1`, but two tasks on the same EC2 instance do not. There is no
"one Agent per node, shared by many tasks" option. Fabric-adjacent
connectivity on ECS therefore means an Agent **sidecar in the same task
definition** — one Agent (cert, tunnel) per application task, not
per-node. That reopens the per-instance resource/cert-lifecycle cost the
DaemonSet model was chosen to avoid on Kubernetes. This is a
substrate-forced architectural difference, not a packaging oversight;
anyone reasoning from the K8s model alone will wrongly assume ECS scales
the same way. See `deploy/connect-agent/ecs/README.md` and `L3-POC-ECS` /
`L3-ACL-02`.

**Multi-instance Agent identity (`L3-AGT-02`) — implemented.** Enrollment
and leaf certificates are 1:N with Agent *processes* (DaemonSet pods /
ECS tasks), not 1:1 with the tenant.

Shipped shape:

1. **Bootstrap:** multi-redeem until `bootstrap_expires_at` — do not null
   on first use. Exposure bound = expiry window; early kill =
   `revokeBootstrapToken`. Redemptions are audited (`bootstrap_token_redeemed`).
2. **Leaf certs:** CSR inside `POST /v1/agents/enroll`; control plane signs
   with `FABRIC_AGENT_CA_*`; per-instance leaf written to pod/task-local
   storage; shared install Secret is **CA/trust only**.
3. **Cert missing, agent-id present** (identity volume wipe / fresh ECS ephemeral
   volume): re-bootstrap using the tenant’s still-open bootstrap window if
   one exists; otherwise **fail closed** and require a freshly issued
   bootstrap token. No “prove prior identity without the private key” path.
4. **Migration:** existing shared-cert fleets reinstall with the new
   bundle — no live in-place reissuance.
5. **`max_tunnels` default stays 50** (see quotas paragraph below). Each
   Agent instance consumes a real tunnel slot; onboarding must set the
   per-tenant cap to at least the planned node/task count.
   Tenant-app checklist: `Tenant-App-UI-Checklist.md`.

ECS full task-def packaging remains example-only until `L3-POC-ECS`.

### Agent credential distribution (G-CRED-1) — Agent pulls; nothing pushes

**Constraint (product, not a K8s convenience):** once a tenant has completed
Day‑1 install, **neither Platform nor the customer must manage ongoing
token/cert distribution by hand** (no “update this Secret on every node /
recreate every Agent pod / edit every VM unit”). Substrate-specific push
stories (Kubernetes Secret roll, ECS secret injection, systemd drop-ins)
do not generalize and re-involve the customer at every rotation. That is
rejected for v1 operations.

**Pattern:** after an Agent instance has *any* verified identity, **it**
asks the control plane “what is current for me,” on its own schedule, over
the same outbound HTTPS path `enroll()` already uses. That call is
identical on Kubernetes, ECS, and VM — it does not depend on the
orchestrator. Leaf-certificate auto-rotation (`certlife.StartLoop` rotates
at 50% of TTL; force-reconnects onto the new leaf immediately) is the
shipped implementation; every other refreshable Agent credential follows
the same pull-based pattern.

**Credential inventory:**

| Credential | Role | Distribution rule |
|---|---|---|
| **Bootstrap token** | Root of trust for a *brand-new* install (no leaf yet) | **Stays the one deliberate out-of-band human step** — issue once into the install package (Secret/env/file). Short-lived; revoke to early-kill. You cannot bootstrap trust from nothing without this. |
| **CA trust bundle** | Trust anchor for Ghostunnel / leaf verify | Rare planned change. Already a file; refresh with the same file-update path used for other local material. Not rotated on a customer-facing Day‑N loop. |
| **Agent leaf certificate** | Per-instance tunnel identity (Ghostunnel / Gateway) | **Pull-based (shipped, D3-AUTO)** — Agent CSR → CP signs → write to identity.Store; auto-rotate at 50% life; force-reconnect onto new leaf. Manual `FABRIC_AGENT_ROTATE=1` for emergency only. |
| **Agent API bearer token** | Gates CP REST (list registrations, observed, rotate) — not the Ghostunnel channel | **Pull-based (shipped, L3-CRED-01)** — Agent derives bearer from leaf cert via PoP pull after enroll. No Day-1 seed needed. Refresh every 1h (D5); CP reuses fresh bearer until near expiry (D1). |

**Why the bearer token is not redundant with the leaf:** enroll and the
other Agent→CP REST calls are plain HTTPS to the control plane, not the
Gateway mTLS tunnel. A new instance calling `enroll` has no leaf yet.
Building a second mTLS listener on the CP REST API for every Agent call
is more infrastructure, not less. The scoped bearer remains the pragmatic
gate for that REST surface; **how it is refreshed** is what G-CRED-1
fixes.

**Concrete shape (`L3-CRED-01` — shipped):**

1. **App-layer PoP, not a second CP mTLS listener.** Ghostunnel already
   terminates tunnel mTLS; the CP REST API is plain HTTP behind whatever
   platform TLS you put in front. Standing up client-cert TLS just for
   four Agent REST calls would be more infrastructure than a signature
   over a short challenge. Locked choice: PoP.
2. **Present the leaf on the pull call; do not store leaf PEM in Postgres.**
   Store still keeps fingerprint-only (plus prior FP overlap). The Agent
   already has `tls.crt` locally; each pull sends `certificate_pem` +
   RSA-SHA256 over `agentId` + newline + unix `signedAt`. CP verifies issued-by Agent CA,
   fingerprint bound to `agent_id`, then signature. Persisting PEM at
   issue time was considered and **rejected as unnecessary complexity**
   for an hourly (or rarer) call — and it would grow a column of full
   certs we do not otherwise need.
3. **Hash-only bearer storage stays.** Raw token is returned at issue/pull
   only; DB has current (+ prior-in-overlap) hashes. Pull **re-issues**
   with overlap so multi-instance fleets do not break. Same one-way
   discipline as bootstrap.
4. **Agent:** No Day-1 seed needed. After enroll, the bearer lives at
   `FABRIC_AGENT_CERT_DIR/agent-api.token`, refreshed by
   `POST /v1/agents/:id/api-token/current` every `FABRIC_AGENT_TOKEN_REFRESH`
   (default 1h). PoP-authenticated (leaf private key signs challenge),
   so the very first pull works with only the leaf — no bootstrap of
   the bearer credential separately.
5. **Optional CP job** `FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL` re-issues
   with overlap; Agents pick up on next pull — no customer Secret rolls.
6. **Design review flag for any future credential:** Agent pull over the
   existing CP HTTPS channel, or reject the design.

Day‑1 issues only bootstrap out of band (no bearer seed);
Day‑N refresh of leaf and bearer is fully automatic.

Ticket / ops: `L3-CRED-01` Done; Runbook + `Tenant-App-UI-Checklist.md` §0.

### Platform Ambient (G-MESH-1) — Spec §5.4 reminder

- **ztunnel:** Platform L4; privileged; Customer Environments never run it.
  **Required** on pathways A1, A2 (after Gateway), A3 (before Gateway), B1,
  and B4.
- **waypoint:** Platform optional L7 (HTTP/gRPC). Default provision per
  namespace; omit only when L7 is genuinely unused. Never parses database
  protocols; never replaces Gateway authorization.
- **Packaging (locked):** reuse Istio Ambient (`istioctl` profile `ambient`);
  Day-0 scripts and ops live in `deploy/platform/ambient/` and the
  Operational Runbook Ambient step. Do **not** install Ambient on Customer
  Agent clusters.

---

## Part 3 — Filling the one gap the Spec left open: how does a Platform service actually dial the Gateway?

This is the single most substantial thing this codebase decided beyond
what the Spec specifies, so it gets its own section rather than a table
row. Internally this is referred to by its short code, **G-A3-1** — that
label is this repository's own shorthand, not Spec vocabulary, though the
*existence* of the gap it resolves is now named directly in Spec §8.3, §8.8,
and §14's addressing note for A3/B4.

**The gap, stated precisely:** the Spec's hop chains for A3 and B4 correctly
name every component in the chain — waypoint (optionally), ztunnel, the
Gateway, the tunnel, the Connect Agent — but never says how a Platform
service actually addresses *which tenant's* Gateway path it wants to reach.
Worth being equally precise about what this is *not*: it is not the same
question as §14 item 3 (Agent selection), which is about picking among
multiple eligible Connect Agent instances *after* the right registration has
already been identified. G-A3-1 answers the step before that — how the
Platform service names the destination at all.

**This codebase's answer:** a Platform service dials an ordinary-looking DNS
name that encodes both the tenant and the registration — for example
`<registration_id>.<tenant_id>.connect.fabric`. That name resolves to one
shared, per-tenant Gateway inbound endpoint; the Gateway reads which name
was actually dialed (via TLS SNI, or the original destination hostname),
looks up the matching registration, authorizes it, and only then reaches
out over the existing tunnel to the right Connect Agent. Written out against
the Spec's own hop order, to make clear this doesn't reorder anything:

```text
A3 (Service), Spec order preserved:
  Platform Service -> (optional waypoint) -> ztunnel
    -> dials <registration_id>.<tenant_id>.connect.fabric
    -> Gateway (reads SNI -> looks up registration -> authorizes -> picks an Agent)
    -> tunnel -> Connect Agent -> Customer Service

B4 (Resource), Spec order preserved, no waypoint:
  Platform Service -> ztunnel
    -> dials <registration_id>.<tenant_id>.connect.fabric
    -> Gateway -> Connect Agent Adapter -> tunnel -> Connect Agent -> Customer Resource
```

**Why this scales the way it needs to:** the actual product constraint
driving this design was that a human should only ever have to do setup work
**once per tenant**, never once per registration.

| What | How often does a human touch it | Who actually does it |
|---|---|---|
| The tenant's shared inbound Gateway endpoint | Once, at onboarding | Automated the moment the tenant goes Active |
| The DNS name for one specific registration | Never — created automatically | Controller automation, the instant a registration reaches Active |
| The actual listening process / load balancer | Shared across every registration for that tenant | Nothing new is opened per registration |

The number of DNS records naturally grows with the number of registrations,
and that's fine — it's fully automated. What's deliberately avoided is
opening a new Ghostunnel listener or load balancer per registration, since
that would scale operational surface with registration count rather than
staying flat. B4 cannot use HTTP waypoint paths; hostname / original-dst
mapping is the TCP-friendly approach.

**One alternative considered and rejected**: a single hostname per tenant,
with no way to distinguish which registration is meant. That would leave
a Platform service with no way to say "I mean *this* customer database,
not that one" without inventing an entirely separate SDK or protocol just
to carry that information — the per-registration DNS name is the simpler
answer precisely because it reuses DNS itself as the addressing mechanism,
rather than building a new one.

---

## Part 4 — Decisions this codebase made beyond what the Spec strictly requires

These are real, deliberate product decisions — not gaps, not oversights —
but they go slightly further than the Spec's own minimum, so they're kept
visibly distinct from Parts 1–3's resolutions of genuinely open Spec
questions.

**An extra approval checkpoint on top of bootstrap (G-BOOT-1 + Approve).**
The Spec's bootstrap flow already establishes that a Connect Agent uses one
single mTLS tunnel for both its initial bootstrap handshake and all later
data traffic, with the security enforcement point being individual
application streams, not the tunnel itself. This codebase adds one more
explicit state on top of that: after certificate issuance, a newly
bootstrapped Agent sits in `PendingApproval`, and no data stream is
permitted through until a human — normally the tenant's own administrator
in the Platform Controller UI (scoped to that tenant), though a Platform
operator can act as an audited break-glass, and an `auto_approve_agents`
setting exists for trusted or development tenants — explicitly approves it.
The tunnel can be, and often is, fully up during this waiting period; only
the data-carrying streams are gated. Bootstrap tokens are multi-redeem for
their expiry window (L3-AGT-02) and
stored hashed in Postgres (`ablv_tenant_connect`); the raw token is shown
once in the UI.

**B2's hairpin is an accepted invariant, not a limitation someone forgot to
optimize away.** Customer-to-customer-resource traffic always routes out to
the Gateway and back, even when source and destination are sitting right
next to each other on the customer's own network. That's deliberate: it
keeps every authorization decision and every audit record centralized,
with no special-cased shortcut for the case where it might look
unnecessary.

**Agent selection (Spec §14 item 3).** Among Agents that are Connected or
Degraded, not explicitly `reachable=false`, prefer `reachable=true`, then
fewest open Gateway→Agent streams. If none are eligible, the stream outcome
is `DESTINATION_UNAVAILABLE` — not a silent fallback to a random Agent.

**Specific default quota numbers.** The Spec establishes that the Gateway
should have per-tenant limits (§14 item 8, as a named risk needing a
decision); this codebase picked concrete starting defaults — 50 concurrent
tunnels, 2,000 concurrent streams, 100 stream-opens per second — configurable
per tenant, not hardcoded.

**`max_tunnels` after `L3-AGT-02` (locked).** With multi-instance identity
shipped, each Agent process consumes a real tunnel slot. **Decision: keep
default 50** — enough for typical clusters; large fleets use
`POST /v1/tenants/:id/quotas`. What *must* change is product/onboarding
behavior: set `max_tunnels >=` planned Agent instance count
(Kubernetes nodes running the DaemonSet, or ECS tasks with the
sidecar) at tenant onboard, and warn in the tenant app if planned count
exceeds the cap. Do not raise the global default “just in case” without an
explicit fleet-size policy.

**Revocation and stale-vs-emergency (items 5 and 11).** Fingerprint list on
`ablv_tenant_connect` plus control-plane → Gateway push (`/internal/revoke`).
A security-cause revoke force-closes immediately and does not wait on Agent
generation refresh. Decommission-cause revoke drains, then force-closes.

**Optional strict substrate binding at enrollment.** A tenant can opt into
checking a newly enrolling Agent against an expected substrate fingerprint.
This is a repo-only decision. (An earlier draft incorrectly cited Spec
§10.1 — that section is "Three Phases," the Day-0/1/N lifecycle overview,
and has nothing to do with substrate binding. The wrong citation is not
repeated here.)

**G-A2-1 — Platform service `host`.** Registration `host` for
`PLATFORM_SERVICE` is Fabric-reachable DNS name of the Platform Service.
After Gateway authz on A2, the Gateway dials into Ambient (`ztunnel` →
optional `waypoint` → Platform Service).

**Controller blast radius (item 9).** High-risk mutations (tenant suspend,
cert revoke, registration delete, substrate-binding changes) require
dual-control (`X-ABLV-Break-Glass`) in addition to the control-plane Bearer
token when those tokens are configured.

---

## Part 5 — Ghostunnel: the exact configuration, and why each flag is what it is

Sources: [ghostunnel man page](https://ghostunnel.dev/docs/reference/manpage-linux/),
[Access Control Flags](https://ghostunnel.dev/docs/security/access-flags/),
[PROXY protocol](https://ghostunnel.dev/docs/networking/proxy-protocol/).

Ghostunnel runs in exactly one place — the Gateway pod — and nowhere else.
The Connect Agent is a plain Go TLS client; it carries its own certificate,
but it never runs Ghostunnel itself.

| Side | What it actually does |
|---|---|
| Connect Agent | Ordinary TLS client, presenting its own certificate to the Gateway |
| Ghostunnel (Gateway pod) | TLS server — terminates the Agent's mTLS connection, forwards the decrypted connection onward |
| Gateway dispatch | Everything after that: yamux multiplexing, the StreamOpen handshake, and the actual Registration-based authorization decision |

```text
Agent (TLS client)
  --mTLS--> Ghostunnel server  [Gateway pod]
              --unix + PROXY tls-full--> Gateway dispatch (yamux / authz)
```

Ghostunnel itself is a single, small, statically-linked Go binary —
tens of megabytes, not a full Fabric data-plane component — which is
precisely why it's an acceptable, low-overhead thing to run as a sidecar
on the Gateway pod specifically, and precisely why it was never considered
for the Connect Agent side at all.

The actual flags this deployment uses, and the documented reasoning behind
each one:

```text
ghostunnel server \
  --listen 0.0.0.0:8443 \
  --target unix:/var/run/fabric/gateway.sock \
  --cert <gateway-chain.pem> \
  --key <gateway-key.pem> \
  --cacert <platform-intermediate-ca.pem> \
  --allow-all \
  --proxy-protocol-mode=tls-full \
  --status http://127.0.0.1:6060 \
  --timed-reload 300s
```

- **`--allow-all`** — Ghostunnel's own documentation describes this
  precisely as "allow all clients with a valid certificate, regardless of
  subject." That's the right choice here specifically because the
  Intermediate CA (via `--cacert`) already scopes which certificates are
  trusted at all, and the finer-grained question — *which tenant may reach
  which destination* — is deliberately kept as the Gateway's job, not
  Ghostunnel's. Ghostunnel's own OPA-based policy hook is intentionally
  never used for this reason: that decision needs a live lookup against the
  Registration Store, which is not the kind of thing a static policy engine
  in front of the Gateway is well suited to do.
- **`--cacert`** — trusts only this Platform's own Intermediate CA, nothing
  else.
- **`--proxy-protocol-mode=tls-full`** — forwards the full, verified client
  certificate (not just connection metadata) to the Gateway's dispatch
  logic, so it can read the tenant identity that authenticated the
  connection. The Gateway's own dispatch code is required to actually parse
  this PROXY protocol v2 header — that's a real, documented backend
  requirement of using this mode, not optional.
- **`--target unix:...`** — forwards only to a local Unix socket, never back
  out over the network.
- **`--timed-reload`** — lets certificates rotate without needing to
  restart or redesign the process.
- **Deliberately not used**: `--allow-policy`/OPA, `--allow-cn` allowlists,
  `--disable-authentication`. None of these are needed once Registration
  authorization is correctly centralized in the Gateway itself.

This configuration is treated as locked, sourced directly from Ghostunnel's
own documentation — not something waiting on a future proof-of-concept to
decide between `--allow-all` and an OPA-based alternative. A proof-of-concept
is still valuable, but for confirming this configuration behaves correctly
under real load and a real multi-tenant certificate set, not for choosing
between it and some other approach.

---

## Part 6 — ORM / store pointer

- TypeScript control plane: **Sequelize** models/migrations for
  `ablv_tenant_connect`, `ablv_registrations`, `ablv_agents`.
- FK → `ablv_tenants(tenant_id)`.
- An ORM swap later should not change table DDL — keep migrations as SQL
  (or Sequelize migrations that emit clear SQL).
- Full column lists and Access API shapes:
  **`Level-3-Store-OIDC-Spec.md`**.

---

## Part 7 — What's actually still open

Kept short and honest.

| Item | Who owns closing it |
|---|---|
| Cert-expiry scan / alert (`L3-PKI-01` remainder) | Implementation (same job family as token rotate) |
| OCI NLB + Gateway push DNS wiring (`L3-OPS-01`) | Platform Day 0 ops (config; code side shipped) |
| Real sample request/response JSON for the Access API (R1/R2) | Product/integration work, later |
| ECS substrate support, including its idle-connection behavior validation | Deferred |
| The actual OIDC-enablement scripts for EKS and RKE2 | Implementation, once prioritized |

---

## Part 8 — What's actually built and working today

This section exists so nobody has to guess "is this real, or just planned."
Narrative first, then the ticket-linked status table.

**Quotas (L3-GW-02)** are live at the Gateway (`quota.Tracker`), reading
their limits from the tenant's own configuration row (`POST /v1/tenants/:id/quotas`).
Exceeding the concurrent-stream or rate limit produces a distinct
`RETRY_LATER` outcome, separate from an actual authorization failure
(`UNAUTHORIZED`) — the two are never conflated.

**Heartbeat-driven degradation** is live: a control-plane watchdog
(`FABRIC_HEARTBEAT_DEGRADED_AFTER`) marks a Connected Agent as Degraded after
a period of missed heartbeats, and a fresh heartbeat or an explicit
tunnel-up event recovers it back to Connected automatically.

**The per-tenant DNS addressing from Part 3** is fully built, both for
local development (a static CoreDNS wildcard) and for production (a real
reconciler, `control-plane/src/dns/reconciler.ts`, continuously polling
every tenant's Active `CUSTOMER_SERVICE`/`CUSTOMER_RESOURCE` registrations
and keeping the desired DNS record set in sync). Two provider backends ship
today — writing the desired records to a file for an external sync process
to pick up, or POSTing them to a webhook. Wiring that webhook to a specific
real-world DNS provider (Route53, Cloud DNS, an internal IPAM system) is
deliberately left as an operational integration step; no specific provider
is assumed anywhere in the architecture itself.

**Certificate revocation** now has both halves working: the fingerprint
list plus Gateway polling, and a control-plane-to-Gateway push path
(`/internal/revoke`) so revocation doesn't have to wait for the next poll
cycle. By design, there's still no Ghostunnel-native CRL mechanism —
Ghostunnel itself holds no authorization state at all (ADR-002 / ADR-007).

**Install-time ACL templates** are complete for Kubernetes (a NetworkPolicy)
and VM (systemd plus firewall rules plus a hosts-writer). ECS only has an
example security-group configuration so far; a full task-definition
template is deferred (`L3-POC-ECS`).

**The cause-based drain/force-close split** — whether a suspended or revoked
tenant's existing traffic gets a grace period or is cut immediately — is
fully implemented and tested for both suspension and certificate revocation
(`"billing"` vs `"security"` for suspension; `"decommission"` vs `"security"`
for revocation). Streams belonging to a Registration that's left the Active
state are now correctly force-closed after their grace window too, scoped
precisely to that one tenant-and-registration pair — not the entire tunnel,
and not any other registration sharing it. (`Updating` registrations are
left untouched by design.)

**Graceful shutdown** is implemented on the Gateway: a `SIGTERM` stops it
from accepting anything new, then gives in-flight relays a configurable
grace window (`FABRIC_SHUTDOWN_GRACE`, default 25 seconds) to finish before
exiting.

**In-place registration updates** are implemented: a registration's name,
host, or port can be changed without deleting and recreating it, moving
`Active → Updating → Active` and bumping its internal generation number.
If the update itself turns out to be invalid, the registration is restored
to its exact prior configuration and stays Active — never left stuck
mid-update (`L3-GW-06`).

**The wire-level `StreamOpenResult` outcome enum** is finalized to exactly
five values — `ACCEPTED`, `UNAUTHORIZED`, `NOT_FOUND`,
`DESTINATION_UNAVAILABLE`, `RETRY_LATER` — with `PENDING_APPROVAL` handled
as a specific reason string attached to an `UNAUTHORIZED` outcome, rather
than as a sixth wire-level value of its own. Protocol version enforcement
is also live: the Gateway rejects an out-of-range `StreamOpen.protocol_version`
before authorization logic ever runs.

**Platform Ambient packaging** ships under `deploy/platform/ambient/`
(ztunnel + optional waypoint). Local Ambient L4 paths can be exercised with
`deploy/local/k3d/ambient/smoke-ambient.sh` on a Platform Kubernetes
cluster; the default compose smoke remains Gateway + Agent only.

### Status table (ticket-linked)

| Item | Status | Notes |
|---|---|---|
| L3-GW-02 quotas | **Done** | `quota.Tracker`; `RETRY_LATER` vs `UNAUTHORIZED`; limits from `ablv_tenant_connect` |
| Heartbeat → Degraded | **Done** | CP watchdog (`FABRIC_HEARTBEAT_DEGRADED_AFTER`) |
| G-A3-1 DNS (local) | **Done** | CoreDNS wildcard for local dev |
| G-A3-1 DNS (prod reconciler) | **Done** | `control-plane/src/dns/reconciler.ts`; `file` and `webhook` providers |
| G-A3-1 DNS (live cloud DNS API) | Ops | Webhook receiver against the real DNS backend is ops-owned |
| L3-CTL-01 auth (local) | **Partial** | Scoped Agent API token (1a) Done; dual-control Done; mTLS writers later |
| G-CRED-1 / L3-CRED-01 Agent credential pull | **Done** | Leaf PoP `api-token/current`, file store, refresh loop, overlap + optional CP rotate job |
| Platform Ambient (ztunnel + CNI) | **Done** (L4 verified on k3d Platform) | `deploy/platform/ambient/` + `smoke-ambient.sh`; re-verify on real Platform at cutover |
| Optional waypoint (A1/A2/A3) | **Packaged** | `waypoint-apply.sh`; Spec §5.4 optional L7; not required for A1 L4 / B1 |
| Local Ambient E2E (A1/B1 L4) | **Done** (2026-07-25) | ztunnel HBONE access logs; waypoint CRDs optional |
| Revoke CRL + push (L3-PKI-01) | **Partial** | Issue + revoke + rotate Done; expiry CronJob still open; no Ghostunnel-native CRL by design |
| ACL install templates (L3-ACL-01..03) | **Done** (K8s/VM) / **Partial** (ECS) | ECS full task def deferred to `L3-POC-ECS` |
| Suspend cause (L2 §G.3) | **Done** | `"billing"` drain-then-force-close; `"security"` immediate |
| Revoke cause (L2 §D.3) | **Done** | `"decommission"` drain vs `"security"` force-close |
| In-flight stream drain, Registration Deleting (L2 §G.3 row 1) | **Done** | Scoped to `(tenant_id, registration_id)` after grace |
| Gateway graceful shutdown (L2 §H.2) | **Done** | `SIGTERM` + `FABRIC_SHUTDOWN_GRACE` (default 25s) |
| Registration Update (L2 §A.2 / §G.5 / §F.3) | **Done** | `POST /v1/registrations/:id/update`; restore on failure |
| Strict substrate binding | **Done** | Optional per-tenant enrollment check (repo-only; not Spec §10.1) |
| `protocol_version` enforcement (L2 §J.4) | **Done** | Rejected before authz |
| `StreamOpenResult` enum (L2 §J.3) | **Done** | Five wire values; `PENDING_APPROVAL` → `UNAUTHORIZED` + reason |

Ghostunnel `--allow-all` is **locked from official docs** (not a PoC open
question). Authorization is still enforced in the Gateway after PROXY
identity.

---

## Part 9 — Post-v1 architecture evolution

### Cert auto-rotation (D3-AUTO, shipped)

Leaf TTL reduced from 825 days to **7 days** (`FABRIC_AGENT_CERT_DAYS`).
Agent `certlife.StartLoop` checks remaining life every `FABRIC_CERT_CHECK_INTERVAL`
(default 1h) and rotates at 50% of total TTL. Same industry pattern as
Teleport tbot / SPIRE / Vault Agent.

**Always on by default** (`FABRIC_CERT_AUTO_ROTATE` defaults to enabled;
set `=0` only as a debugging escape hatch) — not gated behind an
opt-in flag. Short-lived certs make identity loss cheap everywhere
(re-enroll takes seconds), so there's no substrate-specific reason to
withhold rotation the way the pre-`identity.Store` hostPath-only design
needed to.

Plan: 7d → **24h** after monitoring confirms stability. At 24h, revocation
becomes belt-and-suspenders rather than a critical control.

Manual `FABRIC_AGENT_ROTATE=1` retained for emergency/compromise — not routine ops.

### Identity storage abstraction (`identity.Store`, shipped)

`connect-agent/internal/identity` defines a `Store` interface (`Load`,
`SaveCert`, `SaveAPIToken`, `Paths`) that every identity-touching package
(`certlife`, `cptoken`, `tunnel.Dial` via `Paths()`, main.go's enroll
flow) now depends on instead of raw file paths. Two implementations ship:

- **`identity/file`** — plain directory, byte-for-byte the pre-refactor
  behavior. Default for VM, ECS, Docker, or a Kubernetes install that
  wants to keep hostPath.
- **`identity/k8ssecret`** — per-node Kubernetes Secret (RBAC:
  get/create/patch on Secrets), with a local file cache. A cache miss
  (e.g. after a Pod recreate wipes an `emptyDir` cache) transparently
  falls through to fetching the Secret and re-warming the cache before
  returning — so callers above the Store never observe the miss.

This supersedes `PRODUCTION-READINESS.md`'s original D2 (hostPath vs PVC
vs "document only") — see that doc's **D2-NEW** for the full write-up.
`FABRIC_IDENTITY_STORE=kubernetes` is the `daemonset.yaml` default going
forward; `FABRIC_IDENTITY_STORE=file` remains supported for hostPath
installs or non-Kubernetes substrates.

**Extension point:** a third substrate-specific `Store` (Vault, cloud
KMS) is one new package implementing the four-method interface, plus one
`case` in `main.go`'s `newIdentityStore` — no changes anywhere else.

### Join method abstraction (`enroll.Method`, shipped)

`connect-agent/internal/enroll` defines a `Method` interface
(`Credentials(ctx) (Credentials, error)`) answering "how does this Agent
instance prove it may enroll," independent of `identity.Store`'s "where
does the resulting identity live." One implementation ships:
`enroll/bootstrap.Method`, wrapping today's `FABRIC_BOOTSTRAP_TOKEN` flow.
`enroll/bootstrap` also hosts the shared enroll HTTP call and CSR
generation, since those are common to every `Method`.

This is the extension point for **L4-CLOUD-JOIN** below — a future
`oci.Method` / `awsiam.Method` / `k8soidc.Method` implements the same
interface by fetching a platform-native attestation instead of reading
an env var; `main.go`'s enrollment control flow does not change.

### SPIFFE-compatible SAN (D9, shipped)

`issueLeafFromCsr` now embeds `subjectAltName=URI:spiffe://fabric.abluva.io/tenant/<tid>/agent`
in the leaf certificate extensions. This gives:
- Cryptographic tenant binding verifiable at TLS layer
- SPIFFE-compatible URI for future ecosystem interop
- Service-level identity via the existing `<reg_id>.<tenant_id>.connect.fabric` DNS

Does NOT require SPIRE, workload attestation, or per-pod SVIDs.

### Multi-region Gateway (L4-MULTI-REGION, future)

See `PRODUCTION-READINESS.md` — 3-phase evolution from single-cluster
replicas to geo-distributed active/active Gateways.

### Cloud-native join (L4-CLOUD-JOIN, future)

See `PRODUCTION-READINESS.md` — OCI instance principal, AWS IAM join,
GCP metadata attestation as alternatives to bootstrap token. Builds on
`L3-EVID-01` workload evidence infrastructure.

### Substrate strategy (D10)

Shipped, not just planned: `deploy/connect-agent/k3s-appliance/install.sh`
is a real single-command installer (k3s + Agent DaemonSet), and is the
**recommended default for VM/bare-metal**, not a "v2, only if you have
multiple services" fallback. The reliability layer k3s brings — liveness/
readiness probes, resource limits, rolling updates, Secret-backed identity
parity with the Kubernetes path — is the point on its own, independent of
whether the customer runs one companion service or several. The plain
systemd single-binary path (`deploy/connect-agent/systemd/`) still exists
and still works, but is now the simplest-case fallback, not the default
recommendation. Kubernetes customers use `tenant-start.sh` (a Helm chart
is planned, not yet shipped); ECS uses a task-definition template; Docker
uses `docker compose`.
