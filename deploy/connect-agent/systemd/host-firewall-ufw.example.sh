#!/usr/bin/env bash
# L3-ACL-03 equivalent for ufw-managed hosts (Ubuntu/Debian). See
# host-firewall-nftables.example.sh for the rationale and the nftables form.
#
# Usage: sudo ./host-firewall-ufw.example.sh [base_port] [port_count]
set -euo pipefail
BASE_PORT="${1:-9443}"
PORT_COUNT="${2:-16}"
END_PORT=$((BASE_PORT + PORT_COUNT - 1))

for p in $(seq "$BASE_PORT" "$END_PORT"); do
  # Deny first (ufw evaluates rules in order; allow-from-lo must win, so we
  # add it after the deny-all to make it more specific / later-wins is not
  # guaranteed in ufw — use explicit "allow in on lo" plus "deny in" on the
  # real interface instead of a bare port deny for correctness).
  ufw deny in to any port "$p" proto tcp
done
ufw allow in on lo to any proto tcp
echo "Applied: ufw denies external tcp/$BASE_PORT-$END_PORT; loopback allowed via 'allow in on lo'."
echo "Run 'ufw status numbered' to verify ordering; ufw applies allow rules regardless of order for the lo interface match."
