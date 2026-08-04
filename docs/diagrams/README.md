# Architecture diagrams index

Canonical place for Abluva Platform OCI + Fabric architecture visuals.
Narrative: `Connectivity-Technical-Guide.md`. Ops: `Operational-Runbook.md`.
Normative hops: `Architecture-Spec.docx`.

**Goal of the pack (two audiences, few diagrams)**

| Set | Purpose | Who reads it |
|---|---|---|
| **A — Platform OCI** | Confidence: security posture, subnets, LBs, HA/DR | Cloud / security / compliance |
| **B — Fabric connectivity** | Confidence: how traffic is protected, dialed, authorized | Product / eng / solution architects |

Prefer **3–4 strong diagrams per set** over many thin ones. Use **sequence**
only where time order matters; **SVG/topology** for placement; **flowchart**
only for decision/authz logic.

---

## Clarifications (locked for diagramming)

## Namespace layout (canonical)

| Namespace | Role | Workloads |
|---|---|---|
| **`fabric-control`** | Network plane | Fabric Gateway, Ghostunnel, NLB backends, gateway TLS secrets |
| **`3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c`** | SaaS control plane + apps | Control Plane, `fabric-dns-webhook`, `discovery`, `unified-access`, CP secrets |
| **`ambient-plane`** | Istio Ambient data plane | `ztunnel` DaemonSet, Istio CNI (replaces `istio-system`) |
| **`fabric-edge`** | Customer Connect Agent | Agent DaemonSet, identity secrets, local Service (replaces older `mesh-tenant` examples) |
| **`tenant-*`** | Optional per tenant | SaaS-hosted app pods or Hybrid bookkeeping on Platform OKE |

Source of truth for scripts: `deploy/platform/namespaces.sh`.

Cross-namespace traffic is normal K8s Service DNS (Gateway in `fabric-control`
calls `fabric-control-plane.3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c.svc:8080`; revoke push stays
`fabric-gateway.fabric-control.svc:9090`).

### What lives where (no overlap)

| Component | Namespace | Notes |
|---|---|---|
| Gateway + Ghostunnel | `fabric-control` | Only networking / stream relay |
| Control Plane + dns-webhook | SaaS ns | Config + DNS reconciler — **not** in `fabric-control` |
| `discovery`, `unified-access` | SaaS ns | UI-facing APIs; A1 path is in-cluster DNS here |
| ztunnel | `ambient-plane` | Enroll `fabric-control` + SaaS ns for mTLS |
| Connect Agent | `fabric-edge` (customer cluster) | Never on Platform OKE for Hybrid |

### Two load balancers (Set A)

| LB | OCI type | Role |
|---|---|---|
| **Flexible / Application LB** | OCI Flexible Load Balancer | Normal cloud/web HTTPS (UI, APIs, product front door) |
| **Fabric NLB** | Network Load Balancer (L4, PROXY off) | **Only** Agent tunnel + Platform inbound Fabric (`:8443` Ghostunnel). Not HTTP app traffic |

Do not merge them into one box on architecture slides — security reviewers
care that Fabric is L4 TCP mTLS, separate from the web LB.

Do not merge web LB and Fabric NLB on architecture slides — Fabric traffic is
L4 TCP mTLS, separate from product HTTPS.

### Namespaces on **our** OKE

See **Namespace layout** above. Customer Connect Agent is **never** the
Platform `tenant-*` namespace in Hybrid — Agent runs on the customer cluster
or appliance.

### Public vs private (Set A)

| Subnet | Typical contents |
|---|---|
| **Public** | Flexible LB (web), Fabric NLB (TCP 8443), optional bastion |
| **Private** | OKE node pools, all pods (`fabric-control`, SaaS ns, `ambient-plane`, optional `tenant-*`), OCI Managed Postgres, OCI Vault |

---

## Conventions

| Item | Rule |
|---|---|
| Public DNS examples | `abluva.com`, **`fabric.abluva.com`** (Agent/NLB), `connect.abluva.com` (inbound) |

Canonical public Gateway hostname is **`fabric.abluva.com`** (not `mesh-gateway.abluva.com`). Env vars use `FABRIC_*`; K8s Service is `fabric-gateway`.
| Formats | **SVG** for executive / security topology (OCI icons, fixed grid). **Mermaid sequence** for lifecycle. **Mermaid flowchart** only for authz/decision. Keep a `.mmd` twin when the SVG is topology so git diffs stay possible |
| Icons | `icons/*.svg` from [oci-designer-toolkit](https://github.com/oracle/oci-designer-toolkit); flush top-left with a light `#D0D5DD` border only (no fill badge) |
| Brand | Primary `#674EA7` · light `#B4A7D6` · tint `#EDE8F5` · dark `#4F3B85` |

---

## Set A — Platform OCI (security / DR confidence)

**Clubbed to 3 diagrams** (was A1–A5).

| ID | Title | Style | What it must show |
|---|---|---|---|
| **A-OCI** | Platform on OCI (one-pager) | **SVG topology** (+ optional `.mmd`) | VCN; external Cloudflare; **public** Flexible LB + Fabric NLB + IGW; **private** OKE (`fabric-control` network, `3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c` control+SaaS); Postgres + **Vault**; NAT; NSG |
| **A-HA** | Resilience in-region + DR | **SVG topology** with AD / region swimlanes | Node pools across ADs (optional); DB primary/standby; multi-region DR by subscription — **one** HA+DR picture, not two files |
| **A-IAM** | Access boundary (short) | **Mermaid flowchart** or compact SVG | Dynamic group for dns-webhook; who can reach NLB vs web LB; gateway secrets in `fabric-control`, CP secrets in SaaS ns — only if A-OCI cannot fit IAM without clutter |

**Default ship: A-OCI + A-HA.** Add A-IAM only if security asks for a dedicated IAM slide.

---

## Set B — Fabric connectivity (protection / stability)

**Clubbed to 4 diagrams** (was B1–B8). Draft front-door files become **B-CTX**.

| ID | Title | Style | What it must show |
|---|---|---|---|
| **B-A1** | Platform service → Platform service | **SVG topology** (left→right) | `discovery` → ztunnel L4 mTLS → optional waypoint → `unified-access`; SaaS ns on OKE; no Gateway / Agent / `connect.abluva.com` |
| **B-CTX** | Fabric context & deployment | **SVG topology** | SaaS OKE (SaaS ns + `fabric-control` + `ambient-plane`) ↔ Fabric NLB ↔ customer Agent in `fabric-edge` (K8s / k3s); Cloudflare DNS (Agent A + `connect` NS); Hybrid vs SaaS-hosted callout; **not** the web Flexible LB as the tunnel path |
| **B-LIFE** | Join & traffic lifecycle | **Mermaid sequence** (2–3 frames or one long) | enroll → approve → tunnel up → StreamOpen; Platform→Customer inbound SNI; credential pull (PoP) as a short adjacent frame or footnote — **one sequence doc**, not separate enroll vs revoke decks |
| **B-AUTH** | Control vs data + authz | **Mermaid flowchart** | CP = config/desired-state only; Gateway = sole stream yes/no; key = `(tenant_id, registration_id)` + cert/suspend/quotas; DNS reconciler feeds inbound names (UUID + friendly slug) |
| **B-DFD** | Threat-modeling data flow | **Mermaid + draw.io DFD** | Level-1 DFD: external entities, processes, stores, trust boundaries TB1–TB5, numbered flows DF0–DF17 for STRIDE |
| **B-DIAL** | How apps dial | **SVG or annotated table + small topology** | Customer→Platform: `connect-agent.<ns>.svc:<port>`; Platform→Customer: `privacy.<tenant_id>.connect.abluva.com`; same-cluster = plain K8s DNS; Hybrid vs SaaS-hosted destination `host` on registration |

**Do not** ship separate diagrams for B2/B4/B5/B6/B8 unless a stakeholder asks — those themes are **panels or callouts** inside B-CTX / B-LIFE / B-AUTH / B-DIAL.

---

## Style cheat sheet

| Need | Use | Avoid |
|---|---|---|
| “Where does it sit in OCI?” | SVG topology (A-OCI, A-HA, B-CTX) | Sequence |
| “What happens in order?” | Mermaid **sequence** (B-LIFE) | Busy SVG with numbered arrows only |
| “Who is allowed / what fails closed?” | Mermaid **flowchart** (B-AUTH, optional A-IAM) | Topology soup |
| “Threat model / STRIDE on flows?” | **B-DFD** (Mermaid + draw.io) | Pure topology without numbered flows |
| “What URL do I put in config?” | B-DIAL (table + tiny diagram) | Another full VCN map |

---

## Enterprise ask → diagram map (updated)

| Typical ask | Answer with | Diagram type |
|---|---|---|
| Where does it run in OCI (subnets, LBs, data stores)? | **A-OCI** | SVG topology |
| HA / DR (multi-region by subscription) | **A-HA** | SVG topology (AD/region swimlanes) |
| Ingress / egress / open ports | **A-OCI** + **B-CTX** legend | Topology + protocol callouts |
| High-level Hybrid connectivity | **B-CTX** | SVG topology |
| Onboarding / Day‑1 / cert lifecycle | **B-LIFE** | Mermaid sequence |
| Trust boundary / authz / tenant vs registration | **B-AUTH** | Mermaid flowchart |
| Threat model / DFD / STRIDE worksheet | **B-DFD** | Mermaid + draw.io DFD |
| Same-cluster Platform service dial (A1) | **B-A1** | SVG topology |
| App config / dial names / ports in code | **B-DIAL** | Table + small topology |
| Shared responsibility (Hybrid vs SaaS-hosted) | **B-CTX** + **B-DIAL** | Callouts, not a 5th deck |
| Cloudflare vs OCI DNS split | **B-CTX** | Topology (Agent A vs connect NS) |
| Is Fabric a separate product from Platform? | **A-OCI** CP panel + **B-AUTH** | One backend, two roles (config vs stream) |
| IAM / instance principal / secrets | **A-IAM** (if needed) | Flowchart |
| Multi-tenant isolation story | **B-AUTH** + **B-CTX** | Flowchart + topology callout |

---

## Build order

1. This index (consolidated) — done  
2. **A-OCI** — [`a-oci-platform.svg`](a-oci-platform.svg) + [`a-oci-platform.drawio`](a-oci-platform.drawio) — done  
3. **A-HA** — [`a-ha-resilience.svg`](a-ha-resilience.svg) + [`a-ha-resilience.drawio`](a-ha-resilience.drawio) — done  
4. **B-A1** — [`b-a1-platform-service.svg`](b-a1-platform-service.svg) (+ [`.mmd`](b-a1-platform-service.mmd)) — done  
5. **B-CTX** — [`b-ctx-fabric-context.svg`](b-ctx-fabric-context.svg) (+ [`.mmd`](b-ctx-fabric-context.mmd)) — done  
6. **B-DIAL** — [`b-dial-how-apps-dial.svg`](b-dial-how-apps-dial.svg) (+ [`.mmd`](b-dial-how-apps-dial.mmd)) — done  
7. **B-LIFE** — [`b-life-join-traffic.mmd`](b-life-join-traffic.mmd) — done  
8. **B-AUTH** — [`b-auth-control-vs-data.mmd`](b-auth-control-vs-data.mmd) — done  
9. **B-DFD** — [`b-dfd-threat-model.mmd`](b-dfd-threat-model.mmd) + [`b-dfd-threat-model.drawio`](b-dfd-threat-model.drawio) — done  
10. **A-IAM** — only if security asks for a dedicated IAM slide  

---

## Files

| Path | Maps to |
|---|---|
| [`a-oci-platform.svg`](a-oci-platform.svg) | **A-OCI** — OCI icons, brand purple `#674EA7` |
| [`a-oci-platform.drawio`](a-oci-platform.drawio) | **A-OCI** — editable diagrams.net twin (open in draw.io) |
| [`a-ha-resilience.svg`](a-ha-resilience.svg) | **A-HA** — AD node pools + dashed DR region |
| [`a-ha-resilience.drawio`](a-ha-resilience.drawio) | **A-HA** — editable diagrams.net twin (open in draw.io) |
| [`b-a1-platform-service.svg`](b-a1-platform-service.svg) | **B-A1** — discovery → ztunnel → optional waypoint → unified-access |
| [`b-ctx-fabric-context.svg`](b-ctx-fabric-context.svg) | **B-CTX** — Fabric NLB tunnel path, Cloudflare DNS, Hybrid vs SaaS-hosted |
| [`b-dial-how-apps-dial.svg`](b-dial-how-apps-dial.svg) | **B-DIAL** — dial catalog + tiny topology |
| [`b-life-join-traffic.mmd`](b-life-join-traffic.mmd) | **B-LIFE** — enroll → approve → tunnel → StreamOpen (+ inbound SNI, PoP) |
| [`b-auth-control-vs-data.mmd`](b-auth-control-vs-data.mmd) | **B-AUTH** — CP config vs Gateway authz pipeline |
| [`b-dfd-threat-model.mmd`](b-dfd-threat-model.mmd) | **B-DFD** — Level-1 threat-modeling DFD (Mermaid) |
| [`b-dfd-threat-model.drawio`](b-dfd-threat-model.drawio) | **B-DFD** — editable diagrams.net twin (classic DFD shapes) |
| [`reference/arch-skills.md`](reference/arch-skills.md) | Diagram design system (brand purple locked) |
| [`reference/abluva-arch.svg`](reference/abluva-arch.svg) | Style reference (abluva.com brand) |
| [`reference/aws-arch.svg`](reference/aws-arch.svg) | Connector craft reference (orthogonal + small arrows) |
| [`icons/`](icons/) | OCI Designer Toolkit icons (SVG; bordered top-left, no fill badge) |
