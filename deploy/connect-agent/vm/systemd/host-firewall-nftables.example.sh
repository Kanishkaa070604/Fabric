#!/usr/bin/env bash
# L3-ACL-03: deny non-local dial to Connect Agent listen ports on a VM/bare-metal
# host. Developer-Reference: "Host-firewall templates in the install bundle
# must deny non-local dial to Agent ports. No inbound Internet port is
# required." Agent already binds 127.0.0.1 by default (see
# connect-agent.env.example); this is defense in depth in case that default
# is ever overridden.
#
# Usage: sudo ./host-firewall-nftables.example.sh [base_port] [port_count]
set -euo pipefail
BASE_PORT="${1:-9443}"
PORT_COUNT="${2:-16}"
END_PORT=$((BASE_PORT + PORT_COUNT - 1))

TABLE="ablv_connect_agent"
nft list table inet "$TABLE" >/dev/null 2>&1 && nft delete table inet "$TABLE"
nft add table inet "$TABLE"
nft add chain inet "$TABLE" input '{ type filter hook input priority 0; policy accept; }'
# Loopback traffic (the local app dialing the Agent) is always allowed.
nft add rule inet "$TABLE" input iif lo tcp dport "$BASE_PORT-$END_PORT" accept
# Any non-loopback dial to an Agent port is dropped.
nft add rule inet "$TABLE" input iif != lo tcp dport "$BASE_PORT-$END_PORT" drop

echo "Applied: only loopback may dial tcp/$BASE_PORT-$END_PORT (Connect Agent listeners)."
echo "Persist with your distro's nftables config (e.g. nft list ruleset > /etc/nftables.conf)."
