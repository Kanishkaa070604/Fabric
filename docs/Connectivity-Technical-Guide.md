# Fabric Connectivity Technical Guide

**One document for the full connectivity story.** For any pathway or
credential, one read should answer: which components are involved, what config
drives each hop, what the Gateway checks and in what order, what’s on the wire,
what is automatic vs human, and how customer apps dial.

Normative hop chains remain `Architecture-Spec.docx` §8. This guide explains
and implements them. Day‑0/1/N *copy-paste commands* stay in
`Operational-Runbook.md` — this guide is the coherent narrative those commands
implement.

**Related (narrow roles — do not re-read mid-flow for architecture):**

| Document | Role |
|---|---|
| `Architecture-Spec.docx` | Frozen hop chains, ADRs, vocabulary |
| `Architecture-Resolutions.md` | §14 decisions, G-* IDs |
| `Operational-Runbook.md` | Operator curls / kubectl |
| `PRODUCTION-READINESS.md` | Locked D1–D8 product decisions |
| `Validation-Plan.md` | Smoke matrix |
| `deploy/connect-agent/README.md` | K8s / VM / ECS packaging detail |
| `Level-3-Store-OIDC-Spec.md` | Postgres + Access API (`X-ABLV-Tenant-ID` ≠ data plane) |
| `Developer-Reference.md` (+ `.docx`) | Schemas, wire shapes, manifests, state machines — Part 17 |

---

## Part 1 — The problem

Two networks that were never designed to trust each other:

- **Platform** — infrastructure you (the SaaS vendor) operate.
- **Customer Environment** — the tenant’s Kubernetes, ECS, or VMs.

Goal: **only pre-approved traffic crosses the boundary** — no customer inbound
firewall holes, no privileged interceptors on customer nodes.

| Component | Role |
|---|---|
| **Control plane** | Tenants, Agents, registrations, health, DNS desired-state. Never proxies app bytes. |
| **Gateway** | Sole **yes/no** for cross-boundary data streams (ADR-002). |
| **Connect Agent** | Outbound dial, local listeners, byte relay, observed reachability. **Never** authorizes. |
| **ztunnel / waypoint** | Platform Ambient only (Parts 3–4). |

---

## Part 2 — Four networking ideas

### 2.1 Outbound-only dialing

Once TCP is up, either side can send. The Agent always **dials out**; Platform
→ Customer still rides that same tunnel.

### 2.2 TLS and mTLS

TLS verifies the server. **mTLS** also verifies the client certificate. Every
Agent↔Gateway connection is mTLS.

### 2.3 Multiplexing (yamux)

One long-lived mTLS connection carries many independent **streams**. One Agent
instance ⇒ one tunnel, many concurrent flows.

### 2.4 Service mesh (Platform only)

Kubernetes moves packets; Ambient adds mTLS / optional HTTP policy on the
**Platform** cluster only.

---

## Part 3 — What never runs on the customer side

**ztunnel** needs elevated capabilities. Spec ADR-001 forbids that on customer
infrastructure. Ambient exists **only** on Platform Kubernetes.

The Connect Agent listens on an **explicit** port; apps dial it on purpose.
No transparent redirect → no special node capabilities for the Agent process
itself. (Identity uses a per-node K8s Secret by default — Part 6.3 — no
node filesystem dependency or PSA exception needed.)

---

## Part 4 — ztunnel and waypoint (Platform)

| Component | Layer | Role | When |
|---|---|---|---|
| **ztunnel** | L4 | Per-node mTLS / L4 policy between Platform pods | A1; Platform legs of A2/A3/B1/B4 |
| **waypoint** | L7 HTTP/gRPC | Optional retries, timeouts, policy | Services only; **never** Resource/DB |

Retry ownership:

- Tunnel drop → **Agent** reconnect (backoff, cap 30s, never gives up).
- Platform HTTP with waypoint → waypoint may retry.
- App hang / 5xx without waypoint → **calling app**.
- DB down → **ORM / driver**, not Fabric.

---

## Part 5 — Core vocabulary

| Term | Meaning |
|---|---|
| **the tunnel** | Long-lived Agent→Gateway mTLS + yamux. Never “ztunnel.” |
| **yamux** | Many streams on one tunnel. |
| **stream** | One logical conversation; starts with `StreamOpen` / `AgentDial`. |
| **ztunnel** | Platform Ambient L4. |
| **waypoint** | Optional Platform HTTP/gRPC L7. |
| **hairpin** | Customer↔customer still via Gateway (A4/B2) for central authz/audit. |
| **G-A3-1** | Spec §8.3/§8.8 inbound DNS/SNI addressing ([This repo] ops label). |

### Tunnel layers

1. **mTLS TCP** — Agent dials Gateway (prod: NLB `:8443`).
2. **yamux** — keepalive / write timeout via `FABRIC_YAMUX_KEEPALIVE` /
   `FABRIC_YAMUX_WRITE_TIMEOUT` (defaults **30s** / **10s**, Agent and
   Gateway). Keepalive must stay below NLB/NAT idle timeout. Reconnect with
   exponential backoff + jitter (start 1s, double, **cap 30s**, reset on
   success; never stop until process exit). Cert auto-rotate force-reconnects
   after successful persist (~0.5–1s delay).
3. **Stream handshake** — identify tenant + registration; then raw bytes.

```text
Connect Agent --mTLS--> Ghostunnel (Gateway pod)
                         --Unix + PROXY tls-full--> Gateway (yamux + authz + relay)
```

Public NLB: **PROXY/PPv2 off**. Ghostunnel alone speaks PROXY to the Gateway
Unix socket.

---

## Part 6 — Every credential: what it proves and its lifecycle

Four credentials. Conflating any two is the most common confusion.

**End-to-end workflow** (ensure → bootstrap validity/expiry → enroll →
leaf → bearer → refresh / failures): see Operational-Runbook
[Flow (happy path + expiry + refresh)](#flow-happy-path--expiry--refresh)
under “Credentials.” Debug map: Runbook
[Troubleshooting](#troubleshooting).

### 6.1 Bootstrap token

**Proves:** this install may enroll Agents for tenant X — nothing else.

- Issued: `POST /v1/tenants/:id/bootstrap-token` (UI / admin).
- **Multi-redeem within expiry** (“single install window,” not single
  redemption). Security bound is `bootstrap_expires_at`.
- Stored hashed only; raw shown once in install snippet.
- Revoke: `POST …/bootstrap-token/revoke`.
- Human: Day‑1 only.

### 6.2 CA trust bundle (`ca.crt`)

**Proves:** nothing alone — Agents use it to verify Ghostunnel’s server cert.

- Platform PKI at Day 0; rare Root/Intermediate rotation.
- Mounted read-only (`FABRIC_AGENT_CA_FILE`). Tenant never mints it.
- Install Secret is **CA-only** — never a shared Agent leaf.

### 6.3 Agent leaf (`tls.crt` + `tls.key`)

**Proves:** *this* Agent instance. Ghostunnel verifies it; Gateway keys the
tunnel registry on cert fingerprint.

- Agent generates keypair + CSR locally; key never leaves the instance.
- CP signs CSR at enroll → leaf + `agent_id`.
- **One leaf per instance** (node / task / VM host) — never shared.
- **SAN identity (D9):**
  `URI:spiffe://fabric.abluva.io/tenant/<tenant_id>/agent` — cryptographic
  tenant binding without SPIRE.
- **TTL:** Default **7 days** (`FABRIC_AGENT_CERT_DAYS` on CP); plan to
  tighten to 24h after auto-rotation is proven in prod.
- **Identity store:** DaemonSet sets `FABRIC_IDENTITY_STORE=kubernetes`
  (per-node Secret; emptyDir is cache only). Binary/VM default is `file`.
  Plain `emptyDir` with `file` store ⇒ every pod recreate re-enrolls ⇒ new
  `agent_id` ⇒ re-approve.
- Human: approve once per new instance only when `auto_approve_agents` is
  **off** (high-security); default is auto-approve on.

**Steady-state rotate (D3-AUTO — always on):**

```text
certlife tick (FABRIC_CERT_CHECK_INTERVAL, default 1h)
  → remaining life ≤ 50% of TTL?
       no  → wait
       yes → RotateLeaf:
              Load on-disk leaf → CSR + leaf PoP → POST /v1/agents/:id/rotate
              CP: current FP = new; prior FP accepted for DEFAULT_CERT_OVERLAP_SECONDS (300s)
              SaveCert (Secret-first if k8s; then local paths)
              forceReconnect → dial presents new leaf within ~0.5–1s backoff
```

Manual / emergency only: `FABRIC_AGENT_ROTATE=1` (one-shot rollout) or writer
`POST /v1/agents/:id/rotate`. Clear the env flag after the rollout.

**Failure handling (read Agent logs by event name):**

| Situation | What happens | Log cues | Recovery |
|---|---|---|---|
| CP unreachable / PoP reject / rotate HTTP error | Full rotate retried every **30s** (not the full 1h) until success | `cert_auto_rotate_failed`, ticker shortened | Fix CP/network; no operator rotate needed |
| CP rotate **OK**, `SaveCert` **fails** | CP already has new FP. Agent caches PEMs and retries **persist only** every 30s — **does not** call CP again (a second rotate would stomp the single prior-FP slot and strand the on-disk leaf) | `cert_auto_rotate_persist_pending` → `…_persist_retry_failed` / `…_success` | Fix identity store (RBAC, disk, Secret quota). After success: reconnect fires |
| Persist broken for > ~300s after CP commit | Prior FP expires → StreamOpen authz fails; further PoP-on-rotate with old leaf → `cert_not_bound_to_agent` | Traffic down; rotate keeps failing | Writer rotate **or** wipe identity + re-enroll (bootstrap window) |
| Success path | New leaf on disk; tunnel redials immediately | `cert_auto_rotate_success`, `cert_auto_rotate_reconnecting` | — |

Overlap (300s) is a **safety margin** for cutover, not the intended steady
state. Force-reconnect after successful persist is what makes cutover prompt.

### 6.4 Agent API bearer

**Proves:** scoped CP REST (`enroll`, list regs, `observed`, `rotate`) —
**not** the tunnel. Cannot suspend / revoke-cert / delete registrations.

- No Day‑1 seed — Agent pulls after enroll via leaf PoP.
- Steady state: `POST /v1/agents/:id/api-token/current` every
  `FABRIC_AGENT_TOKEN_REFRESH` (default **1h**; `0` disables the loop).
- **D1 reuse:** sending `current_agent_api_token` while still fresh returns
  the same bearer (no mint). Mint near expiry or `force_renew`. Prior-hash
  overlap on mint keeps sibling DaemonSet pods alive.
- File: `$FABRIC_AGENT_CERT_DIR/agent-api.token` (or Secret key when using
  kubernetes store).
- **Writer revoke of bearer:** watch/list gets **401** until the next
  hourly PoP pull issues a new token. That lockout is intentional; shorten
  `FABRIC_AGENT_TOKEN_REFRESH` (e.g. `5m`) only if ops need faster recovery.
- CP mass-rotate job (`FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL`) stays **off**
  for v1 (D4-A).

### 6.5 Lifecycle under failure (tunnel, CP, drain)

These postures are intentional — not temporary shortcuts.

| Event | Data plane (tunnel / StreamOpen) | Control plane REST | Notes |
|---|---|---|---|
| **CP down** | Live relays keep running. **New** StreamOpen → `RETRY_LATER` (`authz_lookup_failed`). `ReconcileSecurity` skips revoke checks that need CP until it returns | Enroll / watch / observed / rotate soft-fail or CrashLoop on first-boot enroll | Killing all tunnels when CP dies would be worse |
| **Gateway rolling update** | Draining replica refuses new streams with `RETRY_LATER` / `reason=gateway_draining`; in-flight relays drain for `FABRIC_SHUTDOWN_GRACE`. Idle tunnels die when the process exits; Agent reconnects (backoff, cap 30s) | Unaffected | Prefer `stream_open_rejected` over raw EOF in Agent logs |
| **ReserveTunnel CP blip at bind** | Tunnel stays accepted; bind/reserve retried every 500ms. Only real quota exhaustion tears the session down | — | Logs: `tunnel_reserve_deferred` vs `tunnel_quota_denied` |
| **Tunnel drop** | Agent dial loop: backoff+jitter (1s → … **cap 30s**), never gives up until process exit | — | After successful dial, backoff resets to 1s |
| **Fresh enroll, CP down** | No identity → `os.Exit(1)` | — | DaemonSet CrashLoopBackOff **is** the retry |
| **Observed non-2xx** | Local probe still correct; report dropped | Next 5s tick retries | `FABRIC_PROBE_GRACE` (15s) covers a few misses |
| **Agent states** | See `Developer-Reference.md` state machine | Tunnel up does not imply `Connected` — need approve | `PendingApproval` → deny StreamOpen until approve |

```text
Enroll → PendingApproval → (approve) → Connecting → Connected
Connected ↔ Degraded          (heartbeat stale / recover)
* → Disconnected → Connected  (tunnel down / up)
* → Retired                   (terminal; Gateway force-closes live tunnel)
```

---

## Part 7 — Day 0 / Day 1 handshake (continuous)

### 7.1 Day 0 — Platform (before any tenant)

1. Root CA (offline) + Intermediate (signs Gateway + Agent leaves).
2. Istio Ambient: `deploy/platform/ambient/install-ambient.sh` (ztunnel + CNI).
3. Gateway + Ghostunnel in-pod (`deploy/gateway/deployment.yaml`, **replicas: 2**).
4. Control plane (`FABRIC_STORE=postgres`), DB creds via Access API.
5. OCI NLB TCP passthrough, **`is_ppv2enabled = false`**.
6. DNS reconciler live (`FABRIC_DNS_RECONCILE_ENABLED`, Part 11).

### 7.2 Day 1 — Tenant credentials (admin / UI)

These are **admin/UI → control plane** calls. They are **not** Agent
`/enroll`.

1. `POST /v1/tenants/ensure` with body `{ "tenant_id": "…" }` — **idempotent
   get-or-create** of Fabric tenant profile (quotas defaults, suspend
   flags empty, etc.). Path has **no** `:id` segment; the id is in the JSON
   body. Re-calling with an existing id returns the row as-is (it does
   **not** patch quotas — use `/quotas`). SaaS tenant row must already
   exist outside Fabric. Named **ensure** (not `create`) because callers can
   safely repeat it: “make sure this Fabric profile exists.”
2. `POST /v1/tenants/:id/bootstrap-token` — issue the Day‑1 enroll window
   (multi-redeem until `bootstrap_expires_at`). No Agent API seed: after
   enroll the Agent pulls its bearer via leaf PoP.
3. Optional: `POST /v1/tenants/:id/quotas` (defaults: 50 tunnels, 2k streams,
   100 opens/s).
4. Install snippet: bootstrap token + `ca.crt` + `FABRIC_GATEWAY_ADDRESS` +
   `FABRIC_TLS_SERVER_NAME`.

**Later, on the Agent (not this step):** `POST /v1/agents/enroll` with
bootstrap + CSR → leaf. Full path list: Runbook API catalog (must match
`control-plane/src/http/server.ts`). Credential chain: Runbook Flow + §6.1–6.5.

### 7.3 Day 1 — Customer installs Agent

1. `tenant-start.sh` (K8s) or VM/ECS equivalent — sets **NO_PROXY** for Gateway
   host (top support trap).
2. Namespace, CA Secret, bootstrap Secret, DaemonSet, Service, RBAC,
   NetworkPolicy example; identity on **K8s Secret** (`FABRIC_IDENTITY_STORE=kubernetes`, default).
3. Each instance: CSR enroll → leaf written to identity store → dial Gateway → often
   `PendingApproval` while tunnel is already up.

### 7.4 Approve

`POST /v1/agents/:id/approve` (or `auto_approve_agents`). If tunnel already up
→ `Connected`; else `Connecting` until dial succeeds.

### 7.5 Create registration

`POST /v1/registrations` — validate + return **`Active`** or **`Failed`**
(sync). Within ~one Agent poll (~5s): local listener; if
`FABRIC_K8S_SERVICE_MANAGE_ENABLED=1`, Service ports updated.

App dials `connect-agent.<ns>.svc:<port>` (Part 12). Expect 5–10s before first
dial is reliable.

L2 also defines Requested → Validating → Provisioning → Active; **Failed →
retry** drives Failed → Validating → … → Active (`POST …/retry`). DNS only for
**Active** inbound `CUSTOMER_*` (Part 11).

---

## Part 8 — Ghostunnel and the Gateway authz pipeline

Identical for every cross-boundary pathway. Pathways only change hops *before*
and *after* this sequence.

### 8.1 Ghostunnel (Gateway pod only)

```text
ghostunnel server
  --listen 0.0.0.0:8443
  --target unix:/var/run/fabric/gateway.sock
  --cert … --key … --cacert <intermediate>
  --allow-all
  --proxy-protocol-mode=tls-full
  --shutdown-timeout=25s   # match FABRIC_SHUTDOWN_GRACE; pod grace 45s
```

- `--allow-all` + Platform CA: TLS layer only. Registration authz is Gateway.
- `tls-full`: verified client cert to Gateway via PROXY v2 (tenant identity
  without Gateway parsing TLS).
- Align Ghostunnel shutdown with Gateway drain or Kubernetes SIGKILLs mid-drain.

### 8.2 Authorization pipeline (every stream)

1. Read `StreamOpen` (`tenant_id`, `registration_id`, `connectivity_type`,
   optional `workload_evidence`, `protocol_version`).
2. **Claim vs tunnel identity** — stream `tenant_id` must match cert→Agent→tenant
   (inbound A3/B4: SNI supplies reg+tenant). Mismatch → `UNAUTHORIZED`.
3. **One** `FetchAuthzContext` (registration, suspend, revoke list, quotas,
   eligible Agents).
4. Tenant suspended → `UNAUTHORIZED`.
5. Cert fingerprint revoked → `UNAUTHORIZED`.
6. Quota → `RETRY_LATER` (capacity, not authz).
7. Registration must exist for `(tenant_id, registration_id)` and be usable
   (`Active`; `Updating` per update rules). Other states → specific deny.
8. `connectivity_type` must match registration.
9. Workload evidence → audit only (never authz gate by default).
10. Destination Adapter (`DIRECT_ENDPOINT` / `PLATFORM_CONNECTOR` /
    `CONNECT_AGENT`) — dial failure → `DESTINATION_UNAVAILABLE`.
11. `StreamOpenResult`: `ACCEPTED` | `UNAUTHORIZED` | `NOT_FOUND` |
    `DESTINATION_UNAVAILABLE` | `RETRY_LATER`.
12. Allow and deny audited with shared `correlation_id`.

### 8.3 Registrations store reachability, not credentials

| Field | Meaning |
|---|---|
| `connectivity_type` | `SERVICE` \| `RESOURCE` |
| `destination_kind` | `PLATFORM_*` \| `CUSTOMER_*` |
| `host` / `port` | Where Agent or Gateway dials after “yes” |

DB passwords / OIDC secrets: apps or Access API — never the registration row.

---

## Part 9 — How Gateway knows `tenant_id` — what apps see

| Path | Trusted source |
|---|---|
| Agent-originated (A2/A4/B2/B3) | Cert FP → Agent → `tenant_id`; StreamOpen `registration_id` |
| Platform inbound (A3/B4) | SNI `<registration_id>.<tenant_id>.<domain>` (`pinbound`) |

`X-ABLV-Tenant-ID` is Access/CP vault traffic — **not** the data plane.

Gateway is **L4** after accept — it does **not** inject HTTP headers into app
traffic. Platform callers encode identity in the **hostname**; customer apps
know their tenant from deploy config. Need headers → your app or L7 proxy.

---

## Part 10 — The eight pathways

Hop chains are Spec order. Config/retry notes are [This repo].

### Quick reference

| ID | Chain (short) | GW | ztunnel | waypoint |
|---|---|---:|---:|---:|
| A1 | PS → ztunnel → [wp] → ztunnel → PS | No | Yes | Opt |
| A2 | CS → Agent → tunnel → GW → ztunnel → [wp] → PS | Yes | After | Opt |
| A3 | PS → [wp] → ztunnel → GW → tunnel → Agent → CS | Yes | Before | Opt |
| A4 | CS → Agent → tunnel → GW → tunnel → Agent → CS | Yes | No | No |
| B1 | PS → ztunnel → Platform Connector → PR | No | Yes | No |
| B2 | CS → Agent → tunnel → GW → Agent → CR | Yes | No | No |
| B3 | CS → Agent → tunnel → GW → Platform Connector → PR | Yes | No | No |
| B4 | PS → ztunnel → GW → Agent → CR | Yes | Yes | No |

```text
PLATFORM: A1/B1 stay in Ambient; A2/A3/B3/B4 touch Gateway
                │
                └── Agent↔Gateway mTLS + yamux ──┐
CUSTOMER: listeners + local dials ◄──────────────┘
          A4/B2 always hairpin through Gateway
```

### A1 — Platform → Platform service

```text
Platform Service → ztunnel → [optional waypoint] → ztunnel → Platform Service
```

No Gateway/Agent. No tenant-specific config.

### A2 — Customer → Platform service

```text
Customer Service → connect-agent.<ns>.svc:<port> → Agent
  → tunnel → Ghostunnel → Gateway (Part 8)
  → ztunnel → [optional waypoint] → Platform Service
```

Registration `host`/`port` = Platform target (`DIRECT_ENDPOINT`). Customer dials
**Agent Service port** (different number). Retry: transport to Gateway = Agent;
Platform HTTP = optional waypoint; tunnel drop mid-request = **app** decides.

### A3 — Platform → Customer service (DNS/SNI)

```text
Platform Service → [optional waypoint] → ztunnel
  → dial <registration_id>.<tenant_id>.connect.fabric
  → Gateway (SNI → reg → Part 8) → tunnel → Agent → Customer Service
```

**Example**

| Tenant | Reg | DNS/SNI |
|---|---|---|
| `ten_acme` | `reg_orders` → `orders.acme.svc:8080` | `reg_orders.ten_acme.connect.fabric` |
| `ten_globex` | `reg_orders` → `orders.globex.svc:8080` | `reg_orders.ten_globex.connect.fabric` |

```yaml
# SaaS config — no Fabric SDK
customers:
  acme:   { orders_base_url: "https://reg_orders.ten_acme.connect.fabric/" }
  globex: { orders_base_url: "https://reg_orders.ten_globex.connect.fabric/" }
```

Many DNS names → **one shared inbound VIP**; multiplex by SNI. One hostname per
tenant was rejected (would need a proprietary dial API to name the registration).

---

### Concrete example: 2 tenants x 2 services each + 2 SaaS services

**Setup:**
- SaaS services: `discovery` and `catalogue` (single deployment, serves all tenants)
- Tenant Alpha (ID `aaa-111`): runs `privacy` (Postgres, 5432) and `sec-interface` (HTTP, 8080)
- Tenant Beta (ID `bbb-222`): same two services
- Domain: `connect.abluva.com` (`FABRIC_GATEWAY_INBOUND_DOMAIN`)

**Registrations (once per tenant):**

```bash
POST /v1/registrations
  { tenant_id: "aaa-111", display_name: "privacy",
    destination_kind: "CUSTOMER_SERVICE",
    host: "privacy-svc.fabric-edge.svc.cluster.local", port: 5432 }
# Response: inbound_hostname_friendly = "privacy.aaa-111.connect.abluva.com"
```

**DNS (Cloudflare Path C):**
- **A** `fabric.abluva.com` → NLB VIP (Agent dial `:8443`)
- **CNAME** `*.connect.abluva.com` → `fabric.abluva.com` (inbound SNI names `:8444`)

Both resolve to the same NLB VIP. Do not use orange-cloud HTTP proxy.

**SaaS deployment (ZERO per-tenant config):**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: discovery
  namespace: platform-services
spec:
  template:
    spec:
      containers:
        - name: discovery
          env:
            - name: FABRIC_CONNECT_DOMAIN
              value: "connect.abluva.com"
            - name: FABRIC_GATEWAY_INBOUND_PORT
              value: "8444"
```

**Application code (standard library, no Fabric SDK):**

```python
import os, psycopg2

FABRIC_DOMAIN = os.environ["FABRIC_CONNECT_DOMAIN"]   # connect.abluva.com
GW_PORT = int(os.environ["FABRIC_GATEWAY_INBOUND_PORT"])  # 8444

@app.route("/discover/<item_id>")
def discover(item_id):
    tenant_id = request.headers["x-ablv-tenant-id"]
    # Convention: <service>.<tenant>.<domain>
    hostname = f"privacy.{tenant_id}.{FABRIC_DOMAIN}"
    # Dial Gateway inbound (8444) with TLS+SNI. Gateway terminates,
    # reads SNI, authorizes, relays Postgres wire through tunnel to Agent.
    conn = psycopg2.connect(host=hostname, port=GW_PORT, sslmode="require")
    # Standard SQL from here -- transparent end-to-end.
```

**Wire path:**
```
discovery dials privacy.aaa-111.connect.abluva.com:8444
  DNS (Cloudflare wildcard) -> NLB IP
  TLS; SNI = privacy.aaa-111.connect.abluva.com
  Gateway: SNI -> tenant=aaa-111, reg=privacy (slug lookup)
  AuthorizeInbound -> pick Agent -> yamux stream on tunnel
  Agent dials privacy-svc.fabric-edge.svc.cluster.local:5432
  Bytes: discovery <-> Gateway <-> tunnel <-> Agent <-> Postgres
```

**vs Skupper:**

| | Skupper | Fabric |
|---|---|---|
| App dials | `privacy.<tenant-ns>.svc:5432` | `privacy.<tenant-id>.connect.abluva.com:8444` |
| Port | Real service port | Gateway inbound port (8444) |
| TLS | Optional | Required (SNI = routing key) |

Adding a new tenant = create registrations + install Agent. No SaaS redeploy.

---

### A4 — Customer → Customer service (hairpin)

```text
Customer Service → Agent → tunnel → Gateway → tunnel → Agent → Customer Service
```

Always hairpin — even if colocated. No ztunnel/waypoint.

### B1 — Platform → Platform resource

```text
Platform Service → ztunnel → Platform Connector → Platform Resource
```

No Gateway. Credentials from Access API. Never waypoint.

### B2 — Customer → Customer resource (hairpin)

```text
Customer Service → Agent → tunnel → Gateway → Agent → Customer Resource
```

Pure TCP passthrough (Postgres in-band TLS must not be terminated). App/ORM owns
retry.

### B3 — Customer → Platform resource

```text
Customer Service → Agent → tunnel → Gateway → Platform Connector → Platform Resource
```

No second Agent. Access API credentials. No ztunnel/waypoint on Gateway→resource.

### B4 — Platform → Customer resource

```text
Platform Service → ztunnel → dial <reg>.<tenant>.connect.fabric
  → Gateway → tunnel → Agent → Customer Resource
```

Same addressing as A3. Never waypoint. ETL/backup/reporting pattern.

---

## Part 11 — DNS and registration state

Reconciler (`control-plane/src/dns/reconciler.ts`):

- Record `<registration_id>.<tenant_id>.<domainSuffix>` only when
  `state === "Active"`, not deleted, kind `CUSTOMER_SERVICE`|
  `CUSTOMER_RESOURCE`.
- `tenant_id` = `ablv_tenants.tenant_id`.
- Target = shared Gateway inbound (`FABRIC_DNS_TARGET`) — not one LB per reg.
- Leave Active → record removed. **Failed → `…/retry` → Active → DNS returns.**

| Name | Who dials | Target |
|---|---|---|
| Gateway NLB host | **Agents** outbound | Ghostunnel `:8443` |
| `reg.*.tenant.*.connect.fabric` | **Platform apps** A3/B4 | Shared inbound; SNI multiplex |

Config: `FABRIC_DNS_RECONCILE_ENABLED`, `FABRIC_DNS_PROVIDER` (`file`/`webhook`),
`FABRIC_DNS_TARGET`, Lease election (`FABRIC_DNS_LEADER_ELECTION`) with CP replicas ≥2.

---

## Part 12 — How customer apps dial (K8s / VM / ECS)

Your **app launcher** still deploys your services. Fabric adds Agent install
beside them. **Your applications need zero code changes** — they dial a
hostname:port that happens to route through Fabric tunnel instead of
directly to the target. The protocol (Postgres wire, HTTP, gRPC, raw TCP)
flows through unmodified; Fabric is invisible at the application layer.

**Realistic example (B3 — Customer app → Platform Postgres):**

```yaml
# Before Fabric: app dials Postgres directly
DATABASE_URL: postgres://user:pass@orders-pg.orders.svc:5432/orders

# After Fabric: app dials the Agent's local listener instead — same protocol
DATABASE_URL: postgres://user:pass@connect-agent.fabric-edge.svc:9443/orders
#                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#                                   This is the ONLY change. The Agent
#                                   tunnels this connection to the Platform
#                                   Postgres via the Gateway. The app sees
#                                   a normal Postgres connection.
```

**Realistic example (A3 — Platform service → Customer's orders API):**

```yaml
# Platform service config (no Fabric SDK, no library):
customers:
  acme:   { orders_url: "https://reg_orders.ten_acme.connect.fabric/" }
  globex: { orders_url: "https://reg_orders.ten_globex.connect.fabric/" }
# These DNS names resolve to the shared Gateway inbound VIP.
# The Gateway reads SNI, authorizes, and tunnels to the correct customer.
```

### Kubernetes (GA)

1. `tenant-start.sh` + approve + registrations (shipped path today). A
   Helm chart is **planned, not yet shipped** — no `deploy/connect-agent/`
   chart exists in this repo yet; do not tell a customer to `helm install`
   until one does.
2. Identity: Kubernetes Secret managed by Agent (RBAC: get/create/patch on Secrets).
3. Dial: `connect-agent.<namespace>.svc.cluster.local:<port>`
4. Port map: annotation `fabric.abluva.io/registration-ports` (Agent reconciler).
5. NetworkPolicy: consumers labeled `abluva.io/connect-consumer=true`.

Documented in Runbook + `deploy/connect-agent/README.md`. Smoke:
`smoke-k8s-service.sh`.

### VM / Bare Metal (k3s appliance — recommended even for a single service)

**Why k3s even for one service:** k3s provides liveness/readiness probes,
resource limits, rolling updates with zero downtime, automatic restart with
backoff, and the same K8s-Secret-based identity store as full Kubernetes
customers — all without asking the customer to "install Kubernetes." It's
a single 60MB binary underneath; the customer sees one install command.

The plain systemd path (`deploy/connect-agent/systemd/`) still works for
the simplest case (one binary, restarted on crash, identity on local disk),
but it lacks probes, resource limits, rolling updates, and the Secret-based
identity store. **For production customers, prefer the k3s appliance** —
it gives operational parity with K8s customers and means one packaging
path to maintain, not two.

Install: `curl -sSL https://install.fabric.abluva.io | sh -s -- --token=<BOOTSTRAP>`.
Namespace is fixed **`fabric-edge`**. Apps that run as **pods on that k3s**
dial like full K8s:

`connect-agent.fabric-edge.svc.cluster.local:<port>`

(port map: `fabric.abluva.io/registration-ports` on `svc/connect-agent`).
Host-OS processes outside k3s cannot use ClusterIP/`127.0.0.1` without
NodePort/`hostPort` — prefer co-locating the app as a pod. See Runbook
[How customer apps dial](#how-customer-apps-dial-service-names--ports).

### ECS

Multi-container task definition (Agent as sidecar). Identity: ephemeral
task storage + re-enroll on task recycle (cheap with 7d auto-rotating certs).
Full task-def template: `L3-POC-ECS`.

### Docker

`docker-compose` with bind-mounted volume for identity. Or `docker run` with
named volume. Same `file.DiskStore` as VM.

---

## Part 12b — Substrate-neutral identity store (shipped)

All substrates share the same Agent binary and protocol. What differs is
**where identity is persisted** — abstracted behind `identity.Store`
(`connect-agent/internal/identity`):

| Substrate | Store | Config | Survives |
|---|---|---|---|
| **Kubernetes** | K8s Secret (per-node, managed by Agent) | `FABRIC_IDENTITY_STORE=kubernetes` | Rollout, drain, pod delete |
| **VM / bare metal** | Local disk (`/var/lib/abluva/...`) | `FABRIC_IDENTITY_STORE=file` (default) | Process restart, reboot |
| **ECS** | Task-ephemeral + re-enroll | `FABRIC_IDENTITY_STORE=file` | Within task; re-enroll on recycle |
| **Docker** | Bind mount / named volume | `FABRIC_IDENTITY_STORE=file` | Container recreate |
| **k3s appliance** | K8s Secret (inside embedded k3s) | `FABRIC_IDENTITY_STORE=kubernetes` | Same as K8s |

**The interface** (`internal/identity/identity.go`):

```go
type Store interface {
    Load(ctx context.Context) (*Identity, error)                     // cert + key + agent-id + api-token, or ErrNoIdentity
    SaveCert(ctx context.Context, agentID string, certPEM, keyPEM []byte) error
    SaveAPIToken(ctx context.Context, token string) error
    Paths() FilePaths                                                 // local file paths every existing reader keeps using
}
```

Two implementations ship today: `identity/file` (plain directory — this
is the pre-refactor behavior, byte for byte) and `identity/k8ssecret`
(per-node Kubernetes Secret, with a local file cache so `tunnel.Dial`,
`certlife`, and `cptoken` need zero code changes regardless of which
`Store` is wired up).

**Why this matters:**
- No hostPath, no PSA exceptions, no emptyDir-vs-hostPath decisions —
  `k8ssecret.Store`'s local cache can be plain `emptyDir`, because a cache
  miss (Pod recreate) transparently re-fetches from the Secret
- Auto-rotation (`certlife`) writes through the Store; `tunnel.Dial` reads
  the Store's `Paths()` — neither package knows which `Store` is active
- The entire hostPath-vs-PSA decision (formerly `PRODUCTION-READINESS.md`
  D2) is now a config choice (`FABRIC_IDENTITY_STORE`), not an architecture
  fork
- Adding a new `Store` (Vault, cloud KMS, **or a future “workload identity
  projected volume” backend**) means one new package + one `case` in
  `main.go`'s `newIdentityStore` — no other package changes. The Store
  must still materialize PEM files at `Paths()` so `tunnel.Dial` /
  `certlife` keep working.

**Workload identity / SPIFFE later:** two seams, both already interfaces:

| Need | Interface | Today | Plug-in shape |
|---|---|---|---|
| Where leaf + bearer **persist** | `identity.Store` | `file`, `k8ssecret` | New Store that syncs PEMs to/from your WI-backed secret store; keep `Paths()` warm |
| How instance **proves enroll** | `enroll.Method` (D11) | `bootstrap` token | e.g. OCI instance principal / K8s SA JWT Method that still returns CSR→leaf via CP |

Per-pod SPIFFE SVIDs replacing the Agent leaf are **deferred**
(Architecture-Resolutions R4b) — that is a larger protocol change, not a
drop-in Store. Using WI only to **protect or fetch** the existing leaf
material is the easy plug-in path via `identity.Store`.

**The companion interface — `enroll.Method`** (`internal/enroll`) answers a
different question: not "where does identity live" but "how does an
Agent instance prove it may enroll in the first place." Shipped today:
`enroll/bootstrap.Method` (the existing `FABRIC_BOOTSTRAP_TOKEN` flow).
Designed so a future cloud-native join method (OCI instance principal,
AWS IAM, a Kubernetes pod's own ServiceAccount token — see
`PRODUCTION-READINESS.md` "Cloud-native join") is a new `Method`
implementation, not a change to `main.go`'s enrollment control flow.

```go
type Method interface {
    Credentials(ctx context.Context) (Credentials, error)
}
```

**UI implication:** Tenant onboarding asks "What infrastructure?" to
generate the correct install snippet (`FABRIC_IDENTITY_STORE` +
substrate-specific manifest). That answer is the UI/SaaS app's own
onboarding state — Fabric's control-plane has no tenant install-flavor
column (`tenant.substrate_type` is **not** a real field; see
`Tenant-App-UI-Checklist.md` → Install flavor). The only substrate signal
Fabric itself stores is each *Agent's* own
`substrate` field, reported at enroll (`kubernetes` / `ecs` / `vm`),
which is per-instance, not per-tenant.

---

## Part 13 — Gateway robustness

`deploy/gateway/deployment.yaml`: **replicas: 2**, Service `:8443` + `:9090`
(revoke push in-cluster only), `FABRIC_SHUTDOWN_GRACE` 25s, Ghostunnel shutdown
matched, pod grace 45s, `FABRIC_REGISTRATION_DRAIN_GRACE` 3m (billing/delete;
security revoke immediate via `ReconcileSecurity` ~2s).

**SIGTERM drain order:** stop accepting new Agent tunnels →
`BeginDraining` (new StreamOpen → `RETRY_LATER` / `gateway_draining`) →
`AwaitDrain` for in-flight relays → process exit. Idle tunnels (zero
streams) are not held; Agents reconnect on their own backoff.

Dead Gateway pod drops **its** yamux sessions. Agents **keep reconnecting**
(Part 5) until a healthy replica accepts mTLS — SaaS↔customer for that Agent
stays down until then. Cap 30s between attempts is intentional (faster recovery
than a multi-minute max backoff). After a successful cert rotate, the Agent
force-closes the session and pays only the post-success backoff (~0.5–1s).

CP: replicas 2+ with DNS Lease. Optional HPA/PDB = Platform SRE choice.

---

## Part 14 — Configuration catalog

Defaults and recommended values below match code + shipped manifests.
Operator-facing “if you set it wrong” narrative also lives in
`Operational-Runbook.md` (Environment variables). Keep both in sync when
changing a default.

### 14.1 Gateway + Ghostunnel

| Variable | Default | Recommended | Notes |
|---|---|---|---|
| `FABRIC_SHUTDOWN_GRACE` | `25s` | **`25s`** | Drain in-flight streams on SIGTERM. Must be **<** pod `terminationGracePeriodSeconds`. |
| Ghostunnel `--shutdown-timeout` | (lib default 5m) | **Same as** `FABRIC_SHUTDOWN_GRACE` | Sibling process in the pod. |
| `terminationGracePeriodSeconds` | often `30` | **`45`** (manifest) | Must exceed grace + Ghostunnel timeout. |
| `FABRIC_REGISTRATION_DRAIN_GRACE` | `3m` | **`3m`** | Billing/delete stream drain. Security revoke ignores this. |
| `FABRIC_DESTINATION_DIAL_TIMEOUT` | `10s` | `5s`–`15s` | Dial Platform / AgentDial timeout. |
| `FABRIC_REVOKE_PUSH_LISTEN` | unset | **`0.0.0.0:9090`** | In-cluster only — never public NLB. |
| `FABRIC_YAMUX_KEEPALIVE` | `30s` | leave default; **below NLB/NAT idle** | Dead-tunnel detection. |
| `FABRIC_YAMUX_WRITE_TIMEOUT` | `10s` | leave default | yamux stream write deadline. |

### 14.2 Control plane

| Variable | Default | Recommended | Notes |
|---|---|---|---|
| `FABRIC_STORE` | `memory` | **`postgres`** in prod | Memory loses state on restart. |
| `FABRIC_CONTROL_PLANE_TOKEN` | empty | **required Secret** | Writer/admin bearer. |
| `FABRIC_DUAL_CONTROL_TOKEN` | empty | **required** for suspend/revoke/delete | Second factor; fail closed if missing. |
| `FABRIC_HEARTBEAT_DEGRADED_AFTER` | `90s` | **`90s`** | Connected → Degraded when heartbeats stop. |
| `FABRIC_PROBE_GRACE` | `15s` | leave default | New regs eligible before first probe. |
| `FABRIC_AGENT_CERT_DAYS` | `7` | **`7`** now; plan **`1`** later | Leaf TTL at issue/rotate. |
| `DEFAULT_CERT_OVERLAP_SECONDS` | `300` | leave | Prior FP accepted after rotate (code constant). |
| `FABRIC_CERT_EXPIRY_SCAN_INTERVAL` | `6h` | **`6h`** | Safety-net scan only (`0` = off). |
| `FABRIC_CERT_EXPIRY_WARN_WITHIN` | `48h` | **`24h`–`72h`** | Warn window; hit ⇒ auto-rotate failing. |
| `FABRIC_CERT_EXPIRY_WEBHOOK_URL` | unset | **Secret** `fabric-cert-expiry-webhook` | Unset → log only. |
| `FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL` | off | **Leave off (v1)** | Mass bearer mint; Agent hourly pull covers hygiene. |
| `FABRIC_GATEWAY_PUSH_DNS_NAMES` | — | in-cluster SVC | Revoke push target; port **9090**, not NLB `:8443`. |
| `FABRIC_DNS_*` | see Part 11 | **on** in prod for A3/B4 | Required for inbound DNS. |
| `FABRIC_ENSURE_SAAS_TENANT` | off | **Never in prod** | Local smoke only. |

### 14.3 Connect Agent

| Variable | Default | Recommended | Notes |
|---|---|---|---|
| `FABRIC_GATEWAY_ADDRESS` | required | Platform NLB `host:8443` | Raw mTLS dial target. |
| `FABRIC_TLS_SERVER_NAME` | — | Gateway cert DNS SAN | SNI / verify name. |
| `FABRIC_TENANT_ID` | required | install snippet | Tenant scope. |
| `NO_PROXY` / `no_proxy` | — | **Must include Gateway host** | Tunnel is not HTTP; proxies break it. |
| `FABRIC_CONTROL_PLANE_URL` | — | Public CP HTTPS | Enroll, watch, token, rotate. |
| `FABRIC_BOOTSTRAP_TOKEN` | — | Day‑1 Secret; revoke when window closes | Multi-redeem enroll. |
| `FABRIC_CONTROL_PLANE_TOKEN` | — | **Removed** | Bearer comes from leaf PoP pull. |
| `FABRIC_IDENTITY_STORE` | `file` (binary) | **`kubernetes`** (DaemonSet) | `kubernetes` = per-node Secret + emptyDir cache; `file` = disk/hostPath. |
| `FABRIC_IDENTITY_NAMESPACE` | in-cluster ns | leave | k8s store only. |
| `FABRIC_IDENTITY_SECRET_PREFIX` | `connect-agent-identity` | leave | Secret name = prefix + node. |
| `FABRIC_NODE_NAME` | — | **required** with k8s store | Downward API `spec.nodeName`. |
| `FABRIC_AGENT_CERT_DIR` | `/etc/connect-agent/tls` | leave | Leaf paths / cache dir. |
| `FABRIC_AGENT_CA_FILE` | `$CertDir/ca.crt` | Platform CA mount | Trust Ghostunnel. |
| `FABRIC_AGENT_ID_PATH` | `/var/run/abluva/agent-id` | leave | Local agent-id mirror. |
| `FABRIC_AGENT_API_TOKEN_FILE` | under cert dir | leave | Optional override path for bearer file. |
| `FABRIC_AGENT_TOKEN_REFRESH` | `1h` | **`1h`** (`0` = off) | PoP pull cadence; faster only if revoke recovery must be quicker. |
| `FABRIC_CERT_AUTO_ROTATE` | **on** (unset) | leave on | Set `0` only to debug. |
| `FABRIC_CERT_CHECK_INTERVAL` | `1h` | **`1h`** (7d TTL); **`15m`** if TTL→24h | Healthy check cadence. Failures shorten to **30s** in-process. |
| `FABRIC_AGENT_ROTATE` | unset | **Unset**; `1` one-shot then clear | Emergency mid-life rotate at startup. |
| `FABRIC_YAMUX_KEEPALIVE` | `30s` | leave; **< NLB/NAT idle** | Must match Gateway side intent; Agent and Gateway both read this name. |
| `FABRIC_YAMUX_WRITE_TIMEOUT` | `10s` | leave default | Same name on Gateway. |
| `FABRIC_SUBSTRATE` | `kubernetes` | `kubernetes` / `ecs` / `vm` | Reported at enroll. |
| `FABRIC_K8S_SERVICE_MANAGE_ENABLED` | off in code | **`1`** in DaemonSet | Patch Service ports to match regs. |
| `FABRIC_LOG_LEVEL` | `info` | `info` | — |

### Easy to confuse

| This | Is not |
|---|---|
| API bearer refresh (`FABRIC_AGENT_TOKEN_REFRESH`) | Leaf rotate (`FABRIC_AGENT_ROTATE` / D3-AUTO) |
| Cert-expiry webhook | Tenant-configurable |
| Revoke push `:9090` | Tunnel `:8443` |
| Registration drain grace | Security revoke (immediate) |
| Pod shutdown grace | Registration drain grace |
| `cert_auto_rotate_failed` (pre-commit) | `cert_auto_rotate_persist_pending` (CP already committed) |
| `tunnel_reserve_deferred` | `tunnel_quota_denied` |

---

## Part 15 — Who does what

| Action | Owner | Auto / human |
|---|---|---|
| Root/Intermediate CA | Platform PKI | Manual, rare |
| Tenant + bootstrap | Tenant admin UI | Manual, Day‑1 |
| Enroll (CSR → leaf) | Each Agent | Automatic after install |
| Approve Agent | Tenant admin / auto-approve | Once per instance |
| Create registration | Admin / automation | Per resource |
| DNS record | CP reconciler | Automatic when Active |
| Leaf rotate | Agent `certlife.StartLoop` (D3-AUTO) | **Automatic** (emergency: `FABRIC_AGENT_ROTATE=1`) |
| API bearer refresh | Agent hourly PoP+reuse | Automatic |
| Revoke (compromise) | Platform writer API | Trigger manual; Agents pull after |

---

## Part 16 — Smoke and troubleshooting

| Script | Proves |
|---|---|
| `smoke-k3d-tenant.sh` | Enroll→day‑N cross-boundary suite |
| `smoke-k8s-service.sh` | Multi-reg Service ports |
| `smoke-lifecycle.sh` | Retired force-close + SIGTERM drain |
| `smoke-ambient.sh` | A1/B1 L4 |
| `smoke-dns-lease.sh` | DNS Lease failover |

| Symptom | Layer |
|---|---|
| A1 fails | Ambient — not Agent |
| PendingApproval deny | Approve (G-BOOT-1) |
| `DESTINATION_UNAVAILABLE` | No eligible Agent / reachable / generation |
| `RETRY_LATER` | Quota, CP authz lookup down, **or** `gateway_draining` — check `reason` |
| Inbound SNI fail | DNS / VIP / hostname shape |
| Stuck `Connecting` | Dial, certs, **NO_PROXY** |
| Empty reply on deny | Check Gateway `stream_denied` |
| `cert_auto_rotate_persist_pending` looping | Identity store write failing after CP already rotated — fix RBAC/disk before overlap (~300s) expires |
| `cert_not_bound_to_agent` on rotate | Prior FP gone; Agent stranded — writer rotate or wipe + re-enroll |
| Watch `status=401` for ≤1h | Bearer revoked; wait for next `FABRIC_AGENT_TOKEN_REFRESH` PoP pull (or lower the interval) |
| Spurious Agent reconnect flaps | NLB/NAT idle **<** `FABRIC_YAMUX_KEEPALIVE` (Agent and Gateway) |

---

## Part 17 — Developer Reference

**Canonical:** `Developer-Reference.md` (Word export: `Developer-Reference.docx`).

Concrete schemas, `StreamOpen` wire shapes, Agent/Gateway packaging facts,
state machines, sequence diagrams, and the shipped repo layout. Narrative
“why” stays in this Connectivity guide; DDL stays in
`Level-3-Store-OIDC-Spec.md`.

Historical pre-L3 skeleton (wrong on hostPath / Certificate Controller leaf /
open storage): `Developer-Reference.pre-l3-skeleton.docx` — do not use for
implementation.

---

## Appendix A — Terms (short)

Tunnel / ztunnel / waypoint / Registration / Hairpin / G-A3-1 / Active — see
Part 5 and Part 11.

## Appendix B — Implementation status

| Capability | Status |
|---|---|
| A2–A4 / B2–B4 | Implemented; tenant smoke |
| A1/B1 Ambient L4 | Packaged + smoke |
| Credentials B.1–B.4 as Part 6 | Implemented (D1/D2/D4/D5) |
| G-A3-1 + DNS reconciler | Implemented; cloud DNS = ops |
| Gateway replicas: 2 + drain | Shipped |
| Inject tenant HTTP headers to apps | **Not v1** |
| ECS full GA | `L3-POC-ECS` |
| Developer-Reference.md / .docx | **Rewritten** (Part 17); old skeleton archived |

## Appendix C — File index

| Topic | Location |
|---|---|
| Runbook | `docs/Operational-Runbook.md` |
| Readiness D1–D8 | `docs/PRODUCTION-READINESS.md` |
| Gateway deploy | `deploy/gateway/deployment.yaml` |
| Agent install | `deploy/connect-agent/` |
| DNS | `control-plane/src/dns/` |
| Inbound SNI | `gateway/internal/pinbound/` |
| Authz | `gateway/internal/dispatch/` |
| Token PoP+reuse | `control-plane/src/http/server.ts`, `connect-agent/internal/cptoken/` |
| Agent reconnect | `connect-agent/cmd/connect-agent/main.go` |
