output "nlb_ocid" {
  value       = oci_network_load_balancer_network_load_balancer.fabric_gateway.id
  description = "Network Load Balancer OCID."
}

output "nlb_ip_addresses" {
  value       = oci_network_load_balancer_network_load_balancer.fabric_gateway.ip_addresses
  description = "VIP(s). Point DNS (var.dns_hostname) at the public IP."
}

locals {
  nlb_ip = try(
    [
      for a in oci_network_load_balancer_network_load_balancer.fabric_gateway.ip_addresses : a.ip_address
      if lookup(a, "is_public", true)
    ][0],
    try(oci_network_load_balancer_network_load_balancer.fabric_gateway.ip_addresses[0].ip_address, "PENDING")
  )
  gateway_host = var.dns_hostname != "" ? var.dns_hostname : local.nlb_ip
}

output "fabric_gateway_address" {
  value       = format("%s:%d", local.gateway_host, var.listener_port)
  description = "Public Gateway dial target for FABRIC_GATEWAY_ADDRESS (host:port). Example host: fabric.abluva.com."
}

# Alias kept for older snippets / scripts.
output "fabric_gateway_address" {
  value       = format("%s:%d", local.gateway_host, var.listener_port)
  description = "Alias of fabric_gateway_address (same value)."
}

output "agent_snippet_hint" {
  value = <<-EOT
    # After DNS for ${local.gateway_host} propagates (if using dns_hostname):
    # 1) Tenant install (UI snippet + deploy/connect-agent/tenant-start.env):
    #      FABRIC_GATEWAY_ADDRESS=${local.gateway_host}:${var.listener_port}
    # 2) NO_PROXY must include that hostname (tenant-start.sh does this).
    # 3) Do NOT point FABRIC_GATEWAY_PUSH_* at this NLB — keep in-cluster :9090.
    # 4) Verify from outside the cluster:
    #      openssl s_client -connect ${local.gateway_host}:${var.listener_port} -servername ${local.gateway_host} </dev/null
  EOT
}
