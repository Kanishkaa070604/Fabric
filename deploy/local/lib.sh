#!/usr/bin/env bash
# Shared helpers for deploy/local and deploy/platform scripts.
# Portable across macOS and Linux (incl. OCI aarch64). Source me; do not exec.

# SHA-256 of a cert's DER encoding (Agent fingerprint used by enroll / Gateway).
# Prefer openssl+sha256sum (Linux); fall back to shasum -a 256 (macOS).
cert_sha256() {
  local cert="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    openssl x509 -in "$cert" -outform DER | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    openssl x509 -in "$cert" -outform DER | shasum -a 256 | awk '{print $1}'
  else
    echo "cert_sha256: need sha256sum or shasum" >&2
    return 1
  fi
}

# Hostname a container/pod on this machine uses to reach published host ports
# (compose :18080/:18443, host echo servers, etc.).
#
# Priority:
#   1. FABRIC_HOST_GATEWAY env (operator override — use on unusual networks)
#   2. host.docker.internal (Docker Desktop; Docker Engine with host-gateway)
#   3. host.k3d.internal (k3d injects this into cluster CoreDNS)
#   4. 172.17.0.1 (common Linux docker0 bridge gateway — last resort)
mesh_host_gateway() {
  if [[ -n "${FABRIC_HOST_GATEWAY:-}" ]]; then
    printf '%s' "$FABRIC_HOST_GATEWAY"
    return
  fi
  # Prefer names that work both from k3d pods and from compose containers.
  if getent hosts host.docker.internal >/dev/null 2>&1 \
    || host host.docker.internal >/dev/null 2>&1 \
    || ping -c1 -W1 host.docker.internal >/dev/null 2>&1; then
    printf '%s' "host.docker.internal"
    return
  fi
  if getent hosts host.k3d.internal >/dev/null 2>&1 \
    || host host.k3d.internal >/dev/null 2>&1; then
    printf '%s' "host.k3d.internal"
    return
  fi
  # Linux Docker Engine without host.docker.internal: docker0 gateway.
  if [[ -r /proc/net/route ]]; then
    local gw
    gw=$(awk '$2=="00000000" && $1=="docker0" {printf "%d.%d.%d.%d\n","0x"substr($3,7,2),"0x"substr($3,5,2),"0x"substr($3,3,2),"0x"substr($3,1,2); exit}' /proc/net/route 2>/dev/null || true)
    if [[ -n "$gw" ]]; then
      printf '%s' "$gw"
      return
    fi
  fi
  # Default: Docker Desktop / compose host-gateway alias (also set on gateway service).
  printf '%s' "host.docker.internal"
}
