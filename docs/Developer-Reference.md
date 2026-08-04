# Developer Reference

Concrete schemas, wire shapes, manifests, state machines, and repository
layout for Level‑3 implementation.

**Companion to:** `Architecture-Spec.docx` (Level 1), `L2-Design.docx` (Level 2),
and the narrative in `Connectivity-Technical-Guide.md`.

**Purpose:** Make Spec/L2 decisions typeable. Nothing here invents a new
architecture decision. Prefer **this markdown + live code/manifests** over any
older Word skeleton.

| Need | Go here instead |
|---|---|
| Why / pathways / credentials story | `Connectivity-Technical-Guide.md` |
| Day‑0/1/N commands | `Operational-Runbook.md` |
| Postgres columns / Access API | `Level-3-Store-OIDC-Spec.md` |
| Locked product packaging (D1–D8) | `PRODUCTION-READINESS.md` |

IDs in production APIs and Postgres are **plain UUIDs** (no `tnt_` / `reg_`
prefixes). Examples below may use short labels for readability.

---

## Part 1 — Schemas and configuration shapes

### 1.1 Registration (system of record)

Corresponds to Spec §2.2 / §7, L2 Part A.2. TypeScript:
`control-plane/src/store/types.ts` (`Registration` / `RegistrationState`).

```yaml
# Semantic shape — storage is Sequelize → Postgres (Level-3-Store-OIDC-Spec)
registration:
  id: "<uuid>"                         # platform-generated, immutable
  tenant_id: "<uuid>"                  # FK to ablv_tenants.tenant_id; every
                                       # lookup is (tenant_id, id) together
  generation: 7                        # bumps on desired-state change
  connectivity_type: "RESOURCE"        # SERVICE | RESOURCE (fixed at create)
  destination_kind: "CUSTOMER_RESOURCE"
  # PLATFORM_SERVICE | CUSTOMER_SERVICE | PLATFORM_RESOURCE | CUSTOMER_RESOURCE
  display_name: "orders-db"            # mutable; never a lookup key
  host: "orders-db.orders.svc.cluster.local"
  port: 5432
  # host/port meaning:
  #   CUSTOMER_*  → reachable from Connect Agent
  #   PLATFORM_*  → reachable from Gateway / Platform Connector after authz
  state: "Active"
  # Requested | Validating | Provisioning | Active | Updating | Deleting |
  # Deleted | Failed
  failure_reason: null                 # set when Failed
  observed: {}                         # per-agent reachability map (JSON)
  inbound_hostname: null               # set for Active CUSTOMER_* inbound
  # e.g. "<reg_id>.<tenant_id>.connect.fabric"
  deleted_at: null
  created_at / created_by / updated_at / updated_by
```

**Create path today:** `POST /v1/registrations` validates and returns
`Active` or `Failed` synchronously. L2 intermediate states still apply on
**retry** (`Failed → Validating → Provisioning → Active` via
`POST /v1/registrations/:id/retry`).

**Credentials never live on this row.** Platform resource secrets → Access API.

**Adapter selection** (`destination_kind` → Gateway code id):

| `destination_kind` | Adapter |
|---|---|
| `CUSTOMER_SERVICE`, `CUSTOMER_RESOURCE` | `CONNECT_AGENT` |
| `PLATFORM_SERVICE` | `DIRECT_ENDPOINT` |
| `PLATFORM_RESOURCE` | `PLATFORM_CONNECTOR` |

### 1.2 Agent record

```yaml
agent:
  id: "<uuid>"
  tenant_id: "<uuid>"
  state: "Connected"
  # NotInstalled | Installing | Bootstrapping | PendingApproval | Connecting |
  # Connected | Degraded | Disconnected | Retired
  cert_fingerprint_sha256: "<hex>"
  cert_not_after: "<timestamp>"        # leaf expiry (cert-expiry scan)
  tunnel_state: "up" | "down" | ...
  last_heartbeat_at: "<timestamp>"
  enrollment_approved_by: "<actor>" | null
  substrate: "kubernetes" | "ecs" | "vm" | ...
  deleted_at: null
  # audit columns as above
```

Transitions: `AGENT_TRANSITIONS` in `types.ts`. Selection for
`CONNECT_AGENT`: `Connected` or `Degraded`, not revoked, not
`reachable=false`, matching registration generation; prefer
`reachable=true`, then fewer open streams.

### 1.3 Tenant connect row (Fabric side)

See `Level-3-Store-OIDC-Spec.md` / `ablv_tenant_connect`: bootstrap token
**hash**, Agent API token **hash** + expiry, revoked cert fingerprints
(capped at 500), quotas, `auto_approve_agents`, optional substrate binding.

### 1.4 Connect Agent — Kubernetes manifests

**Authoritative files** (do not invent parallel YAML in docs):

| Artifact | Path |
|---|---|
| Installer | `deploy/connect-agent/tenant-start.sh` + `tenant-start.env.example` |
| DaemonSet + Service + RBAC | `deploy/connect-agent/daemonset.yaml` |
| NetworkPolicy example | `deploy/connect-agent/networkpolicy-example.yaml` |
| Packaging notes | `deploy/connect-agent/README.md` |

**Locked packaging facts:**

- Agent dials **outbound** mTLS to Platform NLB `:8443` (no customer LB for tunnel).
- `connect-agent-tls` Secret is **CA-only** (`ca.crt`). Leaf is **not** pushed
  by a Certificate Controller into that Secret.
- Agent generates CSR locally; CP signs at enroll; leaf + `agent_id` + API
  token file live on **K8s Secret store**
  (`FABRIC_IDENTITY_STORE=kubernetes`, the production DaemonSet default). Legacy
  path: **`hostPath`** `/var/lib/abluva/connect-agent/<namespace>`
  (`FABRIC_IDENTITY_STORE=file`). Never `emptyDir` as the sole identity store
  for production.
- `FABRIC_K8S_SERVICE_MANAGE_ENABLED=1` + Role: Agent patches
  `Service/connect-agent` ports to match Active registrations.
- `internalTrafficPolicy: Local` is **required** (DaemonSet port maps are
  per-node).
- Apps dial: `connect-agent.<ns>.svc.cluster.local:<port>` — port map in
  annotation `fabric.abluva.io/registration-ports`.
- `NO_PROXY` / `no_proxy` **must** include Gateway hostname.

ADR-001 “Never” list = no privileged **traffic intercept** (ztunnel) on
customer nodes. **K8s Secret store is the recommended identity backend**;
hostPath remains supported as a legacy path for existing fleets.

### 1.5 ECS and VM

| Substrate | Location | Status |
|---|---|---|
| ECS | `deploy/connect-agent/ecs/` (SG example + README) | Partial — full task / identity-survives-recycle = `L3-POC-ECS` |
| VM / bare metal | `deploy/connect-agent/systemd/` | Shipped (L3-ACL-03) |

Same protocol: app → local Agent listener → outbound tunnel.

### 1.6 Gateway + Ghostunnel (Platform)

**Authoritative:** `deploy/gateway/deployment.yaml`

```text
# Ghostunnel (sidecar in fabric-gateway pod) — shape, not copy-paste pin
ghostunnel server \
  --listen=0.0.0.0:8443 \
  --target=unix:/var/run/fabric/gateway.sock \
  --cert=… --key=… --cacert=<platform-intermediate> \
  --allow-all \
  --proxy-protocol-mode=tls-full \
  --shutdown-timeout=25s   # match FABRIC_SHUTDOWN_GRACE
```

- **replicas: 2**; Service `:8443` (mTLS) + `:9090` (in-cluster revoke push HTTP).
- Public OCI NLB: TCP passthrough, **`is_ppv2enabled = false`**
  (`deploy/platform/oci/nlb/`).
- Ambient: enroll `fabric-control` / app namespaces — see
  `deploy/platform/ambient/`.

### 1.7 Waypoint / ztunnel

Platform-only. Install: `deploy/platform/ambient/`. Waypoint optional L7 for
**Services** (A1/A2/A3); **never** Resource paths. Sample waypoint apply:
`deploy/platform/ambient/waypoint-apply.sh`. Do not put waypoint CRDs in
customer clusters.

### 1.8 Connectivity protocol — stream messages

**Code:** `gateway/internal/stream/framing.go` (Agent shares the same JSON
frame convention). Wire: **4-byte big-endian length + JSON** (v1).

#### StreamOpen (Agent → Gateway, or inbound path equivalent)

```json
{
  "tenant_id": "<uuid>",
  "registration_id": "<uuid>",
  "connectivity_type": "SERVICE",
  "workload_evidence": null,
  "protocol_version": 1
}
```

`CurrentProtocolVersion = 1`, `MinSupportedProtocolVersion = 1`.

#### StreamOpenResult

Exactly five outcomes (L2 §J.3):

| Outcome | Meaning |
|---|---|
| `ACCEPTED` | Relay bytes |
| `UNAUTHORIZED` | Authz / pending approval / bad version (reason string) |
| `NOT_FOUND` | Missing registration |
| `DESTINATION_UNAVAILABLE` | No eligible Agent / dial failure |
| `RETRY_LATER` | Quota / transient lookup |

`PENDING_APPROVAL` is **not** a wire enum — map to `UNAUTHORIZED` + reason.

```json
{
  "outcome": "ACCEPTED",
  "reason": "",
  "correlation_id": "<id>"
}
```

#### AgentDial (Gateway → Agent on CONNECT_AGENT)

```json
{
  "registration_id": "<uuid>",
  "host": "orders-db.orders.svc.cluster.local",
  "port": 5432
}
```

### 1.9 Agent API token pull (PoP)

`POST /v1/agents/:id/api-token/current`

```json
{
  "certificate_pem": "-----BEGIN CERTIFICATE-----...",
  "signed_at": 1710000000,
  "signature_b64": "<RSA-SHA256 over agent_id\\nsigned_at>",
  "current_agent_api_token": "<optional; enables reuse>",
  "force_renew": false,
  "overlap_seconds": 3600
}
```

Auth = leaf PoP. If current bearer still fresh, CP **reuses** (D1); else mints
with overlap. Refresh interval default **1h** (`FABRIC_AGENT_TOKEN_REFRESH`).

### 1.10 State machines (machine-readable)

**Agent** (`AGENT_TRANSITIONS`):

```text
NotInstalled → Installing → Bootstrapping
  → PendingApproval → Connecting → Connected
Connected ↔ Degraded
Connected / Degraded / Connecting → Disconnected → Connected
* → Retired (terminal)
Bootstrapping → NotInstalled (bad/expired bootstrap)
```

**Registration** (`REG_TRANSITIONS`):

```text
Requested → Validating → Provisioning → Active
Validating | Provisioning → Failed
Active → Updating → Active   (update API; restore on failure)
Active → Deleting → Deleted
Failed → Validating          (retry)
Failed → Deleted             (abandon)
```

**Suspend / revoke causes:** `billing|security` / `decommission|security` —
security force-closes; billing/decommission drain then close
(`FABRIC_REGISTRATION_DRAIN_GRACE`, default 3m).

**Leaf / bearer lifecycle under failure** (auto-rotate, persist-only retry,
CP-down StreamOpen `RETRY_LATER`, drain `gateway_draining`, bearer revoke
lockout): see `Connectivity-Technical-Guide.md` §6.3–6.5 and Part 14
(env defaults). Do not duplicate those tables here.

---

## Part 2 — Sequence diagrams (textual)

### 2.1 Customer onboarding and Agent bootstrap

```text
Admin UI          Control plane           Customer cluster              Gateway
   |                    |                        |                         |
   | ensure tenant      |                        |                         |
   | bootstrap-token    |                        |                         |
   | agent-api-token    |                        |                         |
   | install snippet -->|                        |                         |
   |                    |     tenant-start.sh     |                         |
   |                    |     (CA Secret, bootstrap Secret, DaemonSet)      |
   |                    |                        |                         |
   |                    |<-- POST /v1/agents/enroll (bootstrap + CSR) ------|
   |                    |--- leaf + agent_id --->| write hostPath          |
   |                    |                        |                         |
   |                    |                        |-- mTLS dial NLB:8443 -->|
   |                    |                        |   Ghostunnel → yamux    |
   |                    |                        |   state PendingApproval |
   | POST …/approve     |                        |                         |
   |                    |--- approved ---------->| Connected (if tunnel up)|
   |                    |                        |                         |
   |                    |<-- api-token/current (PoP) ----------------------|
   |                    |--- bearer (reuse/mint) -> agent-api.token        |
```

### 2.2 Customer adds a database (B2 / B4 style registration)

```text
Admin                 CP                      Agent                     Gateway
  | POST /registrations |                       |                          |
  | CUSTOMER_RESOURCE   |                       |                          |
  | host/port           |-- Active ------------>|                          |
  |                     |                       | poll ~5s                 |
  |                     |                       | open listener            |
  |                     |                       | patch Service ports      |
  |                     |                       |                          |
  |  (B2) app dials connect-agent.svc:port      |                          |
  |                     |                       | StreamOpen ------------->|
  |                     |                       |                    authz |
  |                     |                       |<----------- AgentDial ---|
  |                     |                       | dial postgres            |
  |                     |                       |<======== bytes ========>|
  |                     |                       |                          |
  |  (B4) Platform app dials reg.tenant.connect.fabric (SNI) --------------->|
  |                     |                       |<----------- AgentDial ---|
```

DNS: reconciler emits `<reg>.<tenant>.<domain>` only while registration is
**Active** `CUSTOMER_*` → shared inbound target (`FABRIC_DNS_TARGET`).

### 2.3 Gateway restart — failure recovery

```text
Agent                         Gateway pods (replicas ≥ 2) / NLB
  | tunnel on pod A                  |
  |         pod A dies / SIGTERM     |
  | yamux CloseChan                  |
  | log tunnel_disconnected          |
  | sleep backoff+jitter (1s…cap 30s)|
  | dial FABRIC_GATEWAY_ADDRESS again  |
  | ------------------------------- >| healthy pod B accepts mTLS
  | tunnel_ready / agent_running     |
  | streams work again               |
```

Agents **never stop** retrying until process exit. In-flight streams on the
dead pod are lost; SaaS↔customer for that Agent is down until reconnect.
Max backoff **30s** (hardcoded) — intentional for multi-minute Gateway outages
(faster recovery than a multi-minute cap).

---

## Part 3 — Repository layout (as shipped)

```text
fabric/
├── control-plane/          # TypeScript CP (HTTP, store, DNS, jobs, Access client)
│   ├── src/http/server.ts
│   ├── src/store/          # types, sequelize, memory
│   ├── src/dns/            # reconciler, lease, providers
│   └── test/
├── gateway/                # Go Gateway
│   ├── cmd/gateway/
│   └── internal/
│       ├── session/        # yamux, drain, heartbeat report
│       ├── dispatch/       # authorize + adapters
│       ├── stream/         # StreamOpen framing
│       ├── pinbound/       # A3/B4 inbound SNI
│       ├── terminate/      # PROXY tls-full identity
│       └── quota/
├── connect-agent/          # Go Agent
│   ├── cmd/connect-agent/
│   └── internal/
│       ├── cptoken/        # PoP pull + refresh loop
│       ├── watch/          # registrations → listeners
│       ├── k8ssvc/         # Service port reconciler
│       └── tunnel/
├── deploy/
│   ├── gateway/deployment.yaml
│   ├── control-plane/
│   ├── connect-agent/      # tenant-start, daemonset, ecs/, systemd/
│   ├── platform/ambient/
│   ├── platform/oci/nlb/
│   └── local/              # compose + k3d smokes
└── docs/                   # Spec/L2 Word + markdown companions
```

Ghostunnel is the **upstream binary sidecar**, not an in-tree
`ghostunnel_wrapper.go`. Gateway reads identity from PROXY on the Unix socket
(`gateway/internal/terminate/`).

---

## Part 4 — Control-plane HTTP surface (developer index)

Full curls: `Operational-Runbook.md`. Shape reference:

| Area | Examples |
|---|---|
| Auth | `Authorization: Bearer` (writer or Agent-scoped); break-glass `X-ABLV-Break-Glass`; `X-ABLV-Actor` audit-only |
| Tenant | `POST /v1/tenants/ensure`, bootstrap-token, agent-api-token, quotas, suspend, auto-approve |
| Agents | enroll, approve, rotate, retire, `api-token/current` |
| Tenant (high-risk) | suspend, **`revoke-cert` by fingerprint**, registration delete (dual-control) |
| Registrations | create, update, delete, retry, observed |
| Internal | authz-context, tunnel events (Gateway→CP) |
| DNS | reconciler tick (no public “create DNS” API — automatic on Active) |

---

## Part 5 — What replaced the pre-L3 Word skeleton

| Old skeleton assumption | Current |
|---|---|
| Storage technology open | Postgres + Sequelize |
| No hostPath on Agent | hostPath identity (D2-A) |
| Leaf via Certificate Controller Secret | CA-only Secret + CSR enroll to disk |
| Ghostunnel embedded Go wrapper | Sidecar binary + PROXY tls-full |
| Invented `controllers/` tree | `control-plane/`, `gateway/`, `connect-agent/` |

Archived original Word (if present): `Developer-Reference.pre-l3-skeleton.docx`.

---

## Appendix — File index

| Topic | Path |
|---|---|
| Registration / agent types | `control-plane/src/store/types.ts` |
| Wire framing | `gateway/internal/stream/framing.go` |
| Authz | `gateway/internal/dispatch/authorize/` |
| Inbound SNI | `gateway/internal/pinbound/` |
| Token PoP | `connect-agent/internal/cptoken/`, `control-plane/src/http/server.ts` |
| DNS | `control-plane/src/dns/` |
| Store / OIDC | `docs/Level-3-Store-OIDC-Spec.md` |
| Narrative | `docs/Connectivity-Technical-Guide.md` |
