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
| `substrate_selected` | Row 2 | Yes | UI's own record has a non-null substrate choice (see "Where substrate_type lives" below — Fabric has no field to poll here) |
| `agent_count_planned` | Row 3 | No (informational; feeds row 4) | UI's own record has a planned count |
| `quotas_set` | Row 4 | No (default 50 is usually fine) | `GET /v1/tenants/:id` → `max_tunnels` ≥ planned count |
| `bootstrap_issued` | Row 5 | Yes | `GET /v1/tenants/:id` → `bootstrap_token_outstanding: true` (see `publicTenant()` in `control-plane/src/store/types.ts`) |
| `ca_bundle_downloaded` | Row 6 | No (bundled into row 7's snippet automatically) | UI-tracked only — `GET /v1/ca-bundle` has no server-side "did they download it" state |
| `install_snippet_shown` | Row 7 | No (can't verify from Fabric; see task `first_agent_connected` below for the real gate) | UI-tracked only |
| `first_agent_connected` | Downstream of Row 7 | **Yes — this is the real "is the tenant actually online" gate** | `GET /v1/tenants/:id/agents` has ≥1 row with `state: "Connected"` or `"Connecting"` |
| `first_registration_created` | Row 8 | No (optional in wizard) | `GET /v1/tenants/:id/registrations` has ≥1 row |
| `first_agent_approved` | Row 9 | Yes (if any Agent enrolled and no `auto_approve_agents`) | `GET /v1/tenants/:id/agents` has ≥1 row with `state: "Connected"` (implies approved — see G-BOOT-1) |

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

UI owns control-plane steps. **Customer-cluster install stays script/manifest**
(`deploy/connect-agent/daemonset.yaml`, ECS/VM bundle). The UI issues the
token and trust bundle, then hands the operator a paste-ready snippet.

| Step | Surface | Owner | API / artifact | Copy / rules |
|---|---|---|---|---|
| 1 | Open / ensure Fabric profile | UI | `POST /v1/tenants/ensure`, `GET /v1/tenants/:id` | SaaS tenant row must already exist (outside Fabric) |
| 2 | **Ask which substrate this customer runs** | UI (product input, first real question of the wizard) | — | Offer **Kubernetes** (any distro) or **VM / bare metal** today — both have a shipped, pass-as-is install artifact. **ECS** and **Docker** have no shipped install artifact yet (see row 7) — either hide them until they ship, or show them as "coming soon." This choice is the **UI/SaaS app's own onboarding state**, not a Fabric field — see "Where `substrate_type` lives" below. Don't guess — the wrong artifact wastes the operator's Day-1 session. |
| 3 | Planned Agent instance count | UI (product input) | — | K8s: DaemonSet node count. ECS: task count. VM/Docker: host count. Depends on the substrate chosen in step 2. |
| 4 | Set `max_tunnels` ≥ planned count | UI | `POST /v1/tenants/:id/quotas` | Global default stays **50**; do not silently raise it for everyone |
| 5 | Issue bootstrap token (copy-once) | UI | `POST /v1/tenants/:id/bootstrap-token` | Show `bootstrap_expires_at`. Multi-redeem for the whole window; revoke if leaked |
| 6 | Download **CA trust** only | UI | Install-bundle / `ca.crt` | Label: trust bundle, **not** the Agent leaf |
| 7 | Show install snippet for the substrate chosen in step 2 | UI embeds / links | **Kubernetes:** `deploy/connect-agent/tenant-start.sh` + filled `tenant-start.env` (a Helm chart is **planned, not yet shipped** — do not offer it as an option today). **VM / bare metal:** the k3s appliance installer (`deploy/connect-agent/k3s-appliance/install.sh`) is the recommended default — it gives probes, resource limits, and rolling-update handling that the plain systemd single-binary path (`deploy/connect-agent/systemd/`) does not. **ECS:** only a security-group template is shipped (`deploy/connect-agent/ecs/security-group.example.json`) — the full task-definition is blocked on `L3-POC-ECS`; **do not offer ECS as a wizard option until that ships.** **Docker:** no `docker-compose.yml` install artifact exists for the Agent yet — **do not offer Docker as a wizard option today.** | Operator runs the one command shown. No shared `tls.crt`/`tls.key` in any snippet. Secret keys (K8s): `ca.crt`, `bootstrap_token`. No separate Agent API seed needed — the Agent derives its bearer from the leaf cert after enrollment. `FABRIC_GATEWAY_ADDRESS` = Platform NLB from ops Step 5b. **K8s identity (required copy):** identity is stored in a per-node **Kubernetes Secret** (`FABRIC_IDENTITY_STORE=kubernetes`, the default) — no `hostPath`, no Pod Security exception needed. If a fleet was installed before this default shipped, the legacy `hostPath` volume is still supported (`FABRIC_IDENTITY_STORE=file`); see `PRODUCTION-READINESS.md` D2-NEW. |
| 8 | Create first registration (optional in wizard) | UI | `POST /v1/registrations` | Prefer a **customer Postgres / `CUSTOMER_RESOURCE`** example in the wizard. Copy: “Allow ~5–10 seconds after create before the first app connection (Agent poll).” Surface `inbound_hostname` for Platform→Customer kinds. Show Service annotation / port hint when available. |
| 9 | Approve Agent(s) | UI | `GET …/agents`, `POST /v1/agents/:id/approve` | PendingApproval expected until this step |

Optional lab control (not default product): `POST /v1/tenants/:id/auto-approve` — **default off**.

**Where `substrate_type` lives (build guidance for the Tenant UI, not a Fabric field):**

Row 2's answer ("Kubernetes" / "VM or bare metal" / "ECS" / "Docker") drives
which install snippet the wizard shows next (row 7) and which icon the
Agents list shows (§2 below) — but Fabric's control-plane has **no
`substrate_type` column on the tenant** and should not grow one just for
this. The only substrate signal Fabric itself stores is `agent.substrate`
(each *Agent instance* reports `kubernetes` / `ecs` / `vm` at enroll — see
`enrollAgent()` in `control-plane/src/store/types.ts`), and that's
per-instance, not per-tenant: a tenant could in principle enroll Agents
from more than one substrate over time (e.g. migrating from VM to K8s).

What the Tenant UI should build instead:
- Persist the wizard's row-2 answer in **the UI's own tenant/environment
  record** (whatever table already backs "environment activation" tasks).
- Treat it as **onboarding UX state** — which snippet to show, which
  wizard branch to take — not as an authorization or protocol input.
  Fabric's actual authorization decisions (approve, quotas, revoke) never
  need to know which substrate a tenant picked.
- If the UI wants a per-tenant "substrate" badge somewhere for display,
  derive it by reading back `GET /v1/tenants/:id/agents` and majority-voting
  the `substrate` field across enrolled Agents, rather than trusting a
  value the wizard captured once and never reconciles against reality.

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
4. **After register:** wait one Agent poll (~5–10s) before dialing
   `connect-agent.<ns>.svc`.

Optional disclosures (`L3-DOC-01..03`): plaintext/`tls_mode`, ACL-skip residual risk, hairpin / data-residency.

---

## 2. Day‑N — Agents

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| List Agents + state badge | Health without kubectl | `GET /v1/tenants/:id/agents` | Show substrate icon (K8s / VM / ECS / Docker) per Agent row, read from `agent.substrate` field. State badge: `Connected` (green), `Degraded` (amber), `PendingApproval` (blue), `Connecting` (gray), `Retired` (strikethrough) |
| **Approve** | Unblock StreamOpen | `POST /v1/agents/:id/approve` | Only when `PendingApproval` |
| **Retire** | Offboard node/task | `POST /v1/agents/:id/retire` | Confirm: tunnel force-closes (~2s Gateway security reconcile) |
| Cert fingerprint per row | Support + revoke targeting | Agent record field | **Per instance**, never “the tenant cert” |
| Re-issue bootstrap | Scale-out / cert-loss | Bootstrap issue | Cert missing → still-open window or **fresh** token; no prove-without-key path |
| **Revoke bootstrap** | Leak response | `POST …/bootstrap-token/revoke` | Immediate |
| **Revoke Agent API token** | Leaked seed / compromise | `POST …/agent-api-token/revoke` | Writer revoke. Copy: “Agents re-pull a new bearer automatically; you do **not** need to roll every pod’s Secret.” Optional: re-issue seed only if new installs are mid-flight |
| Cert expiry / rotation status (informational) | Reassurance, not action | Agent record's `cert_not_after` | Leaf is 7 days, **auto-rotates** at ~50% life (D3-AUTO) — nothing for the tenant admin to click, no "rotate" button in v1. If rotation keeps failing, the cert-expiry webhook (Platform on-call) fires before NotAfter — that's a Platform incident, not a tenant action. For compromise, see §4 **Revoke leaf**. |

---

## 3. Day‑N — Registrations

| UI need | Why | API | Copy / rules |
|---|---|---|---|
| List + state badge | Failed must be obvious | `GET /v1/tenants/:id/registrations` | |
| Create | Day‑N adds | `POST /v1/registrations` | Show `inbound_hostname` for Active `CUSTOMER_*` |
| **Edit** on Active | In-place update | `POST …/update` | Validation error → leave Active unchanged (§G.5) |
| **Retry** on `Failed` only | Production recovery | `POST …/retry` | **Not a scheduled job.** Hide unless `Failed`. Show new `generation` |
| **Delete / abandon** | Explicit teardown | `POST …/delete` | Confirm: loses id + inbound DNS name |

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
| **D2-NEW** `identity.Store` (K8s Secret default) | §1 steps 2/8 substrate + identity copy |
| **D10** substrate packaging | §1 step 2 substrate question; "Where `substrate_type` lives" build guidance |
| L3-DOC-01..03 | §1 optional disclosures |
| L3-DOC-04 this checklist | This file |
| Production readiness POV | `docs/PRODUCTION-READINESS.md` (includes open go-live decisions) |
| Full e2e proof | `docs/Validation-Plan.md` |
