# Fabric documentation map

**Authority order** (higher wins on conflict):

1. `Architecture-Spec.docx` — Level-1 architecture (frozen vocabulary, ADRs, §7–§8 pathways, §9 retry, §14 resolutions)
2. `L2-Design.docx` — state machines, failure semantics, yamux/`StreamOpen`, Agent selection
3. Markdown implementation truth (below) — when Spec/L2 are silent on packaging that shipped in this repo
4. `Operational-Runbook.md` — Day-0/1/N commands + E2E OCI/k3s checklist (prefer over `Operational-Runbook.docx`)
5. `Developer-Reference.md` (+ generated `.docx`) — schemas, wire shapes, manifests, repo layout

**Frozen vocabulary (Spec §2)** — use these, not conversational aliases:

| Use | Do not use as primary |
|---|---|
| **Platform** | “SaaS side”, “our side”, “internal” |
| **Customer Environment** | “tenant side”, “external” |
| **Service Connectivity / Resource Connectivity** | “Path A / Path B” |
| **Platform Service / Customer Service** | informal synonyms alone |
| **Destination Adapter** | inventing hop names that replace Spec chains |

---

## What each file is for

| File | Purpose | Not for |
|---|---|---|
| **`Connectivity-Technical-Guide.md`** | **Canonical connectivity story** — credentials + **leaf/bearer failure flows** (§6.3–6.5), Day‑0/1, Ghostunnel + authz pipeline, eight pathways, DNS, dial, HA, **config catalog with defaults/recommended** (Part 14) | Ticket backlog; Postgres DDL |
| **`Developer-Reference.md`** | **Canonical developer artifacts** — registration/agent shapes, wire frames, manifest pointers, state machines, sequences, repo tree | Pathway “why” essays (use Connectivity guide) |
| **`Developer-Reference.docx`** | Word export of the markdown (regenerate from `.md` if editing) | Editing alone without updating `.md` |
| **`Developer-Reference.pre-l3-skeleton.docx`** | Archived pre-L3 draft (stale) | Implementation |
| **`network-product-guide.md`** | Pointer → Connectivity Technical Guide | New content |
| **`Architecture-Resolutions.md`** | Spec §14 companion, G-* IDs, impl status | Day-by-day ops |
| **`Operational-Runbook.md`** | Operator curls / kubectl Day-0/1/N; **E2E OCI + k3s appliance** ☐ checklist | New hop chains |
| **`Operational-Runbook.docx`** | Legacy Word checklist — **superseded** by `.md` | Current procedures |
| **`PRODUCTION-READINESS.md`** | Locked D1–D8, ship bar | Spec hop-chain authority |
| **`Level-3-Store-OIDC-Spec.md`** | Postgres + OIDC + Access API | Pathway design |
| **`Level-3-Tickets.md`** | Ticket backlog | Architectural truth |
| **`Tenant-App-UI-Checklist.md`** | Tenant-app UI surfaces | Fabric implementation |
| **`Validation-Plan.md`** | Smoke proof matrix | Architecture debate |

Word Spec/L2 remain normative for architecture. For **shipped packaging**
(identity.Store [K8s Secret or file], Ghostunnel sidecar, token PoP+reuse, NLB PROXY-off), trust
Connectivity + Developer-Reference markdown + manifests.

---

## Pathway hop chains

Only Spec §8 is normative. Resolutions / Technical Guide / Runbook must copy those chains (waypoint = optional L7 on Services; never on Resource Connectivity).

**One reading (story):** `Connectivity-Technical-Guide.md`  
**One reading (shapes/code):** `Developer-Reference.md`  
**Commands:** `Operational-Runbook.md`
