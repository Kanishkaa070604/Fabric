# Abluva Architecture Diagram Design System

**Version:** 1.0

---

# 1. Philosophy

Architecture diagrams should answer four questions within **10 seconds**:

1. **Where does this run?**
2. **Who owns it?**
3. **How does traffic flow?**
4. **How does it fail over?**

Every design decision should improve one of these four.

---

# 2. Design Principles

* Minimal
* Modern
* Vendor-neutral
* Consistent
* Highly readable
* White space over decoration

Avoid:

* Gradients
* Shadows
* 3D effects
* Excessive nesting
* Rainbow colour palettes

The style should feel closer to **Stripe, Vercel, Grafana or modern AWS documentation** than classic enterprise Visio diagrams.

---

# 3. Visual Hierarchy

Every diagram should use the same hierarchy.

```
Cloud Provider

    Region

        Availability Domain

            Network (VCN / VPC)

                Subnet

                    Kubernetes Cluster

                        Node Pool

                            Node

                                Application

Managed Services

External Systems
```

Not every level must appear.

Only show the layers needed to explain the architecture.

---

# 4. Ownership Model

Ownership is the most important visual concept.

## Abluva Platform

Examples

* Control Plane
* Portal
* Controller
* AI Services
* Licensing
* Policy Engine

Use

Border:

Brand Purple

Header:

Brand Purple

Fill:

White

Never fill the entire box purple.

---

## Customer Infrastructure

Examples

* Customer AWS
* Customer OCI
* Customer Azure
* Customer Kubernetes
* Customer VM

Border:

Neutral Gray

Fill:

White

---

## Third Party

Examples

* GitHub
* Okta
* Microsoft Entra
* Stripe
* Slack
* OpenAI

Border:

Amber

Fill:

Very light amber

---

# 5. Colour Palette

## Abluva Brand

Primary

#674EA7

Primary Light

#B4A7D6

Primary Tint (fills)

#EDE8F5

Primary Dark

#4F3B85

Use for

* Control Plane
* Headers
* Important callouts
* Control connections
* Abluva-owned containers (SaaS ns, fabric-edge)

Never use as a background for large containers.

---

## Neutral

Border

#D0D5DD

Text

#344054

Secondary Text

#667085

Light Fill

#FCFCFD

---

## Public Networking

Border

#2E90FA

Fill

#EFF8FF

---

## Private Networking

Border

#D0D5DD

Fill

White

---

## External Systems

Border

#F79009

Fill

#FFFAEB

---

## Disaster Recovery

Border

#98A2B3 (Dashed)

Fill

#F8F9FC

---

## Success / Security

Border

#16A34A

Fill

#ECFDF3

Only for security-related callouts.

---

## Error / Failover

Border

#DC2626

Fill

#FEF3F2

Only for failover arrows.

---

# 6. Canvas

Background

White

Preferred Size

16:9

Margins

48–64 px

Grid

8 px

Flow

Left → Right

---

# 7. Typography

Font

Inter

Region Header

20 px

Container Header

16 px

Card Title

14 px

Subtitle

12 px

Text Colour

#344054

---

# 8. Regions

Regions are top-level containers.

Style

Thin border

Very subtle

White background

Example

```
OCI Region (Sydney)
AWS us-east-1
Azure East US
```

---

## Disaster Recovery Region

Use

Dashed border

Very light gray background

Example

```
OCI Region (Frankfurt)

Passive
```

Replication arrows always terminate here.

---

# 9. Availability Domains

Availability Domains are cards inside the region.

Never colour them.

Never make them visually dominant.

```
AD-1

AD-2

AD-3
```

Use equal widths.

Spacing:

24 px

---

# 10. Network

Networks exist inside Regions.

Examples

VCN

VPC

Virtual Network

Only draw when networking matters.

Otherwise omit.

---

# 11. Subnets

Subnets always exist inside the network.

## Public Subnet

Blue border

Light blue fill

Contains

* Flexible Load Balancer
* API Gateway
* Bastion

---

## Private Subnet

Gray border

White fill

Contains

* OKE
* PostgreSQL
* Vault
* Redis
* Workers

---

# 12. Kubernetes

Represent Kubernetes as a container.

Header

☸ OKE Cluster

or

☸ Kubernetes Cluster

Inside

Node Pools

Applications

Services

Avoid showing every Kubernetes resource.

---

# 13. Node Pools

Node Pools exist inside the cluster.

Example

Node Pool

AD-1

Worker Node

Node Pool

AD-2

Worker Node

This makes HA immediately obvious.

If node pools aren't important, omit them.

---

# 14. Nodes

Only include nodes when discussing

* Scheduling
* HA
* Affinity
* Capacity

Otherwise omit.

---

# 15. Applications

Applications never use cloud icons.

Always use rounded white cards.

Examples

API

Gateway

Controller

Worker

AI Runtime

Scheduler

Policy Engine

Embedding Service

---

# 16. Managed Services

Managed services sit beside Kubernetes.

Never inside Kubernetes.

Examples

🗄 PostgreSQL

🛡 Vault

🪣 Object Storage

⚡ Redis

---

# 17. External Systems

Represent using amber.

Examples

GitHub

Okta

Microsoft Entra

Stripe

Customer Browser

OpenAI

Anthropic

---

# 18. Connectors

## Line types

| Kind | Style | Colour |
|---|---|---|
| Normal traffic | Solid | `#667085` |
| Control / Fabric tunnel | Solid | Brand purple `#674EA7` |
| Replication | Dashed | `#98A2B3` |
| Failover | Dashed | `#DC2626` |
| Monitoring | Dotted | `#98A2B3` |

Never call control lines “Abluva Blue” — brand is purple.

## Craft rules (from reference diagrams)

* **Orthogonal only** — horizontal and vertical segments; no diagonals across cards.
* **Route in gutters** — leave 16–24 px channels between containers; never draw through card text or icons.
* **No crossings** — if two paths must meet, stagger on different gutters or share a trunk then branch.
* **Stroke weight** — 1.5 px.
* **Arrowheads** — small filled triangles (~6×6 px), same colour as the stroke. Use sparingly: one arrow at the **destination** end only.
* **Endpoint gap** — stop the stroke 4–8 px before the target card edge so the arrow sits in clear space.
* **Labels** — short path labels sit above the horizontal segment in the gutter, never on the card.

## SVG pattern

```xml
<defs>
  <marker id="arrowGray" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
    <path d="M0,0 L6,3 L0,6 Z" fill="#667085"/>
  </marker>
  <marker id="arrowBrand" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
    <path d="M0,0 L6,3 L0,6 Z" fill="#674EA7"/>
  </marker>
</defs>
<path d="M … H … V …" fill="none" stroke="#667085" stroke-width="1.5" marker-end="url(#arrowGray)"/>
```

---

# 19. Icons

Infrastructure

Official cloud icons

Applications

No icons

Service Cards

Icon always appears

Top-left

Next to title

Never centered.

---

# 20. Recommended Layer Order

```
External Users

↓

Internet

↓

Cloud Provider

↓

Region

↓

Availability Domains

↓

Network

↓

Subnets

↓

Kubernetes

↓

Applications

↓

Managed Services

↓

Disaster Recovery
```

---

# 21. Typical Customer Deployment

```
Customer Environment

OCI Region

    VCN

        Public Subnet

            Flexible LB

            Network LB

        Private Subnet

            OKE

                Node Pool (AD-1)

                Node Pool (AD-2)

            PostgreSQL

            Vault

Replication

↓

DR Region

    PostgreSQL Backup
```

---

# 22. Typical Abluva Deployment

```
Abluva SaaS

Portal

API

Controller

Policy Engine

AI Services

↓

Control Connection

↓

Customer Environment

↓

Kubernetes

↓

Applications
```

The brand-purple control connection immediately communicates:

"This is managed by Abluva."

---

# 23. Spacing

Sibling Cards

24–32 px

Major Containers

48–64 px

Regions

80 px

Whitespace is more valuable than decoration.

---

# 24. Style Checklist

✓ White canvas

✓ Thin borders

✓ Rounded corners (8–10 px)

✓ Inter typography

✓ Official cloud icons

✓ Icons in top-left headers

✓ Applications as simple cards

✓ Brand purple (`#674EA7`) reserved for Abluva

✓ Neutral gray for customer infrastructure

✓ Blue only for public networking

✓ Amber for third parties

✓ Dashed borders for disaster recovery

✓ Dashed lines for replication

✓ Red dashed lines for failover

✓ Gray solid lines for traffic

✓ Brand-purple solid lines for control / Fabric tunnel

✓ Orthogonal connectors in gutters (no card crossings)

✓ Small filled arrowheads at destination only

✓ Equal spacing throughout

✓ Minimal text

✓ Consistent hierarchy

✓ No gradients

✓ No shadows

✓ No visual clutter

---

# 25. Golden Rule

Every diagram should clearly separate:

* **Customer Environment**
* **Abluva Platform**
* **External Services**
* **Cloud Infrastructure**
* **Applications**
* **Data**
* **Disaster Recovery**

If someone can identify those seven concepts without reading documentation, the diagram has achieved its goal.
