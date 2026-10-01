#!/usr/bin/env bash
# Optional VM install-bundle step (Developer-Reference): "The install
# artifact may write local name -> loopback mappings (e.g. /etc/hosts ...)
# so applications keep ordinary DNS names" instead of hardcoding 127.0.0.1
# and a port per Registration.
#
# Input: a mapping file, one "name" per line, produced by the install bundle
# from the tenant's Active Registrations (display_name -> local port is
# already tracked by the running Agent; this script only owns the /etc/hosts
# side, so it is safe to re-run any time the mapping changes).
#
# Usage: sudo ./hosts-writer.sh add   my-service.internal
#        sudo ./hosts-writer.sh remove my-service.internal
#        sudo ./hosts-writer.sh list
set -euo pipefail
MARKER_BEGIN="# BEGIN ablv-connect-agent (managed — do not hand-edit within this block)"
MARKER_END="# END ablv-connect-agent"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"

ensure_block() {
  grep -qF "$MARKER_BEGIN" "$HOSTS_FILE" || {
    { echo "$MARKER_BEGIN"; echo "$MARKER_END"; } >>"$HOSTS_FILE"
  }
}

case "${1:-}" in
  add)
    name="${2:?usage: hosts-writer.sh add <name>}"
    ensure_block
    grep -qF " $name" "$HOSTS_FILE" && { echo "already present: $name"; exit 0; }
    tmp=$(mktemp)
    awk -v name="$name" -v marker="$MARKER_END" \
      '{print} $0==marker && !done {print "127.0.0.1\t" name; done=1}' \
      "$HOSTS_FILE" >"$tmp"
    mv "$tmp" "$HOSTS_FILE"
    echo "added: 127.0.0.1 $name"
    ;;
  remove)
    name="${2:?usage: hosts-writer.sh remove <name>}"
    sed -i.bak "/^127\.0\.0\.1[[:space:]]\+$name\$/d" "$HOSTS_FILE"
    echo "removed: $name"
    ;;
  list)
    awk "/$MARKER_BEGIN/,/$MARKER_END/" "$HOSTS_FILE"
    ;;
  *)
    echo "usage: $0 {add|remove|list} [name]" >&2
    exit 1
    ;;
esac
