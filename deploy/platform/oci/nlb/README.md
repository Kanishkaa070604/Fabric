# OCI Network Load Balancer for Fabric Gateway

Terraform and helper scripts for an OCI **Network Load Balancer** (L4 TCP,
PROXY protocol off) in front of Ghostunnel on port `:8443`.

Normative procedure: [`docs/Operational-Runbook.md`](../../../docs/Operational-Runbook.md)
→ **Day 0 Step 5b** (NodePort, NSG, DNS, validation). This directory holds
implementation artifacts; the Runbook is the operator source of truth.

## Scope

| In scope | Out of scope |
|---|---|
| NLB in public subnet targeting OKE worker NodePort `:8443` | Application / Flexible Load Balancer |
| Optional Terraform A record when `oci_dns_zone_ocid` is set | Terminating TLS on the NLB |
| Backend discovery via `collect-backend-values.sh` | Pointing `FABRIC_GATEWAY_PUSH_*` at the NLB (revoke stays in-cluster `:9090`) |

## Prerequisites

- OKE cluster with `fabric-gateway` deployed in **`fabric-control`** (network plane).
- Runbook Step 5b NSG rules: NLB → worker NodePort (required before agents dial).
- `terraform`, `kubectl`, and OCI credentials configured for the target tenancy.

## Layout

| Component | Namespace | Notes |
|---|---|---|
| `fabric-gateway` Service (NodePort) | `fabric-control` | Patched from ClusterIP before NLB apply |
| NLB VIP | Public subnet | Shared by Agent dial (`fabric.abluva.com`) and inbound DNS target |
| Control Plane | `3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c` (target) / `fabric-control` (current default) | CP namespace does not affect NLB backend selection |

## Procedure

1. Complete Runbook Step 5b through NodePort exposure and NSG validation.
2. Expose the Gateway Service and collect backend values:

```bash
kubectl -n fabric-control patch svc fabric-gateway --type='json' -p='[
  {"op":"replace","path":"/spec/type","value":"NodePort"}
]'
./collect-backend-values.sh
```

3. Configure Terraform:

```bash
cp terraform.tfvars.example terraform.tfvars
# Populate from Runbook Step 5b and collect-backend-values.sh output
terraform init && terraform plan && terraform apply
terraform output fabric_gateway_address
```

4. Create or verify DNS:
   - Set `oci_dns_zone_ocid` in tfvars for Terraform-managed A records, **or**
   - Create A records in Cloudflare / OCI DNS per Runbook Step 5b.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FABRIC_NAMESPACE` | `fabric-control` | Namespace of `fabric-gateway` Service for `collect-backend-values.sh` |

## Files

| Path | Role |
|---|---|
| `main.tf` | NLB, backend set, optional DNS record |
| `collect-backend-values.sh` | Emits worker IP / NodePort for tfvars |
| `terraform.tfvars.example` | Template inputs |

## Related documentation

- [`docs/Operational-Runbook.md`](../../../docs/Operational-Runbook.md) — Step 5b
- [`docs/diagrams/a-oci-platform.svg`](../../../docs/diagrams/a-oci-platform.svg) — A-OCI topology
