#!/usr/bin/env bash
# ============================================================
# Secrets-only wrapper around day0.sh
#
# Full platform Day 0 (Fabric + infra-api):
#   ./day-0.sh                    # from workspace ROOT
#
# Fabric-only full Day 0 (PKI + Secrets + deploy + Ambient):
#   ./day0.sh                     # this directory
#
# This file (secrets only — no deploy, no Ambient):
#   ./setup-day0.sh
#   → SKIP_DEPLOY=1 SKIP_AMBIENT=1 ./day0.sh
# ============================================================
set -euo pipefail
export SKIP_DEPLOY=1 SKIP_AMBIENT=1
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/day0.sh"
