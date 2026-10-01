# Connect Agent on ECS (L3-ACL-02)

## Status

- **Shipped now:** `security-group.example.json` — the network-ACL half of §14 item 1/7.
- **Still blocked:** the full `ecs-task-definition.json` (sidecar container spec + one
  published port per Active Registration) is deliberately **not** here yet. It waits on
  **L3-POC-ECS** (`docs/Level-3-Tickets.md` §D) — Fargate's idle-connection and
  task-recycle behavior against yamux keepalive must be observed directly before the
  task definition's port-publish pattern is written once and treated as final
  (L2-Design.docx §H.8/§J.1). Shipping the task definition before that PoC would risk
  hand-editing it later, which the Developer-Reference skeleton explicitly avoids.

## Prerequisite: same-tenant multi-instance identity (`L3-AGT-02`) — **Done**

Control-plane/Agent enrollment now supports **N Agent instances per
tenant** (multi-redeem bootstrap window + CSR-in-enroll → per-task leaf).
ECS still needs the idle/recycle PoC (`L3-POC-ECS`) before a full task
definition is treated as production-ready. Remember: each ECS task gets its
own Agent/tunnel, so set `max_tunnels` ≥ planned task count (default 50).

## Why ECS is not a port of the Kubernetes DaemonSet

This is a substrate-forced shape difference, not deferred packaging polish.

| | Kubernetes | ECS (`awsvpc`) |
|---|---|---|
| Shared network unit | Node (pods still distinct IPs / namespaces) | Task (all containers share one ENI / IP) |
| Agent placement | DaemonSet — one Agent per node | Sidecar — one Agent **per task** |
| How apps reach the Agent | Cluster Service + `internalTrafficPolicy: Local` | `127.0.0.1` inside the same task |
| Cost at N app instances | ~1 tunnel/cert per **node** | 1 tunnel/cert per **task** |

Two ECS tasks on the same EC2 instance do **not** share a network namespace the
way two pods on one Kubernetes node can route via a node-local Service. There
is no "one Agent per node, shared by many tasks" option under `awsvpc`. The
DaemonSet-plus-Service model therefore has no direct equivalent — the only
way to get an Agent network-adjacent to a customer container is the same-task
sidecar. That reopens the per-instance resource and certificate-lifecycle cost
the DaemonSet model was chosen to avoid on Kubernetes. Documented here and in
`Architecture-Resolutions.md` so nobody reasons from the K8s model alone and
assumes ECS scales the same way. This is also why a full task-definition
template is materially different work from `daemonset.yaml`, not a rename.

## What the security group encodes

Per Developer-Reference: "Connect Agent runs as a sidecar in the ECS task. Customer
workloads dial `127.0.0.1` ... on ports published by the task definition ... Security-group
templates in the install bundle must allow task-to-sidecar local dial and deny
cross-task dial to Agent ports."

On ECS `awsvpc` networking, all containers in one task share a network namespace and
ENI, so `127.0.0.1` dial between the app container and the Agent sidecar is already
unconditionally local — no security group can or needs to mediate it. What a security
group *can* enforce is the cross-task boundary: `security-group.example.json`'s ingress
rule is self-referencing (`SourceSecurityGroupId` = the group's own ID), so only ENIs
that are members of this same security group — i.e. this tenant's own tasks — may reach
the Agent's ports at all. Any other task, even in the same VPC/subnet, is denied by
default (no explicit allow = deny, standard SG semantics).

## Applying it

1. Create the security group, then replace `REPLACE_WITH_THIS_GROUPS_OWN_ID` with the
   group's own ID (self-reference) once AWS assigns it.
2. Attach the security group to the ECS service/task definition's network configuration.
3. Set `FromPort`/`ToPort` to match this tenant's actual `FABRIC_LISTEN_BASE_PORT` range
   (default base `9443`; one port per Active Registration).
4. Set the egress CIDR/prefix-list to the Gateway's address — outbound-only, per spec.
