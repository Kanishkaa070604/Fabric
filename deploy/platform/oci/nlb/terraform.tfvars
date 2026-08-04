# OCI NLB for Fabric Gateway — fabric.abluva.com

compartment_ocid = "ocid1.tenancy.oc1..aaaaaaaazrqdvyighgi6vt34gjvgur7dylkhwisomxehsy3hhprr5omslmaq"
subnet_ocid = "ocid1.subnet.oc1.phx.aaaaaaaac2mxvu4wn6ybuhpbq4s6nv7r25a3jdi7zlgqs6lcjhf4nqhbabea"

backend_ip_addresses = [
  "10.0.11.114",
  "10.0.11.222",
]
backend_port  = 31697
listener_port = 8443

dns_hostname = "fabric.abluva.com"

is_private = false
