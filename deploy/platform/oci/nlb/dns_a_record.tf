# Optional: create/update an A record for var.dns_hostname → NLB public VIP
# inside an existing OCI DNS Zone. Enable by setting oci_dns_zone_ocid
# (and usually oci_dns_compartment_ocid) in terraform.tfvars.
#
# If your Agent gateway hostname is NOT in OCI DNS (Cloudflare, Route53,
# corporate DNS), leave these variables empty and create the A record
# manually — see docs/Operational-Runbook.md Day 0 Step 5b.

resource "oci_dns_rrset" "gateway_a" {
  count = var.oci_dns_zone_ocid != "" && var.dns_hostname != "" ? 1 : 0

  zone_name_or_id = var.oci_dns_zone_ocid
  domain          = var.dns_hostname
  rtype           = "A"
  compartment_id  = coalesce(var.oci_dns_compartment_ocid, var.compartment_ocid)

  items {
    domain = var.dns_hostname
    rtype  = "A"
    ttl    = var.oci_dns_record_ttl
    rdata  = local.nlb_ip
  }

  depends_on = [
    oci_network_load_balancer_network_load_balancer.fabric_gateway,
    oci_network_load_balancer_listener.mtls,
  ]
}

output "oci_dns_a_record" {
  value = var.oci_dns_zone_ocid != "" && var.dns_hostname != "" ? {
    zone_ocid = var.oci_dns_zone_ocid
    domain    = var.dns_hostname
    rdata     = local.nlb_ip
    ttl       = var.oci_dns_record_ttl
  } : null
  description = "A record created when oci_dns_zone_ocid is set; null if DNS is external."
}
