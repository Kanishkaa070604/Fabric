# Tenant-app UI checklist (Fabric companions)

This repo is the **Fabric control plane / Gateway / Connect Agent**. The
**tenant application** (customer-facing product UI) lives elsewhere. This
file lists the UI surfaces that must exist so tenant admins are not stuck
on raw `curl` for **Day‑N** Fabric work.

It goes **hand in hand** with `Operational-Runbook.md`:

| Phase | Who | How (this repo’s contract) |
|---|---|---|
| **Platform Day 0** | Platform ops | Scripts / kubectl / manifests only — **never** the tenant app. Runbook → “Installing the platform (Day 0)” |
| **Tenant Day 1** | Tenant admin + Platform assist | Mix: UI for control-plane actions; **scripts/manifests** for Agent install on the customer substrate. Runbook → “Onboarding a customer Agent (Day 1)” |
| **Day‑N** | Tenant admin | **UI first** (APIs below). Curl/scripts remain the fallback and the smoke harness. Runbook → “Day to day” |

Background tickers (DNS reconciler, heartbeat watchdog, Gateway security /
drain / quota sweeps, Agent registration watch) are **Platform or Agent
process loops** — not tenant-app features. See Runbook → “Background jobs
(what runs without a human)” and `Validation-Plan.md`.

---

## How to read this doc

- Build UI in section order so onboarding is coherent.
- “API” means this Fabric repo already exposes the HTTP path unless noted.
- Install snippets and kubectl live in `deploy/connect-agent/` — the UI
  should deep-link or embed them, not reinvent cluster access.
- **Pure SaaS / Platform-only tenants** (no customer Connect Agent): **do not**
  run §1 Agent wizard. Ops: `Operational-Runbook.md` →
  [Pure SaaS tenants](Operational-Runbook.md#pure-saas-tenants-no-connect-agent).
  Hide or skip bootstrap / Agent install / Fabric registration tasks until
  the tenant needs a customer connector.

| Column | Meaning |
|---|---|
| UI need | Screen / control |
| Why | Operator outcome if missing |
| API / artifact | Fabric HTTP path or install artifact |
| Copy / rules | Locked product wording |

---

## How this maps to the Tenant UI's task system

The Tenant UI has its own concept of **tasks linked to environment
activation** — a checklist that gates whether an environment can go live.
Section 1 below (Tenant Day 1) is written so each row can become one task
in that system, in order. This repo does not build that task system; this
table is the **task definition contract** the Tenant UI should implement
against.

| Task ID (suggested) | Maps to §1 row | Blocks env activation? | Completion check |
|---|---|---|---|
| `fabric_profile_ensured` | Row 1 | Yes | `GET /v1/tenants/:id` returns 200 |
| `substrate_selected` | Row 2 | Yes | UI's own onboarding field has a non-null install-flavor choice (see [Install flavor vs agent.substrate](#install-flavor-wizard-row-2-vs-agentsubstrate) — Fabric has no tenant substrate column to poll) |
| `agent_count_planned` | Row 3 | No (informational; feeds row 4) | UI's own record has a planned count |
| `quotas_set` | Row 4 | No (default 50 is usually fine) | `GET /v1/tenants/:id` → `max_tunnels` ≥ planned count |
| `bootstrap_issued` | Row 5 | Yes | `GET /v1/tenants/:id` → `bootstrap_token_outstanding: true` (see `publicTenant()` in `control-plane/src/store/types.ts`) |
| `ca_bundle_downloaded` | Row 6 | No (bundled into row 7's snippet automatically) | UI-tracked only — `GET /v1/ca-bundle` has no server-side "did they download it" state |
| `install_snippet_shown` | Row 7 | No (can't verify from Fabric; see task `first_agent_connected` below for the real gate) | UI-tracked only |
| `first_agent_connected` | Downstream of Row 7 | **Yes — this is the real "is the tenant actually online" gate** | `GET /v1/tenants/:id/agents` has ≥1 row with `state: "Connected"` or `"Connecting"` |
| `platform_catalog_seeded` | Row 8a | **Yes** when the tenant must reach fixed SaaS services | `GET /v1/tenants/:id/registrations` includes Active `PLATFORM_*` rows matching the catalog entries the UX enabled (see [Platform service catalog](#platform-service-catalog--day1-seed)) |
| `customer_destinations_ready` | Row 8b | **Yes** when this env must expose customer-side targets (inbound A3/B4 or customer resources) | ≥1 Active `CUSTOMER_*` registration for each required customer destination; skip this task entirely if the env is Platform-outbound-only |
| `first_agent_approved` | Row 9 | Yes only if `auto_approve_agents=false` | Default auto-approve: skip — use `first_agent_connected`. Manual mode: ≥1 Agent `Connected` after Approve |

**Polling note:** none of these need a webhook from Fabric — every
completion check above is a plain `GET` the Tenant UI already has reason
to poll during onboarding (Agent state, tenant record). Poll on an
interval (e.g. every 5s while the onboarding wizard is open, matching the
Agent's own ~5s registration-watch cadence) rather than trying to get Fabric
to push task-completion events; Fabric doesn't have a push channel for this
and adding one for onboarding UX alone isn't worth a new integration point.

---

## 0. Credentials the UI must explain (not just buttons)

Show this mental model in onboarding help / tooltips. Full ops detail:
`Operational-Runbook.md` → **Agent credentials (G-CRED-1)**.

| Credential | Purpose (one line) | UI shows / does | After Day‑1 |
|---|---|---|---|
| **Bootstrap token** | Lets brand-new Agents call `enroll` before they have a cert | Issue (copy-once), show expiry, **Revoke** if leaked | Only for new installs / cert-loss recovery — not “rotate weekly” |
| **CA bundle** | Trusts Agent leaves signed by Platform | Include in install snippet (`ca.crt`) | Platform rotates rarely; tenant does not manage |
| **Agent leaf** | Per-pod/task mTLS identity to the Gateway | Show **fingerprint** per Agent row; Approve / Retire / Revoke-cert | 7-day TTL, **auto-rotates** at ~50% life with no human step (D3-AUTO). UI does **not** download private keys or expose a routine "rotate" button |
| **Agent API bearer** | Auth for Agent→CP REST when CP auth is on | Agent derives bearer from leaf cert after enrollment — no seed needed | **Agent pulls** replacements (`L3-CRED-01`). UI must **not** teach “update Secret + restart all pods” as steady state |

**Who is in the loop**

| Moment | Human |
|---|---|
| First install: issue bootstrap + apply snippet | Tenant admin (+ Platform assist) |
| Approve Agent, create registrations, revoke-cert, revoke bootstrap | Tenant admin (UI) |
| Bearer refresh, leaf rotate, CP token rotate job | **No human** — Agent + control plane |
| Writer/admin CP token, Agent CA, Gateway | Platform ops only (never in tenant snippet) |

---

## 1. Tenant Day 1 — first Agent (UI + install scripts)

**Skip this entire section** for pure SaaS (Platform A1/B1 only, no customer
Agent). See Runbook [Pure SaaS tenants](Operational-Runbook.md#pure-saas-tenants-no-connect-agent).

UI owns control-plane steps. **Customer-cluster install stays script/manifest**
(`deploy/connect-agent/daemonset.yaml`, ECS/VM bundle). The UI issues the
token and trust bundle, then hands the operator a paste-ready snippet.

| Step | Surface | Owner | API / artifact | Copy / rules |
|---|---|---|---|---|
| 1 | Open / ensure Fabric profile | UI | `POST /v1/tenants/ensure`, `GET /v1/tenants/:id` | SaaS tenant row must already exist (outside Fabric) |
| 2 | **Ask install flavor** (what infrastructure hosts the Agent) | UI (product input, first real question of the wizard) | — | Values: **Kubernetes** / **VM or bare metal** (k3s appliance recommended) today; **ECS** / **Docker** coming soon. This is **UI onboarding state only** — see [Install flavor vs agent.substrate](#install-flavor-wizard-row-2-vs-agentsubstrate). Wrong flavor → wrong install snippet. |
| 3 | Planned Agent instance count | UI (product input) | — | K8s: DaemonSet node count. ECS: task count. VM/Docker: host count. Depends on the substrate chosen in step 2. |
| 4 | Set `max_tunnels` ≥ planned count | UI | `POST /v1/tenants/:id/quotas` | Global default stays **50**; do not silently raise it for everyone |
| 5 | Issue bootstrap token (copy-once) | UI | `POST /v1/tenants/:id/bootstrap-token` | Show `bootstrap_expires_at`. Multi-redeem for the whole window; revoke if leaked |
| 6 | Download **CA trust** only | UI | Install-bundle / `ca.crt` | Label: trust bundle, **not** the Agent leaf |
| 7 | Show install snippet for the substrate chosen in step 2 | UI embeds / links | **Kubernetes:** `deploy/connect-agent/tenant-start.sh` + filled `tenant-start.env` (a Helm chart is **planned, not yet shipped** — do not offer it as an option today). **VM / bare metal:** the k3s appliance installer (`deploy/connect-agent/k3s-appliance/install.sh`) is the recommended default — it gives probes, resource limits, and rolling-update handling that the plain systemd single-binary path (`deploy/connect-agent/systemd/`) does not. **ECS:** only a security-group template is shipped (`deploy/connect-agent/ecs/security-group.example.json`) — the full task-definition is blocked on `L3-POC-ECS`; **do not offer ECS as a wizard option until that ships.** **Docker:** no `docker-compose.yml` install artifact exists for the Agent yet — **do not offer Docker as a wizard option today.** | Operator runs the one command shown. No shared `tls.crt`/`tls.key` in any snippet. Secret keys (K8s): `ca.crt`, `bootstrap_token`. No separate Agent API seed needed — the Agent derives its bearer from the leaf cert after enrollment. `FABRIC_GATEWAY_ADDRESS` = Platform NLB from ops Step 5b. **K8s identity (required copy):** identity is stored in a per-node **Kubernetes Secret** (`FABRIC_IDENTITY_STORE=kubernetes`, the default) — no `hostPath`, no Pod Security exception needed. If a fleet was installed before this default shipped, the legacy `hostPath` volume is still supported (`FABRIC_IDENTITY_STORE=file`); see `PRODUCTION-READINESS.md` D2-NEW. |
| 8a | **Enable Platform service catalog** (fixed SaaS destinations) | UI + Day‑1 script | Catalog table (UI/product-owned) → `POST /v1/registrations` per selected row | See [Platform service catalog](#platform-service-catalog--day1-seed). This is the normal path for known SaaS services (`discovery`, `catalogue`, …) — **not** a one-off optional curl. |
| 8b | Create **customer** destinations | UI | `POST /v1/registrations` | **Required when** this env exposes customer-side targets Platform/hairpin must reach (`CUSTOMER_SERVICE` / `CUSTOMER_RESOURCE`). **Skip** when Platform-outbound-only (catalog 8a only). Surface `inbound_hostname`. Copy: “Allow ~5–10 seconds after create before the first dial (Agent poll).” |
| 9 | Approve Agent(s) | UI | `GET …/agents`, `POST /v1/agents/:id/approve` | **Default `auto_approve_agents=true`** — skip unless tenant disabled auto-approve (high-security). Then `PendingApproval` until Approve. |

Optional high-security control: `POST /v1/tenants/:id/auto-approve` `{ "enabled": false }` — manual approve per enroll.

### Platform service catalog → Day‑1 seed

SaaS apps (`discovery`, `catalogue`, …) are **one shared Deployment** for all
tenants. Fabric still needs a **per-tenant** `PLATFORM_*` registration so that
tenant’s Agent can open a listener and StreamOpen can authorize the path.
Do **not** ask operators to invent host/port by hand for every known SaaS
service.

**Ideal shape (Tenant UI / Day‑1 automation owns the catalog — not an
`ablv_*` Fabric table):**

| Catalog key | `display_name` | `destination_kind` | `connectivity_type` | `host` (Platform cluster DNS) | `port` | Default on? |
|---|---|---|---|---|---|---|
| `discovery` | `discovery` | `PLATFORM_SERVICE` | `SERVICE` | `discovery.<saas-ns>.svc.cluster.local` | `8080` | yes |
| `catalogue` | `catalogue` | `PLATFORM_SERVICE` | `SERVICE` | `catalogue.<saas-ns>.svc.cluster.local` | `8080` | yes |
| *(add rows as Platform ships services)* | … | `PLATFORM_SERVICE` or `PLATFORM_RESOURCE` | … | … | … | … |

Concrete host/port/ns values are **Platform config** (same values for every
tenant). Keep the table in the Tenant UI’s config (or a checked-in Day‑1
manifest the script reads) — Fabric’s contract remains plain
`POST /v1/registrations`.

**UX (wizard row 8a):**

1. Show the catalog as a checklist (“Services this environment can reach”).
2. Pre-check `default on` rows; allow tenant admin to uncheck only if product
   policy allows.
3. On continue, **Day‑1 script / UI BFF** loops selected rows and calls
   `POST /v1/registrations` with that tenant’s `tenant_id` (idempotent by
   `display_name` — skip or no-op if an Active row already exists).
4. Completion: task `platform_catalog_seeded` — every enabled catalog key has
   an Active `PLATFORM_*` registration for this tenant.

**Not the catalog:** customer Postgres / `sec-interface` / other
`CUSTOMER_*` destinations are row **8b**. They are not “optional decorations”
— they are **required whenever this environment exposes something on the
customer side** that Platform (or hairpin) must dial. They are simply a
**different kind of destination** from the fixed SaaS catalog: host/port are
customer-owned and vary per tenant. If an environment only calls out to
Platform services and never receives inbound Fabric traffic, skip 8b.

### Install flavor (wizard row 2) vs `agent.substrate` — no contradiction

**Short version:** Fabric does **not** store install flavor on the tenant.
The wizard asks once so Day‑1 can show the **right install commands**.
After install, the Agent **reports** `substrate` into Fabric. Those are
sequential steps, not two competing sources of truth.

#### 1. What “install snippet” means

Row 7 of the wizard must hand the operator **one paste-ready install path**.
Different infrastructures use **different artifacts** in this repo:

| Wizard answer (install flavor) | Artifact the UI shows / links |
|---|---|
| Kubernetes cluster (EKS, RKE2, GKE, …) | `deploy/connect-agent/tenant-start.sh` + DaemonSet (`daemonset.yaml`) |
| VM / bare metal | `deploy/connect-agent/k3s-appliance/install.sh` (recommended) — not the same as the K8s DaemonSet apply |
| ECS / Docker | Not shipped yet — hide or “coming soon” |

Without asking, the UI cannot know whether to give the operator a
`kubectl apply` DaemonSet flow or a k3s appliance installer. That question
is **only** for picking that artifact **before any Agent exists**.

Store the answer in the **Tenant UI’s own** onboarding record if you want
to resume the wizard — **never** as a Fabric `ablv_*` column.

#### 2. What `agent.substrate` is (the only Fabric field)

| | |
|---|---|
| **Where** | `ablv_agents.substrate` |
| **Who sets it** | The **Agent**, on `POST /v1/agents/enroll`, from env `FABRIC_SUBSTRATE` |
| **Who puts it in the env** | The install artifact from step 1 (DaemonSet already sets `FABRIC_SUBSTRATE=kubernetes`) |
| **Why Fabric needs it** | Per-Agent truth after enroll: list icons, support filters, optional strict binding. A tenant can later add Agents on another substrate — one value per Agent row, not one per tenant. |

#### 3. Same-substrate scale (automatic — no UI)

```text
Day 1: pick K8s → apply DaemonSet once (FABRIC_SUBSTRATE=kubernetes + bootstrap)
        ↓
Agents enroll → auto-approve (default) → Connected
        ↓
New EKS nodes: same DaemonSet — nobody opens the UI
```

**k3s appliance:** Day‑1 flavor = “VM”; snippet sets `FABRIC_SUBSTRATE=kubernetes`.

#### 4. Second substrate — full operational workflow (what the UI actually shows)

This is **not** “Approve with a flavor picker.” It is a **second install
package** for the same Fabric tenant. Trigger is almost always: customer
asks (ticket / CSM / sales) “we also run workloads on ECS” (or VM, etc.).

**Actors**

| Role | Does what |
|---|---|
| Customer | Asks for another infrastructure; their eng applies the install snippet |
| Abluva CSM / Platform (optional) | Confirms product readiness (e.g. ECS artifact shipped); may raise `max_tunnels` |
| Tenant admin (customer) | In **Tenant UI**, runs **Connect another infrastructure** once |

**Step-by-step**

| # | Where | What happens |
|---|---|---|
| 0 | Outside product | Customer: “We need Agents on ECS too.” CSM confirms ECS install is available (today: blocked on `L3-POC-ECS` — hide until shipped). |
| 1 | Tenant UI → **Agents** | Screen already lists current Agents (e.g. 3× `substrate=kubernetes`). Primary actions: list, Retire, Revoke-cert. **New control:** button **“Connect another infrastructure”** (not per-row). |
| 2 | UI modal / short wizard | **Title:** Connect another infrastructure. **Copy:** “This adds a second install for the same environment. Existing Kubernetes Agents are unchanged.” **Question:** “Where will the new Agents run?” radio: ○ Kubernetes  ○ VM / bare metal (k3s)  ○ ECS (when shipped)  ○ Docker (hide). Customer picks **ECS**. |
| 3 | Same wizard — capacity | “How many Agent instances do you expect on ECS?” → if `max_tunnels` too low, UI offers `POST …/quotas` bump (same as Day‑1 row 4). |
| 4 | Same wizard — bootstrap | UI calls `POST …/bootstrap-token` (or reuses outstanding window if still valid). **Show once:** token + `bootstrap_expires_at`. Copy: “Paste into the ECS install secret only. Do not reuse the old K8s secret file unless it already has this token.” |
| 5 | Same wizard — install | UI shows **ECS-only** snippet (task def / script) with env already filled: `FABRIC_TENANT_ID`, `FABRIC_GATEWAY_ADDRESS`, `FABRIC_SUBSTRATE=ecs`, `FABRIC_BOOTSTRAP_TOKEN=<issued>`, CA. **Download / copy.** No Approve step (auto-approve default). |
| 6 | Customer eng | Applies that ECS artifact in their AWS account **once**. Scales desired count. |
| 7 | Tenant UI → **Agents** | New rows appear with `substrate=ecs`, state Connecting→Connected. Filter/badge by substrate. Done. |

**What the UI must not do**

- Ask substrate on Approve (Approve is only when auto-approve is off).
- Make tenant admin click once per ECS task.
- “Add another fleet flavor” as a Platform schema change — flavors are fixed product artifacts; UI only **selects which artifact to emit**.

**Platform-assisted variant (same UI, different trigger):** CSM opens the
tenant in admin tools / tells customer “use Connect another infrastructure
→ ECS.” Still ends at steps 2–7 in the Tenant UI — Abluva does not SSH into
customer AWS to set `FABRIC_SUBSTRATE`.

Until ECS ships, step 2 shows ECS as disabled with “Coming soon.”
**Install UI callouts (wizard footer / tooltip):**

1. **Identity storage (Kubernetes):** Connect Agent stores its leaf cert
   and agent id in a per-node Kubernetes Secret, not on the node's disk.
   This means rolling Agent upgrades and Pod recreates keep identity
   without re-approval, and no Pod Security exception is ever required.
2. **Cert lifetime:** Leaf certs are short-lived (7 days) and rotate
   automatically with no human step. There is nothing to schedule or
   remember here.
3. **NO_PROXY:** Gateway NLB hostname must be in `NO_PROXY` (script sets
   this). Corporate HTTP proxy must not intercept the mTLS tunnel.
4. **After Platform catalog seed / customer register:** wait one Agent poll
   (~5–10s) before dialing `connect-agent.<ns>.svc`.

Optional disclosures (`L3-DOC-01..03`): plaintext/`tls_mode`, ACL-skip residual risk, hairpin / data-residency.

---

## 2. Day‑N — Agents

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| List Agents + state badge | Health without kubectl | `GET /v1/tenants/:id/agents` | Show substrate icon (K8s / VM / ECS / Docker) per Agent row, read from `agent.substrate` field. State badge: `Connected` (green), `Degraded` (amber), `PendingApproval` (blue), `Connecting` (gray), `Retired` (strikethrough) |
| **Connect another infrastructure** | Second substrate under same tenant | Same as Day‑1 rows 2–7 (flavor → quotas → bootstrap → snippet) | Full workflow: [§1 ¶4](#4-second-substrate--full-operational-workflow-what-the-ui-actually-shows). Button on Agents page, **not** per Agent row. |
| **Approve** | Unblock StreamOpen | `POST /v1/agents/:id/approve` | Only when `PendingApproval` (auto-approve off) |
| **Retire** | Offboard node/task | `POST /v1/agents/:id/retire` | Confirm: tunnel force-closes (~2s Gateway security reconcile) |
| Cert fingerprint per row | Support + revoke targeting | Agent record field | **Per instance**, never “the tenant cert” |
| Re-issue bootstrap | Scale-out after window / cert-loss | Bootstrap issue | See **L3-BOOT-SCALE-01** — known ops hole if expiry passed; put new token in install Secret once per fleet |
| **Revoke bootstrap** | Leak response | `POST …/bootstrap-token/revoke` | Immediate |
| **Revoke Agent API token** | Leaked seed / compromise | `POST …/agent-api-token/revoke` | Writer revoke. Copy: “Agents re-pull a new bearer automatically; you do **not** need to roll every pod’s Secret.” Optional: re-issue seed only if new installs are mid-flight |
| Cert expiry / rotation status (informational) | Reassurance, not action | Agent record's `cert_not_after` | Leaf is 7 days, **auto-rotates** at ~50% life (D3-AUTO) — nothing for the tenant admin to click, no "rotate" button in v1. If rotation keeps failing, the cert-expiry webhook (Platform on-call) fires before NotAfter — that's a Platform incident, not a tenant action. For compromise, see §4 **Revoke leaf**. |

---

## 3. Day‑N — Registrations

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| List + state badge | Failed must be obvious | `GET /v1/tenants/:id/registrations` | |
| Create | Day‑N adds | `POST /v1/registrations` | Prefer catalog-driven `PLATFORM_*` for known SaaS services (§1 row 8a); free-form create for `CUSTOMER_*`. Show `inbound_hostname` for Active `CUSTOMER_*` |
| **Edit** on Active | In-place update | `POST …/update` | Validation error → leave Active unchanged (§G.5) |
| **Retry** on `Failed` only | Production recovery | `POST …/retry` | **Not a scheduled job.** Hide unless `Failed`. Show new `generation` |
| **Delete / abandon** | Explicit teardown | `POST …/delete` | Confirm: loses id + inbound DNS name |

---

## 3b. Day‑N — Workload evidence (L3-EVID-01)

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| Choose evidence strategy | Attribution when cluster can issue SA OIDC JWTs | `GET/PUT /v1/tenants/:id/workload-evidence` | Values: `none` (default) · `kubernetes_oidc` (EKS/RKE2/**k3s**) · `ecs_task_identity` (later — hide). **Not** install flavor. |
| Register cluster issuer | Arms Gateway JWKS verify | `PUT` `{ "strategy":"kubernetes_oidc", "oidc_issuer_url":"https://…" }` | CP probes `/.well-known/openid-configuration`; sets `oidc_enabled` when JWKS reachable. Show `oidc_last_discovery_error` on failure. Customer prep: `deploy/connect-agent/enable-oidc-{eks,rke2,k3s}.sh` |
| Status badge | Ops confidence | GET | Green = `oidc_enabled`; amber = strategy set but discovery failed |

**How the token file appears (not a Fabric API):**

Kubernetes **kubelet** writes a projected ServiceAccount token into the Pod
when the Pod spec mounts a `projected` volume with
`serviceAccountToken.audience: abluva-connect`. Fabric does **not** push
the token via CP/API. The shipped DaemonSet already declares that volume at
`/var/run/abluva/evidence/token`; the Agent only **reads the file** and
forwards bytes on StreamOpen (`FABRIC_EVIDENCE_PATH`).

UI copy: “Enable OIDC on the cluster (script) → register issuer here →
Agent Pod already mounts the projected token; no extra API to mint
evidence.”

Attribution today = **Connect Agent’s** ServiceAccount (DaemonSet). Missing
token is allowed; invalid token is denied. Not pairwise allowlisting yet.

---

## 4. Day‑N — Trust & certificates

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| CA trust download | Install + trust rotate | `GET /v1/ca-bundle` (public, no auth — CA cert only, never a key) | Leaf private keys never leave the Agent |
| Per-instance leaf model help | Explains why each Agent row has its own fingerprint | Docs beside Agents | One leaf per Agent process (per node / task / VM), never shared across instances |
| **Revoke leaf** by fingerprint | Incident response | `POST /v1/tenants/:id/revoke-cert` (dual-control) | Cause: `security` (immediate) vs `decommission` (drains first). Prefer fingerprint from Agent row. Revoked cert also can't outlast its 7-day TTL either way (D3-AUTO). **SaaS-mediated, not tenant-held:** the tenant admin clicks a button in the tenant app; the tenant app's own backend (not the browser, not the tenant admin) holds `FABRIC_DUAL_CONTROL_TOKEN` and attaches `X-ABLV-Break-Glass` server-side. The tenant admin never sees or handles that credential — see the non-goals note below. |

---

## 5. Day‑N — Quotas & tenancy

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| View / edit quotas | Capacity is real at N Agents | `POST /v1/tenants/:id/quotas` | Keep `max_tunnels` ≥ instance count when scaling |
| Suspend / unsuspend + **cause** | Billing drain vs security | Suspend API (dual-control) | `security` force-closes immediately. **SaaS-mediated, not tenant-held** — same BFF pattern as Revoke leaf above: the tenant app's backend attaches the break-glass header, the tenant admin never holds it directly. |

---

## 6. Diagnostics (nice-to-have)

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| Registration `observed` / reachable | Destination confidence | Observed fields | Agent posts `…/observed` on its own ticker |
| Agent tunnel / last heartbeat | Spot Degraded | Agent record | Heartbeat watchdog is Platform-side (not a UI cron) |
| Deep-links to Runbook | Cut support load | N/A | Failed retry, bootstrap window, `NO_PROXY`, cert-loss |

---

## Explicit non-goals for the tenant app

| Non-goal | Where it actually lives |
|---|---|
| Platform Day 0 install (Gateway, Ghostunnel, CP, Ambient) | Runbook Day 0 + `deploy/platform/`, `deploy/control-plane/` |
| DNS reconciler / Lease election | Control-plane process; `FABRIC_DNS_*` |
| Heartbeat → Degraded watchdog | Control-plane `heartbeat.ts` |
| Gateway security / drain / quota-opens sweeps | Gateway process tickers |
| Agent registration watch, probes, K8s Service reconciler | Connect Agent process |
| Auto-scheduled retry of `Failed` registrations | **Does not exist** — on-demand `…/retry` only |
| Editing Platform Ambient / ztunnel | Platform ops |
| Minting / downloading Agent leaf private keys | Agent local volume / identity Secret only |
| Agent leaf certificate rotation | **Fully automatic** — `certlife.StartLoop` inside the Agent (D3-AUTO). No tenant-app button, no scheduled job of any kind |
| Choosing `FABRIC_IDENTITY_STORE` (Secret vs disk) per Agent instance | Baked into the substrate's install artifact (D10) — not a per-Agent tenant-app toggle |
| **Handing `FABRIC_DUAL_CONTROL_TOKEN` itself to tenant admins** (not the same as offering Revoke/Suspend buttons — see §4/§5) | Platform ops holds the credential; the tenant app's own backend attaches it server-side (SaaS BFF pattern) when a tenant admin clicks Revoke/Suspend. The browser and the tenant admin never see the header or the token value. |

---

## Traceability

| Fabric ticket / area | UI section |
|---|---|
| L3-REG-01 Failed retry | §3 Retry |
| L3-AGT-02 multi-instance identity | §1 planned count + CA-only; §2 fingerprints |
| L3-CTL-01a Agent API token (API) | §1 steps 5–7; §2 revoke (interim) |
| L3-CRED-01 / G-CRED-1 Agent pull | §1 seed vs steady-state; §2 revoke target |
| L3-GW-02 quotas | §1 / §5 |
| L3-BOOT-01 approval | §1 step 9 / §2 Approve |
| L3-PKI-01 revoke | §4 revoke |
| **D3-AUTO** cert auto-rotation | §0 credential model; §2 expiry status (informational only) |
| **D2-NEW** `identity.Store` (K8s Secret default) | §1 steps 2/8 identity copy |
| **D10** substrate packaging | §1 step 2 install flavor; [Install flavor vs agent.substrate](#install-flavor-wizard-row-2-vs-agentsubstrate) |
| Platform SaaS catalog seed | §1 row 8a; [Platform service catalog](#platform-service-catalog--day1-seed) |
| L3-EVID-01 workload evidence | §3b; `Level-3-Store-OIDC-Spec.md` Part 4a |
| L3-DOC-01..03 | §1 optional disclosures |
| L3-DOC-04 this checklist | This file |
| Production readiness POV | `docs/PRODUCTION-READINESS.md` (includes open go-live decisions) |
| Full e2e proof | `docs/Validation-Plan.md` |
