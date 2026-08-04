#!/usr/bin/env bash
# Generate a local CA, Gateway leaf, and Agent leaf(s) for Ghostunnel smoke.
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"
cd "$DIR"

ensure_agent2() {
  if [[ -f agent2.crt && -f agent2.key ]]; then
    return 0
  fi
  if [[ ! -f ca.crt || ! -f ca.key ]]; then
    echo "FAIL: need ca.crt/ca.key to mint agent2" >&2
    exit 1
  fi
  cat > agent2.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=DNS:connect-agent-2
EOF
  openssl req -newkey rsa:2048 -nodes -keyout agent2.key -out agent2.csr \
    -subj "/CN=connect-agent-2"
  openssl x509 -req -in agent2.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out agent2.crt -days 825 -sha256 -extfile agent2.ext
  rm -f agent2.csr agent2.ext
  chmod 644 agent2.crt
  chmod 600 agent2.key
  echo "wrote agent2 leaf"
  echo "agent2_cert_sha256=$(cert_sha256 agent2.crt)"
}

if [[ -f ca.crt && -f gateway.crt && -f agent.crt ]]; then
  echo "certs already present in $DIR (delete to regenerate)"
  ensure_agent2
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 \
  -subj "/CN=fabric-local-ca"

# Gateway leaf with SANs (Go TLS requires SAN; CN alone is not enough)
cat > gateway.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:fabric-gateway,DNS:localhost,DNS:host.k3d.internal,DNS:host.docker.internal,IP:127.0.0.1
EOF
openssl req -newkey rsa:2048 -nodes -keyout gateway.key -out gateway.csr \
  -subj "/CN=fabric-gateway"
openssl x509 -req -in gateway.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out gateway.crt -days 825 -sha256 -extfile gateway.ext

# Agent leaf (clientAuth)
cat > agent.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=DNS:connect-agent
EOF
openssl req -newkey rsa:2048 -nodes -keyout agent.key -out agent.csr \
  -subj "/CN=connect-agent"
openssl x509 -req -in agent.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out agent.crt -days 825 -sha256 -extfile agent.ext

rm -f gateway.csr agent.csr gateway.ext agent.ext
chmod 644 ca.crt gateway.crt agent.crt
chmod 600 ca.key gateway.key agent.key
echo "wrote CA + gateway + agent certs to $DIR"
echo "agent_cert_sha256=$(cert_sha256 agent.crt)"
ensure_agent2
