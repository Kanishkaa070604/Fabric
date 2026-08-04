package watch

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/abluva/fabric/connect-agent/internal/k8ssvc"
	"github.com/abluva/fabric/connect-agent/internal/logging"
)

// registrationPortsAnnotation exposes the full registration-ID -> port
// mapping on the reconciled Service, so an operator/customer app can
// discover "which port is my registration on" via `kubectl get svc
// connect-agent -o jsonpath=...` or the Kubernetes API, instead of having
// to grep an Agent pod's logs for its listener_scheduled line. Named ports
// alone can't carry this: Kubernetes' IANA_SVC_NAME port-name format caps
// at 15 characters, too short to hold a full registration UUID.
const registrationPortsAnnotation = "fabric.abluva.io/registration-ports"

// ServiceConfig controls the optional in-cluster Service reconciler -- see
// Manager.ServiceCfg's doc comment for why this exists and why it must
// stay opt-in.
type ServiceConfig struct {
	Enabled   bool
	Name      string
	Namespace string
	// Selector must match this DaemonSet's own pod labels (e.g.
	// {"app": "connect-agent"}) -- it is NOT computed from anything this
	// process observes about itself, since a Service's selector has to
	// match across all of the DaemonSet's pods/nodes, not just this one.
	Selector map[string]string
}

// buildDesiredService computes the full desired Service spec from the
// Agent's own currently-assigned, stable ports (keyed by registration ID
// -- see syncListeners' "keep existing" comment for why these are sticky
// across ticks, not recomputed from scratch each time). Pure function, no
// I/O, so the actual K8s API call (reconcileService) stays a thin,
// separately-testable step on top of it.
func buildDesiredService(cfg ServiceConfig, ports map[string]int) k8ssvc.Service {
	ids := make([]string, 0, len(ports))
	for id := range ports {
		ids = append(ids, id)
	}
	sort.Strings(ids) // deterministic port ordering tick to tick

	svcPorts := make([]k8ssvc.ServicePort, 0, len(ids))
	regPorts := make(map[string]int, len(ids))
	usedNames := map[string]bool{}
	for _, id := range ids {
		p := ports[id]
		name := uniquePortName(id, usedNames)
		usedNames[name] = true
		svcPorts = append(svcPorts, k8ssvc.ServicePort{
			Name:       name,
			Protocol:   "TCP",
			Port:       int32(p),
			TargetPort: int32(p),
		})
		regPorts[id] = p
	}

	annotations := map[string]string{}
	if b, err := json.Marshal(regPorts); err == nil {
		annotations[registrationPortsAnnotation] = string(b)
	}

	return k8ssvc.Service{
		Metadata: k8ssvc.ObjectMeta{
			Name:        cfg.Name,
			Namespace:   cfg.Namespace,
			Labels:      map[string]string{"fabric.abluva.io/managed-by": "connect-agent"},
			Annotations: annotations,
		},
		Spec: k8ssvc.ServiceSpec{
			Type:     "ClusterIP",
			Selector: cfg.Selector,
			Ports:    svcPorts,
			// Required, not a nice-to-have (see the bug write-up's second
			// finding, "internalTrafficPolicy: Local is missing"): the
			// Agent is a DaemonSet with independently, stickily-assigned
			// ports per node -- the SAME registration ID can legitimately
			// map to a DIFFERENT physical port on two different nodes if
			// they observed registration add/remove churn in a different
			// order or timing (ports are "keep existing, assign lowest
			// free for new ones" per node, not a pure function of the
			// current registration set -- see syncListeners). Without
			// this, a plain Service can load-balance a connection to a
			// node whose port<->registration mapping doesn't match the
			// one the client actually intended, silently connecting to
			// the wrong destination instead of just being slower.
			InternalTrafficPolicy: "Local",
		},
	}
}

// uniquePortName derives a Kubernetes-legal named-port label (RFC 6335
// IANA_SVC_NAME: lowercase alphanumeric/'-', <=15 chars, must start/end
// alphanumeric) from a registration ID. Not meant to be human-reversible
// at a glance -- registrationPortsAnnotation carries the real mapping --
// just unique and stable for the same ID across ticks. Collisions are
// astronomically unlikely (would need two registration IDs sharing their
// first several characters after normalization) and fail loud: the
// Kubernetes API rejects a Service with duplicate port names, so a
// reconcile error surfaces immediately rather than silently misrouting.
func uniquePortName(registrationID string, used map[string]bool) string {
	var b strings.Builder
	for _, r := range strings.ToLower(registrationID) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	base := "r-" + b.String()
	if len(base) > 15 {
		base = base[:15]
	}
	base = strings.TrimRight(base, "-")
	if base == "" || base == "r" {
		base = "r-0"
	}
	name := base
	for n := 1; used[name]; n++ {
		suffix := "-" + strconv.Itoa(n)
		trimmed := base
		if len(trimmed)+len(suffix) > 15 {
			trimmed = trimmed[:15-len(suffix)]
		}
		name = trimmed + suffix
	}
	return name
}

// reconcileService pushes the current port assignments to the in-cluster
// Service, if Service management is enabled and its client initialized
// successfully (see Manager.Run). A failure here is logged and retried
// next tick, same as every other best-effort reconciliation loop in this
// codebase (DNS reconciler, probeAndReport) -- it never blocks or fails
// the Agent's actual tunnel/listener lifecycle.
func (m *Manager) reconcileService(ctx context.Context, ports map[string]int) {
	if m.k8sClient == nil {
		return
	}
	desired := buildDesiredService(m.ServiceCfg, ports)
	if err := m.k8sClient.EnsureService(ctx, m.ServiceCfg.Namespace, desired); err != nil {
		logging.Info(ctx, m.Log, "k8s_service_reconcile_failed", "error", err.Error())
		return
	}
	logging.Debug(ctx, m.Log, "k8s_service_reconciled",
		"service", m.ServiceCfg.Name,
		"namespace", m.ServiceCfg.Namespace,
		"port_count", len(ports),
	)
}

// portsSnapshot returns a defensive copy of the current registration ->
// port assignments, safe to read without holding m.mu afterward.
func (m *Manager) portsSnapshot() map[string]int {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]int, len(m.ports))
	for k, v := range m.ports {
		out[k] = v
	}
	return out
}
