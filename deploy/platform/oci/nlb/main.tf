# L3-OPS-01 — OCI Network Load Balancer in front of Ghostunnel :8443.
#
# Hard rules (see docs/Operational-Runbook.md Step 5b):
#   - Network LB (L4), NOT Application LB
#   - PROXY protocol OFF (is_ppv2enabled = false) — Ghostunnel already emits PROXY tls-full
#   - Agents dial this VIP; CP revoke push stays in-cluster :9090

resource "oci_network_load_balancer_network_load_balancer" "fabric_gateway" {
  compartment_id = var.compartment_ocid
  display_name   = var.display_name
  subnet_id      = var.subnet_ocid
  is_private     = var.is_private

  # Preserve client source IP when the path allows it (helps audit; not required for mTLS).
  is_preserve_source_destination = false

  freeform_tags = var.freeform_tags
}

resource "oci_network_load_balancer_backend_set" "ghostunnel" {
  network_load_balancer_id = oci_network_load_balancer_network_load_balancer.fabric_gateway.id
  name                     = "ghostunnel-8443"
  policy                   = "FIVE_TUPLE"

  is_preserve_source = true

  health_checker {
    protocol = "TCP"
    # Must match the port NLB uses to reach Ghostunnel (NodePort or 8443 hostPort).
    port = var.health_check_port != null ? var.health_check_port : var.backend_port
    # Interval/retries are OCI defaults unless you need tighter failure detection.
  }
}

resource "oci_network_load_balancer_backend" "nodes" {
  for_each = toset(var.backend_ip_addresses)

  network_load_balancer_id = oci_network_load_balancer_network_load_balancer.fabric_gateway.id
  backend_set_name         = oci_network_load_balancer_backend_set.ghostunnel.name
  ip_address               = each.value
  port                     = var.backend_port
  is_backup                = false
  is_drain                 = false
  is_offline               = false
  weight                   = 1
}

resource "oci_network_load_balancer_listener" "mtls" {
  network_load_balancer_id = oci_network_load_balancer_network_load_balancer.fabric_gateway.id
  name                     = "agent-mtls"
  default_backend_set_name = oci_network_load_balancer_backend_set.ghostunnel.name
  port                     = var.listener_port
  protocol                 = "TCP"

  # CRITICAL: PROXY off. Ghostunnel already emits PROXY tls-full to the Gateway
  # Unix socket; a second PPv2 header from the NLB breaks dispatch.
  is_ppv2enabled = false
}

# ---------------------------------------------------------------------------
# Optional Platform→Customer inbound (A3/B4) — public :8444 → Gateway inbound.
# Do NOT put fabric-control-plane :8080 or revoke :9090 on this NLB.
# ---------------------------------------------------------------------------

resource "oci_network_load_balancer_backend_set" "inbound" {
  count = var.enable_inbound ? 1 : 0

  network_load_balancer_id = oci_network_load_balancer_network_load_balancer.fabric_gateway.id
  name                     = "inbound-8444"
  policy                   = "FIVE_TUPLE"

  is_preserve_source = true

  health_checker {
    protocol = "TCP"
    port     = var.inbound_health_check_port != null ? var.inbound_health_check_port : var.inbound_backend_port
  }
}

resource "oci_network_load_balancer_backend" "inbound_nodes" {
  for_each = var.enable_inbound ? toset(var.backend_ip_addresses) : toset([])

  network_load_balancer_id = oci_network_load_balancer_network_load_balancer.fabric_gateway.id
  backend_set_name         = oci_network_load_balancer_backend_set.inbound[0].name
  ip_address               = each.value
  port                     = var.inbound_backend_port
  is_backup                = false
  is_drain                 = false
  is_offline               = false
  weight                   = 1
}

resource "oci_network_load_balancer_listener" "inbound" {
  count = var.enable_inbound ? 1 : 0

  network_load_balancer_id = oci_network_load_balancer_network_load_balancer.fabric_gateway.id
  name                     = "inbound"
  default_backend_set_name = oci_network_load_balancer_backend_set.inbound[0].name
  port                     = var.inbound_listener_port
  protocol                 = "TCP"
  is_ppv2enabled           = false
}
