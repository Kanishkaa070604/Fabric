variable "compartment_ocid" {
  type        = string
  description = "OCI compartment for the Network Load Balancer."
}

variable "subnet_ocid" {
  type        = string
  description = "Regional public (or customer-reachable) subnet OCID for the NLB."
}

variable "display_name" {
  type        = string
  default     = "fabric-gateway-nlb"
  description = "NLB display name."
}

variable "is_private" {
  type        = bool
  default     = false
  description = "false = public VIP (typical Agent dial). true = private NLB (VPN/peering only)."
}

variable "backend_ip_addresses" {
  type        = list(string)
  description = "Node IPs (or pod IPs if using hostNetwork) that expose Ghostunnel :8443. For OKE NodePort, use worker node IPs + node_port."
}

variable "backend_port" {
  type        = number
  default     = 8443
  description = "Backend port: Ghostunnel container port when using hostPort/hostNetwork, or the NodePort mapped to Service port 8443."
}

variable "listener_port" {
  type        = number
  default     = 8443
  description = "Public listener port Agents dial (FABRIC_GATEWAY_ADDRESS host:port)."
}

variable "health_check_port" {
  type        = number
  default     = null
  description = "TCP health check port on backends. Defaults to backend_port (correct for NodePort). Only override if you have a dedicated HC port."
}

variable "dns_hostname" {
  type        = string
  default     = ""
  description = "FQDN Agents dial (FABRIC_GATEWAY_ADDRESS host). Example: fabric.yourcompany.com. Emitted in outputs; optionally auto-A-recorded when oci_dns_zone_ocid is set."
}

variable "oci_dns_zone_ocid" {
  type        = string
  default     = ""
  description = "Optional. If set (with dns_hostname), Terraform creates an A record for dns_hostname → NLB VIP in this OCI DNS Zone. Leave empty if DNS is outside OCI (see Operational-Runbook Day 0 Step 5b)."
}

variable "oci_dns_compartment_ocid" {
  type        = string
  default     = ""
  description = "Compartment for the DNS rrset. Defaults to compartment_ocid when empty."
}

variable "oci_dns_record_ttl" {
  type        = number
  default     = 60
  description = "TTL seconds for the optional gateway A record."
}

variable "freeform_tags" {
  type        = map(string)
  default     = { component = "fabric-gateway", layer = "agent-front" }
  description = "Freeform tags on the NLB."
}
