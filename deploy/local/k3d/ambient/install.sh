# Optional: install Platform Ambient into a k3d cluster used as *platform*.
# Default laptop smoke (docker-compose platform + k3d tenant) does NOT include
# ztunnel — compose has no node CNI for Ambient. Use this only when you have a
# Kubernetes cluster that plays the Platform role (A1/B1/A2-platform-side).
#
# Example:
#   k3d cluster create fabric-platform
#   export KUBE_CONTEXT=k3d-fabric-platform
#   ./deploy/local/k3d/ambient/install.sh
#   ./deploy/platform/ambient/enroll-namespaces.sh default
#   ./deploy/platform/ambient/verify-ambient.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
exec "$ROOT/deploy/platform/ambient/install-ambient.sh"
