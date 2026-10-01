# OCI DNS webhook receiver

Small in-cluster service: CP reconciler webhook → OCI DNS
`PatchZoneRecords` for Platform→Customer inbound names (G-A3-1).

**Ops procedure (zone OCID, **IAM dynamic group**, wire CP):**  
[`docs/Operational-Runbook.md`](../../../docs/Operational-Runbook.md) →
**Day 0 Step 5c** and
[IAM dynamic group + policy](../../../docs/Operational-Runbook.md#iam-dynamic-group--policy-for-dns-webhook-step-5c).
This README is not a second ops guide.

## Quick commands (after reading Step 5c)

```bash
# Edit deployment.yaml: OCI_DNS_ZONE_ID, OCI_DNS_COMPARTMENT_ID, image
kubectl apply -f deployment.yaml
# CP env: FABRIC_DNS_PROVIDER=webhook, FABRIC_DNS_WEBHOOK_URL,
#         FABRIC_DNS_WEBHOOK_TOKEN, FABRIC_DNS_TARGET (see Runbook)
```

Build image from `Dockerfile` / `package.json` as needed. Token Secret:
prefer `deploy/platform/setup-day0.sh` (`fabric-dns-webhook-token`).

## Local dry-run

```bash
OCI_DNS_ZONE_ID=test OCI_DNS_COMPARTMENT_ID=test OCI_DNS_DRY_RUN=1 node server.js
```
