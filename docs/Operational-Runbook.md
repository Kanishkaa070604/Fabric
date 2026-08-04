# Operational Runbook — Fabric Connectivity Platform

This runbook is for people who install the platform, onboard tenants, and
troubleshoot Fabric day to day. It's written as plain instructions and
copy-pasteable checks, not architecture explanation — for the concepts and
reasoning behind what's below, read `Connectivity-Technical-Guide.md` first.
For schemas/wire shapes/manifest pointers, use `Developer-Reference.md`.
For the frozen architecture itself (vocabulary, the eight pathways, ADRs),
`Architecture-Spec.docx` is the normative source; this runbook never
contradicts it, only operationalizes it. Document map: `README.md`. Decisions
and short IDs: `Architecture-Resolutions.md`. Locked packaging (D1–D8):
`PRODUCTION-READINESS.md`. Store/OIDC: `Level-3-Store-OIDC-Spec.md`.
Ticket backlog only (not architecture): `Level-3-Tickets.md`.

Throughout, this document uses the Spec's own terms — **Platform** and
**Customer Environment** — never "SaaS side" or "tenant side."

**If something is failing, work through [Troubleshooting](#troubleshooting)
before hand-editing SQL or adding proxy settings you haven't confirmed are
the actual cause.**

---

## What you're actually operating

Five moving parts, in the order traffic touches them:

1. **Connect Agent** — runs inside the customer's Kubernetes cluster. Dials
   out to the Platform; never accepts an inbound connection.
2. **The tunnel** — the long-lived mutual-TLS connection the Agent opens to
   the Gateway. (This is *not* the same thing as ztunnel below — see the
   terminology note immediately after this list, because confusing the two
   is the most common source of misdiagnosis in this system.)
3. **Ghostunnel**, on the Gateway pod — terminates that incoming TLS
   connection and hands a decrypted connection, plus the client's
   certificate identity, to the Gateway process over a Unix socket.
4. **The Gateway** — decides whether each individual application stream is
   allowed (authorization), then relays bytes to wherever it's actually
   going.
5. **Istio Ambient**, on the Platform Kubernetes cluster only — **ztunnel**
   gives every Platform pod mutual TLS automatically; **waypoint**
   (optional, per namespace) adds HTTP/gRPC-aware retries and policy on top.
   Applies to Spec pathways A1, A2 (after the Gateway), A3 (before the
   Gateway), B1, and B4. Installed and verified via
   `deploy/platform/ambient/` (Step 7 below).

The **control plane** is the sixth piece, off to the side of the traffic
path: it stores tenant records, Agent state, registrations, and bootstrap
tokens, and it talks to Postgres using credentials it fetches from the
**Access API** — never from a password sitting in an environment variable.

**Terminology, stated once so it never has to be re-explained:** "the
tunnel" always means the Agent↔Gateway connection in item 2 above.
"ztunnel" always means Istio's own component in item 5. They sound similar,
they're both mTLS, and they are otherwise unrelated — different mechanism,
different components, different side of the Platform/Customer boundary.
Ghostunnel and ztunnel/waypoint never run in the same place: **Ghostunnel
runs only on the Gateway pod, never on the Agent. ztunnel and waypoint run
only on the Platform cluster, never in any Customer Environment.**

---

## Scripts vs UI (so Day 0 / Day 1 / Day‑N stay aligned)

| Phase | Owner | How | Source of truth in this repo |
|---|---|---|---|
| **Platform Day 0** | Platform ops | Scripts / kubectl / manifests only | This Runbook → [Installing the platform (Day 0)](#installing-the-platform-day-0) |
| **Tenant Day 1** | Tenant admin (+ Platform assist) | **UI** for control-plane actions (ensure, quotas, bootstrap, approve, first registration); **scripts/manifests** for Agent install on the customer cluster | Runbook [Day 1](#onboarding-a-customer-agent-day-1) (API + table checks in each step) + `Tenant-App-UI-Checklist.md` §1 + `deploy/connect-agent/` |
| **Day‑N** | Tenant admin | **UI first** (retry Failed, edit regs, retire, revoke, suspend). Curl remains the ops fallback and the smoke harness | Runbook → [Day to day](#day-to-day-registrations-and-pathways) + `Tenant-App-UI-Checklist.md` §§2–5 |

End-to-end proof matrix (k3d, Ambient, jobs, AGT-02): `Validation-Plan.md`.

**There is no tenant-app CronJob** for Failed registrations, DNS, or heartbeats.
Those are either on-demand UI/API actions or in-process Platform/Agent
tickers — see [Background jobs](#background-jobs-what-runs-without-a-human).

---

## Before you install

You'll need, gathered up front:

- **A Platform Kubernetes cluster** (this deployment: OKE) to run the
  Gateway, the control plane, and Istio Ambient (ztunnel).
- **Customer clusters** (RKE2 or EKS in this deployment) where Connect
  Agents will run. No Ambient, no ztunnel, ever, on these.
- **Intermediate CA material** for issuing Gateway and Agent certificates.
  The Root CA itself stays offline, per the architecture's certificate
  hierarchy.
- **Access API reachability**, at `ABLV_ACCESS_URL`, with your platform
  tenant and environment IDs on hand.
- **Postgres reachability** from the control plane — credentials for this
  come from Access API's `keys#database`, not a static connection string.
- **Container images** for `fabric-gateway`, `connect-agent`, and Ghostunnel
  — pin Ghostunnel to **v1.11.1**, or any release **≥ v1.10.0** (that
  version is the first to support `--proxy-protocol-mode=tls-full`, which
  this deployment relies on).
- **`istioctl`**, or use the wrapper script
  `deploy/platform/ambient/install-ambient.sh`, which can fetch a pinned
  Istio release for you.

For local development without a real Postgres, the control plane defaults
to an in-memory store (`FABRIC_STORE=memory`). Production always runs
`FABRIC_STORE=postgres`, after the SQL migration in Step 4 below has been
applied.

---

## The one idea that causes the most confusion: "tunnel up" ≠ "approved for traffic"

This is worth its own section because it's the single most common thing
an on-call engineer gets wrong on their first incident with this system.

When a customer installs a Connect Agent, it's completely normal — expected,
by design — for the Agent to successfully dial the Gateway and hold a
healthy tunnel *before* any human has approved it. The tunnel and the
approval are two separate gates, and that's deliberate: this system uses
**one single mTLS tunnel for both the bootstrap handshake and all later
data traffic** (rather than a separate bootstrap-only channel), and it
enforces security at the level of individual **application streams**, not
by refusing to let the tunnel come up at all.

| What you're seeing | What it actually means | What to do |
|---|---|---|
| Tunnel is up, Agent state is `PendingApproval` | Completely normal — waiting on a human | Approve the Agent. Do not open a network investigation. |
| An application connection fails with deny / empty reply while Agent is `PendingApproval` | Gateway blocked StreamOpen (`UNAUTHORIZED` + pending-approval reason on the wire — not a separate outcome enum) | Same fix — approve the Agent |
| Agent stuck in `Connecting` for a long time | Approved, but the Gateway has never actually seen a live tunnel | Now it's a real networking problem — check the dial, the certificates, DNS, or `NO_PROXY` (below) |
| Agent shows `Connected`, but applications still fail | Approval and the tunnel are both fine — look at the registration (`Failed` → retry), the destination, or reachability instead | Use [Troubleshooting](#troubleshooting) (esp. [Registration is Failed](#registration-is-failed)) |

**Who actually approves an Agent:**
- Normally, the tenant's own administrator, through the product UI (or
  directly: `POST /v1/agents/:id/approve`).
- A Platform operator can use the same approval endpoint as a break-glass
  action — always record who did it via the `X-ABLV-Actor` header.
- A tenant can opt into auto-approve (**default off**) with
  `POST /v1/tenants/:id/auto-approve` `{ "enabled": true }` — labs/dev only.
  That skips `PendingApproval` so the Agent goes straight to `Connecting`
  then `Connected` when its tunnel is up. Production keeps human approve.

Data traffic is only ever allowed when an Agent's state is **`Connected`**
or **`Degraded`** — nothing else.

### Agent states, plainly

| State | What it means | Can applications use Fabric right now? |
|---|---|---|
| `PendingApproval` | Enrolled, waiting on a human (or an auto-approve policy) | No |
| `Connecting` | Approved, waiting for the tunnel to actually come up | No |
| `Connected` | Approved, and the tunnel is healthy | Yes |
| `Degraded` | Still usable, but health signals are reduced — see the note below | Yes |
| `Disconnected` | Tunnel lost; the Agent's own dial loop reconnects with backoff | No |
| `Retired` | Deliberately offboarded | No |

Worth calling out explicitly, because it surprises people: `Degraded` still
allows traffic. Degraded is a health signal, not a security gate — the
distinction matters because conflating the two would mean a routine health
blip silently cuts off a tenant's traffic, which is not the intended
behavior.

**Two orders this can happen in, both normal:**

*Approve, then tunnel comes up* — the straightforward case: enroll →
`PendingApproval` → an admin approves → `Connecting` → the Agent's dial
succeeds and the Gateway reports the tunnel up → `Connected`. Applications
can now open streams.

*Tunnel comes up first, approval happens later* (very common right after a
fresh install) — enroll → `PendingApproval` → the Agent dials the Gateway
and the tunnel actually comes up immediately, while state is still
`PendingApproval` (you'll see this reflected as `up_pending_approval` on
the tunnel field) → any application that tries to use it now correctly gets
`PENDING_APPROVAL` → once an admin approves, since the tunnel is *already*
up, the state jumps straight to `Connected` with no `Connecting` step in
between.

You can exercise this whole path yourself, any time:

```bash
./deploy/scripts/api-smoke.sh
cd control-plane && npm test
```

---

## Network and HTTP proxies (top support trap)

**What “corporate proxy without `NO_PROXY` for Gateway host” means:** many
enterprise Kubernetes nodes inject `HTTP_PROXY` / `HTTPS_PROXY` (admission
webhook, node agent, or base image). The Agent→Gateway path is **raw
mutual-TLS TCP**, not HTTP. If the Gateway NLB hostname is **not** listed in
`NO_PROXY` / `no_proxy`, the runtime still tries to send that dial through the
HTTP proxy. The proxy cannot terminate or forward mTLS correctly → the Agent
stays in `Connecting` / never reaches `tunnel_ready`, often with no obvious
TLS error in the UI. That is the support trap: looks like “network is fine”
(HTTPS to the control plane may work via the same proxy) while Fabric
tunnel is silently broken.

**The rules:**
- On the Agent pod, `NO_PROXY`/`no_proxy` **must** include the Gateway's
  hostname (NLB DNS) and the cluster's internal address ranges.
  `deploy/connect-agent/tenant-start.sh` and the DaemonSet template set this.
- Do **not** set `HTTP_PROXY`/`HTTPS_PROXY` on the Agent in an attempt to
  "help" it reach the Gateway — that almost always breaks the tunnel.
- On the Gateway side, keep the control-plane and Access API hosts in
  `NO_PROXY`. Only consider `HTTPS_PROXY` later, and only if the Gateway
  specifically needs to reach a customer's OIDC JWKS endpoint through a
  corporate proxy.

**Checking a running Agent's proxy configuration:**

```bash
NS=<tenant-namespace>
POD=$(kubectl -n "$NS" get pod -l app=connect-agent -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" exec "$POD" -- printenv | egrep -i 'proxy|FABRIC_GATEWAY'
```

You should see `FABRIC_GATEWAY_ADDRESS` set, and that same host present in
`NO_PROXY`/`no_proxy`.

---

## Installing the platform (Day 0)

Everything in this section happens once per Platform environment.

**OCI front-door (NLB + inbound DNS):** Steps **5b** and **5c** below are the
blind ops procedure (Console/CLI for every OCID, NodePort, DNS→VIP, zone/IAM/webhook).
Deploy READMEs under `deploy/platform/oci/` are thin pointers back here — not a second guide.

**DNS prerequisite (do this while NLB is being created).** You own the
public domain (`abluva.com` in examples). You need the Gateway A record
in all cases, plus ONE of two approaches for inbound registration names:

| # | Record in Cloudflare | Points at | Created when | Which path |
|---|---|---|---|---|
| 1 | **A** `fabric.abluva.com` (DNS-only / grey cloud) | NLB public VIP | Step 5b, after `terraform apply` gives the VIP | **Both** (always needed) |
| 2a | **CNAME** `*.connect.abluva.com` → `fabric.abluva.com` (DNS-only / grey cloud) | Gateway inbound (wildcard) | Now (one-time Cloudflare click) | **Path C — simplest** |
| 2b | **NS** `connect.abluva.com` → OCI nameservers (4 records) | OCI DNS (delegated zone) | Step 5c, when you create the OCI inbound zone | **Path B — per-record audit** |

**Choose path C (wildcard) unless you need per-registration DNS audit.**
Path C = 2 Cloudflare records total, zero OCI DNS zone, no dns-webhook,
no IAM policy, no reconciler. Path B = OCI zone + NS delegation + webhook
deploy + IAM — more infrastructure but gives you explicit per-registration
records visible in OCI DNS console.

**Do not combine 2a and 2b** — a wildcard CNAME and NS delegation for the
same subdomain conflict. Pick one.

**Do not** enable Cloudflare's HTTP proxy (orange cloud) on any Fabric
record — Agents and inbound dials are TCP mTLS to `:8443`/`:8444`, not HTTP.

### Step 0 — Platform Secrets (one script)

All Platform Secrets (writer bearer, dual-control, platform Access IDs,
cert-expiry webhook, DNS webhook URL+token, Agent CA, Gateway TLS) are
created by a single script so names/keys match the Deployments:

```bash
cd deploy/platform

export FABRIC_NAMESPACE=fabric-control
export ABLV_PLATFORM_TENANT_ID=<platform-saas-tenant-uuid>      # required
export ABLV_PLATFORM_ENVIRONMENT_ID=<platform-env-uuid>         # required
export CERT_EXPIRY_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx   # optional
export FABRIC_AGENT_CA_CERT_FILE=/path/to/agent-ca.crt
export FABRIC_AGENT_CA_KEY_FILE=/path/to/agent-ca.key
export FABRIC_GATEWAY_CERT_FILE=/path/to/gateway.crt
export FABRIC_GATEWAY_KEY_FILE=/path/to/gateway.key
export FABRIC_GATEWAY_CA_FILE=/path/to/intermediate-ca.pem        # Ghostunnel --cacert

./setup-day0.sh
# Prints generated tokens (save securely) and next-step instructions.
```

**Secrets this must create** (must match `deploy/*/deployment.yaml`):

| Secret | Keys | Consumed by |
|---|---|---|
| `fabric-control-plane-auth` | `bearer_token`, `dual_control_token` | CP |
| `fabric-platform-ids` | `tenant_id`, `environment_id` | CP + Gateway |
| `fabric-dns-webhook` | `url`, `token` | CP |
| `fabric-dns-webhook-token` | `token` (same value) | dns-webhook Deployment |
| `fabric-agent-ca` | `ca.crt`, `ca.key` | CP volume |
| `fabric-gateway-tls` | `gateway-cert.pem`, `gateway-key.pem`, `intermediate-ca.pem` | Ghostunnel |
| `fabric-cert-expiry-webhook` | `url` (optional) | CP |

**Who owns this:** Platform ops. Idempotent. See `deploy/platform/setup-day0.sh`.

### Step 1 — Non-secret configuration

Set these on both the control plane and the Gateway (ConfigMap, or your
deployment's own env mechanism). Database passwords and TLS private keys
never belong in plain environment variables for production — those come
from Access API and from certificate distribution, respectively.

| Variable | What it's for | Example |
|---|---|---|
| `ABLV_ACCESS_URL` | Access API endpoint | `http://172.16.1.101:3000/v1/access` |
| `ABLV_PLATFORM_TENANT_ID` | Platform's own tenant UUID | — |
| `ABLV_PLATFORM_ENVIRONMENT_ID` | Platform's own environment UUID | — |
| `FABRIC_VAULT_PREFIX` | Secret naming prefix | `ablv-fabric` |
| `FABRIC_CONTROL_PLANE_URL` | How the Gateway and Agents reach the control plane | in-cluster Service URL |
| `FABRIC_GATEWAY_UNIX_SOCKET` | The Unix socket Ghostunnel forwards to | `/var/run/fabric/gateway.sock` |
| `FABRIC_STORE` | `memory` for local dev, `postgres` for anything real | `postgres` in production |
| `FABRIC_LOG_LEVEL` | Log verbosity | `info` |

### Step 2 — Certificates

1. The Root CA stays offline, always.
2. Issue an Intermediate CA — this is what actually signs Gateway and
   Agent leaf certificates day to day.
3. Sanity-check it:

```bash
openssl x509 -in intermediate.pem -noout -subject -issuer
```

### Step 3 — Confirm Access API and Postgres are actually reachable

From anywhere that can reach the Access API:

```bash
# This checks the SHAPE of the response only — use your real platform
# tenant/environment headers, and never commit the password it returns.
curl -sS -X POST "$ABLV_ACCESS_URL" \
  -H "Content-Type: application/json" \
  -H "X-ABLV-Tenant-ID: $ABLV_PLATFORM_TENANT_ID" \
  -H "X-ABLV-Environment-ID: $ABLV_PLATFORM_ENVIRONMENT_ID" \
  -H "X-ABLV-ResourceType: keys#database" \
  | jq '{status,statusCode,host:.data.connection.host,db:.data.connection.database,user:.data.credential.username,tls:.data.tls.mode}'
```

A healthy response has `status=success`, a real host/database/username, and
a `tls.mode` (commonly `VERIFY_FULL`). The control plane maps this response
shape automatically.

Fetching a general secret works the same way, reading `data.value`:

```bash
curl -sS -X POST "$ABLV_ACCESS_URL" \
  -H "Content-Type: application/json" \
  -H "X-ABLV-Tenant-ID: $ABLV_PLATFORM_TENANT_ID" \
  -H "X-ABLV-Environment-ID: $ABLV_PLATFORM_ENVIRONMENT_ID" \
  -H "X-ABLV-ResourceType: data-privacy#secrets-manager" \
  -d '{"action":"get","secretName":"service-test-key"}' \
  | jq '{status,statusCode,value_present:(.data.value!=null)}'
```

### Step 4 — Apply the Fabric SQL migration

Only do this after Step 3's database credentials are confirmed working,
and only if `ablv_tenants(tenant_id)` already exists in that database (this
migration adds Fabric-specific tables alongside it, not instead of it).

**Single file (pre-production — no incremental chain):**
`control-plane/migrations/20260723120000-init-fabric.sql`

Confirm it landed correctly:

```sql
SELECT tablename FROM pg_tables
 WHERE schemaname = 'public' AND tablename LIKE 'ablv_%'
 ORDER BY 1;

SELECT column_name FROM information_schema.columns
 WHERE table_name = 'ablv_tenant_connect'
   AND column_name IN (
     'suspended', 'bootstrap_token_hash', 'revoked_cert_fingerprints',
     'agent_api_token_hash', 'prior_agent_api_token_hash'
   );
```

You're looking for `ablv_tenant_connect`, `ablv_registrations`, and
`ablv_agents` to exist, with the columns above present.

**Never** hand-fix an Agent's state with something like
`UPDATE ablv_agents SET state='Connected'`. Doing that skips the approval
step and tunnel-reporting logic entirely, and will leave the Gateway's own
authorization view of that Agent inconsistent with the database.

### Step 5 — Deploy the Gateway and Ghostunnel

Manifest: `deploy/gateway/deployment.yaml`

A few things worth knowing before you apply it:

- Ghostunnel's image must be **≥ v1.10.0** — the manifest pins
  `ghostunnel/ghostunnel:v1.11.1-distroless`.
- Use `--proxy-protocol-mode=tls-full` **by itself** — never alongside the
  older `--proxy-protocol` flag, since the two are mutually exclusive (this
  is enforced by Ghostunnel itself, not just a style preference).
- Use `--allow-all`, relying on Intermediate CA verification to scope which
  clients are trusted — deliberately not adding an OPA policy on top of
  Ghostunnel, since Registration-level authorization is the Gateway's job,
  not Ghostunnel's.
- The Gateway listens only on the Unix socket; Ghostunnel is what actually
  listens on `:8443` and terminates the incoming TLS.

```bash
kubectl -n fabric-control apply -f deploy/gateway/deployment.yaml
kubectl -n fabric-control get deploy fabric-gateway
kubectl -n fabric-control logs deploy/fabric-gateway -c gateway --tail=50
```

You're looking for a log line confirming the Gateway is listening on its
Unix socket. Shipped Deployment uses **`replicas: 2`** — check both pods
Ready. A dead Gateway pod drops **its** yamux tunnels; Agents reconnect
with backoff (1s → cap **30s**, never give up) to a healthy replica behind
the Service/NLB. SaaS↔customer for that Agent stays down until reconnect
succeeds — that is expected, not a stuck Agent.

**Two independent shutdown timers exist in this same pod, and they need to
agree with each other.** The Gateway process has its own graceful-shutdown
behavior (below), but Ghostunnel — sitting in front of it in the same
pod — has its *own*, separately configured `--shutdown-timeout` (5 minutes,
by Ghostunnel's own default) governing how long *it* waits for in-flight
connections to drain before force-exiting. If your deployment manifest only
tunes the Gateway's own grace period below and leaves Ghostunnel's
`--shutdown-timeout` at its 5-minute default, Ghostunnel can still be
draining well after the Gateway process it fronts has already exited —
worth explicitly setting Ghostunnel's `--shutdown-timeout` to agree with
the same budget, rather than assuming one grace period covers both
processes. **Shipped (`L3-GW-07`):** manifests set `--shutdown-timeout=25s`
alongside `FABRIC_SHUTDOWN_GRACE=25s` and `terminationGracePeriodSeconds: 45`.
In-cluster Service `fabric-gateway` (mtls:8443, internal revoke:9090) is for
CP push / admin — public Agent dials use Platform OCI NLB (TCP, PROXY off);
see Step 5b and `PRODUCTION-READINESS.md` / `L3-OPS-01`.

#### Step 5b — OCI NLB for Agent dial (`L3-OPS-01`) — blind ops

Agents dial Ghostunnel from outside the Platform cluster. That needs a
public (or customer-reachable) **L4** front — not an HTTP/TLS-terminating LB.

**Audience:** Platform ops who have never seen this repo. Follow subsections
in order; each value tells you the Console path or CLI. Artifacts only
(no separate ops doc): `deploy/platform/oci/nlb/`,
`deploy/platform/setup-day0.sh`, `deploy/gateway/deployment.yaml`.

##### Prerequisites

| Need | How you get it |
|---|---|
| `kubectl` on the **Platform** OKE cluster | Cluster admin |
| `terraform` ≥ 1.3 | Install locally / CI |
| `oci` CLI (`oci setup config`) or instance principal | [OCI CLI install](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm) |
| Compartment + rights to create NLB / DNS / IAM | Tenancy admin |

```bash
kubectl cluster-info
kubectl get ns fabric-control 2>/dev/null || kubectl create ns fabric-control
```

##### Collect OCI IDs

**Compartment OCID** — Console: Identity & Security → Compartments → open
Platform compartment → copy **OCID** (`ocid1.compartment…`).

```bash
oci iam compartment list --compartment-id-in-subtree true \
  --query "data[?name=='YOUR_COMPARTMENT_NAME'].id | [0]" --raw-output
```

**Subnet OCID** (regional **public** subnet, or one customers can reach) —
Console: Networking → VCNs → your VCN → Subnets → open subnet → **OCID**
(`ocid1.subnet…`).

```bash
oci network subnet list --compartment-id "$COMPARTMENT_OCID" --output table
```

##### Expose Ghostunnel to the NLB (required)

The shipped `fabric-gateway` Service is **ClusterIP** — an NLB cannot reach
it until you expose backends. **Recommended: NodePort.**

```bash
kubectl -n fabric-control apply -f deploy/gateway/deployment.yaml
kubectl -n fabric-control rollout status deploy/fabric-gateway

kubectl -n fabric-control patch svc fabric-gateway --type='json' -p='[
  {"op":"replace","path":"/spec/type","value":"NodePort"}
]'
cd deploy/platform/oci/nlb
./collect-backend-values.sh   # prints backend_ip_addresses + backend_port for tfvars
```

**Alternative — hostPort:** set Ghostunnel `hostPort: 8443` in
`deploy/gateway/deployment.yaml`, re-apply; then `backend_port = 8443` and
backends = worker InternalIPs that can run Gateway pods.

##### NSG: NLB → OKE workers on NodePort (required before Agents can dial)

You may already have an LB for the **control plane** — that is separate.
Agents dial Ghostunnel through an **OCI Network Load Balancer** (L4 TCP,
PROXY off) created in this Step 5b (`deploy/platform/oci/nlb/`). Until that
NLB exists **and** NSGs allow the path below, `openssl s_client` from
outside will fail even if pods are Ready.

**1. Learn the NodePort** (after the Service patch above):

```bash
kubectl -n fabric-control get svc fabric-gateway -o jsonpath='{.spec.ports[?(@.name=="mtls")].nodePort}{"\n"}'
# Example output: 31443
NODE_PORT=$(kubectl -n fabric-control get svc fabric-gateway -o jsonpath='{.spec.ports[?(@.name=="mtls")].nodePort}')
```

`collect-backend-values.sh` prints the same port as `backend_port` for
`terraform.tfvars`.

**2. Know which NSGs matter**

| Attachment | Typical role |
|---|---|
| NSG on the **NLB subnet** (or NLB VNIC) | Ingress from customers/internet; egress to workers |
| NSG on **OKE worker** subnet / node pool | Ingress from NLB subnet on `$NODE_PORT` |

Console: **Networking → Virtual Cloud Networks →** your VCN →
**Network Security Groups** (prefer NSG over Security Lists when both
exist — OKE often uses both).

**3. Rules to add** (minimum)

| NSG | Direction | Source / Dest | Protocol | Port | Why |
|---|---|---|---|---|---|
| NLB / public path | **Ingress** | `0.0.0.0/0` or customer CIDRs | TCP | **8443** | Customers dial NLB listener |
| NLB | **Egress** | OKE worker subnet CIDR | TCP | **`$NODE_PORT`** | NLB health check + data to Ghostunnel |
| Worker / node-pool NSG | **Ingress** | NLB subnet CIDR (not 0.0.0.0/0) | TCP | **`$NODE_PORT`** | Only the NLB may hit NodePort |
| Worker | — | — | — | **Do not** publish 9090 publicly | Revoke push stays in-cluster |

If you used **hostPort 8443** instead of NodePort, replace `$NODE_PORT`
with **8443** in the NLB→worker rules.

**4. CLI sketch** (replace OCIDs; or do the same in Console → NSG → Add rule):

```bash
# Example: allow NLB subnet → workers on NodePort (worker NSG)
# SOURCE = NLB subnet CIDR, e.g. 10.0.20.0/24
oci network nsg-security-rules add --nsg-id "$WORKER_NSG_OCID" \
  --security-rules "[{\"description\":\"fabric-nlb-to-ghostunnel-nodeport\",\"direction\":\"INGRESS\",\"protocol\":\"6\",\"source\":\"$NLB_SUBNET_CIDR\",\"sourceType\":\"CIDR_BLOCK\",\"tcpOptions\":{\"destinationPortRange\":{\"min\":$NODE_PORT,\"max\":$NODE_PORT}}}]"
```

**5. ☐ Validate NSG**

```bash
# From a host outside the VCN (laptop / customer-like):
nc -vz "$(terraform -chdir=deploy/platform/oci/nlb output -json nlb_ip_addresses | jq -r '.[0].ip_address // .[0]')" 8443
# or after DNS: nc -vz fabric.yourcompany.com 8443
```

If this times out but pods are Ready, NSG/Security List is almost always
the cause (or NLB backends wrong IP/port).

##### Apply NLB Terraform

| Decision | Value | Why |
|---|---|---|
| LB type | **OCI Network Load Balancer** (NLB) | L4 TCP. Never OCI Application LB. |
| PROXY on NLB | **Off** (`is_ppv2enabled = false`) | Ghostunnel already emits PROXY tls-full |
| Health check | Same as `backend_port` (TF default) | Do not HTTP-probe Ghostunnel |
| CP revoke push | in-cluster `fabric-gateway:9090` | **Never** the public NLB |

```bash
cd deploy/platform/oci/nlb
cp terraform.tfvars.example terraform.tfvars
# Fill compartment_ocid, subnet_ocid, dns_hostname from above
# Paste backend_ip_addresses + backend_port from collect-backend-values.sh
# Example dns_hostname: "fabric.yourcompany.com"
# Optional: oci_dns_zone_ocid to auto-create A record → VIP (see next subsection)

terraform init && terraform plan && terraform apply
terraform output nlb_ip_addresses        # VIP = public IP when is_private=false
terraform output fabric_gateway_address    # → FABRIC_GATEWAY_ADDRESS for tenants
terraform output agent_snippet_hint
```

**VIP** = NLB virtual IP = the **public IP** in `nlb_ip_addresses` for a
public NLB.

##### Point DNS name → NLB VIP (`FABRIC_GATEWAY_ADDRESS`)

Agents need a hostname (example: `fabric.yourcompany.com`) whose
**A record** is the NLB VIP.

| Where is that hostname hosted? | What to do |
|---|---|
| **OCI DNS Zone** | Set `oci_dns_zone_ocid` (+ compartment) in `terraform.tfvars` → re-`apply` (TF creates the A record) |
| **External DNS** (Cloudflare / Route53 / corporate) | Manually create **A** record → VIP from `nlb_ip_addresses`. No Fabric TF for non-OCI DNS. |

```bash
# Verify from a host that mimics customer egress (not from inside the cluster):
openssl s_client -connect "$(cd deploy/platform/oci/nlb && terraform output -raw fabric_gateway_address)" \
  -servername fabric.abluva.com </dev/null
# or: -servername "$(cd deploy/platform/oci/nlb && terraform output -raw fabric_gateway_address | cut -d: -f1)"
# Expect TLS handshake (not connection refused / plaintext HTTP).

# Revoke push must stay in-cluster :9090
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c exec deploy/fabric-control-plane -- \
  wget -qO- --timeout=2 http://fabric-gateway.fabric-control.svc.cluster.local:9090/ || true
```

Put `FABRIC_GATEWAY_ADDRESS=<host:8443>` into the tenant UI snippet /
`tenant-start.env`.

##### Cloudflare exact steps (`abluva.com` example)

Assumes: OCI NLB already applied; you have the public VIP; zone
`abluva.com` is already on Cloudflare.

**Inbound names (`connect.abluva.com`) — pick one path (not both):**

| Path | What you create | When |
|---|---|---|
| **C (recommended)** | Cloudflare **CNAME** `*.connect` → `fabric.abluva.com` | §C below — one click, no OCI DNS |
| **B** | Cloudflare **NS** `connect` → OCI nameservers + dns-webhook | §B below — per-registration records in OCI |

**Always** create the Agent dial **A** record first (§A): `fabric` → NLB VIP.

**Do not** enable Cloudflare proxy (orange cloud) on any Fabric record —
Agents and inbound dials are **TCP mTLS to :8443 / :8444**, not HTTP.

###### A. Agent dial hostname (you create once)

1. Get VIP:
   ```bash
   cd deploy/platform/oci/nlb && terraform output -json nlb_ip_addresses
   # pick the public IPv4
   ```
2. Cloudflare → **DNS** → **Records** → **Add record**

   | Field | Value |
   |---|---|
   | Type | **A** |
   | Name | `fabric` (→ `fabric.abluva.com`) |
   | IPv4 address | NLB public VIP |
   | Proxy status | **DNS only** (grey cloud) |
   | TTL | Auto |

3. Wire Fabric:
   ```bash
   # tenant-start.env / UI snippet
   FABRIC_GATEWAY_ADDRESS=fabric.abluva.com:8443
   ```
4. ☐ Check:
   ```bash
   dig +short fabric.abluva.com A
   # must equal NLB VIP
   openssl s_client -connect fabric.abluva.com:8443 -servername fabric.abluva.com </dev/null
   # expect TLS handshake (not HTTP/Cloudflare challenge page)
   ```

###### B. Inbound zone delegation (Platform → customer names)

Fabric auto-creates `*.connect.abluva.com` in **OCI DNS**, not as hand-made
Cloudflare A records. Cloudflare only **delegates** the subdomain.

**1. Create the OCI zone and copy the nameservers OCI assigns**

Console: **Networking → DNS Management → Zones → Create Zone**

| Field | Value |
|---|---|
| Zone type | Primary |
| Zone name | `connect.abluva.com` |
| Compartment | Platform compartment |

After create, open that zone. On the zone details page, OCI shows
**Nameservers** (Oracle-assigned hostnames for *this* zone — not a fixed
global list). Example shape only:

```text
ns1.p68.dns.oraclecloud.net
ns2.p68.dns.oraclecloud.net
ns3.p68.dns.oraclecloud.net
ns4.p68.dns.oraclecloud.net
```

Your `pXX` / hostnames **will differ**. Copy **every** nameserver shown
(often four). Also copy the zone **OCID** → `OCI_DNS_ZONE_ID`.

CLI equivalent (after `oci` is configured):

```bash
# Create (once):
oci dns zone create --compartment-id "$COMPARTMENT_OCID" \
  --name connect.abluva.com --zone-type PRIMARY

# List nameservers for the zone (this is the source of truth):
oci dns zone get --zone-name-or-id connect.abluva.com \
  --query 'data.nameservers[*].hostname' --raw-output
# or full JSON:
oci dns zone get --zone-name-or-id connect.abluva.com --query 'data.nameservers'
```

**2. Paste those hostnames into Cloudflare as NS records**

Cloudflare → **DNS** → **Records** → **Add record** — **one NS record per
OCI nameserver hostname** from step 1:

| Field | Value |
|---|---|
| Type | **NS** |
| Name | `connect` (FQDN becomes `connect.abluva.com`) |
| Nameserver | e.g. `ns1.p68.dns.oraclecloud.net` (exact string from OCI) |
| TTL | Auto |

Repeat until every OCI nameserver has a matching Cloudflare NS row.
If OCI listed four hostnames, you add **four** NS records.

**3. ☐ Check delegation**

```bash
dig NS connect.abluva.com +short
# must list the same oraclecloud nameservers you copied — not Cloudflare’s
```

**4. Continue Day 0 Step 5c** (IAM + `fabric-dns-webhook` + CP):

- inbound suffix = `connect.abluva.com`
- `FABRIC_DNS_TARGET=fabric.abluva.com` (same host as §A, **no** `:8443`)

**5.** After a test `CUSTOMER_*` registration:

```bash
dig +short <inbound_hostname> A
# e.g. <reg-id>.<tenant-id>.connect.abluva.com → same NLB VIP
```

**You do not** add one Cloudflare A record per registration.

###### C. Alternative: Cloudflare wildcard (simpler, no OCI DNS zone needed)

If you **skip OCI DNS entirely** and don't need the dns-webhook receiver
(which manages per-registration records in OCI DNS), you can put a single
**wildcard CNAME** directly in Cloudflare instead:

Cloudflare → **DNS** → **Records** → **Add record**

| Field | Value |
|---|---|
| Type | **CNAME** |
| Name | `*.connect` (FQDN becomes `*.connect.abluva.com`) |
| Target | `fabric.abluva.com` |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

**That's it.** One record covers every current and future registration
hostname (`privacy.aaa-111.connect.abluva.com`, `sec-interface.bbb-222.connect.abluva.com`, ...).
The Gateway routes by SNI, not by individual DNS records.

**When to choose this over path B:**
- You don't need per-registration DNS record audit/visibility in OCI
- You want zero ongoing DNS automation (no webhook, no OCI zone, no IAM policy)
- Simpler to set up (one Cloudflare click vs OCI zone + NS delegation + webhook deploy)

**When to choose path B (OCI zone delegation) instead:**
- You want explicit per-registration records (audit: "which records exist?")
- You need conditional DNS (e.g., some registrations point to a different target)
- Compliance requires records in OCI DNS specifically

**If you use path C, skip:**
- §B (OCI zone creation + NS delegation)
- Step 5c (dns-webhook deployment + IAM)
- `FABRIC_DNS_RECONCILE_ENABLED` (leave unset or disabled)

**Still required with path C:**
- §A (Gateway A record: `fabric.abluva.com` → NLB VIP)
- Control plane `FABRIC_GATEWAY_INBOUND_DOMAIN=connect.abluva.com`
- Gateway `FABRIC_GATEWAY_INBOUND_DOMAIN=connect.abluva.com`

**Platform config** (same for both path B and C):

```yaml
# Control plane deployment.yaml:
FABRIC_GATEWAY_INBOUND_DOMAIN: connect.abluva.com
FABRIC_DNS_TARGET: fabric.abluva.com    # only used if reconciler enabled (path B)

# Gateway deployment.yaml:
FABRIC_GATEWAY_INBOUND_DOMAIN: connect.abluva.com
FABRIC_GATEWAY_INBOUND_LISTEN: "0.0.0.0:8444"

# Agent install snippet (tenant-start.env / k3s --gateway=...):
FABRIC_GATEWAY_ADDRESS: fabric.abluva.com:8443
FABRIC_TLS_SERVER_NAME: fabric.abluva.com

# SaaS service deployments (discovery, catalogue, etc.):
FABRIC_CONNECT_DOMAIN: connect.abluva.com
FABRIC_GATEWAY_INBOUND_PORT: "8444"
```

**☐ Verify (after wildcard is live):**
```bash
# Any subdomain of connect.abluva.com should resolve to the NLB VIP:
dig +short anything.anything.connect.abluva.com
# Expected: same IP as fabric.abluva.com

# SaaS service can reach Gateway inbound:
openssl s_client -connect fabric.abluva.com:8444 \
  -servername privacy.aaa-111.connect.abluva.com </dev/null
# Expected: TLS handshake (not connection refused)
```

##### NSG / security lists (summary)

Full procedure: [NSG: NLB → OKE workers on NodePort](#nsg-nlb--oke-workers-on-nodeport-required-before-agents-can-dial).

| Direction | Allow |
|---|---|
| Customer / internet → NLB | TCP **8443** |
| NLB subnet → OKE workers | TCP **NodePort** (or **8443** if hostPort) |
| In-cluster only | CP → `fabric-gateway:9090` — never on the public NLB |

##### IAM: dynamic group + policy for dns-webhook (Step 5c)

dns-webhook runs **on OKE workers** and calls OCI DNS as **instance
principal**. Without the dynamic group + policy, logs show SDK/auth
errors and A3/B4 records never appear.

**1. Dynamic group** — Console: **Identity & Security → Domains →**
(your domain) → **Dynamic groups → Create dynamic group**

| Field | Value |
|---|---|
| Name | `fabric-platform-workers` |
| Description | OKE workers allowed to patch Fabric DNS records |

**Matching rule (pick one):**

```text
# Preferred when all Platform OKE nodes live in one compartment:
ALL {instance.compartment.id = 'ocid1.compartment.oc1..aaaa...'}

# Or pin a specific node pool (replace OCID):
ALL {instance.compartment.id = 'ocid1.compartment.oc1..aaaa...', tag.oke.node_pool = 'fabric-platform'}
```

To confirm instances match: Console → Dynamic group → **Matched instances**
should list OKE worker compute instances after a minute.

**CLI:**

```bash
oci iam dynamic-group create \
  --name fabric-platform-workers \
  --description "OKE workers for Fabric dns-webhook" \
  --matching-rule "ALL {instance.compartment.id = '${COMPARTMENT_OCID}'}"
```

**2. Policy** — Identity → Policies → Create in the **same compartment**
as the DNS zone (or tenancy root if that is how you manage DNS):

```text
Allow dynamic-group fabric-platform-workers to manage dns-records in compartment <compartment-name>
Allow dynamic-group fabric-platform-workers to use dns-zones in compartment <compartment-name>
```

(`<compartment-name>` = name string OCI expects in policy language, not
always the OCID.)

**3. Wire the pod** — `deploy/platform/oci/dns-webhook/deployment.yaml`:

| Env | Value |
|---|---|
| `OCI_AUTH_MODE` | `instance_principal` |
| `OCI_DNS_ZONE_ID` | zone OCID |
| `OCI_DNS_COMPARTMENT_ID` | compartment OCID |
| `WEBHOOK_TOKEN` | from Secret `fabric-dns-webhook-token` |

**4. ☐ Validate IAM**

```bash
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c logs deploy/fabric-dns-webhook --tail=50
# Expect: OCI DNS client initialized (auth=instance_principal)
# Not: Failed to init OCI SDK / NotAuthenticated / NotAuthorizedOrNotFound
```

Then create a test `CUSTOMER_*` registration and confirm a record appears
in the OCI DNS Zone within one reconcile tick (~30–60s).

**Separate from Step 5b.** 5b = how Agents find the Gateway. 5c = how
Platform resolves `<registration_id>.<tenant_id>.<zone>` for inbound
(A3/B4). Artifact: `deploy/platform/oci/dns-webhook/`.

##### Create OCI DNS Zone (if missing)

**Console:** Networking → DNS Management → Zones → Create Zone

| Field | Example |
|---|---|
| Zone type | Primary |
| Zone name | `connect.yourcompany.com` (must match CP inbound domain suffix) |
| Compartment | Platform compartment |

Copy zone **OCID** (`ocid1.dns-zone…`) → `OCI_DNS_ZONE_ID`. If public,
delegate NS records at the parent registrar (Console shows them).

```bash
oci dns zone create --compartment-id "$COMPARTMENT_OCID" \
  --name connect.yourcompany.com --zone-type PRIMARY
oci dns zone list --compartment-id "$COMPARTMENT_OCID" --output table
```

##### IAM so OKE can patch records

Full Console/CLI procedure (matching rule, policy statements, log checks):
[IAM: dynamic group + policy for dns-webhook](#iam-dynamic-group--policy-for-dns-webhook-step-5c).

Summary: dynamic group covering OKE workers +

```
Allow dynamic-group fabric-platform-workers to manage dns-records in compartment <compartment-name>
Allow dynamic-group fabric-platform-workers to use dns-zones in compartment <compartment-name>
```

##### Deploy webhook + wire control plane

Prefer token from `deploy/platform/setup-day0.sh` (`fabric-dns-webhook-token`).

```bash
# Edit deploy/platform/oci/dns-webhook/deployment.yaml:
#   OCI_DNS_ZONE_ID, OCI_DNS_COMPARTMENT_ID, image registry tag
kubectl apply -f deploy/platform/oci/dns-webhook/deployment.yaml
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c rollout status deploy/fabric-dns-webhook
```

On the control plane (`deploy/control-plane/deployment.yaml` or overlay):

| Env | Example |
|---|---|
| `FABRIC_DNS_RECONCILE_ENABLED` | `1` |
| `FABRIC_DNS_PROVIDER` | `webhook` |
| `FABRIC_DNS_WEBHOOK_URL` | `http://fabric-dns-webhook.3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c.svc:8090` |
| `FABRIC_DNS_WEBHOOK_TOKEN` | Same as Secret `fabric-dns-webhook-token` |
| `FABRIC_DNS_TARGET` | **Same hostname or VIP as Step 5b**, **without** `:8443` |

If `FABRIC_DNS_PROVIDER` stays `file`, inbound DNS never hits OCI — A3/B4
fails silently (tunnel can still be up).

##### Day‑0 OCI done checklist

| ☐ | Check |
|---|---|
| ☐ | Secrets from `setup-day0.sh` in `fabric-control` (Gateway) + SaaS ns (CP) |
| ☐ | Gateway Ready; Service is NodePort (or hostPort) |
| ☐ | NLB `terraform apply` OK; VIP known |
| ☐ | Agent hostname A record → VIP resolves (`dig`) |
| ☐ | `openssl s_client` to `FABRIC_GATEWAY_ADDRESS` works from outside the cluster |
| ☐ | OCI DNS Zone + dynamic group + policy exist |
| ☐ | `fabric-dns-webhook` Ready; CP has webhook provider + `FABRIC_DNS_TARGET` |
| ☐ | Test `CUSTOMER_*` registration creates a record in the Zone |
| ☐ | Revoke push still in-cluster `:9090` |

**Glossary:** **VIP** = NLB public IP (typical). **Agent dial** =
`FABRIC_GATEWAY_ADDRESS` = hostname:8443. **`FABRIC_DNS_TARGET`** = where
inbound DNS records point (same host/VIP, no port). **BFF** = tenant-app
backend (not this repo) that attaches dual-control for revoke/suspend —
see `Tenant-App-UI-Checklist.md`.

The Gateway's own shutdown/drain behavior (Level 1 §12 graceful shutdown;
L2 §G.3 in-flight drain):

| Env var | Default | What it controls |
|---|---|---|
| `FABRIC_SHUTDOWN_GRACE` | `25s` | On `SIGTERM`/`SIGINT`, the Gateway immediately stops accepting new tunnels and new streams, then waits up to this long for in-flight relays to finish before exiting. Keep this **below** your orchestrator's `terminationGracePeriodSeconds` (Kubernetes defaults to 30s) — otherwise the pod gets `SIGKILL`ed before the wait even completes. Agents connected to this instance simply reconnect elsewhere on their normal backoff schedule once it exits; that's expected behavior, not an incident. |
| `FABRIC_REGISTRATION_DRAIN_GRACE` | `3m` | How long a Registration's streams are allowed to keep running after that Registration leaves `Active` (moves to `Deleting`/`Deleted`/`Failed`), or after a tenant is suspended for a **billing** cause, before the Gateway force-closes them. A **security**-cause suspend or certificate revoke is never subject to this grace period — those force-close immediately, with no drain, via a separate reconciliation path. Registrations in `Updating` are never touched by this timer at all — their existing streams simply keep running against whatever configuration was in force when they opened. |

Also complete **cert-expiry paging** once per Platform environment (not per
tenant): create Secret `fabric-cert-expiry-webhook` as in
[Wire the webhook](#wire-the-webhook-platform-day-0--once-per-env). Until
then the scan still runs but only logs.

### Step 6 — Deploy the control plane

**Production (OKE / Platform Kubernetes)** — apply the shipped Deployment,
not a laptop `npm run dev`:

```bash
# Secrets/config from Steps 0–1 in fabric-control (Gateway) + SaaS ns (CP)
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c apply -f deploy/control-plane/deployment.yaml
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c rollout status deploy/fabric-control-plane
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c get pods -l app=fabric-control-plane

# In-cluster health (from a debug pod or port-forward):
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c port-forward svc/fabric-control-plane 8080:8080 &
curl -sf http://127.0.0.1:8080/healthz   # expect {"ok":true}
```

**Customer-reachable CP URL:** Agents on customer hosts call
`FABRIC_CONTROL_PLANE_URL` over the internet (enroll, watch, token, rotate).

**Is a public load-balancer IP enough?** Only if **all** of these are true:

| Check | Why |
|---|---|
| LB forwards to the **control-plane** Service (`fabric-control-plane:8080`), not Ghostunnel `:8443` | Agents speak **HTTPS/HTTP JSON** to CP; mTLS tunnel is a **different** front (NLB :8443) |
| You can `curl -sf http(s)://<that-host>/healthz` from the **customer Linux VM** and get `{"ok":true}` | Public IP alone with no listener/backend = useless |
| Prefer **HTTPS** (TLS on LB/Ingress) for production | Bearer tokens and PoP travel on this path |
| DNS name in the install snippet matches that front | `FABRIC_CONTROL_PLANE_URL=https://cp.example.com` (no path suffix except as you deploy) |

Gateway / revoke push still use the **in-cluster** Service
(`http://fabric-control-plane.3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c.svc:8080`). Do **not** point
`FABRIC_GATEWAY_PUSH_*` or Agent tunnel dials at the CP LB.

Expose CP with your Platform standard (OCI **Flexible/Application** LB or
Ingress controller + TLS). That is separate from the **Network** LB in
Step 5b (Agents → Ghostunnel).

With `FABRIC_STORE=postgres`, enroll/approve/registration persist through
SequelizeStore; bootstrap tokens are stored only as SHA-256 hashes.

**Laptop-only** (not OCI production):

```bash
cd control-plane && npm run dev
# or: cd deploy/local && ./smoke.sh
```

Never enable `FABRIC_ENSURE_SAAS_TENANT` against a real SaaS database.

#### Control-plane DNS reconciliation — production default (do not re-decide)

DNS reconciliation must have **exactly one active writer**. That is not an
operator preference; both providers race if two processes reconcile at once
(`L3-DNS-02`). What *is* decided for you in production:

| Setting | Production default | Why |
|---|---|---|
| How many API replicas | `replicas: 2+` | Availability |
| Who runs the reconcile loop | Lease holder among those replicas | Automatic failover; no human pin |
| Manifest | `deploy/control-plane/deployment.yaml` | Single Deployment + Lease RBAC |
| `FABRIC_DNS_RECONCILE_ENABLED` | `1` on every replica | Safe because election gates ticks |
| `FABRIC_DNS_LEADER_ELECTION` | `1` (also the binary default when reconcile is on **and** the process is in-cluster) | Production-fit; local compose stays off automatically |

Apply **only** `deployment.yaml` on Platform Kubernetes (OKE). Grep logs for
`dns_reconciler_acquired_lease` — one `identity` (pod name) at a time is
healthy. If election cannot start (no in-cluster SA), the reconciler
**refuses to run** rather than writing uncoordinated.

**Escape hatch only** (cannot grant `coordination.k8s.io` Lease RBAC):
`deploy/control-plane/deployment-split-reconciler.yaml` — two Deployments,
reconciler pinned to `replicas: 1`, with `FABRIC_DNS_LEADER_ELECTION=0`
explicit. DNS pauses while that one pod restarts. Do not mix with
`deployment.yaml`. Do not scale the reconciler Deployment past 1.

**Local / compose** (not in-cluster): leave election unset. With reconcile
enabled, the binary keeps election off (no API server to elect against).
Set `FABRIC_DNS_LEADER_ELECTION=0` only if you need to be explicit.

### Step 7 — Platform mesh: Istio Ambient

This is entirely Platform-side. ztunnel is required for Spec pathways A1,
A2 (after the Gateway), A3 (before the Gateway), and B1/B4; waypoint is
optional L7, for Service-carrying namespaces only, never for Resource
traffic. Everything for this step lives under `deploy/platform/ambient/`.

**7a — install ztunnel, the Istio CNI plugin, and istiod:**

```bash
# Optional pinning:
#   export ISTIO_VERSION=1.24.2
#   export KUBE_CONTEXT=<platform-context>
./deploy/platform/ambient/install-ambient.sh
```

This applies the privileged Pod Security Admission level only to the
`ambient-plane` namespace — every other namespace stays at the restricted
level, per the architecture's explicit scoping of where the one privileged
workload in this whole system is allowed to run.

**7b — enroll the Platform namespaces that need Fabric Ambient:**

```bash
./deploy/platform/ambient/enroll-namespaces.sh fabric-control 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c
```

`fabric-control` itself must be enrolled — without it, neither the Gateway's
own dial into Fabric (A2) nor a Platform service's dial toward the
Gateway (A3/B4) actually passes through ztunnel.

**7c — apply waypoints, only where HTTP/gRPC-level policy is actually wanted:**

```bash
# Namespaces with business-application HTTP/gRPC traffic that wants
# retries and circuit breaking:
./deploy/platform/ambient/waypoint-apply.sh 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c

# Never apply a waypoint to a namespace that's purely database/Resource traffic.
```

**7d — verify:**

```bash
./deploy/platform/ambient/verify-ambient.sh
# Expect: the ztunnel DaemonSet is Ready, and your labeled namespaces are listed
kubectl -n ambient-plane get ds ztunnel
kubectl get ns -l istio.io/dataplane-mode=ambient
```

**What breaks if you skip this step entirely:**

| Pathway | What's missing without Ambient |
|---|---|
| A1 | Platform Service ↔ Platform Service has no mTLS or L7 Ambient path at all |
| A2 | After Gateway authorization, the hop into the Platform Service loses ztunnel's mTLS and any optional waypoint retry behavior |
| A3 / B4 | The Platform-to-Gateway hop loses ztunnel entirely |
| B1 | Platform-to-Platform-Resource loses ztunnel |
| A4 / B2 / B3 | Unaffected — none of these ever touch Ambient in the first place |

The local docker-compose + k3d *tenant* smoke (`smoke-k3d-tenant.sh`)
intentionally does not install Ambient (its Platform side is plain compose).
To exercise Ambient (A1/B1 L4) locally on a Platform Kubernetes cluster:

```bash
export KUBE_CONTEXT=k3d-fabric-platform   # or your platform context
./deploy/local/k3d/ambient/smoke-ambient.sh
```

On k3s/k3d, `install-ambient.sh` auto-sets `cniConfDir` and `cniBinDir` so
istio-cni becomes Ready (without both, Ambient install fails on those
clusters). Prefer that script over hand-running `istioctl`.

**Laptop note:** Ambient needs its own Platform cluster. Running Ambient
install while a tenant k3d cluster *and* docker compose are already under
heavy load can starve scheduling — that is a local resource constraint, not
an Ambient architecture failure. Free RAM (or stop compose / the unused
cluster) if install pods stay Pending.

---

## Agent credentials — what they are, who touches them (G-CRED-1)

Four credentials show up in Day‑1 / Day‑N. Only **one** of them is meant to
stay a human/out-of-band step forever. The rest must not become “call the
customer to update a Secret on every node.”

Architecture lock: **G-CRED-1** in `Architecture-Resolutions.md` — after the
Agent has a leaf, **the Agent pulls** current material from the control
plane over outbound HTTPS. Same on Kubernetes, ECS, and VM.

### Inventory (read this before Day 1)

| Credential | What it does | Lifecycle | Human / UI involved? | Ops / Platform involved? |
|---|---|---|---|---|
| **Bootstrap token** | Proves “this install is allowed to enroll Agents for tenant X” on `POST /v1/agents/enroll` before any leaf exists. Multi-redeem until `bootstrap_expires_at`. | Issue (UI/ops) → put once in install Secret/env → Agents redeem during the window → expiry or `…/bootstrap-token/revoke` kills it. Hash only in Postgres. | **Yes — Day‑1 only.** Tenant admin (UI) issues + copies into the install snippet. Revoke if leaked; re-issue for scale-out after expiry or cert-loss when the window is closed. | Platform may assist Day‑1; do not use bootstrap for Day‑N hygiene. |
| **CA trust bundle** (`ca.crt`) | On the **Agent**: verifies the Gateway/Ghostunnel **server** certificate. (Separately, CP mounts Agent CA material to **sign** leafs — that is not this customer Secret.) | Rare. Created/rotated with Platform CA ops. Mounted read-only on every Agent (`FABRIC_AGENT_CA_FILE` / Secret `connect-agent-tls`, **CA-only**). | **Almost never.** Tenant does not mint this. UI may show “download CA for install” as Platform-issued material. | **Platform.** Root/intermediate rotation is a planned change; roll the shared trust Secret/file when that happens. |
| **Agent leaf** (`tls.crt` + `tls.key`) | Per-instance identity for the Ghostunnel mTLS tunnel (Gateway keys tunnels by fingerprint). Not used as the CP REST bearer. | Agent generates key+CSR → CP signs at enroll → written to identity store → **auto-rotated at 50% life by `certlife.StartLoop` (D3-AUTO)**; emergency: `POST /v1/agents/:id/rotate` / `FABRIC_AGENT_ROTATE=1` → new leaf, same `agent_id`, overlap window for prior FP. Wipe of identity store = re-bootstrap if window open, else fail closed. | **Approve** the Agent in UI (G-BOOT-1). Revoke a fingerprint on compromise (`revoke-cert`). Do **not** download private keys into the UI. | Platform runs Agent CA (`FABRIC_AGENT_CA_*`). Expiry scan job logs `agent_cert_expiry_warning` (`L3-PKI-01`; optional `FABRIC_CERT_EXPIRY_WEBHOOK_URL`). |
| **Agent API bearer** | Gates Agent→CP **REST** (list registrations, observed, cert rotate) when CP auth is on. Not Ghostunnel. Scoped — cannot suspend/revoke. | Agent derives its bearer from the leaf cert after enrollment (no Day‑1 seed needed). **Steady state (G-CRED-1):** Agent calls `POST /v1/agents/:id/api-token/current` with leaf PoP (+ optional `current_agent_api_token` for **reuse** until near expiry), writes `agent-api.token`, refresh every `FABRIC_AGENT_TOKEN_REFRESH` (**1h**). CP mass-rotate job (`FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL`) stays **off for v1 (D4-A)**. | Day‑N: **do not** ask customers to roll Secrets for token hygiene. Compromise: writer revoke, then Agents pull on next refresh. | Platform configures writer bearer separately. Do not enable the CP rotate job unless you have an explicit compliance reason. |

### Flow (happy path + expiry + refresh)

Canonical end-to-end credential chain. Failure detail for leaf/bearer also
in `Connectivity-Technical-Guide.md` §6.3–6.5.

```text
┌─ Day 1 (human / UI once) ─────────────────────────────────────────┐
│ 1. POST /v1/tenants/ensure {tenant_id}   ← Fabric profile, NOT enroll│
│ 2. POST /v1/tenants/:id/bootstrap-token  ← raw shown once          │
│       valid: multi-redeem until bootstrap_expires_at               │
│       dead:  expiry OR …/bootstrap-token/revoke                    │
│       if expired/revoked → re-issue; Agents cannot enroll          │
│ 3. Install snippet: FABRIC_BOOTSTRAP_TOKEN + ca.crt + Gateway addr   │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Agent first boot ─────────────────────────────────────────────────┐
│ 4. POST /v1/agents/enroll (bootstrap + CSR)                        │
│       → leaf (tls.crt/key) + agent_id in identity store            │
│       fail: bootstrap_token_expired/invalid → CrashLoop until fix  │
│ 5. POST /v1/agents/:id/api-token/current (leaf PoP)                │
│       → agent-api.token (soft-fail at startup; refresh loop retries)│
│ 6. Dial Gateway mTLS (leaf) → tunnel up; state often PendingApproval│
│ 7. UI: POST /v1/agents/:id/approve → Connecting → Connected        │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ Day N (automatic — no customer Secret rolls) ─────────────────────┐
│ LEAF:  certlife every FABRIC_CERT_CHECK_INTERVAL (1h)                │
│        rotate at 50% TTL → SaveCert → forceReconnect               │
│        overlap prior FP: 300s; failure → 30s retry / persist-only  │
│ BEARER: cptoken every FABRIC_AGENT_TOKEN_REFRESH (1h)                │
│        usually REUSE until near expiry; mint+overlap (1h) if needed│
│        writer revoke → watch 401 until next pull (intentional)     │
│ BOOTSTRAP: unused after enroll; do not use for Day‑N hygiene       │
│ EMERGENCY leaf: FABRIC_AGENT_ROTATE=1 or writer POST …/rotate        │
└────────────────────────────────────────────────────────────────────┘
```

**If bootstrap expired and identity was wiped** (re-enroll needed): issue a
new bootstrap token, put it in the install Secret, restart Agent pods.
**If leaf/bearer only need refresh:** do nothing — Agent loops handle it.

| Credential | Created | Presented to | Auth mechanism | Rotated by | Overlap window | Revocation |
|---|---|---|---|---|---|---|
| **Bootstrap token** | UI/ops issues (`/bootstrap-token`) | CP (`POST /enroll` body) | Hash comparison (CP stores hash only) | Re-issue for new window | N/A (multi-redeem until expiry) | Expiry or explicit `/bootstrap-token/revoke` |
| **Agent leaf** (`tls.crt`+`tls.key`) | Agent generates key, CP signs CSR at enroll | Gateway (mTLS on tunnel) | TLS handshake + fingerprint binding | `certlife.StartLoop` auto-rotates at 50% life (D3-AUTO); `FABRIC_AGENT_ROTATE=1` for emergency | `DEFAULT_CERT_OVERLAP_SECONDS` (300s) — prior FP stays accepted | `POST /v1/tenants/:id/revoke-cert` → force-close if cause=security |
| **Agent API bearer** | Agent pulls via leaf PoP (`/api-token/current`) | CP REST (`Authorization: Bearer`) | Bearer hash comparison; PoP for issuance | `cptoken.StartRefreshLoop` (1h); CP reuses fresh bearer (D1) | `DEFAULT_TOKEN_OVERLAP_SECONDS` (3600s) — prior hash stays accepted | Writer revokes (`/agent-api-token/revoke`); Agents pull fresh on next refresh |
| **Writer bearer** (`FABRIC_CONTROL_PLANE_TOKEN`) | Platform ops at Day-0 | CP REST (all endpoints) | Constant comparison | Manual ops rotation (shared secret) | N/A (single value) | Rotate at source; restart CP with new value |
| **Dual-control** (`FABRIC_DUAL_CONTROL_TOKEN`) | Platform ops at Day-0 | CP REST (`X-ABLV-Break-Glass` for high-risk mutations) | Constant comparison | Same as writer | N/A | Same as writer |

### What Ops does vs what the customer does

| Action | Who |
|---|---|
| Day‑0 Platform: CP/Gateway/Ghostunnel, Agent CA, writer `FABRIC_CONTROL_PLANE_TOKEN`, dual-control, NLB | **Platform ops** |
| Day‑1 issue bootstrap + hand install snippet | **Tenant admin (UI)** (+ Platform assist) |
| Apply DaemonSet / ECS / systemd on customer substrate | **Customer / Platform assist** (scripts, not ongoing token push) |
| Approve / retire Agents, registrations, revoke-cert, revoke bootstrap | **Tenant admin (UI)** |
| Ongoing bearer or leaf refresh after Day‑1 | **Agent + CP automatically** — not a customer ticket |

### Step 3 — Install (credential mapping)

See Step 3 below for kubectl detail. Mapping for the Secret:

| Secret / file key | Agent env / path | Role |
|---|---|---|
| `bootstrap_token` | `FABRIC_BOOTSTRAP_TOKEN` | Day‑1 enroll window only |
| `ca.crt` | `FABRIC_AGENT_CA_FILE` | Trust bundle |
| (none — local) | `FABRIC_AGENT_CERT_DIR/tls.crt\|tls.key` | Leaf after enroll |
| (none — local) | `…/agent-api.token` | Steady-state bearer |

---

## Onboarding a customer Agent (Day 1)

Walk these steps in order. After each action: confirm the **API**, then the
**table** (when `FABRIC_STORE=postgres`). API is enough for routine ops; SQL
catches store drift. **Never** hand-`UPDATE` Agent `state` to force
`Connected` (see Day 0 [SQL migration](#step-4--apply-the-fabric-sql-migration)).

**Split of labor:** Steps 1–2, 4–5 (ensure, bootstrap, approve, registration)
are **tenant-app UI** once the product ships — curl below is the ops fallback
and what smoke uses today. Step 3 (install) stays **script/manifest** on the
customer cluster; the UI only hands over the token + CA + paste-ready snippet
(`Tenant-App-UI-Checklist.md` §1).

When the control plane has `FABRIC_CONTROL_PLANE_TOKEN` set, every `/v1/*` call
needs `Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN`. High-risk mutations
(suspend, revoke-cert, registration delete) also need
`X-ABLV-Break-Glass: $FABRIC_DUAL_CONTROL_TOKEN`.

```bash
CP=$FABRIC_CONTROL_PLANE_URL
TENANT=<tenant-uuid>
# psql (optional): \set tenant_id '<same-uuid>'
```

### Step 1 — Confirm the SaaS tenant already exists

The tenant row in `ablv_tenants` is owned by the main SaaS application, not
this Fabric system — confirm it exists before proceeding.

**Confirm (table):**

```sql
SELECT tenant_id FROM ablv_tenants WHERE tenant_id = :'tenant_id';
-- Expect: 1 row. If 0, stop — Fabric ensure will fail FK.
```

### Step 2 — Create the Fabric tenant profile and bootstrap token

**2a — Ensure Fabric profile**

```bash
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: ops" \
  -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  -d "{\"tenant_id\":\"$TENANT\"}" "$CP/v1/tenants/ensure" | jq .

curl -sS -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  "$CP/v1/tenants/$TENANT" | jq '{tenant_id,suspended,bootstrap_token_outstanding,max_tunnels}'
```

**Confirm (API):** `200`; `suspended: false`; quotas present (defaults OK).

**Confirm (table):**

```sql
SELECT tenant_id, suspended, auto_approve_agents,
       max_tunnels, max_concurrent_streams, max_stream_open_per_sec,
       bootstrap_token_hash IS NOT NULL AS bootstrap_hash_set,
       agent_api_token_hash IS NOT NULL AS api_token_hash_set
  FROM ablv_tenant_connect
 WHERE tenant_id = :'tenant_id';
-- Expect: 1 row; suspended=false; auto_approve_agents=false in prod;
--         quotas > 0; bootstrap_hash_set=false; api_token_hash_set=false.
```

**2b — Optional quotas** (raise before DaemonSet scale-out; default `max_tunnels=50`)

```bash
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: ops" \
  -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  -d '{"max_tunnels":50,"max_concurrent_streams":2000,"max_stream_open_per_sec":100}' \
  "$CP/v1/tenants/$TENANT/quotas" | jq .
```

**Confirm (API + table):** response limits match; re-run the Step 2a SQL — same
row, updated quota columns.

**2c — Issue bootstrap token** (raw value shown **once**)

```bash
curl -sS -H "X-ABLV-Actor: ops" \
  -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  -X POST "$CP/v1/tenants/$TENANT/bootstrap-token" | jq .

curl -sS -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  "$CP/v1/tenants/$TENANT" | jq '{bootstrap_token_outstanding}'
```

Keep the returned `bootstrap_token` for the install window. Bootstrap is
**multi-redeem until `bootstrap_expires_at`**. Revoke early if leaked.
Production stores a **hash only** — never the raw token.

**Confirm (API):** `bootstrap_token` + `bootstrap_expires_at` in create
response; `bootstrap_token_outstanding: true` on GET.

**Confirm (table):**

```sql
SELECT bootstrap_token_hash IS NOT NULL AS hash_set,
       bootstrap_expires_at,
       bootstrap_expires_at > NOW() AS still_valid
  FROM ablv_tenant_connect
 WHERE tenant_id = :'tenant_id';
-- Expect: hash_set=true; still_valid=true. No raw-token column exists.
```

<details>
<summary>Inbound DNS (G-A3-1) — no action in this step; read if you need Platform→Customer later</summary>

The CP DNS reconciler (`FABRIC_DNS_RECONCILE_ENABLED=1`) keeps
`<registration_id>.<tenant_id>.<domain>` in sync for Active `CUSTOMER_*`
regs. Operators do not create those records by hand. On OCI, finish Day 0
[Step 5c](#step-5c--oci-dns-for-platformcustomer-inbound-g-a3-1) first
(`FABRIC_DNS_PROVIDER=webhook`, `FABRIC_DNS_TARGET` = Gateway host **without**
`:8443`). Without that wiring, inbound breaks silently even when the tunnel
is up. Multi-replica CP uses Lease election — see Step 6.
</details>

### Step 3 — Install the Connect Agent (enroll → PoP → tunnel)

Pick **one** substrate. Do not mix.

| Customer substrate | Install artifact | Doc |
|---|---|---|
| **Kubernetes** (any distro) | `deploy/connect-agent/tenant-start.sh` + `tenant-start.env` | below |
| **VM / bare metal (Linux)** | **`deploy/connect-agent/k3s-appliance/install.sh`** (recommended) | [E2E OCI + k3s](#end-to-end-oci-oke--linux-vm-k3s-appliance) + `k3s-appliance/README.md` |
| VM fallback | `deploy/connect-agent/systemd/` | weaker probes/limits — prefer k3s appliance |
| ECS / Docker | **Not GA** | UI must not offer yet (`Tenant-App-UI-Checklist.md` §1) |

**Mac customers:** the k3s appliance needs **Linux + systemd**. Run it inside
a Linux VM on the Mac, or use a real Linux box.

#### 3a — Kubernetes (`tenant-start.sh`)

```bash
cd deploy/connect-agent
cp tenant-start.env.example tenant-start.env
# Fill: TENANT_*, FABRIC_GATEWAY_ADDRESS, FABRIC_CONTROL_PLANE_URL,
# CONNECT_AGENT_IMAGE, CA_CERT_FILE, BOOTSTRAP_TOKEN
./tenant-start.sh ./tenant-start.env
kubectl -n "$TENANT_NAMESPACE" get pods -l app=connect-agent
kubectl -n "$TENANT_NAMESPACE" logs -l app=connect-agent --tail=100
```

Manual path: `daemonset.yaml` + `networkpolicy-example.yaml` — CA-only Secret
(`ca.crt`), `FABRIC_BOOTSTRAP_TOKEN`, `NO_PROXY` includes Gateway hostname,
`FABRIC_IDENTITY_STORE=kubernetes` (recommended). Apps dial
`connect-agent.<ns>.svc.cluster.local:<port>` (ports from
`fabric.abluva.io/registration-ports`). Full mechanism:
`deploy/connect-agent/README.md`.

#### 3b — VM — k3s appliance

```bash
# From the VM: reach CP + Gateway first, then:
sudo ./install.sh --env-file=fabric-edge.env
k3s kubectl -n fabric-edge get pods -l app=connect-agent   # Running 1/1
k3s kubectl -n fabric-edge logs -l app=connect-agent --tail=100
```

Full copy-paste path: [E2E OCI + k3s](#end-to-end-oci-oke--linux-vm-k3s-appliance).

**Confirm (logs):** `enroll_submitted` (or enroll success); `agent_api_token_pulled`
or deferred retry; `tunnel_ready` / `agent_running`. **Not**
`identity_unavailable`, `bootstrap_token_expired`, endless TLS errors.

**Confirm (API):**

```bash
curl -sS -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  "$CP/v1/tenants/$TENANT/agents" \
  | jq '[.[] | {id,state,tunnel_state,cert_fingerprint_sha256,enrollment_approved_at}]'
# Copy agent id + fingerprint for Step 4.
```

**Confirm (table) — enroll:**

```sql
SELECT id, state, substrate, cert_fingerprint_sha256,
       enrollment_approved_at, tunnel_state, last_heartbeat_at, deleted_at
  FROM ablv_agents
 WHERE tenant_id = :'tenant_id' AND deleted_at IS NULL
 ORDER BY created_at DESC;
-- Expect ≥1 row: state='PendingApproval' (or 'Connecting' if auto_approve — lab only);
--   fingerprint NOT NULL; enrollment_approved_at IS NULL; deleted_at IS NULL.
```

**Confirm (table) — tunnel + PoP:**

```sql
SELECT id, state, tunnel_state, last_heartbeat_at,
       NOW() - last_heartbeat_at AS heartbeat_age
  FROM ablv_agents
 WHERE tenant_id = :'tenant_id' AND deleted_at IS NULL
 ORDER BY created_at DESC LIMIT 5;
-- Expect: tunnel_state IN ('up','up_pending_approval'); heartbeat_age under ~90s.

SELECT agent_api_token_hash IS NOT NULL AS api_token_hash_set,
       agent_api_token_expires_at
  FROM ablv_tenant_connect WHERE tenant_id = :'tenant_id';
-- Expect: api_token_hash_set=true after PoP (soft-fail OK — re-check in ~1 min).
```

Apps still cannot StreamOpen while `PendingApproval` — that is normal
(tunnel up ≠ approved).

### Step 4 — Approve the Agent

```bash
AGENT_ID=<id-from-step-3>
FP=<cert_fingerprint_sha256>

curl -sS -H "X-ABLV-Actor: tenant-admin@example.com" \
  -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  -X POST "$CP/v1/agents/$AGENT_ID/approve" \
  | jq '{id,state,tunnel_state,enrollment_approved_by}'

curl -sS -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  "$CP/v1/internal/authz-context?tenant_id=$TENANT&cert_fingerprint=$FP" \
  | jq '{agent_approved,agent_state,agent_id}'
```

If the tunnel was already up: `state=Connected` immediately. Otherwise
`Connecting` until dial succeeds. `agent_approved` must be `true` before
application traffic is accepted.

**Confirm (API):** approve → `Connected` or `Connecting`; authz-context →
`agent_approved: true`.

**Confirm (table):**

```sql
SELECT id, state, tunnel_state,
       enrollment_approved_at, enrollment_approved_by, cert_fingerprint_sha256
  FROM ablv_agents
 WHERE tenant_id = :'tenant_id' AND deleted_at IS NULL
 ORDER BY enrollment_approved_at DESC NULLS LAST, created_at DESC
 LIMIT 5;
-- Expect: enrollment_approved_at NOT NULL; approved_by set;
--   state IN ('Connected','Connecting','Degraded');
--   tunnel already up → usually Connected + tunnel_state='up'.
```

### Step 5 — Create the first registration (then dial)

```bash
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: tenant-admin" \
  -H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN" \
  -d '{
    "tenant_id":"'"$TENANT"'",
    "display_name":"smoke-resource",
    "connectivity_type":"RESOURCE",
    "destination_kind":"CUSTOMER_RESOURCE",
    "host":"127.0.0.1",
    "port":5432
  }' \
  "$CP/v1/registrations" | jq '{id,state,destination_kind,host,port}'
```

Wait ~5–10s for the Agent watch tick (listener + Service port map). Dial
`connect-agent.<ns>.svc.cluster.local:<port>` from a consumer pod (port from
`fabric.abluva.io/registration-ports`). More destination kinds and pathways:
[Day to day: registrations](#day-to-day-registrations-and-pathways).

**Confirm (API):** create → `state: Active` (or `Failed` → `POST …/retry` only).

**Confirm (logs):** Agent `listener_started` / `stream_open_accepted`; Gateway
`stream_accepted`.

**Confirm (table):**

```sql
SELECT id, display_name, state, destination_kind, host, port,
       generation, deleted_at, observed
  FROM ablv_registrations
 WHERE tenant_id = :'tenant_id' AND deleted_at IS NULL
 ORDER BY created_at DESC LIMIT 10;
-- Expect: state='Active'; deleted_at IS NULL; generation >= 1;
--   host/port match create; observed may fill after probes.
```

Optional inbound (A3): Active `CUSTOMER_*` + Day 0 Step 5c → OCI/Cloudflare
DNS resolves; CP/dns-webhook logs upsert. Reg row stays Active as above.

### Worked example: privacy + sec-interface ↔ discovery (all YAML + pathways)

**Do you need to change application code to “get the port”?**  
**No.** Apps keep reading a normal base URL from env/config (as they already
do for any dependency). An operator sets that URL **once in the Deployment
YAML / Helm values** after registrations exist. There is no runtime
Kubernetes API call from the app, and no Fabric SDK.

---

#### Step 0 — Assumptions

| Item | Value in this example |
|---|---|
| Tenant id | `ten_acme` |
| Inbound DNS domain | `connect.yourcompany.com` |
| Customer app namespace | `customer-apps` |
| Customer Agent namespace | `abluva-connect` (from tenant-start) |
| Platform app namespace | `platform-apps` |
| App listen ports | all `:8080` HTTP |

Agent install (DaemonSet + `svc/connect-agent`) is already done and
**approved**. Fabric Platform (Gateway + inbound DNS) is already up.

---

#### Step 1 — Customer cluster: deploy apps (normal K8s — no Fabric names)

```yaml
# customer-cluster.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: customer-apps
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: privacy
  namespace: customer-apps
spec:
  replicas: 1
  selector:
    matchLabels: { app: privacy }
  template:
    metadata:
      labels:
        app: privacy
        abluva.io/connect-consumer: "true"   # only if using NetworkPolicy
    spec:
      containers:
        - name: privacy
          image: registry.example.com/privacy:1.0
          ports:
            - containerPort: 8080
          env:
            # Filled in Step 4 after registration — leave empty / placeholder first
            - name: DISCOVERY_BASE_URL
              value: "http://CONNECT-AGENT-PORT-SET-IN-STEP-4"
            # Same-cluster call — never Fabric
            - name: SEC_INTERFACE_BASE_URL
              value: "http://sec-interface.customer-apps.svc.cluster.local:8080"
---
apiVersion: v1
kind: Service
metadata:
  name: privacy
  namespace: customer-apps
spec:
  selector: { app: privacy }
  ports:
    - port: 8080
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sec-interface
  namespace: customer-apps
spec:
  replicas: 1
  selector:
    matchLabels: { app: sec-interface }
  template:
    metadata:
      labels:
        app: sec-interface
        abluva.io/connect-consumer: "true"
    spec:
      containers:
        - name: sec-interface
          image: registry.example.com/sec-interface:1.0
          ports:
            - containerPort: 8080
          env:
            - name: DISCOVERY_BASE_URL
              value: "http://CONNECT-AGENT-PORT-SET-IN-STEP-4"
---
apiVersion: v1
kind: Service
metadata:
  name: sec-interface
  namespace: customer-apps
spec:
  selector: { app: sec-interface }
  ports:
    - port: 8080
      targetPort: 8080
```

Agent stays in **`abluva-connect`** (or `fabric-edge` on k3s appliance) —
do not put Agent in `customer-apps`.

---

#### Step 2 — Platform cluster: deploy discovery (normal K8s)

```yaml
# platform-cluster.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: platform-apps
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: discovery
  namespace: platform-apps
spec:
  replicas: 1
  selector:
    matchLabels: { app: discovery }
  template:
    metadata:
      labels: { app: discovery }
    spec:
      containers:
        - name: discovery
          image: registry.example.com/discovery:1.0
          ports:
            - containerPort: 8080
          env:
            # Filled in Step 3 from registration response — not customer ClusterIP
            - name: PRIVACY_BASE_URL
              value: "https://SET-IN-STEP-3/"
            - name: SEC_INTERFACE_BASE_URL
              value: "https://SET-IN-STEP-3/"
---
apiVersion: v1
kind: Service
metadata:
  name: discovery
  namespace: platform-apps
spec:
  selector: { app: discovery }
  ports:
    - port: 8080
      targetPort: 8080
```

---

#### Step 3 — Create three registrations (CP API)

```bash
TENANT=ten_acme
CP=https://cp.yourcompany.com   # your control plane

# (A) Platform discovery — used when customer apps call discovery
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: tenant-admin" \
  -d '{
    "tenant_id":"'"$TENANT"'",
    "display_name":"discovery",
    "connectivity_type":"SERVICE",
    "destination_kind":"PLATFORM_SERVICE",
    "host":"discovery.platform-apps.svc.cluster.local",
    "port":8080
  }' "$CP/v1/registrations"
# → note id, e.g. reg_discovery

# (B) Customer privacy — used when discovery calls privacy
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: tenant-admin" \
  -d '{
    "tenant_id":"'"$TENANT"'",
    "display_name":"privacy",
    "connectivity_type":"SERVICE",
    "destination_kind":"CUSTOMER_SERVICE",
    "host":"privacy.customer-apps.svc.cluster.local",
    "port":8080
  }' "$CP/v1/registrations"
# → note id + inbound_hostname, e.g.
#    id: reg_privacy
#    inbound_hostname: reg_privacy.ten_acme.connect.yourcompany.com

# (C) Customer sec-interface
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: tenant-admin" \
  -d '{
    "tenant_id":"'"$TENANT"'",
    "display_name":"sec-interface",
    "connectivity_type":"SERVICE",
    "destination_kind":"CUSTOMER_SERVICE",
    "host":"sec-interface.customer-apps.svc.cluster.local",
    "port":8080
  }' "$CP/v1/registrations"
# → inbound_hostname: reg_sec_interface.ten_acme.connect.yourcompany.com
```

Patch **discovery** env to those inbound hostnames:

```yaml
# on Platform — discovery Deployment
env:
  - name: PRIVACY_BASE_URL
    value: "https://reg_privacy.ten_acme.connect.yourcompany.com/"
  - name: SEC_INTERFACE_BASE_URL
    value: "https://reg_sec_interface.ten_acme.connect.yourcompany.com/"
```

(`host` on the registration is still `privacy.customer-apps…` — that is
what the **Agent** dials inside the customer cluster after the tunnel.
Discovery’s code never sees that string.)

---

#### Step 4 — Read Agent port map; set customer app env

Wait ~5–10s, then:

```bash
kubectl -n abluva-connect get svc connect-agent \
  -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
# example:
# {"reg_discovery":9443,"reg_privacy":9444,"reg_sec_interface":9445}
```

Use **only** the port for `reg_discovery` when customer apps call discovery:

```yaml
# on Customer — privacy + sec-interface Deployments
env:
  - name: DISCOVERY_BASE_URL
    value: "http://connect-agent.abluva-connect.svc.cluster.local:9443"
```

That is an **operator / Helm values** edit, not application logic.

---

#### Step 5 — Every pathway (exact dial)

| # | Pathway | Caller runs on | Exact URL in caller config | What happens |
|---|---|---|---|---|
| 1 | Customer → Platform | `privacy` | `http://connect-agent.abluva-connect.svc.cluster.local:9443` | Agent listener for `reg_discovery` → tunnel → Gateway → `discovery.platform-apps.svc:8080` |
| 2 | Customer → Platform | `sec-interface` | **same** URL as row 1 | Same registration / same port |
| 3 | Platform → Customer | `discovery` | `https://reg_privacy.ten_acme.connect.yourcompany.com/` | Gateway SNI → tunnel → Agent → `privacy.customer-apps.svc:8080` |
| 4 | Platform → Customer | `discovery` | `https://reg_sec_interface.ten_acme.connect.yourcompany.com/` | Same pattern → `sec-interface…:8080` |
| 5 | Same customer cluster | `privacy` | `http://sec-interface.customer-apps.svc.cluster.local:8080` | Plain K8s — **no Fabric** |
| 6 | Same platform cluster | other Platform pod → discovery | `http://discovery.platform-apps.svc.cluster.local:8080` | Plain K8s — **no Fabric** |

```text
PATH 1/2 (privacy or sec-interface → discovery)
  [customer-apps] HTTP → connect-agent.abluva-connect:9443
       → Agent → Gateway → [platform-apps] discovery:8080

PATH 3 (discovery → privacy)
  [platform-apps] HTTPS → reg_privacy.ten_acme.connect.yourcompany.com
       → Gateway → Agent → [customer-apps] privacy:8080

PATH 4 (discovery → sec-interface)
  [platform-apps] HTTPS → reg_sec_interface.ten_acme.connect.yourcompany.com
       → Gateway → Agent → [customer-apps] sec-interface:8080

PATH 5 (privacy → sec-interface)
  [customer-apps] HTTP → sec-interface.customer-apps:8080   (no Agent)
```

---

#### What you change in “code”

| Change | Required? |
|---|---|
| Fabric library / SDK in the app | **No** |
| App calls K8s API to read annotation | **No** |
| App still uses `os.Getenv("DISCOVERY_BASE_URL")` (or equivalent) | **Yes** (normal) |
| Deployment/Helm sets that env to Agent URL or inbound URL | **Yes** (once per env) |
| Rename K8s Services to inbound DNS names | **No** |

If today privacy hardcodes `http://discovery.platform-apps.svc:8080`, that
string cannot work from the customer cluster — replace it with the Agent
URL above **in config**. Same HTTP client; different host:port.

### Customer namespaces (does not complicate Platform OCI)

| Layer | Namespace | Role |
|---|---|---|
| **Platform OKE** | `fabric-control` + SaaS ns | Gateway in `fabric-control`; CP + dns-webhook + SaaS apps in `3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c` |
| **Customer K8s** | `fabric-edge` (or `TENANT_NAMESPACE`, e.g. `abluva-connect` from `tenant-start.env`) | Isolates that tenant’s Agent DaemonSet/Secrets/Service on **their** cluster |
| **k3s appliance** | Fixed `fabric-edge` | Same role on a single-host appliance |

`FABRIC_TENANT_ID` (UUID in CP) is **independent** of the K8s namespace
string. Creating a customer namespace per tenant is normal packaging and
does **not** require a matching namespace on OKE. Do not create per-tenant
namespaces on Platform for Fabric components unless you have a separate
product reason — the shipped path is `fabric-control` (network) + SaaS ns (CP + apps).

---

## End-to-end: OCI (OKE) + Linux VM (k3s appliance)

**Goal:** Platform on **OCI OKE** + one customer **Linux VM** running the
**k3s appliance** (Agent DaemonSet inside k3s — not the plain `systemd/`
Agent binary). Walk every row; do not skip ☐.

**Packaging note:** “Linux + systemd” in the appliance README means the
**host OS** must be Linux so **k3s** can install (k3s creates a systemd
unit). The Connect Agent itself still runs as a **Kubernetes DaemonSet**
with Secret identity — same model as full K8s customers. Prefer this over
`deploy/connect-agent/systemd/`.

**Prereq outside this repo:** An OKE cluster you can `kubectl` to, OCI
compartment/subnet rights, container images pushed to a registry OKE + the
VM can pull, and Access API + Postgres already reachable.

Related: Connectivity Parts 6–7; UI checklist §1; API catalog at end of this
Runbook (must match `control-plane/src/http/server.ts`).

### A — Platform Day 0 (OKE)

| # | Do | Artifact / API | ☐ Validate + logs |
|---|---|---|---|
| A0 | `kubectl` context = Platform OKE; create `fabric-control` | `kubectl config current-context`; `kubectl get ns` | Context is OKE, not a laptop cluster |
| A1 | Run `setup-day0.sh` with Access IDs + PKI files | [Step 0](#step-0--platform-secrets-one-script) | Gateway secrets in `fabric-control`; CP secrets in SaaS ns (`kubectl get secret fabric-control-plane-auth fabric-agent-ca fabric-dns-webhook` in SaaS ns; `fabric-gateway-tls` in `fabric-control`) |
| A2 | Intermediate CA sanity | [Step 2](#step-2--certificates) | `openssl x509 -in intermediate.pem -noout -subject -issuer` |
| A3 | Access API + Postgres shape check | [Step 3](#step-3--confirm-access-api-and-postgres-are-actually-reachable) | curl → `status=success` |
| A4 | Apply `control-plane/migrations/20260723120000-init-fabric.sql` | [Step 4](#step-4--apply-the-fabric-sql-migration) | SQL checks for `ablv_tenant_connect` / agents / registrations |
| A5 | Edit Gateway Deployment: image, `ABLV_ACCESS_URL`; apply | `deploy/gateway/deployment.yaml` · [Step 5](#step-5--deploy-the-gateway-and-ghostunnel) | `kubectl -n fabric-control get deploy fabric-gateway` 2/2 Ready; **logs:** `kubectl … logs -c gateway` → Unix socket listen; `-c ghostunnel` → no cert path errors |
| A5b | Patch Service NodePort → collect backends → NLB TF → DNS A→VIP | [Step 5b](#step-5b--oci-nlb-for-agent-dial-l3-ops-01--blind-ops) · `oci_network_load_balancer_*` (L4, `is_ppv2enabled=false`) | `terraform output fabric_gateway_address`; `dig +short <host>`; from outside OKE: `openssl s_client -connect <host>:8443 </dev/null 2>/dev/null \| openssl x509 -noout -subject` |
| A5c | (If A3/B4 inbound needed) Zone + IAM dynamic group + `dns-webhook` Deploy + CP `FABRIC_DNS_TARGET` | [Step 5c](#step-5c--oci-dns-for-platformcustomer-inbound-g-a3-1) · `deploy/platform/oci/dns-webhook/` uses **oci-dns** `patchZoneRecords` + instance principal | `kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c get deploy fabric-dns-webhook` Ready; logs: `OCI DNS client initialized (auth=instance_principal)`; CP log `dns_reconciler_acquired_lease` |
| A6 | Edit CP Deployment: image, `ABLV_ACCESS_URL`, `FABRIC_DNS_TARGET` (= 5b host **without** `:8443`); apply | `deploy/control-plane/deployment.yaml` · [Step 6](#step-6--deploy-the-control-plane) | 2/2 Ready; `port-forward svc/fabric-control-plane 8080:8080` → `curl -sf localhost:8080/healthz` → `{"ok":true}`; logs no missing Secret |
| A6p | Expose **public HTTPS** to CP Service (Ingress/LB — Platform standard) | Step 6 “Customer-reachable CP URL” | From Linux VM / laptop: `curl -sf https://$PUBLIC_CP/healthz` and `curl -sf https://$PUBLIC_CP/v1/ca-bundle \| head -1` starts with `-----BEGIN` |
| A7 | Ambient on Platform | [Step 7](#step-7--platform-mesh-istio-ambient) | `./verify-ambient.sh`; `kubectl -n ambient-plane get ds ztunnel` Ready |

Save: `FABRIC_GATEWAY_ADDRESS=<dns>:8443`, `FABRIC_CONTROL_PLANE_URL=https://…`,
`FABRIC_CONTROL_PLANE_TOKEN` (from setup-day0 stdout).

### B–D — Tenant Day 1 (follow the guided steps)

Do not re-learn checks here — walk
[Onboarding a customer Agent (Day 1)](#onboarding-a-customer-agent-day-1)
in order. Each Day‑1 step already weaves **do → API confirm → table confirm**.

| ☐ | E2E row | Day 1 step (API + SQL live there) |
|---|---|---|
| ☐ | B1 SaaS tenant exists | [Step 1](#step-1--confirm-the-saas-tenant-already-exists) |
| ☐ | B2 ensure · B3 quotas · B4 bootstrap · B5 snippet | [Step 2](#step-2--create-the-fabric-tenant-profile-and-bootstrap-token) |
| ☐ | C1–C5 install / enroll / tunnel on k3s appliance | [Step 3](#step-3--install-the-connect-agent-enroll--pop--tunnel) (path **3b**) |
| ☐ | D1–D2 approve + authz-context | [Step 4](#step-4--approve-the-agent) |
| ☐ | D3–D5 registration + dial (+ optional inbound DNS) | [Step 5](#step-5--create-the-first-registration-then-dial) |

Use `Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN` when CP auth is on.
Full path list: [API quick reference](#api-quick-reference).

### E — Failure map (logs)

| Symptom | Where to look |
|---|---|
| CP/Gateway CrashLoop `secret "fabric-…" not found` | A1 — Secret name/key mismatch (setup-day0 must match Deployment) |
| Ghostunnel exit / missing PEM | A1 — `fabric-gateway-tls` keys must be `gateway-cert.pem` / `gateway-key.pem` / `intermediate-ca.pem` |
| NLB up, TLS fails | A5b — PPv2 must be **off**; backends = worker IPs + NodePort |
| `bootstrap_token_*` | Day 1 Step 2c / Step 3 — re-issue; update VM env; restart Agent; re-check hash SQL in Step 2c |
| `PendingApproval` / StreamOpen deny | Day 1 Step 3 vs Step 4 — approve; compare Agent SQL before/after |
| dns-webhook `Failed to init OCI SDK` | A5c — image must include `oci-common`/`oci-dns`; IAM dynamic group `manage dns-records` |
| No lease / DNS silent | CP logs `dns_reconciler_acquired_lease`; `FABRIC_DNS_PROVIDER=webhook` |

---

## Day to day: registrations and pathways

### Creating a registration

**Most common customer case — Postgres (or any DB/API) inside the customer
cluster**, reachable from the Connect Agent:

```bash
# Wait ~5–10s after create before the first app dial: Agents poll ~every 5s
# to open a local listener and (if enabled) patch the connect-agent Service ports.
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: tenant-admin" \
  -d '{
    "tenant_id":"'"$TENANT"'",
    "display_name":"orders-postgres",
    "connectivity_type":"RESOURCE",
    "destination_kind":"CUSTOMER_RESOURCE",
    "host":"orders-pg.orders.svc.cluster.local",
    "port":5432
  }' \
  "$CP/v1/registrations" | jq '{id,state,destination_kind,host,port}'

# Port map (after one Agent poll tick):
kubectl -n "$NS" get svc connect-agent -o jsonpath='{.metadata.annotations.fabric\.abluva\.io/registration-ports}{"\n"}'
# App dials: connect-agent.$NS.svc.cluster.local:<port-from-annotation>
# Consumer pods need label abluva.io/connect-consumer=true (NetworkPolicy).
```

Platform-side example (Gateway dials a Platform service after authz):

```bash
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: tenant-admin" \
  -d '{
    "tenant_id":"'"$TENANT"'",
    "display_name":"payments-api",
    "connectivity_type":"SERVICE",
    "destination_kind":"PLATFORM_SERVICE",
    "host":"payments.fabric.svc.cluster.local",
    "port":8080
  }' \
  "$CP/v1/registrations" | jq '{id,state,destination_kind,host,port}'
```

**Propagation:** create returns `Active` immediately (sync DB). The Agent
picks it up on its next watch tick (**~5 seconds** default) — open a
listener, then reconcile Service ports. A dial in that window can fail
with connection refused; retry once after a few seconds, not a support
incident.

**Confirm** the same way as [Day 1 Step 5](#step-5--create-the-first-registration-then-dial)
(API `state: Active`, then the `ablv_registrations` SQL there).

The four allowed destination kinds (Spec §5.2 Destination Adapters;
uppercase names below are the code/log identifiers):

- `PLATFORM_SERVICE` → Direct Endpoint (`DIRECT_ENDPOINT`) — Gateway dials
  Platform service `host`/`port` after authz.
- `PLATFORM_RESOURCE` → Platform Connector (`PLATFORM_CONNECTOR`) — Gateway
  dials Platform resource `host`/`port` after authz (credentials stay out
  of band via Access API, Spec §14 item 10 — never on the stream).
- `CUSTOMER_SERVICE` / `CUSTOMER_RESOURCE` → Connect Agent (`CONNECT_AGENT`) —
  require `host`/`port` meaning "reachable from inside the customer's own
  environment"; the Gateway picks an eligible Connect Agent (Connected or
  Degraded, not explicitly `reachable=false`, preferring `reachable=true`,
  then fewest open Gateway→Agent streams) and sends `AgentDial`.

Only **Active** registrations are ever authorized — every other state is a
deliberate non-match, not a bug.

---

## Agent leaf certificate expiry (alert + rotate)

### Auto-rotation (always on — D3-AUTO)

Auto-rotation is **unconditional** — every Agent with a valid leaf
automatically rotates its certificate. No opt-in flag needed. This matches
industry standard (Teleport tbot, SPIRE, Vault Agent: rotation is always
on, never opt-in).

The Agent's `certlife.StartLoop` checks remaining cert life every
`FABRIC_CERT_CHECK_INTERVAL` (default 1h) and automatically rotates when
remaining life drops below 50% of total TTL. On success it **force-reconnects**
the tunnel onto the new leaf (prior FP stays accepted for
`DEFAULT_CERT_OVERLAP_SECONDS` = 300s as a safety margin).

**With 7-day certs (current default), rotation happens at ~3.5 days.**
No human intervention required. Monitor:

| Log event | Meaning |
|---|---|
| `cert_auto_rotate_success` / `cert_auto_rotate_reconnecting` | Healthy cutover |
| `cert_auto_rotate_failed` | Rotate attempt failed (CP / PoP / network) — retries every **30s** |
| `cert_auto_rotate_persist_pending` | CP already committed new FP; Agent retrying **SaveCert only** every 30s |
| `cert_auto_rotate_persist_retry_failed` | Identity store still rejecting writes |
| `cert_auto_rotate_persist_retry_success` | Pending leaf written; reconnect fired |

| Env var | Default | Recommended | Notes |
|---|---|---|---|
| `FABRIC_CERT_AUTO_ROTATE` | **on** (unset) | leave on | Set `0` only to disable for debugging. |
| `FABRIC_CERT_CHECK_INTERVAL` | `1h` | **`1h`** (7d TTL); use **`15m`** if you move to 24h TTL | Healthy check cadence. Failures temporarily use an in-process **30s** retry (not configurable). |
| `FABRIC_AGENT_CERT_DAYS` | `7` | **`7`** now | **Control plane** setting. Plan: tighten to `1` (24h) after stable. |

**What happens if auto-rotation fails?**

1. **Before CP commits** (network, CP 5xx, PoP reject): Agent logs
   `cert_auto_rotate_failed` and retries every **30s** until success. The
   on-disk leaf stays valid until NotAfter.
2. **After CP commits, SaveCert fails:** Agent logs
   `cert_auto_rotate_persist_pending` and retries persist **without** calling
   CP again (a second rotate would stomp the single prior-FP slot). Fix
   identity store (Secret RBAC, disk full, etc.) quickly — if persist stays
   broken past the **300s** overlap, StreamOpen authz fails and PoP-on-rotate
   with the old leaf returns `cert_not_bound_to_agent` (stuck until writer
   rotate or wipe + re-enroll).
3. **Safety net:** CP cert-expiry scan + webhook (below) pages if a leaf
   somehow nears NotAfter without rotating — that means auto-rotate has been
   failing for days, not routine hygiene.

**When to still use manual `FABRIC_AGENT_ROTATE=1`:** Certificate compromise
requiring immediate key replacement (pair with `revoke-cert` for the old
fingerprint). Do NOT use for routine hygiene — auto-rotation handles that.

Leaf lifetime defaults to **7 days** (`FABRIC_AGENT_CERT_DAYS`). Enforcement at
NotAfter is **automatic and fail-closed** (Ghostunnel rejects the cert — no
traffic). The cert-expiry scan + webhook below is a **safety net**, not the
primary mechanism.

### Wire the webhook (Platform Day 0 / once per env)

```bash
# Point at Slack/PagerDuty/etc. The CP job POSTs JSON when any Agent is
# inside the warn window (default: 48h before cert_not_after).
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c create secret generic fabric-cert-expiry-webhook \
  --from-literal=url='https://hooks.example.com/fabric-cert-expiry' \
  --dry-run=client -o yaml | kubectl apply -f -
# Restart CP pods if they started before the Secret existed:
kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c rollout restart deploy/fabric-control-plane
```

Env (already in `deploy/control-plane/deployment.yaml`, optional Secret):

| Env | Default | Meaning |
|---|---|---|
| `FABRIC_CERT_EXPIRY_SCAN_INTERVAL` | `6h` | How often CP scans (sized for 7d leaf TTL — a safety net for D3-AUTO, not the primary rotation path) |
| `FABRIC_CERT_EXPIRY_WARN_WITHIN` | `48h` | Warn when NotAfter is within this horizon. With the 7d default TTL and auto-rotation at day 3.5, still being unrotated inside 48h is a real signal |
| `FABRIC_CERT_EXPIRY_WEBHOOK_URL` | from Secret | Alert sink; omit → **log only** (`agent_cert_expiry_warning`) |

Webhook body shape (approximately):

```json
{
  "kind": "agent_cert_expiry",
  "count": 1,
  "agents": [{
    "tenant_id": "…",
    "agent_id": "…",
    "state": "Connected",
    "cert_fingerprint_sha256": "…",
    "cert_not_after": "2028-10-01T00:00:00.000Z",
    "days_remaining": 28
  }]
}
```

### What to do when you get the alert (safety net — D3-AUTO handles this automatically)

**Normal operation: you don't need to do anything.** D3-AUTO
(`certlife.StartLoop`) rotates every Agent's leaf at 50% of its TTL (3.5
days for the default 7-day cert), well before it nears expiry. If you're
seeing an expiry warning, it means auto-rotate has failed for this Agent
(Agent down, CP unreachable, identity store write failure, etc.).

**Triage first:** check Agent logs for `cert_auto_rotate_failed` or
`cert_auto_rotate_persist_*`. Fix the underlying cause (network, identity
store permissions, etc.). Pre-commit failures retry every 30s; persist
failures retry SaveCert only. Do not jump to `FABRIC_AGENT_ROTATE=1` unless
the Agent is already past overlap and stuck (`cert_not_bound_to_agent`).

**If triage doesn't resolve it** (or you're rotating for a compromise, not
an expiry): use the manual emergency procedure below. Works with any
identity store (K8s Secret or legacy hostPath).

```bash
NS=<tenant-namespace>

# 1) One-shot rotate flag on the DaemonSet (emergency/compromise only)
kubectl -n "$NS" set env daemonset/connect-agent FABRIC_AGENT_ROTATE=1

# 2) Roll; identity persists in the per-node K8s Secret (default) or
#    hostPath (legacy FABRIC_IDENTITY_STORE=file installs)
kubectl -n "$NS" rollout status daemonset/connect-agent

# 3) Confirm new leaf / same agent_id in UI or:
kubectl -n "$NS" logs -l app=connect-agent --tail=50 | grep -E 'cert_rotated|enroll_'

# 4) Clear the flag so the next rollout does not rotate again
kubectl -n "$NS" set env daemonset/connect-agent FABRIC_AGENT_ROTATE-

# 5) If a node failed: check bootstrap window only if identity was lost
#    (should not happen with K8s Secret store or hostPath on the same node).
```

Same `agent_id`, new fingerprint; prior fingerprint stays accepted for the
rotate overlap window (`DEFAULT_CERT_OVERLAP_SECONDS`, 300s). Tunnel
force-reconnects onto the new leaf immediately after successful rotation.

**If the rotate rollout stalls** (`kubectl rollout status` never finishes —
bad image, node pressure, etc.) while `FABRIC_AGENT_ROTATE=1` is still set:

```bash
# Check first — before chasing unrelated Agent bugs on a later deploy:
kubectl -n "$NS" get daemonset connect-agent -o yaml | grep -A2 FABRIC_AGENT_ROTATE

# Clear the flag regardless of rollout outcome. Leaving it set means the
# *next* unrelated image bump would rotate again on every node (safe, but
# confusing to debug).
kubectl -n "$NS" set env daemonset/connect-agent FABRIC_AGENT_ROTATE-
```

Then fix the stalled rollout (image / resources / node), and only re-run
this emergency procedure when you intentionally want another rotate.

**Compromise / immediate kill:** `POST /v1/tenants/:id/revoke-cert`
`{ "cert_fingerprint_sha256": "…" }` (dual-control) — force-close when
cause is security; then re-bootstrap that instance if it must return.
(Revoke is **tenant-scoped by fingerprint**, not `POST /v1/agents/:id/…`.)

---

### Updating a registration in place

Change a registration's name and/or destination without deleting and
recreating it. Only legal while the registration is currently Active — it
briefly moves `Active → Updating → Active` (bumping its internal generation
number, the same as any other change to desired state). Streams that are
already open on this registration are never disturbed either way: the
Gateway never re-reads a registration's configuration mid-stream, so those
connections simply keep running against whatever configuration was in
force when they were first opened.

```bash
curl -sS -H "Content-Type: application/json" -H "X-ABLV-Actor: tenant-admin" \
  -d '{
    "display_name":"payments-api-v2",
    "host":"payments-v2.fabric.svc.cluster.local",
    "port":8080
  }' \
  "$CP/v1/registrations/$REG_ID/update" | jq '{id,state,generation,display_name,host,port}'
```

Any of `display_name`, `host`, or `port` can be omitted — only the fields
you actually send are changed. If the update itself is invalid (missing a
required `host`/`port`, or a `display_name` that collides with another
registration on the same tenant), the request is rejected with a specific
error, and the registration is left completely untouched — still Active,
still on its previous configuration. It is never left stuck mid-`Updating`,
and a failed update is never silently treated as if it had succeeded.

#### Registration recovery — production default

**Not scheduled.** There is no background job that auto-retries `Failed`
registrations (see [Background jobs](#background-jobs-what-runs-without-a-human)).
Recovery is an **on-demand** call — **tenant-app UI primary** when wired
(`Tenant-App-UI-Checklist.md` §3); curl below is the ops fallback.

| State | What to do | What not to do |
|---|---|---|
| `Failed` | `POST /v1/registrations/:id/retry` | Delete+recreate (loses id / DNS name / observed history) |
| `Failed` (abandon) | `POST /v1/registrations/:id/delete` | Leave Failed rows indefinitely without a decision |
| `Active` (bad config) | `POST /v1/registrations/:id/update` | Delete+recreate for a host/port rename |

```bash
curl -sS -X POST -H "X-ABLV-Actor: tenant-admin" \
  "$CP/v1/registrations/$REG_ID/retry" | jq '{id,state,generation}'
```

Retry is only legal from `Failed` (`Failed → Validating → Provisioning →
Active`, bumps `generation`). Suspended tenants must be unsuspended first.
If applications are failing because a registration is `Failed`, jump to
[Troubleshooting → Registration is Failed](#registration-is-failed).

### The eight pathways, at a glance

waypoint only ever applies to Service traffic, and only on the Platform
side; Resource traffic never touches it under any circumstance. For the
full explanation of why, see `Connectivity-Technical-Guide.md` (pathways /
Part 10).

| Pathway | Hop chain | Notes |
|---|---|---|
| A1 — Platform → Platform service | Platform Service → ztunnel → (optional waypoint) → ztunnel → Platform Service | No Gateway, no Agent — entirely Ambient |
| A2 — Customer → Platform service | Customer Service → Agent → tunnel → Gateway → ztunnel → (optional waypoint) → Platform Service | Direct dial after authorization; Agent retries only at the transport level, waypoint (if present) retries HTTP/gRPC |
| A3 — Platform → Customer service | Platform Service → (optional waypoint) → ztunnel → Gateway → tunnel → Agent → Customer Service | Reaches the right tenant via Spec §8.3 DNS/SNI addressing (ops label G-A3-1); waypoint retries only apply up to the Gateway |
| A4 — Customer → Customer service | Customer Service → Agent → tunnel → Gateway → tunnel → Agent → Customer Service | Always hairpins through the Gateway; the origin Agent listens locally for this registration |
| B1 — Platform → Platform resource | Platform Service → ztunnel → Platform Connector → Platform Resource | No Gateway at all; credentials come from Access API, never from the registration |
| B2 — Customer → Customer resource | Customer Service → Agent → tunnel → Gateway → tunnel → Agent → Customer Resource | Hairpin, pure TCP passthrough, no waypoint; the application owns its own retry logic |
| B3 — Customer → Platform resource | Customer Service → Agent → tunnel → Gateway → Platform Connector → Platform Resource | No second Agent involved; no ztunnel or waypoint on this leg |
| B4 — Platform → Customer resource | Platform Service → ztunnel → Gateway → tunnel → Agent → Customer Resource | Same Spec §8.8 addressing as A3 (G-A3-1); never a waypoint |

When you're chasing a live traffic problem, correlate Agent and Gateway log
lines using the same `correlation_id`:

```bash
kubectl -n fabric-control logs -l app=fabric-gateway -c gateway --tail=200 | egrep 'stream_open|stream_accepted|stream_denied'
kubectl -n "$NS" logs -l app=connect-agent --tail=200 | egrep 'stream_open|tunnel_ready'
```

A healthy exchange shows `ACCEPTED` on both sides against the same
correlation id. A denial should always name a specific **reason string**
(and one of the five wire outcomes: `ACCEPTED` / `UNAUTHORIZED` /
`NOT_FOUND` / `DESTINATION_UNAVAILABLE` / `RETRY_LATER`) — never a bare,
unexplained rejection. Pending approval is `UNAUTHORIZED` + reason, not a
separate wire enum.

### Suspending, revoking, and retiring

Suspending a tenant always requires an explicit `cause` — the API rejects
the request outright (`suspend_cause_required`) if it's missing, on
purpose, since what happens to in-flight traffic depends entirely on why
you're suspending. Revoking a certificate defaults to `"security"` if you
don't specify a cause, which is the fail-safe direction: immediate teardown
rather than an accidental drain.

```bash
# Privilege headers (required when CP tokens are configured):
AUTH=(-H "Authorization: Bearer $FABRIC_CONTROL_PLANE_TOKEN")
DUAL=(-H "X-ABLV-Break-Glass: $FABRIC_DUAL_CONTROL_TOKEN")

# Billing-cause suspend: existing streams keep running, then force-close
# after FABRIC_REGISTRATION_DRAIN_GRACE (3 minutes by default)
curl -sS "${AUTH[@]}" "${DUAL[@]}" -H "Content-Type: application/json" -H "X-ABLV-Actor: security" \
  -d '{"suspended":true,"cause":"billing"}' "$CP/v1/tenants/$TENANT/suspend"

# Security-cause suspend: every one of this tenant's tunnels is force-closed immediately
curl -sS "${AUTH[@]}" "${DUAL[@]}" -H "Content-Type: application/json" -H "X-ABLV-Actor: security" \
  -d '{"suspended":true,"cause":"security"}' "$CP/v1/tenants/$TENANT/suspend"

# Revoke a specific certificate — "decommission" drains gracefully,
# "security" force-closes immediately
curl -sS "${AUTH[@]}" "${DUAL[@]}" -H "Content-Type: application/json" -H "X-ABLV-Actor: security" \
  -d '{"cert_fingerprint_sha256":"<hex>","cause":"security"}' \
  "$CP/v1/tenants/$TENANT/revoke-cert"

# Retire an agent entirely — terminal, no drain window at all. The Gateway
# force-closes its live tunnel on its next security-reconciliation pass
# (roughly every 2 seconds) — a Retired agent has no legitimate reason to
# still be holding a tunnel open. (Bearer required when FABRIC_CONTROL_PLANE_TOKEN
# is set; retire is not on the dual-control high-risk list.)
curl -sS "${AUTH[@]}" -H "X-ABLV-Actor: ops" -X POST "$CP/v1/agents/<agent-id>/retire"
```

---

## Troubleshooting

Work through these in order: **approval → tunnel → registration →
destination → proxy / Ambient.** Skipping straight to the last one is the
most common way to waste an hour on the wrong layer.

**Map of “what to open when”** (Platform `fabric-control` + SaaS ns; Agent in `fabric-edge` or `$NS` on customer cluster):

| Layer | Where | Commands / greps |
|---|---|---|
| **Agent process** | Customer cluster DaemonSet | `kubectl -n "$NS" get pods -l app=connect-agent`; `kubectl -n "$NS" logs -l app=connect-agent --tail=200` |
| Agent identity / enroll / cert | same logs | `egrep 'enroll_|identity_|cert_auto_rotate|agent_api_token|bootstrap'` |
| Agent tunnel | same logs | `egrep 'tunnel_|agent_running|yamux|NO_PROXY|dial'` |
| Agent StreamOpen (customer→Platform) | same logs | `egrep 'stream_open|stream_open_rejected|forward_'` |
| **Gateway** | Platform | `kubectl -n fabric-control logs deploy/fabric-gateway -c gateway --tail=200` |
| Gateway authz / drain | same | `egrep 'stream_open|stream_denied|stream_refused_draining|authz_|tunnel_quota|tunnel_reserve|security_force'` |
| **Ghostunnel** | Gateway pod sidecar | `kubectl -n fabric-control logs deploy/fabric-gateway -c ghostunnel --tail=100` — TLS handshake / client cert |
| **Control plane** | Platform | `kubectl -n 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c logs deploy/fabric-control-plane --tail=200` |
| CP enroll / rotate / token | same | `egrep 'enroll|bootstrap|agent_cert_rotated|agent_api_token|agent_cert_expiry'` |
| CP DNS (A3/B4) | same | `egrep 'dns_|reconcile'` |
| **ztunnel / Ambient** | Platform only (A1/B1 and Platform legs) | `kubectl -n ambient-plane logs -l app=ztunnel --tail=100`; `istioctl ztunnel-config` if installed. **Not** on customer cluster. |
| **NLB / VIP** | OCI / cloud console + curl | TCP to `:8443` from a customer node; confirm PPv2 **off** |
| **API truth** | curl CP | `GET /v1/agents/:id`, `GET /v1/registrations/:id`, `GET /v1/tenants/:id` |

Verification scripts (full pathways): `Validation-Plan.md` and Runbook
[Verification commands](#verification-commands-and-scripts).

### Applications can't connect

1. **Check the Agent's own state**: `GET /v1/agents/:id`
   - `PendingApproval` → this isn't a network problem at all; ask the
     tenant admin to approve it.
   - `Connecting` → the tunnel has genuinely never come up; check the dial,
     the certificates, or `NO_PROXY`.
   - `Disconnected` → an actual Agent or Gateway connectivity problem;
     check heartbeats and dial logs.
   - `Connected` → the Agent side is fine, move on to the next step.
2. **Check the Gateway's own stream logs** for the specific denial reason.
3. **Only after both of the above** consider changing a NetworkPolicy or a
   proxy setting.

### The tunnel won't come up

| Symptom | Likely cause | What to check |
|---|---|---|
| No `tunnel_ready` log line on the Agent | Wrong Gateway address, DNS, or a firewall blocking the dial | `printenv FABRIC_GATEWAY_ADDRESS`; DNS resolution; a plain TCP check against port 8443 |
| TLS handshake fails outright | Wrong CA, or a bad leaf certificate | The Agent's `ca.crt` needs to actually trust the Gateway's certificate chain |
| Failures are intermittent, not constant | An HTTP proxy is quietly intercepting the mTLS connection | Confirm the Gateway's host is genuinely in `NO_PROXY` |
| Tunnel was up, then all Agents reconnecting / `tunnel_disconnected` | Gateway pod restart, NLB blip, or all Gateway replicas briefly down | Wait — Agents retry forever (backoff cap 30s). Confirm `kubectl -n fabric-control get pods -l app=fabric-gateway` Ready ≥1; do not reinstall Agents |
| Gateway logs `proxy_identity_failed`, or a missing client-cert field | Ghostunnel is too old, misconfigured, or the Agent isn't presenting a client cert at all | Confirm the image is ≥ v1.10.0; confirm only `--proxy-protocol-mode=tls-full` is set (not also `--proxy-protocol`); confirm the Agent is actually presenting its client certificate |
| Agent stuck in `Connecting` specifically | The certificate fingerprint recorded at enrollment doesn't match the leaf certificate actually being presented now | `openssl x509 -in tls.crt -outform DER \| sha256sum` (Linux) or `... \| shasum -a 256` (macOS); local dev scripts expose the same value as `cert_sha256` in `deploy/local/lib.sh` |

### Enrollment errors

| Error | What it means | Fix |
|---|---|---|
| `bootstrap_token_invalid` | Wrong token or revoked | Issue a fresh one. The same token stays valid for its expiry window across multiple Agent instances — this error means wrong/revoked, not “already used once” |
| `agent_ca_not_configured` | Control plane has no `FABRIC_AGENT_CA_*` signing material but Agent sent `csr_pem` | Mount Intermediate/CA on the control plane (`fabric-agent-ca` Secret) |
| `csr_or_cert_fingerprint_required` | Enroll body missing both `csr_pem` and `cert_fingerprint_sha256` | Production Agents send a CSR; fingerprint-only is for pre-minted local smoke |
| `bootstrap_token_expired` | Past its expiry window | Issue a fresh one; update install Secret; restart Agent |
| `bootstrap_token_tenant_mismatch` | This token belongs to a different tenant | Re-issue it for the correct tenant |
| `tenant_suspended` | The tenant itself is currently suspended | Lift the suspension, with proper authority |
| `agent_cert_fingerprint_conflict` | Another live Agent is already using this exact certificate | Retire the older Agent, or rotate the certificate |
| Agent CrashLoop, `identity_unavailable` | First-boot enroll failed (CP down, bad bootstrap, missing CA) | Fix cause; DaemonSet restart **is** the retry — do not expect an in-process wait loop |

### Leaf cert / API bearer (Day‑N)

| Symptom | Likely cause | What to check |
|---|---|---|
| `cert_auto_rotate_failed` every ~30s | CP unreachable, PoP reject, rotate HTTP error | CP logs + Agent reachability to `FABRIC_CONTROL_PLANE_URL`; leaf still on disk until NotAfter |
| `cert_auto_rotate_persist_pending` / `…_retry_failed` | CP already committed new FP; identity store write failing | K8s Secret RBAC / disk; fix **before ~300s overlap** expires |
| `cert_not_bound_to_agent` on rotate | Prior FP expired after failed persist | Writer `POST …/rotate` or wipe identity + new bootstrap + re-enroll |
| Watch / list regs `status=401` | Bearer revoked or missing | Wait for next `FABRIC_AGENT_TOKEN_REFRESH` PoP pull, or lower interval; confirm `agent_api_token_pulled` |
| Expiry webhook / `agent_cert_expiry_warning` | Auto-rotate has been failing for days | Triage cert logs above first — not a routine rotate ticket |

### Control plane / Gateway / Ambient blips

| Symptom | Likely cause | What to check |
|---|---|---|
| New streams `RETRY_LATER`, reason authorization lookup | CP down or authz-context failing | CP pods Ready; Gateway still serves **existing** relays by design |
| `stream_open_rejected` / `gateway_draining` | Gateway rolling update | Wait for healthy replica; Agent should not need reinstall |
| A1 / Platform L4 path fails, Agent Connected | ztunnel / Ambient — not Agent | Platform `ambient-plane` ztunnel logs; Ambient enrollment of app namespaces |
| Inbound hostname (A3/B4) NXDOMAIN / wrong target | DNS reconciler / webhook | CP `FABRIC_DNS_*`; `dns-webhook` logs on OCI; never hand-edit records |

### Registration is Failed

A registration in `Failed` is **not** fixed by restarting the Agent or
waiting — nothing in the control plane auto-retries Failed rows on a
schedule.

1. Confirm state: `GET /v1/registrations/:id` → `"state":"Failed"`.
2. **Retry in place** (preferred):
   ```bash
   curl -sS -X POST -H "X-ABLV-Actor: tenant-admin" \
     "$CP/v1/registrations/$REG_ID/retry" | jq '{id,state,generation}'
   ```
   Expect `state: Active` and a bumped `generation`.
3. If retry returns `tenant_suspended`, lift suspension first, then retry.
4. If retry returns `registration_not_retryable`, the row is not Failed
   (e.g. already Active) — do not delete; use update or investigate.
5. **Abandon only if the registration should not exist:**
   `POST /v1/registrations/:id/delete` (`Failed → Deleted`). Then create a
   new registration if needed (new id / DNS name).

Tenant-facing product: expose Retry / Delete on Failed registrations in the
tenant app — see `docs/Tenant-App-UI-Checklist.md`. This repo does not ship
that UI.

### Applications can't connect — registration layer

After approval and tunnel are confirmed Connected:

1. `GET /v1/registrations/:id` — if `Failed`, use the section above (retry).
2. If `Active` but destination wrong — `POST .../update` (host/port/name).
3. If `Active` and Customer-side destination — check Agent `observed`
   reachability / probe logs before blaming the Gateway.

---

## Configuration catalog for operators

**Who this is for:** Platform ops running control plane + Gateway, and
anyone installing the Connect Agent. You do **not** need the full Fabric
architecture memo — only enough background to set timers safely.

**Mental model (30 seconds):**

1. **Connect Agent** (customer cluster) dials **out** over mTLS to the
   Platform **Gateway** (fronted by Ghostunnel on `:8443`).
2. **Control plane** stores tenants/Agents/registrations and tells Agents
   what to listen for; it is **not** on the data path for app bytes.
3. App traffic is a **byte relay** through the Gateway once a registration
   is Active and an Agent is Connected — timers below mostly affect
   *when we stop accepting work*, *when we mark Agents unhealthy*, or
   *when we warn about certs*, not SQL semantics.

Durations accept forms like `25s`, `3m`, `24h`, `30d` unless noted.

Production manifests already pin the important ones
(`deploy/control-plane/deployment.yaml`, `deploy/gateway/deployment.yaml`,
`deploy/connect-agent/daemonset.yaml`). Changing a value without
understanding the “If you set it wrong” column is how you get silent
SIGKILLs or surprise re-rotates.

### Gateway + Ghostunnel (Platform)

| Variable | Default | Recommended | Where set | Background | Impact | If you set it wrong |
|---|---|---|---|---|---|---|
| `FABRIC_SHUTDOWN_GRACE` | `25s` | **`25s`** (keep) | Gateway Deployment | On pod stop (`SIGTERM`), Gateway stops new tunnels/streams, then waits for in-flight relays to finish. | Longer = smoother deploys for long streams; shorter = faster pod exit. | Longer than `terminationGracePeriodSeconds` → kube **SIGKILL** mid-drain (cut connections). Manifest uses grace **45s** so 25s + Ghostunnel timeout fit. |
| Ghostunnel `--shutdown-timeout` | (Ghostunnel default was 5m) | **Same as** `FABRIC_SHUTDOWN_GRACE` (`25s`) | Gateway pod args | Sibling process in the same pod; must not outlive the Gateway drain. | Aligned shutdown. | Much longer than Gateway grace → Ghostunnel holds the pod until kube kills both. |
| `terminationGracePeriodSeconds` | K8s often `30` | **`45`** (manifest) | Gateway Pod spec | Wall clock from SIGTERM to SIGKILL. | Must be **>** shutdown grace + Ghostunnel timeout. | Too low → same SIGKILL problem. |
| `FABRIC_REGISTRATION_DRAIN_GRACE` | `3m` | **`1m`–`5m`**; prod pin **`3m`** | Gateway Deployment | After a registration leaves Active (delete/Failed) or **billing** suspend, existing streams may finish for this long before force-close. **Security** suspend/revoke ignore this — immediate close. | Longer = nicer for long downloads during planned teardown; shorter = faster teardown. | Very long (`hours`) → deleted regs keep carrying traffic; confusing capacity/billing. Too short → apps see abrupt cuts on routine deletes. |
| `FABRIC_DESTINATION_DIAL_TIMEOUT` | `10s` | **`5s`–`15s`** | Gateway (code default) | How long Gateway waits when dialing Platform or asking Agent to dial customer `host:port`. | Faster failure vs patience for slow networks. | Tiny values → flaky StreamOpen; huge → hung streams holding quota. |
| `FABRIC_REVOKE_PUSH_LISTEN` | unset | **`0.0.0.0:9090`** (manifest) | Gateway | HTTP listener for CP “revoke now” push (in-cluster only). | Faster revoke than waiting for poll. | Pointing public NLB here is wrong; Agents use `:8443` mTLS, revoke uses `:9090` HTTP inside the cluster. |
| `FABRIC_YAMUX_KEEPALIVE` | `30s` | leave default; keep **below** NLB/NAT idle timeout | Gateway | yamux keepalive on Agent tunnels. | Detects dead tunnels. | Idle timeout shorter than keepalive → spurious reconnect flaps. Extreme values → chatter or slow dead detection. |
| `FABRIC_YAMUX_WRITE_TIMEOUT` | `10s` | leave default | Gateway | yamux stream write deadline. | Bounds stuck writers. | Too low → false write failures under load. |

### Control plane (Platform)

| Variable | Default | Recommended | Where set | Background | Impact | If you set it wrong |
|---|---|---|---|---|---|---|
| `FABRIC_STORE` | `memory` | **`postgres`** in prod | CP Deployment | Backing store for tenants/Agents/registrations. | Memory loses state on restart. | Leaving `memory` in prod → empty fleet after restart. |
| `FABRIC_CONTROL_PLANE_TOKEN` | empty (open) | **required Secret** in prod | CP | Writer/admin bearer for `/v1/*`. | Authn for mutating APIs. | Empty in prod → anyone who can reach CP can mutate. |
| `FABRIC_DUAL_CONTROL_TOKEN` | empty | **required** for suspend/revoke-cert/delete | CP | Second factor for high-risk mutations. | Break-glass control. | Missing → those calls fail closed (good); don’t disable to “make smoke pass” in prod. |
| `FABRIC_HEARTBEAT_DEGRADED_AFTER` | `90s` | **`60s`–`180s`**; pin **`90s`** | CP Deployment | Gateway posts Agent tunnel heartbeats; if none arrive for this long, Agent goes **Degraded** (still may carry traffic, but selection prefers healthier Agents). | Shorter = faster detection of dead tunnels; longer = tolerate blips. | Too short → flap Degraded under load; too long → sticky selection to a dead Agent. |
| `FABRIC_PROBE_GRACE` | `15s` | leave default | CP (code) | New registrations without a TCP probe yet stay eligible briefly. | Avoids “just created” false DESTINATION_UNAVAILABLE. | Zero → brand-new regs may fail until first probe. |
| `FABRIC_CERT_EXPIRY_SCAN_INTERVAL` | `6h` | **`6h`** | CP (optional override) | How often CP scans Agent leaf `cert_not_after`. | Safety-net alert cadence — auto-rotation (D3-AUTO) is the primary mechanism; this job does **not** rotate anything itself. | `0` disables warnings (you only discover at NotAfter fail-closed). If you raise `FABRIC_AGENT_CERT_DAYS`, widen this proportionally. |
| `FABRIC_CERT_EXPIRY_WARN_WITHIN` | `48h` | **`24h`–`72h`** | CP | Warn when NotAfter is inside this horizon (default 7d leaf; auto-rotates at day 3.5). | Lead time to notice auto-rotation has been failing. | Too short → miss the signal; too long (e.g. old `30d` default) → fires on every cert immediately and pages on nothing. |
| `FABRIC_CERT_EXPIRY_WEBHOOK_URL` | unset | **Set via Secret** `fabric-cert-expiry-webhook` | CP Deployment | POSTs JSON when Agents are in the warn window. See [Wire the webhook](#wire-the-webhook-platform-day-0--once-per-env). | Pages on-call. | Unset → **logs only** — easy to miss. **Not** a tenant setting. |
| `FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL` | unset = **off** | **Leave off (v1)** | CP (commented) | Platform cron that force-mints new Agent API bearers for every tenant. | Compliance mass-rotate. | Turning on without widening overlap vs Agent refresh can stress multi-node fleets; Agent **hourly pull + reuse** already covers hygiene. |
| `FABRIC_GATEWAY_PUSH_DNS_NAMES` | — | **`fabric-gateway.fabric-control.svc.cluster.local`** | CP | Where CP pushes revoke/security updates. | Fast revoke. | **Never** the public NLB or `:8443` — use in-cluster Service **`:9090`**. |
| `FABRIC_GATEWAY_PUSH_DNS_PORT` | `9090` | **`9090`** | CP | Port for that push. | Must match Gateway revoke listen. | `8443` hits Ghostunnel, not the revoke HTTP handler. |
| `FABRIC_DNS_RECONCILE_ENABLED` | off | **`1`** in prod | CP | Maintains DNS for Platform→Customer inbound names. | Needed for A3/B4-style inbound. | Off → inbound hostnames go stale. |
| `FABRIC_DNS_LEADER_ELECTION` | on when reconcile+in-cluster | **`1`** | CP | Only one CP replica writes DNS. | Avoid duplicate upserts. | Off with multiple writers → races; use split manifest only as escape hatch. |
| `FABRIC_DNS_TARGET` | required if reconcile on | Real inbound VIP/hostname | CP | Shared target all inbound DNS records point at. | Wrong target → Platform cannot reach customer listeners by name. | Placeholder `example.com` left in git must be replaced per env. |
| `FABRIC_DNS_PROVIDER` | `file` | **`webhook`** in cloud | CP | `file` = JSON snapshot; `webhook` = POST to your DNS automation. | How records get published. | Webhook URL/token wrong → silent stale DNS. |
| `FABRIC_ENSURE_SAAS_TENANT` | off | **Never in prod** | CP | Local-only FK stub. | Laptop smoke. | On in prod → fake tenant rows / masks missing SaaS tenant. |

### Connect Agent (customer cluster)

| Variable | Default | Recommended | Where set | Background | Impact | If you set it wrong |
|---|---|---|---|---|---|---|
| `FABRIC_GATEWAY_ADDRESS` | — | Platform **NLB** `host:8443` | DaemonSet | Where Agent dials mTLS. | No tunnel if wrong. | Internal Service name from customer cluster won’t reach Platform. |
| `NO_PROXY` / `no_proxy` | must include Gateway host | Set by `tenant-start.sh` | DaemonSet | Agent→Gateway is **raw mTLS TCP**, not HTTP. | Proxies that intercept break the tunnel silently. | Missing Gateway host → stuck `Connecting` while HTTPS to CP still works. |
| `FABRIC_CONTROL_PLANE_URL` | — | Public CP HTTPS URL | DaemonSet | Enroll, watch, token pull, rotate. | Agent can’t call CP. | — |
| `FABRIC_BOOTSTRAP_TOKEN` | — | Day‑1 Secret only | DaemonSet | Multi-redeem enroll window. | First identity mint. | Left forever after Day‑1 increases leak risk; revoke when window should close. |
| `FABRIC_CONTROL_PLANE_TOKEN` | — | **Removed** (no longer needed in Agent) | DaemonSet | Previously: first enroll seed. Now: Agent derives bearer from leaf cert after enrollment. | — | — |
| `FABRIC_AGENT_TOKEN_REFRESH` | `1h` | **`1h`** (pinned; `0`=off) | DaemonSet | How often Agent calls CP for API bearer. Most calls **reuse** the same token until near expiry. | Cheap check-in; also recovery after writer bearer revoke. | Much faster → noise; much slower → slower pickup after revoke / force-renew. |
| `FABRIC_CERT_AUTO_ROTATE` | on (unset) | **leave on** | DaemonSet | Enables `certlife.StartLoop`. | Primary leaf rotation. | `0` disables auto-rotate — only for debugging. |
| `FABRIC_CERT_CHECK_INTERVAL` | `1h` | **`1h`** (7d TTL) | DaemonSet | Healthy remaining-life check cadence. Failures use in-process **30s** retry. | See Connectivity guide §6.3. | Raising without shortening leaf TTL delays detection of “past 50% life.” |
| `FABRIC_AGENT_ROTATE` | unset | **Unset**; set `1` only for one rotate rollout | DaemonSet | On startup, CSR mid-life leaf rotate (keeps `agent_id`). Needs persistent identity (Secret store or hostPath). | Emergency new leaf before NotAfter. | Left at `1` after a **stalled** rollout → next image deploy rotates again unexpectedly. Clear it always ([stall recovery](#agent-leaf-certificate-expiry-alert--rotate)). |
| `FABRIC_IDENTITY_STORE` | `file` (binary) | **`kubernetes`** (DaemonSet) | DaemonSet | Where leaf / agent-id / bearer persist. | Survives rollouts when `kubernetes`. | `file` + emptyDir alone → every rollout re-enrolls. |
| `FABRIC_NODE_NAME` | — | downward API `spec.nodeName` | DaemonSet | Required when store=`kubernetes`. | Per-node Secret name. | Missing → Agent refuses to start. |
| `FABRIC_YAMUX_KEEPALIVE` | `30s` | leave; **< NLB idle** | DaemonSet | Agent-side yamux keepalive (same env name as Gateway). | Must stay under path idle timeouts. | Mismatch with NLB idle → reconnect flaps. |
| `FABRIC_YAMUX_WRITE_TIMEOUT` | `10s` | leave default | DaemonSet | Agent-side yamux write timeout. | Bounds stuck writers. | — |
| Identity volume | — | **K8s Secret** (`FABRIC_IDENTITY_STORE=kubernetes`) or **`hostPath`** (legacy `file`) | DaemonSet | Leaf, agent-id, API token persisted across rollouts. | Survives image rollouts. | `emptyDir` alone with `file` → re-enroll / re-approve. |
| `FABRIC_K8S_SERVICE_MANAGE_ENABLED` | off in code; **`1`** in shipped DaemonSet | Keep `1` with RBAC | DaemonSet | Agent patches `connect-agent` Service ports to match registrations. | Apps dial by Service name. | Off → only placeholder port; multi-reg routing is DIY. |

### Quick “do not confuse” pairs

| This | Is not |
|---|---|
| Agent API bearer refresh (`FABRIC_AGENT_TOKEN_REFRESH`) | Leaf cert rotate (`FABRIC_AGENT_ROTATE` / D3-AUTO) |
| `cert_auto_rotate_failed` (pre-commit) | `cert_auto_rotate_persist_pending` (CP already committed; SaveCert retrying) |
| Cert expiry **webhook** (Platform CP Secret) | Something tenants configure |
| CP revoke push `:9090` | Agent dial NLB `:8443` |
| `FABRIC_REGISTRATION_DRAIN_GRACE` (billing/delete) | Security revoke (always immediate) |
| `FABRIC_SHUTDOWN_GRACE` (pod exit) | Registration drain grace |

---

## Background jobs (what runs without a human)


There are **no Kubernetes CronJobs** in this repo for Fabric recovery. Everything
below is an in-process ticker. Tenant UI must **not** invent scheduled jobs
that duplicate them (especially Failed-registration retry — that is
on-demand only).

| Job | Runs in | Default cadence | Operator / UI impact |
|---|---|---|---|
| DNS reconciler (+ Lease election in-cluster) | Control plane | ~30s tick | Keeps `<reg>.<tenant>.<domain>` in sync for Active `CUSTOMER_*`. Never hand-edit those records. Not a tenant-app feature |
| Heartbeat watchdog | Control plane | stale÷3 (cap 15s); stale default 90s | Connected → Degraded when heartbeats stop. Tenant UI may *display* Degraded; it does not drive the watchdog |
| Gateway → CP tunnel heartbeats | Gateway | ≤15s | Feeds the watchdog |
| `ReconcileSecurity` | Gateway | 2s | Force-closes tunnels on security suspend, security revoke, or Retired Agent |
| `ReconcileRegistrationDrain` | Gateway | 10s poll; grace `FABRIC_REGISTRATION_DRAIN_GRACE` (3m) | After billing suspend / non-Active regs, closes leftover streams once grace elapses |
| Quota `opens` sweep | Gateway | 30s | Internal map hygiene; no UI |
| CP → Gateway revoke push | Control plane | Event-driven | Best-effort; Gateway poll is the reliable fallback |
| Agent registration watch + TCP probes | Connect Agent | ~5s | Opens/closes local listeners; posts `…/observed` |
| **Agent cert auto-rotation (D3-AUTO)** | Connect Agent | Healthy: `FABRIC_CERT_CHECK_INTERVAL` (default `1h`), rotate at 50% TTL. On failure: **30s** retry; persist-only if CP already committed | `certlife.StartLoop`. **Always on** (`FABRIC_CERT_AUTO_ROTATE=0` to disable). Force-reconnect after successful persist. See Connectivity guide §6.3 |
| Agent API bearer refresh (G-CRED-1) | Connect Agent | `FABRIC_AGENT_TOKEN_REFRESH` (default `1h`; `0`=off) | Leaf PoP pull → local `agent-api.token`; CP **reuses** bearer until near expiry; no Secret rolls |
| Agent API token rotate job | Control plane | `FABRIC_AGENT_API_TOKEN_ROTATE_INTERVAL` (**leave unset/off for v1**, D4-A) | Optional mass re-issue. Redundant with D3-AUTO + D1 reuse — Agent-driven refresh already covers hygiene at the (shorter-lived) leaf's own cadence. Do not enable without an explicit compliance reason; see PRODUCTION-READINESS.md D4 |
| Agent cert expiry **safety-net** scan | Control plane | `FABRIC_CERT_EXPIRY_SCAN_INTERVAL` (default **`6h`**; `0`=off); warn within `FABRIC_CERT_EXPIRY_WARN_WITHIN` (default **`48h`**) | Logs `agent_cert_expiry_warning`; optional `FABRIC_CERT_EXPIRY_WEBHOOK_URL`. Defaults sized for the 7d leaf TTL — a hit here means auto-rotation has been failing, not routine expiry. Does not itself rotate anything |
| Agent K8s Service reconciler | Connect Agent | same tick when `FABRIC_K8S_SERVICE_MANAGE_ENABLED=1` | Keeps `svc/connect-agent` ports aligned with registrations |
| Failed registration auto-retry | **Does not exist** | — | Use `POST /v1/registrations/:id/retry` (UI button / curl) |

Full validation of these effects: `Validation-Plan.md` Matrix D.

---

## Verification commands and scripts

Run these whenever you want direct proof the current deployed code actually
behaves the way this runbook describes — not just a description to take on
faith. The full pathway matrix (AGT-02, retry, Ambient, jobs) is
`Validation-Plan.md`.

| What it checks | Command |
|---|---|
| Agent approval / bootstrap / registration authorization | `./deploy/scripts/api-smoke.sh` |
| State-machine logic and Access API response mapping | `cd control-plane && npm test` |
| Control plane liveness | `curl -sf "$FABRIC_CONTROL_PLANE_URL/healthz"` |
| Gateway's parsing of Ghostunnel's PROXY-protocol identity header | `cd gateway && go test ./internal/terminate/ -count=1` |
| Local Postgres store + Ghostunnel mTLS, pinned to v1.11.1 | `cd deploy/local && ./smoke.sh` |
| Full tenant Day 1 / Day‑N in k3d (G-BOOT-1, A2/A3/A4/B2/B3-style, **L3-AGT-02** two Agents + CA-only Secret, Failed **retry**, inbound DNS/TLS, quotas, Degraded, suspend, delete, pod restart, cert revoke) | `cd deploy/local/k3d && ./smoke-k3d-tenant.sh` |
| Gateway SIGTERM drain + Retired-agent force-close under live load | `cd deploy/local && ./smoke-lifecycle.sh` |
| Platform Ambient A1/B1 L4 paths (separate Platform k8s/k3d cluster; not Access API secrets) | `export KUBE_CONTEXT=…; ./deploy/local/k3d/ambient/smoke-ambient.sh` |
| Gateway / Agent actually compile | `cd gateway && go build ./cmd/gateway`, `cd connect-agent && go build ./cmd/connect-agent` |
| An Agent's live proxy environment | see [Network and HTTP proxies](#network-and-http-proxies) above |

Scripts live under `deploy/scripts/`. Only add a new one to this list after
you've actually run it successfully at least once yourself.

---

## API quick reference

Base URL: `$FABRIC_CONTROL_PLANE_URL`. Always send `X-ABLV-Actor: <who>` on
any mutating call.

`X-ABLV-Actor` is audit attribution only — it carries no privilege by
itself. Actual privilege requires `Authorization: Bearer
$FABRIC_CONTROL_PLANE_TOKEN` wherever that's configured (local compose always
sets it). The highest-risk mutations — suspending a tenant, revoking a
certificate, deleting a registration — additionally require
`X-ABLV-Break-Glass: $FABRIC_DUAL_CONTROL_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Is the process up |
| GET | `/v1/ca-bundle` | Public Agent CA trust PEM (no auth; CA only, never a key) |
| POST | `/v1/tenants/ensure` | **Idempotent** create-or-return Fabric tenant profile (`{ "tenant_id" }` in body — no `:id` in path). Does not update quotas/flags on re-call; use dedicated endpoints for those |
| GET | `/v1/tenants/:id` | Read a tenant's settings, revoke list, outstanding bootstrap state |
| POST | `/v1/tenants/:id/bootstrap-token` | Issue a bootstrap token (multi-redeem until expiry) |
| POST | `/v1/tenants/:id/bootstrap-token/revoke` | Invalidate an outstanding bootstrap token |
| POST | `/v1/tenants/:id/agent-api-token` | Writer: issue Agent API bearer (no longer needed for Day‑1; Agent self-derives after enroll) |
| POST | `/v1/tenants/:id/agent-api-token/revoke` | Writer: invalidate Agent API bearer(s) |
| POST | `/v1/tenants/:id/quotas` | `{ "max_tunnels", "max_concurrent_streams", "max_stream_open_per_sec" }` |
| POST | `/v1/agents/:id/api-token/current` | **G-CRED-1:** Agent pulls bearer via leaf PoP (+ optional reuse of current token) |
| POST | `/v1/agents/:id/rotate` | Agent mid-life leaf rotate (CSR; keeps `agent_id`) |
| POST | `/v1/tenants/:id/auto-approve` | `{ "enabled": true\|false }` |
| POST | `/v1/tenants/:id/suspend` | `{ "suspended": true\|false, "cause": "..." }` |
| POST | `/v1/tenants/:id/revoke-cert` | `{ "cert_fingerprint_sha256": "..." }` — **not** under `/v1/agents/…` |
| GET | `/v1/tenants/:id/agents?state=` | List agents, optionally filtered by state |
| GET | `/v1/tenants/:id/registrations` | List live registrations |
| POST | `/v1/agents/enroll` | Agent bootstrap enrollment |
| POST | `/v1/agents/:id/approve` | Tenant admin approval |
| POST | `/v1/agents/:id/retire` | Offboard an agent |
| POST | `/v1/agents/tunnel-event` | Gateway reports tunnel `up`/`down`/`heartbeat` |
| GET | `/v1/agents/:id` | Fetch a single agent's state |
| POST | `/v1/registrations` | Create a registration |
| GET | `/v1/registrations/:id` | Fetch a single registration |
| POST | `/v1/registrations/:id/update` | Change name/host/port in place (`Active → Updating → Active`) |
| POST | `/v1/registrations/:id/retry` | Re-provision a `Failed` registration (`Failed → … → Active`) |
| POST | `/v1/registrations/:id/delete` | Soft-delete a registration (stops new streams) |
| POST | `/v1/registrations/:id/observed` | Agent reports its own reachability |
| GET | `/v1/internal/authz-context` | Snapshot of what the Gateway's own authorization view looks like |
| GET | `/v1/internal/agent-by-cert` | Resolve an agent from a certificate fingerprint |

**Canonical path list** = this table (derived from `control-plane/src/http/server.ts`).
If Connectivity / UI checklist disagree with a path here, **this table wins**
until code changes.
Agent **leaf** issuance is in-band: Agents send `csr_pem` on
`POST /v1/agents/enroll` and the control plane signs with `FABRIC_AGENT_CA_*`
(L3-AGT-02). Platform Intermediate / Root hierarchy and Gateway leaf minting
remain out of band (`deploy/local/gen-certs.sh` locally, or your real CA
pipeline). The control plane records fingerprints at enroll and supports
revocation by fingerprint.

---

## Sign-off sheet

| Gate | Owner | Date | Evidence | Pass |
|---|---|---|---|---|
| `npm test` (state machine + Access API mappers) | | | terminal output | ☐ |
| `./deploy/scripts/api-smoke.sh` | | | terminal output | ☐ |
| `go test ./internal/terminate` | | | terminal output | ☐ |
| `./deploy/local/smoke.sh` (Postgres + Ghostunnel) | | | terminal output | ☐ |
| `./deploy/local/smoke-lifecycle.sh` (retire + SIGTERM drain) | | | terminal output | ☐ |
| `./deploy/local/k3d/smoke-k3d-tenant.sh` (incl. AGT-02 + Failed retry) | | | terminal output | ☐ |
| Access API `keys#database` reachable | | | redacted `jq` output | ☐ |
| SQL migration applied | | | `\dt ablv_*` | ☐ |
| Gateway + Ghostunnel deployed (`replicas` Ready) | | | `kubectl get deploy/pods -n fabric-control` | ☐ |
| Control plane DNS Lease path (`deployment.yaml`) understood | | | Runbook Step 6 | ☐ |
| Cert-expiry webhook Secret created (`fabric-cert-expiry-webhook`) | | | Runbook “Wire the webhook” | ☐ |
| `./deploy/local/k3d/smoke-k8s-service.sh` (multi-reg Service ports) | | | terminal output | ☐ |
| `./deploy/local/k3d/smoke-dns-lease.sh` (optional Platform) | | | terminal output | ☐ |
| Tenant ___ Agent reaches `Connected` | | | Day 1 Step 4 API + SQL | ☐ |
| First Active registration created | | | Day 1 Step 5 API + SQL | ☐ |
| Pathway ___ confirmed accepted end to end | | | matching `correlation_id` logs on both sides | ☐ |
| Ambient verify (platform cluster) / or `smoke-ambient.sh` | | | `verify-ambient.sh` / script OK | ☐ |
| `Validation-Plan.md` Matrix A–E reviewed for this release | | | checklist | ☐ |