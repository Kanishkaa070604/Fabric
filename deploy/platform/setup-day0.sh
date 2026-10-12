# Folded into day0.sh. From the parent of this repo:
#   ./Fabric/deploy/platform/setup-day0.sh
set -euo pipefail
export SKIP_DEPLOY=1 SKIP_AMBIENT=1
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/day0.sh"
