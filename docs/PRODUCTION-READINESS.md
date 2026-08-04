# Production Readiness

**Single** pre-launch / GA doc for multi-tenant Kubernetes Connect.
Not a second ticket tracker.

| Companion | Role |
|---|---|
| [`Level-3-Tickets.md`](Level-3-Tickets.md) | Canonical ticket status + honesty |
| [`Operational-Runbook.md`](Operational-Runbook.md) | Day 0 / 1 / N commands |
| [`Tenant-App-UI-Checklist.md`](Tenant-App-UI-Checklist.md) | Tenant-app UI contract |
| [`Validation-Plan.md`](Validation-Plan.md) | Smoke proof (update after each run) |

> Supersedes the former `PRE-LAUNCH-REPORT.md` (merged here 2026-07-26).
> Status rows match the repository as of that date.

---

## How to read

| Column / section | Meaning |
|---|---|
| **Decisions** | Locked choices + rationale (below) |
| **v1 blocker?** | Must close or explicitly accept risk before multi-tenant K8s GA |
| **Proof** | Test / smoke required for any **Done** claim in tickets |

---

## Decisions locked (2026-07-26)

| ID | Choice | Shipped |
|---|---|---|
| **D2** | **Superseded by identity.Store** — Kubernetes Secret (per-node) is now the recommended backend; `hostPath` remains supported as the `file` store fallback | `internal/identity/{file,k8ssecret}`; `daemonset.yaml` defaults to `FABRIC_IDENTITY_STORE=kubernetes` |
| **D1** | **A — keep PoP** + reuse fresh bearer (no mint-every-pull) | `api-token/current` + Agent sends `current_agent_api_token` |
| **D3** | **AUTO — cert auto-rotation** always on; 7d TTL, rotates at 50% life | `certlife.StartLoop`; disable only via `FABRIC_CERT_AUTO_ROTATE=0` |
| **D5** | **A — refresh 1h**, overlap 1h on mint | DaemonSet `FABRIC_AGENT_TOKEN_REFRESH=1h` (was briefly 15m; eased after D1 reuse — see below) |
| **D4** | **A — CP rotate job off** for v1 | Commented in CP Deployment; Agents self-refresh |
| **D3-A** | **`FABRIC_AGENT_ROTATE=1` one-shot** manual rotate — emergency/compromise path; superseded as the routine path by D3-AUTO above | Documented in DaemonSet comments |
| **D6** | **A — webhook** (optional Secret until wired) | `FABRIC_CERT_EXPIRY_WEBHOOK_URL` from `fabric-cert-expiry-webhook` |
| **D7** | **A — pin** drain + heartbeat in YAML | Gateway `FABRIC_REGISTRATION_DRAIN_GRACE=3m`; CP `FABRIC_HEARTBEAT_DEGRADED_AFTER=90s` |
| **D8** | Approve **required by default**; **auto-approve is an explicit setting** | Default `false`; `POST /v1/tenants/:id/auto-approve` |
| **D9** | **SPIFFE-compatible SAN URI** in agent leaf certs | `spiffe://fabric.abluva.io/tenant/<tid>/agent` in cert SAN |
| **D10** | k3s appliance is the **recommended default** for VM/bare-metal (not just multi-service — the reliability layer is the point); systemd single-binary is the simplest-case fallback; K8s uses `tenant-start.sh` (Helm chart planned, not yet shipped); ECS/Docker use their own templates | `deploy/connect-agent/k3s-appliance/install.sh`, `systemd/`, ECS task def, `docker compose` |

### Industry note (D2 research) — why hostPath, what others do

| Product | Pattern |
|---|---|
| **Teleport** kube-agent | Per-pod **Kubernetes Secret** state (survives recreate; no PV required for identity) |
| **Tailscale** operator / sidecars | Per-replica **Secret** (`TS_KUBE_SECRET`) or PVC; docs warn `emptyDir` loses identity on pod delete |
| **Cloudflare Tunnel** | Shared tunnel **credentials Secret** (replicas share one tunnel — different model than per-node mTLS leaf) |
| **Node agents generally** (CNI, Datadog-style DaemonSets) | Often **hostPath** / node-local state |

**Why hostPath was the original v1 pick (historical — superseded by D2-NEW):**
Connect Agent is a DaemonSet with per-node leaf identity. `hostPath` matched
"identity = this node" and needed no storage class. Teleport/Tailscale
demonstrated per-node Secrets are strictly better for PSA-restricted clusters
— and that follow-up is now the **shipped default**
(`FABRIC_IDENTITY_STORE=kubernetes`). See D2-NEW below.

**Variety of infra (current):** K8s → Secret (default) or hostPath (legacy); VM → local disk; ECS → task-recycle identity remains `L3-POC-ECS`.

---

## Decision detail (reference)

Plain-English rationale for each locked choice.

---

### D2 — Where the Agent keeps its identity on Kubernetes (SUPERSEDED — see D2-NEW below)

**Historical context, kept for the record — this is no longer the shipped
design.** Everything below this note describes the hostPath-only world
before `internal/identity`'s `Store` interface existed. Read D2-NEW first;
this section explains *why* hostPath was the original v1 pick, which is
still useful background for anyone reading the git history or an older
deploy.

**What’s wrong**

On Kubernetes, the Agent stores its “who am I” files (leaf cert, private
key, agent id, pulled API token) under `/var/run/abluva`, mounted as
`emptyDir: {}`. That volume lives and dies with the **Pod**, not the
**node**.

Nuance (important so we don’t overstate):

| Event | Identity kept? |
|---|---|
| Process crash / OOM **inside the same Pod** | **Yes** — no customer work |
| **Pod deleted and recreated** (DaemonSet image rollout, most drains) | **No** — wiped |

So this is **not** “every hiccup needs a human.” It **is** “every time
*we* ship a new Agent image, every node’s Agent forgets who it is.”

Then startup can’t find cert + agent-id → issues a **new** CSR → **new
agent id** → back to `PendingApproval` (human approve again), **or**
CrashLoop if Day‑1 bootstrap was already revoked. Net effect: **your
release cadence becomes a recurring tenant-admin event** across every
customer node — unless you turn on auto-approve (which weakens the
enrollment gate and still doesn’t help if bootstrap is gone).

**Why this isn’t “betraying substrate-neutrality”**

- Core Agent (outbound dial, mTLS, yamux, per-instance leaf) is already
  substrate-neutral and stays that way.
- `emptyDir` is a **Kubernetes packaging** choice in the DaemonSet, not
  the protocol. VM already keeps identity on local disk. ECS task-recycle
  is a separate PoC item — don’t invent one cross-cloud identity service.

**Options**

| Pick | What it means |
|---|---|
| **D2-A `hostPath`** | Store identity on the **node** filesystem. Pod recreate on the same node finds the same files → no re-bootstrap, no re-approve. Needs nothing fancy (no storage class). Cost: Agent touches the node disk; some strict clusters restrict `hostPath` — we document that. **Recommended.** |
| **D2-B PVC** | PersistentVolumeClaim. Survives some cases but **requires** a working storage provisioner — often missing on locked-down customer clusters. **Not recommended** as the default. |
| **D2-C Document only** | Ship `emptyDir`; tell customers “re-approve after every Agent upgrade.” **Not acceptable for GA.** |

**Recommend: D2-A.** Fix the DaemonSet (+ `tenant-start` path) only; leave
VM alone; add “identity survives task recycle” to ECS PoC later. Node
*replacement* still means a new enroll — that’s correct for per-node
DaemonSet identity.

---

### D2-NEW — Shipped: `identity.Store` interface (hostPath is now optional, not required)

**Status: implemented.** `internal/identity` defines a `Store` interface
(`Load` / `SaveCert` / `SaveAPIToken` / `Paths`); everything that used to
read/write raw file paths (`certlife`, `cptoken`, `tunnel.Dial`, main.go's
enroll flow) now goes through this interface. Two implementations ship
today:

| Store | Package | Backing | Local cache needed? |
|---|---|---|---|
| `file` | `internal/identity/file` | Plain directory on disk — byte-for-byte the old behavior | N/A — the directory *is* the store |
| `kubernetes` | `internal/identity/k8ssecret` | Per-node Kubernetes Secret (RBAC: get/create/patch on Secrets, same scoping pattern as the existing Service reconciler) | Yes, but it can be **emptyDir** — see below |

**Why this replaces D2's dilemma entirely, rather than just picking a
side:** D2 was framed as hostPath vs PVC vs "document only," because
every option was implicitly "one write target, choose wisely." With a
`Store` interface, the write target is a parameter, not an architecture
decision baked into `main.go`. Kubernetes gets a Secret (matches
Teleport/Tailscale's own pattern, per the industry note above); VM/ECS/
Docker keep `file` (matches what they always needed — there's no
Kubernetes Secret to have on those substrates anyway).

**Why `k8ssecret.Store`'s local cache can safely be `emptyDir` (unlike the
old design):** `k8ssecret.Store.Load` checks its local file cache first,
but on a miss it falls through to `GetSecret` and re-populates the cache
before returning — so a Pod recreate that wipes an `emptyDir` cache is
invisible to every caller above the Store. `tunnel.Dial`, `certlife`, and
`cptoken` still just read `Paths().CertFile` / `KeyFile` / `APITokenFile`;
none of them know or care that the file might have just been re-fetched
from a Secret a moment earlier.

**Per-node Secret naming** (`identity/k8ssecret.NameForNode`) means N
DaemonSet replicas never share or race one Secret — each node's Agent
owns exactly `connect-agent-identity-<node-name>`, so the RBAC scope
(`get`/`create`/`patch` on Secrets in the tenant namespace) doesn't need
to widen as node count grows, same shape as the Service reconciler's RBAC.

**Config:** `FABRIC_IDENTITY_STORE=kubernetes` (recommended, and the
`daemonset.yaml` default going forward) or `FABRIC_IDENTITY_STORE=file`
(legacy — pair with the commented-out `hostPath` volume in
`daemonset.yaml` if you pick this). `FABRIC_NODE_NAME` (downward API
`fieldRef: spec.nodeName`) is required when `kubernetes` is selected.

**Net effect on the original D2 concerns:**

| Old D2 pain | Status after `identity.Store` |
|---|---|
| PSA `hostPath` exceptions | Gone — Secrets need no special Pod Security exception |
| "Identity tied to this node" | Still true for `kubernetes` (per-node Secret) — same semantics as before, different mechanism |
| Node replacement = re-enroll | Unchanged and correct — a new node has no Secret yet, same as it had no hostPath directory before |
| `emptyDir` = re-enroll storm on every rollout | Fixed for `kubernetes`: emptyDir cache miss re-fetches from the Secret, no re-enroll |
| Strict clusters that deny custom volume types | Secrets always exist as a first-class K8s object; no cluster denies `get`/`create`/`patch` on Secret RBAC the way some deny `hostPath` |

**Also unblocks:** short-lived cert auto-rotation (D3) writes through the
same `Store.SaveCert`, so a rotated cert on Kubernetes lands in the
Secret automatically — no separate "how does rotation reach the Secret"
question to answer.

**Extensibility (design intent, not yet built):** adding a third
substrate-specific `Store` (Vault, cloud KMS, an ECS-task-local
implementation with its own persistence) means implementing the same
four-method interface and adding one `case` to `main.go`'s
`newIdentityStore` — `certlife`, `cptoken`, and the tunnel dial path never
need to change.

---

### D1 — How the Agent proves itself when refreshing its API token

**What’s wrong (two layered issues)**

Day‑1 you put a short-lived **seed** API token in a Secret. After that,
the Agent is supposed to fetch replacements itself so customers never
roll Secrets for hygiene.

What we **built** is the heavier design: the Agent proves it still owns
its **certificate** (signs a challenge — “proof of possession” / PoP)
and the control plane mints a new API token. That works and is secure.
Earlier we had preferred a **simpler** design: “show the API token you
still have (or the previous one during an overlap window)” — enough for
an infrequent ops convenience, less new crypto surface.

Separately, every pull today **always mints a brand-new token** and we
only keep **one** “previous token still valid” slot. On a DaemonSet with
many nodes, each pod refreshes on its own clock; when B refreshes, it can
wipe the overlap protection A was still counting on. So multi-node
tenants can see flaky 401s under bad timing — not just a flat “1 hour
margin” problem.

**Options**

| Pick | What it means |
|---|---|
| **D1-A Keep PoP** | Ship what we have; treat PoP as deliberate. Still should address the single-prior race (or accept it at small N). |
| **D1-B Simplify to bearer** | Drop PoP endpoint; refresh with current/prior bearer only. Smaller surface; still need a plan for the single-prior race. |

**Recommend: D1-A for v1** (don’t rip out working PoP right before GA)
**plus** a small follow-up: either stop minting on every pull (return the
same token until near expiry) **or** keep a short list of priors — so N
nodes don’t invalidate each other. If you strongly want less crypto
surface before GA, pick **D1-B**, but budget that rewrite.

---

### D5 — Timing: how often Agents refresh vs how long old tokens still work

**Locked: refresh `1h`, overlap `1h` on mint.**

**Why not every 15 minutes?** Early D5 proposed 15m when every pull
*minted* a new token (sibling Agents could stomp the single prior slot).
**D1 reuse-if-fresh** removed that: a normal pull returns the same bearer
until ~7 days before expiry. A 15m loop would mostly be empty HTTP
chatter. **1h** is enough to notice revoke / near-expiry mint without
hammering the CP. Tune down (e.g. `15m`) only if you need faster pickup
after a rare platform `force_renew` / future CP rotate job.

---

### D4 — Should the *control plane* also force-rotate API tokens on a timer?

**Locked: D4-A Off for v1** (job left commented in CP Deployment).

**What this job is (and isn’t)**

There are **two** independent “rotation” ideas people conflate:

1. **Agent pull loop (always on after enroll)** — every ~15m the Agent
   calls `api-token/current` with leaf PoP. With D1 reuse, that usually
   returns the **same** bearer until it’s within 7 days of expiry, then
   mints a new one with overlap. No human, no CP cron, no Secret edit.
2. **CP scheduled job (`FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL`)** — a
   timer *inside the control plane* that walks every tenant and calls
   `issueAgentApiToken` whether or not any Agent is online. That
   **invalidates** the current hash (keeping prior for overlap) so the
   next Agent pull must pick up a new value.

So: unset interval ≠ “tokens never rotate.” It means “we don’t
*force-rotate from the platform side* on a calendar.” Day‑N hygiene is
already Agent-driven. Turn the CP job **on** later if compliance wants
“every tenant’s bearer was platform-rotated this week even if Agents
were asleep,” or to mass-rotate after a suspected leak without waiting
for each Agent’s renew window.

**Why off for v1:** less moving parts; D1+D5 already cover live fleets;
enabling the job without care re-introduces multi-instance timing load.

---

### D3 — Automatic certificate rotation (short-lived certs)

**UPDATED (2026-07-27):** Leaf certs now default to **7 days** TTL
(`FABRIC_AGENT_CERT_DAYS=7`) with **automatic rotation** at 50% of life
(~3.5 days). Industry pattern: Teleport tbot (1h default, auto-renew),
SPIRE (auto-rotate SVIDs at half-life), Vault Agent (renew at 2/3 TTL).
Manual `FABRIC_AGENT_ROTATE=1` is retained for emergency/compromise recovery
only — routine rotation is fully automated.

**Plan:** 7d now → **24h** after auto-rotation proves stable in production
(~2-4 weeks of monitoring `cert_auto_rotate_success` log lines). 24h makes
revocation purely a belt-and-suspenders control.

| Pick | What it means |
|---|---|
| **D3-AUTO (locked)** | Auto-rotation is **always on** (default behavior). Agent checks remaining cert life every `FABRIC_CERT_CHECK_INTERVAL` (default 1h); rotates at 50% TTL. Works on any identity storage (hostPath, K8s Secret, disk). Disable only via `FABRIC_CERT_AUTO_ROTATE=0` (debugging escape hatch). |
| **D3-A (legacy)** | Manual `FABRIC_AGENT_ROTATE=1` flip. Emergency/compromise only. |

**Why unconditional (no opt-in flag):** With 7-day certs, identity loss is
cheap — re-enroll takes seconds. The former hostPath-vs-emptyDir concern
was about 825-day certs where losing identity meant months of manual work.
Short-lived certs make that irrelevant. Industry standard (Teleport, SPIRE,
Tailscale): rotation is always on, never opt-in.

---

### D11 — Should "how an Agent proves it may enroll" also be an interface?

**Decision: yes — shipped as `internal/enroll`.** The same reasoning that
motivated `identity.Store` (D2-NEW) applies to the *enrollment credential*
side of things: today's bootstrap-token flow is one way to answer "may
this instance enroll for tenant X," but cloud-native attestation (OCI
instance principal, AWS IAM, a Kubernetes pod's own projected
ServiceAccount token) are different, equally valid answers to the same
question, and main.go should not need to change shape when a new one is
added.

**Naming note:** this interface is named `enroll.Method`, not
`join.Method` — this repo's existing vocabulary for the concept is
already "enroll" (`POST /v1/agents/enroll`, `enroll_starting` /
`enroll_submitted` log lines, `L3-AGT-02`'s "CSR-in-enroll"). The wire
field the control plane reads is still named `join_method` (an
already-shipped, tested HTTP contract — renaming it is a separate,
coordinated server+client change, not bundled into this Go-side rename).

**Shipped:** `enroll.Method` interface
(`Credentials(ctx) (enroll.Credentials, error)`), one implementation
today — `enroll/bootstrap.Method`, wrapping the existing
`FABRIC_BOOTSTRAP_TOKEN` flow byte-for-byte. `enroll/bootstrap` also hosts
the shared `Enroll()` HTTP call and CSR generation, since those are
common to every `Method`, not something each future implementation
should reimplement.

**Why this is the right seam, not premature abstraction:** the interface
is exactly two things — "give me credentials" and "here's what type they
are" (`Credentials.Method` string) — small enough that it costs nothing
today and means the L4-CLOUD-JOIN item (OCI/AWS/GCP attestation, see
below) is "write a new `enroll.Method` implementation," not "restructure
main.go's enrollment flow again."

**What a future cloud-native `Method` would look like:** an
`oci.Method` (or `awsiam.Method`, `k8soidc.Method`) implementing
`Credentials` by fetching a signed attestation from the relevant cloud
metadata service / projected token, and setting `Credentials.Method` to
something like `"oci_instance_principal"`. The control plane's enroll
handler already receives `join_method` in the request body (currently
ignored server-side beyond logging/audit) — verifying a specific
`join_method`'s attestation is server-side work tracked separately
(`L3-EVID-01` / L4-CLOUD-JOIN), not blocked by anything in this
Agent-side interface.

---

### D9 — Service-level identity in leaf certificates

Agent leaf certificates include a SPIFFE-compatible SAN URI:

```
SAN: URI:spiffe://fabric.abluva.io/tenant/<tenant_id>/agent
```

What this gives us without SPIRE: cryptographic tenant binding, TLS-level
scope verification (defense in depth), SPIFFE-compatible format for future
interop. Per-registration DNS (`<reg_id>.<tenant_id>.connect.fabric`) adds
service-level identity — cert proves tenant, registration proves service.

---

### D10 — Substrate strategy: k3s appliance is the recommended default for VM/bare-metal

**Decision: the k3s appliance (`deploy/connect-agent/k3s-appliance/install.sh`,
shipped) is the recommended default for VM/bare-metal customers — not a
"only if you're running multiple services" special case.** The value is
the reliability layer k3s provides on its own (liveness/readiness probes,
resource limits, rolling updates, Secret-backed identity parity with the
Kubernetes DaemonSet path) — a customer running the Agent alone still
benefits from all of that. Whether the customer also runs companion
services (metrics collector, config sync, local cache) is a bonus reason
to prefer k3s, not the reason.

The plain systemd single-binary install (`deploy/connect-agent/systemd/`)
still works and remains the simplest-case fallback for a customer who
explicitly wants no orchestrator at all, but it does not handle restarts,
resource limits, or rolling upgrades the way k3s does — pick it knowingly,
not by default.

**Packaging matrix:**

| Customer Has | You Ship | Day-1 |
|---|---|---|
| **Kubernetes** (any distro) | `tenant-start.sh` (Helm chart **planned, not yet shipped**) | `./tenant-start.sh` against a filled `tenant-start.env` |
| **VM / Bare Metal** (no K8s) | **k3s appliance** (recommended default) — k3s + Agent DaemonSet | `curl -sSL .../k3s-appliance/install.sh \| sh` |
| **VM / Bare Metal**, simplest-case fallback | systemd single binary | `deploy/connect-agent/systemd/` install script |
| **ECS** | Task definition (Agent as sidecar container) | ECS task def template |
| **Docker** | docker-compose | `docker compose up -d` |

**Why k3s:** Smallest footprint (single binary, ~60MB), battle-tested in
edge/IoT, CNCF conformant. Same distribution Replicated uses (via k0s).
Customer never sees raw Kubernetes — they see one install script and a
working system with the same probes/limits/rollout behavior the K8s path
gets for free.

---

### D6 — Who gets told when a cert is about to expire?

**Locked: D6-A webhook** — CP Deployment reads optional Secret
`fabric-cert-expiry-webhook` / key `url`.

**What is automatic vs what is “extra”**

| Layer | Behavior |
|---|---|
| **Enforcement (automatic)** | At NotAfter, Ghostunnel rejects the leaf — tunnel fails **closed** (no traffic). No human required for safety. |
| **Rotate (automatic, D3-AUTO)** | `certlife.StartLoop` runs inside every Agent, always on, and rotates the leaf at 50% of its life (7d default TTL → ~3.5d) with no operator action. `FABRIC_AGENT_ROTATE=1` (**D3-A**) is the manual/emergency escape hatch (e.g. suspected key compromise), not the routine path — see D3/D3-A above. |
| **Alert (extra, D6)** | Daily scan warns within 30d — this is a safety net for when D3-AUTO didn't fire (Agent down, CP unreachable, etc.), giving on-call time to investigate or fall back to a manual D3-A rotate. Without a sink, that warning is only a log line — easy to miss. |

So webhook is not what “makes expiry work”; it’s what makes expiry
**operable**. Create the Secret when your alert route exists:

```bash
kubectl -n fabric-control create secret generic fabric-cert-expiry-webhook \
  --from-literal=url='https://hooks.example/fabric-cert-expiry'
```

---

### D7 — Pin boring timeouts in YAML or leave code defaults?

**What’s wrong**

Drain grace (3 minutes) and heartbeat “degraded after” (90 seconds) only
exist as code defaults — unlike shutdown grace, which we deliberately
set in the Gateway manifest. Not dangerous; just undocumentedly inherited.

**Options**

| Pick | What it means |
|---|---|
| **D7-A** | Write the chosen numbers into Deployment YAML. **Recommended** for ops clarity. |
| **D7-B** | Leave defaults; note in Runbook that defaults are intentional |

**Recommend: D7-A** — small, same discipline as Ghostunnel/Gateway grace.

---

### D8 — Should new Agents auto-approve without a human?

**What’s wrong**

`auto_approve_agents` skips the PendingApproval step. People sometimes
want it so rollouts (with broken `emptyDir`) “just work.” That’s treating
a packaging bug with a weaker security control. It also **doesn’t** fix
CrashLoop when bootstrap is revoked.

**Options**

| Pick | What it means |
|---|---|
| **D8-A Off by default** | Human approve stays a real Day‑1 control. **Recommended** once D2-A removes the rollout pain. |
| **D8-B On for some SKUs** | Faster onboarding; weaker enrollment story — only if product explicitly wants that SKU |

**Recommend: D8-A.**

---

## Recommended default bundle (if you want one line)

**D2-A, D1-A (+ later multi-prior or “don’t mint every pull”), D5-A, D4-A,
D3-A, D6-A or D6-B, D7-A, D8-A.**

---

## Agent identity on Kubernetes — full write-up (D2)

Your summary is **correct on the operational point.** One wording fix:
prefer “**pod recreate**” (DaemonSet rollout) over “crash-loop restart.”
A crash that only restarts the **container inside the same Pod** does
**not** wipe `emptyDir`.

### The issue

Identity (leaf certificate, private key, agent ID, pulled API token) lives
under `/var/run/abluva`, backed by `emptyDir: {}` — tied to the **pod**
lifecycle, not the node.

### Why it’s a real problem

Events that **recreate the pod** wipe that directory:

- Routine **DaemonSet rollout** (new Agent image, resource change, etc.) —
  the common case, tied to **your** release cadence
- Node drain / reschedule that replaces the pod
- Not: simple in-pod process restart

Startup then re-bootstraps as a **new** agent → `PendingApproval` again
(or fail closed without bootstrap). Without a fix, every Agent release
asks for tenant-admin work on every node (unless auto-approve — see D8).

### Fix (recommended): `hostPath`, not a PVC

- Ties the directory to the **node** → rollout on the same node keeps
  identity
- No dynamic storage provisioner required
- Cost: deliberate node filesystem touch — document PSA / `hostPath`
  policy; path should include namespace if multiple tenants share a node
- Do **not** build a cross-substrate identity product; fix K8s packaging
  only; VM already OK; ECS = PoC scope later

---

## Production checklist (priority order)

| # | Item | Current state | v1 blocker? | Ticket / action |
|---|---|---|---|---|
| 1 | Per-instance Agent identity (CSR + multi-redeem bootstrap) | **Done** — CSR + **D2-NEW** K8s Secret identity store (default); `hostPath` legacy fallback | Was blocking; closed | `L3-AGT-02` — proof: `issue_leaf.test.ts`, `smoke-k3d-tenant.sh`; DaemonSet `FABRIC_IDENTITY_STORE=kubernetes` |
| 2 | K8s Service routing for N registrations | **Done** | Was blocking; closed | `L3-ACL-01` — `smoke-k8s-service.sh` |
| 3 | `internalTrafficPolicy: Local` | **Done** | Closed | Same as #2 |
| 4 | Scoped Agent bearer + pull (CTL-01a / CRED-01) | **Done** — PoP + reuse-if-fresh (**D1**) + 1h refresh (**D5**) | Closed | G-CRED-1; `agent_api_token_pull.test.ts` |
| 5 | Cert rotate API + Agent flag | **Done** — **D3-AUTO** always-on auto-rotation (primary); `FABRIC_AGENT_ROTATE=1` emergency-only | Closed | `L3-PKI-01` — `agent_rotate.test.ts` |
| 6 | Ghostunnel shutdown ↔ Gateway grace | **Done** | Closed | `L3-GW-07` |
| 7 | Gateway Service + revoke push + OCI NLB | **Partial** — TF shipped; **apply** open | Ops before go-live | `L3-OPS-01` — `deploy/platform/oci/nlb/` |
| 8 | mTLS/JWT writers (CTL-01b) | **Open** | No — defer | `L3-CTL-01` 1b |
| 9 | OIDC evidence (EVID-01) | **Open** | No | `L3-EVID-01` |
| 10 | Cert expiry scan job | **Done** — webhook Secret optional (**D6-A**) | Soft until Secret filled | `L3-PKI-01` / `cert_expiry_scan.test.ts` |
| 11 | Ambient L4 verify | **Done** on k3d; re-run on OKE | Cutover verify | `L3-MESH-01` |
| 12 | ECS GA | Partial | No — post K8s GA | `L3-POC-ECS` |
| 13 | Quota `opens` sweep | **Done** | Closed | Gateway `quota` |

**v1 ship bar:** decisions D1–D8 locked in code/manifests; apply **#7** NLB,
create cert-expiry webhook Secret when ready, Validation-Plan green, Ambient
re-verify on real Platform. Defer 8–9, 12. Add smoke: identity survives
DaemonSet rollout (hostPath).

---

## Gateway on OCI (`L3-OPS-01`) — locked

Detail: Runbook Step **5b** + `deploy/platform/oci/nlb/README.md`.

1. **OCI Network Load Balancer** — L4 TCP to Ghostunnel **:8443** (not ALB).
2. **PROXY / PPv2 off** — Terraform `is_ppv2enabled = false`.
3. Agent `FABRIC_GATEWAY_ADDRESS` = NLB DNS (`terraform output fabric_gateway_address`).
4. **`FABRIC_GATEWAY_PUSH_*` in-cluster only** →
   `fabric-gateway.fabric-control.svc.cluster.local:9090` (never NLB, never :8443).
5. Customer install: `deploy/connect-agent/tenant-start.sh`.

---

## Day‑N (customer adds Postgres / Platform adds a service)

### Customer adds Postgres (or any customer resource)

1. `POST /v1/registrations` with `CUSTOMER_RESOURCE` (or `CUSTOMER_SERVICE`),
   `host`/`port` **reachable from the Agent** — sync → `Active` or `400`.
2. Within ~one Agent poll (default **5s**): local listener + optional
   Service port reconcile (`FABRIC_K8S_SERVICE_MANAGE_ENABLED`).
3. App dials `connect-agent.<ns>.svc:<port>` (see Service annotation
   `fabric.abluva.io/registration-ports`).

**Still customer work (expected, not a Fabric bug):** NetworkPolicy consumer
label, resolve/reach the Agent Service, Agent→Postgres egress. Not a single
API call in isolation.

**Docs gap (cheap):** Runbook’s first example is `PLATFORM_SERVICE`; add a
customer-Postgres example + “wait ~5–10s after create” on
`tenant-start.sh` / Runbook.

### Platform adds something

- Customer→Platform: `PLATFORM_SERVICE` / `PLATFORM_RESOURCE` registration
  (same Agent listener/Service update).
- Platform→Customer inbound: also needs DNS reconciler + `FABRIC_DNS_TARGET`
  (Day 0). Wrong webhook/VIP breaks A3/B4 even if the Agent tunnel is up.

---

## Long-term ops (after D2)

| Failure | Who fixes | Notes |
|---|---|---|
| Gateway / CP crash | Platform | Agents reconnect on backoff; no customer Secret rolls |
| DNS reconciler / Lease | Platform | Fail-closed logs; no customer action |
| Cert approaching NotAfter | Platform + Agent path (D3) | Webhook/logs (D6); rotate needs Agent CSR |
| Cert expired | Fail-closed at Ghostunnel | Safe (no traffic); remediate via D3 + D2-A |
| API token pull failing | Platform / Agent logs | `agent_api_token_refresh_failed`; leaf PoP does not need Secret edit |
| Identity lost (node replaced) | Re-enroll that node | Expected; bootstrap window or assist |
| Corporate proxy / missing `NO_PROXY` | Customer config | Top support trap — tunnel silent-fail; CP HTTPS may still work |

Debugging today is log-line based (no consecutive-failure counters). Optional
later: alert on N× `agent_api_token_refresh_failed` / `dns_reconciler_lease_error`.

---

## E2E chain (if config is correct)

```text
Day 0  terraform apply NLB → DNS → deploy GW+Ghostunnel + CP + Secrets
Day 1  UI bootstrap → tenant-start.sh → enroll (CSR) → approve → tunnel via NLB:8443
Day N  registration → ~5s → app → connect-agent.svc → StreamOpen → bytes
```

**Not yet proven as one continuous OCI run** (pieces verified separately).
Pilot order:

1. Migration + Access Postgres + Agent CA + auth Secrets  
2. Gateway/Ghostunnel + CP (`deployment.yaml`)  
3. `deploy/platform/oci/nlb` apply + `openssl s_client`  
4. `deploy/platform/oci/dns-webhook` apply (OCI DNS Zone receiver; `FABRIC_DNS_PROVIDER=webhook` on CP) — see Runbook "Wiring the DNS reconciler"  
5. Customer: `tenant-start.sh` → approve → registration → StreamOpen  
6. Revoke-cert force-close (push or poll)  
7. Ambient verify on Platform only  
8. Confirm expiry warnings hit webhook or log alert (D6)

### Cutover hole scan (short)

| Area | Hole |
|---|---|
| Access / Postgres | Real Access samples; no local stub in prod |
| Secrets | `fabric-agent-ca`, `fabric-gateway-tls`, writer/dual-control, DNS webhook token |
| NLB | Apply TF; PROXY off; Agent snippet = NLB host |
| DNS inbound | **Shipped for OCI** (`deploy/platform/oci/dns-webhook/`) — must still be *deployed* and pointed at the real OCI DNS Zone (`OCI_DNS_ZONE_ID`) + `FABRIC_DNS_TARGET` set. Not a code gap anymore, an apply-it gap, same posture as the NLB Terraform. |
| Customer | NLB + `NO_PROXY`; CA-only Secret; **D2-NEW Secret store** (or hostPath legacy) in shipped manifests |
| UI | Day‑1 screens; must not teach Secret rolls for token hygiene |

---

## Watch items (not blockers)

| Item | Note |
|---|---|
| OpenSSL in CP image | `issueLeafFromCsr` shells out — prod image must keep `openssl` |
| Agent API token | Derived from leaf cert after enrollment; steady state = file + pull |
| Shared-leaf → CA-only | Old tenants need **clean reinstall**, not rolling migration |
| Job health metrics | Optional; log alerts suffice for v1 |

---

## Future Architecture: Multi-Region Gateway (post-v1)

**Problem:** Current deployment is single-cluster (replicas: 2, same OKE
cluster). A full region/cluster failure disconnects all tenants until
Agents reconnect to a restored Gateway.

**Industry pattern:** Cloudflare Tunnel maintains 4 connections to 2+
geographically distinct data centers. Teleport Proxy Peering connects
proxies across regions. Boundary multi-hop workers chain across network
boundaries.

**Recommended evolution:**

1. **Phase 1 — Active/Standby Gateway in second region.** Agents configured
   with two Gateway addresses (primary + failover in `FABRIC_GATEWAY_ADDRESS`).
   Agent dial loop tries primary first; on sustained failure (e.g. 3×
   backoff cap), falls through to secondary. DNS-based failover (health
   check removes unhealthy region) is the simplest first step.
2. **Phase 2 — Active/Active multi-region.** Agents hold connections to two
   Gateways simultaneously (like Cloudflare's 4-connection model). Requires
   Gateway state synchronization (registration/revocation state must be
   consistent across regions — either shared DB or event-driven sync).
3. **Phase 3 — Geo-aware routing.** Control plane assigns Agents to nearest
   Gateway based on latency; Platform→Customer (A3/B4) traffic routes to
   the Gateway closest to the target Agent.

**Impact on current code:** Agent `tunnel.Dial` already reconnects forever
with backoff. Phase 1 requires only a fallback address list and a "try next
on sustained failure" loop — minimal Agent change. Gateway state consistency
is the harder problem (shared Postgres across regions, or CP replication).

**Not v1. Track as `L4-MULTI-REGION`.**

---

## Future Architecture: Auto-Discovery / Cloud-Native Join (post-v1)

**Problem:** Day-1 requires a bootstrap token issued out-of-band. For cloud
customers (OCI, AWS, GCP, Azure), the workload can already prove its
identity via platform attestation — eliminating the token step entirely.

**Industry pattern:** Teleport IAM Join (AWS STS, GCP metadata, Azure
managed identity). GitHub Actions OIDC federation. OCI Workload Identity
for self-managed Kubernetes clusters (announced 2025).

**How it would work for this Fabric stack:**

1. Agent starts with `FABRIC_JOIN_METHOD=oci-instance-principal` (or
   `aws-iam`, `gcp-metadata`).
2. Agent calls cloud metadata service to get a signed attestation document
   (OCI: instance principal token; AWS: STS `GetCallerIdentity` presigned
   URL; GCP: instance identity token).
3. Agent sends attestation to control plane `POST /v1/agents/enroll` with
   `join_method: "oci-instance-principal"` + the signed document.
4. Control plane verifies the attestation against cloud APIs (OCI: validate
   instance OCID is in expected compartment; AWS: call STS; GCP: verify
   token audience + project).
5. If attestation matches a pre-configured "allow" rule (e.g., "any
   instance in OCI compartment X may join as tenant Y"), enroll proceeds
   without a bootstrap token.

**Benefits:**
- Zero bootstrap token for cloud-native customers
- Stronger attestation (cloud platform signs the identity, not a shared secret)
- Works with auto-scaling (new instances auto-join without pre-provisioning tokens)
- Aligns with `L3-EVID-01` workload evidence — same infrastructure, different gate

**Prerequisites:** Per-tenant "join rules" in `ablv_tenant_connect` (e.g.,
`allowed_oci_compartments`, `allowed_aws_accounts`). Verification client
for each cloud provider.

**OCI-specific:** OCI already supports Workload Identity for self-managed
K8s clusters (the exact environment your customers run). An Agent pod with
a Kubernetes ServiceAccount can get an OCI-signed OIDC token that proves
"I am running in compartment X, cluster Y, namespace Z." This is the
natural join method for OCI-based customers, and would be implemented as
an `oci.Method` satisfying the `enroll.Method` interface (see D11).

**Not v1. Track as `L4-CLOUD-JOIN`. Builds on `L3-EVID-01` infrastructure.**

---

## Verify, don’t just implement

| Check | Harness |
|---|---|
| Multi-instance enroll | `smoke-k3d-tenant.sh` day-1c |
| N registration Service ports | `smoke-k8s-service.sh` |
| Scoped token cannot suspend | `smoke-k3d-tenant.sh` CTL-01a |
| Cert rotate keeps `agent_id` | `smoke-k3d-tenant.sh` PKI-01a (Secret-store identity, D2-NEW) |
| Identity survives DaemonSet rollout | **Recommended** follow-up smoke (Secret-store survival across image rollout — unit-tested in `k8ssecret_test.go`; dedicated E2E pending) |
| Ambient A1/B1 | `smoke-ambient.sh` on Platform |

**Done discipline:** Level-3-Tickets Done rows cite proof. Missing proof →
Partial/Open.

---

## Sync map

| Concern | Tickets | Ops | UI |
|---|---|---|---|
| Agent identity volume | AGT-02 + **D2** | Runbook Step 3 + DaemonSet | Checklist Day‑1 / upgrade note |
| Agent credential Day‑N | CRED-01 / **D1 D4 D5** | Runbook credentials | Checklist §0 — pull, not Secret roll |
| Cert rotate / expiry | PKI-01 / **D3 D6** | Runbook | Checklist §4 |
| Gateway NLB | OPS-01 | Runbook 5b | Non-goal (Platform) |
| Failed retry | REG-01 | Runbook | Checklist §3 |
| Ambient | MESH-01 | Day 0 | Non-goal (Platform) |

When testing finishes, update **Validation-Plan** first after smokes, then
tickets, then this file.

**Pre-prod doc follow-ups (2026-07-27):** Runbook has full
[Configuration catalog for operators](Operational-Runbook.md#configuration-catalog-for-operators);
cert-rotate **stall recovery** documented; Validation-Plan hostPath row
corrected (production DaemonSet uses K8s Secret store; emptyDir is a local cache).
