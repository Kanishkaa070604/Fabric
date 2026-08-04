# Platform / customer namespace conventions (source of truth for shell scripts).
# shellcheck disable=SC2034
FABRIC_CONTROL_NAMESPACE="${FABRIC_CONTROL_NAMESPACE:-fabric-control}"
SAAS_NAMESPACE="${SAAS_NAMESPACE:-3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c}"
AMBIENT_PLANE_NAMESPACE="${AMBIENT_PLANE_NAMESPACE:-ambient-plane}"
FABRIC_EDGE_NAMESPACE="${FABRIC_EDGE_NAMESPACE:-fabric-edge}"

# Legacy alias: NLB / Gateway scripts target the fabric (network) namespace.
FABRIC_NAMESPACE="${FABRIC_NAMESPACE:-$FABRIC_CONTROL_NAMESPACE}"
