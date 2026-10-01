# Optional local Platform Ambient
#
# Default `./smoke-k3d-tenant.sh` proves Gateway + Agent (A2/A3/A4/B2/B3-style).
# It does **not** install ztunnel: the platform side is docker-compose on the host.
#
# To exercise Ambient (A1 / B1 / ztunnel hops) you need a **Kubernetes** cluster
# as Platform (Mac or Linux/OCI — same scripts):
#
# ```bash
# k3d cluster create fabric-platform
# export KUBE_CONTEXT=k3d-fabric-platform
# ./deploy/local/k3d/ambient/smoke-ambient.sh
# ```
#
# Or step-by-step:
#
# ```bash
# ./deploy/local/k3d/ambient/install.sh   # wraps deploy/platform/ambient/install-ambient.sh
# ./deploy/platform/ambient/enroll-namespaces.sh 3407e407-792a-452d-8bb4-03c54ac34d52-5620f907-0281-497d-9098-8c
# ./deploy/platform/ambient/verify-ambient.sh
# ```
#
# `install-ambient.sh` is OS-portable: downloads `linux-{amd64,arm64}` or `osx-{amd64,arm64}`
# istioctl, and on k3s/k3d sets `cniConfDir` + `cniBinDir` so CNI actually becomes Ready.
#
# Production: always use `deploy/platform/ambient/` on the real Platform cluster
# (see Operational-Runbook Step 7). Never install Ambient on the tenant/Agent cluster.
