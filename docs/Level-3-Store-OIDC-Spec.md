# Level-3 Spec: Registration Store (Postgres) and Kubernetes OIDC Evidence

**Status:** Frozen — schema, OIDC approach, and Access API request/response
shapes are locked (v6, with later additive columns for suspend/revoke cause
and optional substrate binding). What remains as implementation work is
customer-facing OIDC enable scripts; Postgres persistence itself is already
implemented (`SequelizeStore` when `FABRIC_STORE=postgres`).

This file covers exactly three things: the Postgres schema for Fabric's
own tables, how Kubernetes workload evidence is obtained and verified, and
the shape of every request and response this system makes to the Access
API. Everything here is Level 3 — concrete enough to build against
directly. The architectural reasoning behind *why* Access API exists at all
(never storing resource credentials in a Registration) is
`Architecture-Spec.docx` §14 item 10; this document only holds the wire
shapes that decision implies. Pathway-level and Ghostunnel decisions live
in `Architecture-Resolutions.md`, not here. Document map: `docs/README.md`.

---

## Decision register (quick index)

| ID | Decision |
|---|---|
| P1 | Postgres is Platform/SaaS only |
| P2 | Shared DB; `tenant_id` on Fabric rows |
| P3 | Schema, table prefix, tenant table name — **all configurable** |
| P4 | **Plain UUID** in DB and API (no `tnt_` / `reg_` prefixes) |
| P5–P7 | Audit columns **on each table** (`created_at`, `created_by`, `updated_at`, `updated_by`); no separate audit table; stream allow/deny → structured logs |
| P8 | **3 Fabric tables** + FK to existing tenant table |
| P10 / M1 | TypeScript control plane owns DB via **Sequelize**; Go Gateway read-only / no direct secret env |
| T1 | Existing tenant table: **`ablv_tenants`**, PK column **`tenant_id`** |
| O1 | K8s OIDC evidence only as **first** strategy in v1 (extensible — see Part 4a) |
| O2 | Evidence = Gateway attribution only (not waypoint; not authz) |
| O3 | We ship enable scripts; JWKS must become reachable from Platform |
| O4 | **Any Kubernetes with SA issuer discovery** — EKS, RKE2, **and k3s** (incl. VM k3s appliance). Same `kubernetes_oidc` strategy. |
| O6 | Audience `abluva-connect` |
| O10 | Private clusters: script supports **both** JWKS-only proxy **and** Platform IP allowlist |
| O11 | Evidence **strategy** is explicit and pluggable; Gateway picks verifier by strategy; CP stores per-tenant trust material |
| Secrets | **No DB/secret env vars.** Use Access API → DB creds / vault |
| S1 | Vault secret name prefix default **`ablv-fabric`** (config-driven) |
| S2 | Bootstrap tokens: **hash in Postgres only** (not vault) |
| S3 | Fabric control plane uses **fixed platform** `X-ABLV-Tenant-ID` / `X-ABLV-Environment-ID` from config |
| R1 | `keys#database` response envelope locked (Part 7.3) |
| R2 | secrets-manager get/create/update envelopes locked (Part 7.3) |

---

## Part 1 — The shape of the decisions, stated as facts you can build against

A handful of things are locked and non-negotiable at this point; everything
else in this document explains and elaborates on them.

**This Postgres database belongs to the Platform, not to any customer** —
it stores tenant metadata and Fabric state, never anything that runs on
customer infrastructure. It's a single shared database, with every Fabric
table carrying its own `tenant_id` column rather than one database per
tenant.

**Schema naming is fully configurable** — the schema name, table prefix,
and even which table represents "tenants" are all read from configuration,
not hardcoded, in case this ever needs to run against a differently-named
existing schema.

**IDs are plain UUIDs everywhere** — in the database and across every API
response — deliberately without a prefix convention like `tnt_` or `reg_`.

**Every table carries its own audit columns directly** — `created_at`,
`created_by`, `updated_at`, `updated_by` on each table, rather than one
shared audit table joined against everything. Stream-level allow/deny
decisions are logged as structured log lines instead, not written to
Postgres at all — that volume of event doesn't belong in the relational
store.

**There are exactly three Fabric-specific tables**, plus a foreign key back
to the tenant table that already exists (owned by the main SaaS
application, not created or altered by any Fabric migration).

**The TypeScript control plane owns all writes to Postgres, via Sequelize.
The Gateway, written in Go, only ever reads** — and even that read access
comes from credentials fetched fresh from the Access API, never from a
secret sitting in its own environment variables.

**The existing tenant table is `ablv_tenants`, with `tenant_id` as its
primary key** — every Fabric table's foreign key points there.

**Kubernetes OIDC is the first workload-evidence strategy** — ECS and others
are later strategies behind the same pluggable interface (Part 4a). Evidence
is for attribution in the Gateway audit trail, never authorization, and never
anything waypoint touches.

**The customer, not the Platform, is responsible for making their
cluster's OIDC discovery and JWKS endpoint reachable** — the Platform
ships enable scripts to help with this, but the underlying network
reachability is the customer's to arrange.

**Supported for the `kubernetes_oidc` strategy: any Kubernetes that can
expose SA issuer discovery** — EKS, RKE2, and **k3s** (including the VM
**k3s appliance** path). The appliance is Kubernetes for evidence purposes;
do not invent a separate “VM OIDC” strategy when the Agent runs on k3s.
Plain systemd-on-VM without Kubernetes has **no** SA token path in v1
(`evidence_strategy=none`). The audience value every issued token is checked
against is `abluva-connect`.

**For genuinely private clusters** where the JWKS endpoint can't simply be
made public, the enable script supports two approaches: a narrow
JWKS-only reverse proxy, or an explicit IP allowlist for the Platform's
known egress addresses. Either is acceptable; which one a given customer
uses is their choice.

**No database or vault credential is ever a plain environment variable.**
Every credential this system needs — the Postgres connection itself, any
vault-stored secret — is fetched fresh from the Access API at the moment
it's needed, described in full in Part 7.

**Bootstrap tokens are hashed in Postgres and nowhere else** — never
written to the vault, only ever shown to a human once, at the moment
they're issued.

**The Fabric control plane's own calls to the Access API always use one
fixed platform tenant and environment ID**, read from configuration —
distinct from any individual customer's tenant ID, which only comes into
play if Fabric ever needs to operate on that specific customer's own
vault objects (not something it does today).

A few smaller defaults, worth stating plainly since they're easy to miss in
a schema listing: a registration's customer-facing `display_name` must be
unique per tenant among non-deleted rows; enumerated fields are stored as
plain `text` columns with a `CHECK` constraint, not native Postgres `ENUM`
types (easier to extend later without a migration); private key material is
never written to Postgres under any circumstance; and the starting quota
defaults are 50 concurrent tunnels, 2,000 concurrent streams, and 100
stream-opens per second, per tenant.

---

## Part 2 — Configuration

Nothing in this block is secret — every actual credential comes from the
Access API instead, per Part 7.

```bash
FABRIC_PG_SCHEMA=public
FABRIC_TABLE_PREFIX=ablv_
FABRIC_TENANTS_TABLE=ablv_tenants
FABRIC_TENANTS_ID_COLUMN=tenant_id

# Access API itself — the host below is illustrative; make it configurable
ABLV_ACCESS_URL=http://172.16.1.101:3000/v1/access
ABLV_PLATFORM_TENANT_ID=<platform-tenant-uuid>       # used for the Fabric control plane's OWN db/secrets
ABLV_PLATFORM_ENVIRONMENT_ID=<platform-env-uuid>

# Store backend: memory (tests/default bare process) or postgres (compose / real deploy)
FABRIC_STORE=postgres
```

Every Sequelize model's `tableName` is built from `FABRIC_TABLE_PREFIX`; the
values shown throughout this document (`ablv_tenant_connect`, and so on)
are what that prefix produces by default.

---

## Part 3 — The tables

**`ablv_tenants`** already exists, owned by the main SaaS application. Fabric
tables foreign-key against `ablv_tenants.tenant_id` (a UUID) — Fabric
migrations never create or alter this table itself.

**`ablv_tenant_connect`** is the per-tenant Fabric profile: quota limits, OIDC
issuer configuration, the currently-active bootstrap token's hash, the list
of revoked certificate fingerprints (plus per-fingerprint revoke cause),
suspend flag/cause, and optional strict substrate binding fields. Its
primary key doubles as its foreign key — `tenant_id`, referencing
`ablv_tenants.tenant_id` directly.

**`ablv_registrations`** holds connectivity intent — everything a
Registration needs, including its `observed` state as a JSONB column (the
per-component desired-vs-observed tracking described in
`L2-Design.docx` §10.3).

**`ablv_agents`** holds one row per Connect Agent instance: its certificate
metadata and its enrollment history.

**DDL source of truth:** SQL migrations under `control-plane/migrations/`
(start with `20260723120000-init-fabric.sql`, then additive migrations). The
Sequelize model shapes in Part 5 mirror those migrations and live in
`control-plane/src/db/models.ts`. ORM can change later; **column names and
DDL stay**.

---

## Part 4 — Kubernetes OIDC, end to end

The frozen sequence, in the order it actually happens:

1. The customer runs one of two provided scripts —
   `enable-oidc-eks.sh` or `enable-oidc-rke2.sh`, matching their cluster type.
2. That script enables the cluster's service-account token issuer and JWKS
   endpoint, and arranges for the Platform to actually be able to reach
   discovery and JWKS — either by making them reachable directly, or via
   the allowlist/proxy approach above for clusters that are otherwise
   private.
3. The customer registers their cluster's `issuer_url` through the product
   UI, which is stored on `ablv_tenant_connect`.
4. The Platform probes that discovery endpoint on its own, and sets
   `oidc_enabled` once it succeeds.
5. From that point on, the Connect Agent Pod mounts a **kubelet-projected**
   service account token (audience `abluva-connect`) at
   `FABRIC_EVIDENCE_PATH` (default `/var/run/abluva/evidence/token`) — see
   `deploy/connect-agent/daemonset.yaml`. Fabric never writes that file via
   API; kubelet rotates it. The Agent only reads bytes and puts them on
   StreamOpen.
6. The Gateway verifies those opaque bytes for attribution only. Verification
   pins the accepted algorithm to RS256 in configuration (never read from the
   token itself). Absent token = allowed; present-but-invalid = hard reject.

The exact customer-facing commands for the enable scripts live in
`Operational-Runbook.md` (API quick reference → Workload evidence ops) and
`deploy/connect-agent/enable-oidc-*.sh`.

---

## Part 4a — Extensible workload-evidence strategies (design for L3-EVID-01+)

### Why not “one OIDC blob for everything”

Industry pattern (SPIFFE/SPIRE, Teleport `tbot` attestors, cloud WIF):  
**collect locally by substrate → present a typed credential → verify with a
strategy-specific verifier** that loads trust material from a control plane.
Do not hard-code “always JWKS” in the Gateway; do not overload UI
**install flavor** (K8s vs VM snippet) as the evidence strategy.

### Mapping flavor → evidence strategy

| Customer install (UI row 2) | `agent.substrate` at enroll | Evidence strategy | Notes |
|---|---|---|---|
| Kubernetes (EKS / RKE2 / …) | `kubernetes` | `kubernetes_oidc` | Projected SA token, aud=`abluva-connect` |
| VM / bare metal via **k3s appliance** | `kubernetes` (or `vm` if Agent reports vm — treat **runtime** as k3s) | `kubernetes_oidc` | **Same strategy** — k3s is Kubernetes; enable SA issuer + JWKS reachability |
| VM plain systemd (no k3s) | `vm` | `none` (v1) | No SA token; Agent edge identity only |
| ECS (future) | `ecs` | `ecs_task_identity` | Task IAM / identity doc — separate verifier |
| Docker (future) | — | `none` / TBD | |

**Rule:** if the Agent runs inside Kubernetes (including k3s appliance), use
`kubernetes_oidc`. “VM” in the wizard only means “which install script”;
it does **not** imply a different crypto verifier when the appliance is k3s.

### Pattern: typed evidence + pluggable verifiers

```text
Consumer pod  →  (local collect)  →  Agent attaches evidence on StreamOpen
                                         │
Gateway  ←── AuthzContext includes EvidenceTrust for tenant
         →  VerifierRegistry[strategy].Verify(bytes) → Attribution | RejectBad | AbsentOK
```

1. **Agent (collector):** chooses collector from local reality (`FABRIC_EVIDENCE_STRATEGY` or inferred from substrate). For `kubernetes_oidc`, mount projected token at `FABRIC_EVIDENCE_PATH` (today’s file hook). Optionally prefix/envelope with strategy id so Gateway need not guess.
2. **CP (trust config):** stores which strategies are enabled for the tenant and the URLs/keys to validate them.
3. **Gateway (verifier):** never parses unknown formats; looks up strategy → calls that verifier. Missing evidence = permitted (attribution-only). Present-but-invalid = hard reject (already frozen in Part 4).

Aligns with Teleport’s “attestor per platform” and cloud “OIDC federation per issuer” without requiring SPIRE in v1.

### DB / API fields

**Reuse existing `ablv_tenant_connect` OIDC columns** as the config block for
`kubernetes_oidc` (already landed):

| Column | Role |
|---|---|
| `oidc_enabled` | Strategy armed after discovery probe succeeds |
| `oidc_issuer_url` | Expected `iss` |
| `oidc_jwks_uri` | JWKS fetch |
| `oidc_audience` | Default `abluva-connect` |
| `oidc_allowed_algs` | Pin `RS256` |
| `oidc_ca_bundle_pem` | Optional for private JWKS TLS |
| `oidc_last_discovery_ok_at` / `_error` | Probe health |

**Additive columns (in the single init migration — pre-prod, no optional ALTER):**

| Column | Type | Purpose |
|---|---|---|
| `workload_evidence_strategy` | `TEXT NOT NULL DEFAULT 'none'` | Active primary strategy: `none` \| `kubernetes_oidc` \| `ecs_task_identity` (later) |
| `workload_evidence_config` | `JSONB NOT NULL DEFAULT '{}'` | Strategy-specific extras without new columns per cloud (e.g. ECS audience, allowed task-role ARN prefixes) |

When `workload_evidence_strategy = 'kubernetes_oidc'`, read trust from the
`oidc_*` columns. When `'ecs_task_identity'`, read from
`workload_evidence_config` (and later dedicated columns if needed).  
`oidc_enabled` remains the **discovery-probe gate** for the K8s path
(strategy selected but JWKS unreachable → do not treat tokens as verified).

**Multi-substrate tenants (later):** if one tenant has both K8s and ECS
Agents, prefer **evidence self-describes strategy** (small envelope or
StreamOpen field) and CP stores **enabled strategies + trust per type**
(either JSON map in `workload_evidence_config` or a future
`ablv_tenant_evidence_trust` table). Do not invent that table until a second
strategy ships.

### AuthzContext → Gateway

Extend `/v1/internal/authz-context` (or equivalent already used by
`FetchAuthzContext`) with a read-only block, e.g.:

```json
"evidence_trust": {
  "strategy": "kubernetes_oidc",
  "oidc_enabled": true,
  "issuer_url": "https://…",
  "jwks_uri": "https://…/openid/v1/jwks",
  "audience": "abluva-connect",
  "allowed_algs": ["RS256"],
  "ca_bundle_pem": null
}
```

Gateway caches JWKS per `(tenant_id, jwks_uri)` with refresh; CP owns
discovery probe jobs that flip `oidc_enabled` / last_ok timestamps.

### CP HTTP (still to build)

- `PUT/GET /v1/tenants/:id/workload-evidence` (or `/oidc`) — set strategy +
  issuer; never authz policy.
- UI: after install flavor, if strategy is `kubernetes_oidc`, “Register
  cluster issuer” step (`L3-EVID-01`).

### Explicit non-goals for first slice

- Using evidence for StreamOpen allow/deny allowlists (`intended_consumers`).
- SPIRE/SPIFFE SVID verification on the customer path (Agent leaf SPIFFE SAN
  for the **edge** remains separate).
- A Fabric `tenant.substrate_type` column.

## Part 5 — Sequelize model shapes (Fabric tables only)

Illustrative `define()` shapes matching the landed models. Prefer the SQL
migrations when DDL and the TypeScript models disagree.

```js
// FK target (existing) — reference only; not migrated by Fabric:
// ablv_tenants.tenant_id uuid PK

AblvTenantConnect.init({
  tenant_id: { type: DataTypes.UUID, primaryKey: true },
  auto_approve_agents: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  max_tunnels: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50 },
  max_concurrent_streams: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2000 },
  max_stream_open_per_sec: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
  suspended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  suspended_cause: DataTypes.TEXT, // 'billing' | 'security' | null
  strict_substrate_binding: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  expected_substrate_fingerprint: DataTypes.TEXT,
  oidc_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  oidc_issuer_url: DataTypes.TEXT,
  oidc_jwks_uri: DataTypes.TEXT,
  oidc_audience: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'abluva-connect' },
  oidc_allowed_algs: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: ['RS256'] },
  oidc_ca_bundle_pem: DataTypes.TEXT,
  oidc_last_discovery_ok_at: DataTypes.DATE,
  oidc_last_discovery_error: DataTypes.TEXT,
  bootstrap_token_hash: DataTypes.BLOB,
  bootstrap_expires_at: DataTypes.DATE,
  revoked_cert_fingerprints: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  revoked_cert_causes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  created_at: { type: DataTypes.DATE, allowNull: false },
  created_by: { type: DataTypes.TEXT, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
  updated_by: { type: DataTypes.TEXT, allowNull: false },
}, { tableName: 'ablv_tenant_connect', underscored: true, timestamps: false });

AblvRegistration.init({
  id: { type: DataTypes.UUID, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  generation: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 1 },
  connectivity_type: { type: DataTypes.TEXT, allowNull: false }, // SERVICE | RESOURCE
  source_kind: DataTypes.TEXT,
  destination_kind: { type: DataTypes.TEXT, allowNull: false },
  display_name: { type: DataTypes.TEXT, allowNull: false },
  resource_type: DataTypes.TEXT,
  host: DataTypes.TEXT,
  port: DataTypes.INTEGER,
  tls_mode: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'in-band' },
  workload_evidence_attribution_level: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'standard' },
  intended_consumers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  state: { type: DataTypes.TEXT, allowNull: false },
  failure_reason: DataTypes.TEXT,
  observed: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  deleted_at: DataTypes.DATE,
  created_at: { type: DataTypes.DATE, allowNull: false },
  created_by: { type: DataTypes.TEXT, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
  updated_by: { type: DataTypes.TEXT, allowNull: false },
}, { tableName: 'ablv_registrations', underscored: true, timestamps: false });

AblvAgent.init({
  id: { type: DataTypes.UUID, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  state: { type: DataTypes.TEXT, allowNull: false },
  substrate: { type: DataTypes.TEXT, allowNull: false }, // kubernetes (RKE2/EKS)
  substrate_fingerprint: DataTypes.TEXT,
  enrollment_approved_at: DataTypes.DATE,
  enrollment_approved_by: DataTypes.TEXT,
  cert_fingerprint_sha256: DataTypes.TEXT,
  cert_not_after: DataTypes.DATE,
  cert_serial: DataTypes.TEXT,
  last_heartbeat_at: DataTypes.DATE,
  tunnel_state: DataTypes.TEXT,
  deleted_at: DataTypes.DATE,
  created_at: { type: DataTypes.DATE, allowNull: false },
  created_by: { type: DataTypes.TEXT, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
  updated_by: { type: DataTypes.TEXT, allowNull: false },
}, { tableName: 'ablv_agents', underscored: true, timestamps: false });
```

**SQL companions (in migrations):**

- `FOREIGN KEY (tenant_id) REFERENCES ablv_tenants(tenant_id)`
- Partial unique: `UNIQUE (tenant_id, display_name) WHERE deleted_at IS NULL`
- Indexes: `(tenant_id, state)` on registrations and agents
- Partial unique live-agent cert:
  `(tenant_id, cert_fingerprint_sha256)` where cert present, not deleted, not `Retired`
- `CHECK` constraints on `connectivity_type`, `destination_kind`, agent/registration
  `state`, port range, positive quotas, and `suspended_cause ∈ {billing, security}`

---

## Part 6 — How a runtime process gets its database connection without any secret in its environment

The pattern is the same regardless of whether what's being fetched is the
Postgres connection itself or some other vault-stored secret (CA material,
for instance):

1. The process starts with only non-secret configuration —
   `ABLV_ACCESS_URL` and the platform's own tenant/environment IDs. Nothing
   else.
2. It calls the Access API's `keys#database` operation (the exact shape is
   in Part 7.3 below).
3. It builds its actual Sequelize connection configuration in memory from
   that response — host, port, database name, username, password, TLS mode
   — and never writes any of it to disk or to an environment variable.
4. It connects.

Rotating the database password, from an operational point of view, is
simply: re-fetch from the Access API, then reconnect. There's no separate
password-rotation mechanism to build — the Access API is already the
single source of truth for the current credential, every time it's needed.

---

## Part 7 — The Access API itself

**Endpoint** (configurable): `POST {ABLV_ACCESS_URL}` — for example,
`http://172.16.1.101:3000/v1/access` in this environment.

### 7.1 Headers every call sends

| Header | What it carries |
|---|---|
| `Content-Type: application/json` | |
| `X-ABLV-Tenant-ID` | Which tenant's vault objects this call concerns |
| `X-ABLV-Environment-ID` | Which environment |
| `X-ABLV-ResourceType` | Which kind of resource is being requested (see below) |

For the Fabric control plane's *own* database and platform-level secrets,
these headers always carry the **platform's own** tenant and environment
IDs from configuration — never an individual customer's. A customer's own
tenant ID would only come into play if Fabric ever needed to operate on
that specific customer's own vault objects, which isn't something it does
today.

### 7.2 The four operations

**Fetch database credentials:**

```http
POST /v1/access
X-ABLV-Tenant-ID: <uuid>
X-ABLV-Environment-ID: <uuid>
X-ABLV-ResourceType: keys#database
```

(No request body.)

**Fetch a secret:**

```http
X-ABLV-ResourceType: data-privacy#secrets-manager
{"action":"get","secretName":"service-test-key"}
```

**Create a secret:**

```json
{"action":"create","secretName":"new-key","secretValue":"value123","scope":"environment/tenant/global"}
```

**Update a secret:**

```json
{"action":"update","secretName":"service-test-key","secretValue":"new-value"}
```

### 7.3 The response shapes — frozen (R1 / R2)

These are implemented directly in
[`control-plane/src/access/client.ts`](../control-plane/src/access/client.ts).
The samples below are redacted on purpose — never paste a real password
into a commit, a ticket, or a chat log.

**R1 — Database credentials (`keys#database`):**

```json
{
  "status": "success",
  "statusCode": 200,
  "message": "OK",
  "data": {
    "resourceId": "<uuid>",
    "resourceName": "Secrets Database",
    "resourceType": "keys#database",
    "resourceFlavor": "oci#postgres",
    "credential": {
      "type": "PASSWORD",
      "username": "<user>",
      "password": "<redacted>"
    },
    "connection": {
      "host": "<ip-or-hostname>",
      "port": 5432,
      "database": "<db-name>"
    },
    "tls": {
      "mode": "VERIFY_FULL"
    },
    "properties": {
      "refreshable": true,
      "expiresAt": null,
      "resourceVersion": "<string>"
    }
  }
}
```

How this maps onto an actual connection:

| Response field | What it becomes |
|---|---|
| `data.connection.host` / `port` / `database` | Sequelize's connection host/port/database |
| `data.credential.username` / `password` | Sequelize's auth — held in memory only, never written to an environment variable |
| `data.tls.mode` | `VERIFY_FULL` or `VERIFY_CA` becomes `ssl.rejectUnauthorized=true`; an empty value or `DISABLE` means no SSL is used at all |

**R2 — Secrets manager, fetching a value** — the plaintext comes back directly
in `data.value`:

```json
{
  "status": "success",
  "statusCode": 200,
  "message": "OK",
  "data": {
    "action": "get",
    "secretName": "service-test-key",
    "status": "success",
    "value": "<secret-plaintext>"
  }
}
```

For create and update, success is indicated by *both* the outer `status`
and the inner `data.status` reading `"success"` — the `message` field is
informational only, never something to branch logic on. Anything else —
a non-200 `statusCode`, or either status field reading something other than
`"success"` — is treated as a failure, and the client throws a dedicated
`AccessApiError` rather than trying to partially interpret a malformed
response.

### 7.4 Naming convention for Fabric's own vault entries (S1)

Default prefix is **`ablv-fabric`** (overridable via `FABRIC_VAULT_PREFIX`):

| Example secret name | What it's for |
|---|---|
| `ablv-fabric-gateway-tls` | The Gateway's own leaf certificate material, if stored in the vault rather than distributed another way |
| `ablv-fabric-ca-bundle` | The trust bundle, if distributed via the vault |

Bootstrap tokens are the one deliberate exception to "everything goes
through the vault" — they're hashed and stored in Postgres only (S2), never
vaulted, since they're single-use and short-lived by design rather than a
standing credential. Platform Access API calls use fixed platform
tenant/env ids from config (S3).

---

## Part 8 — Who actually reads and writes what

| Actor | Database access | Secrets access |
|---|---|---|
| TypeScript control plane / the SaaS application | Full read/write, via Sequelize | Fetches via the Access API |
| Gateway (Go) | Read-only, using a connection pool built from Access-API-supplied credentials | Uses the Access API only if it needs to |
| Connect Agent | None at all | None — certificates arrive via Controller distribution, never fetched by the Agent itself |

---

## Part 9 — Where things actually stand right now

| Piece / ticket | Status |
|---|---|
| L3-STORE-01 schema | Frozen — three tables + FK into `ablv_tenants.tenant_id`; migrations + Part 5 models |
| L3-EVID-01 Kubernetes OIDC attribution path | **Shipped** — Part 4a strategies; EKS/RKE2/k3s scripts; CP API; Gateway verify |
| Access client (R1/R2) | Both response shapes implemented in `control-plane/src/access/client.ts` |
| Sequelize models + Access→DB connect | Landed in code |
| `SequelizeStore` HTTP persistence | Landed — use `FABRIC_STORE=postgres` (local compose does); `FABRIC_STORE=memory` remains for tests / bare process default |
| Additive columns (suspend/revoke cause, substrate binding) | Landed in migration `20260724090000-suspend-cause-substrate-binding.sql` |

The two envelopes that were genuinely open earlier — **R1**
(`keys#database`) and **R2** (secrets-manager get/create/update) — are
answered in full in Part 7.3. Pathway- and Ghostunnel-related decisions
stay in `Architecture-Resolutions.md`. This document's scope is
deliberately limited to the schema, the OIDC evidence path, and the Access
API's wire shapes.
