package watch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"sync"
	"time"

	"log/slog"

	"github.com/abluva/fabric/connect-agent/internal/k8ssvc"
	"github.com/abluva/fabric/connect-agent/internal/listener"
	"github.com/abluva/fabric/connect-agent/internal/logging"
	"github.com/abluva/fabric/connect-agent/internal/stream"
	"github.com/abluva/fabric/connect-agent/internal/tunnel"
)

// Registration is the control-plane public registration shape we need.
type Registration struct {
	ID               string `json:"id"`
	State            string `json:"state"`
	ConnectivityType string `json:"connectivity_type"`
	DestinationKind  string `json:"destination_kind"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	Generation       int64  `json:"generation"`
}

// Manager polls Active registrations and:
//   - opens local StreamOpen listeners for PLATFORM_* (A2/B3) and CUSTOMER_* (A4/B2 hairpin origins)
//   - probes CUSTOMER_* destinations and POSTs observed reachability (Agent selection, Spec §14 item 3 / L2 §G.1)
type Manager struct {
	Log              *slog.Logger
	ControlPlaneURL  string
	TenantID         string
	AgentID          string
	ListenBasePort   int // StreamOpen listeners: base, base+1, ... by sorted reg id
	ListenHost       string
	DisableListeners bool // smoke mode: StreamOpen listener owned elsewhere
	DisableProbes    bool // smoke mode: observed posted by test harness
	PollInterval     time.Duration
	ProbeTimeout     time.Duration
	EvidencePath     string
	// SetAuth attaches the Agent API bearer (G-CRED-1 cptoken Store).
	// main.go always sets this to apiTok.SetAuthHeader; nil (e.g. an
	// unconfigured test double) means requests go out with no
	// Authorization header at all, matching cptoken's own no-env-fallback
	// posture (SeedFromEnv / FABRIC_CONTROL_PLANE_TOKEN were removed there
	// for the same reason: one credential path, not two).
	SetAuth func(*http.Request)
	HTTPClient       *http.Client
	Session          func() *tunnel.Session // live yamux; may change across reconnects

	// ServiceCfg, if Enabled, reconciles an in-cluster Kubernetes Service
	// whose ports mirror this Agent's own per-registration listener ports
	// -- see service.go's doc comments and the "no Kubernetes Service
	// routing exists for more than one registration per tenant" bug
	// write-up for why this exists. Opt-in and off by default: it requires
	// RBAC (create/patch on Service in this namespace) the customer must
	// explicitly grant, same posture as the NetworkPolicy ACL templates
	// (L3-ACL-01) -- absence of either doesn't break the tunnel/StreamOpen
	// path, it only means the customer owns wiring routing/ACLs some other
	// way.
	ServiceCfg ServiceConfig

	mu        sync.Mutex
	listeners map[string]*listenerHandle // reg id -> handle
	ports     map[string]int             // reg id -> stable listen port
	k8sClient *k8ssvc.Client             // nil unless ServiceCfg.Enabled and in-cluster init succeeded
}

// listenerHandle pairs a listener's cancel func with a channel that's
// closed once its goroutine has actually returned (which only happens
// after its net.Listener is closed -- see listener.Serve's ctx.Done()
// handling). syncListeners waits on stopped before reassigning a freed
// registration's port to a new one in the same cycle: canceling a context
// only *starts* teardown, it doesn't complete it, so without this wait a
// same-cycle port reuse (a registration removed and another added in the
// same tick, or DestinationKind changing) could call net.Listen on a port
// the old socket hadn't released yet, transiently failing with "address
// already in use" until the old listener's ~1s retry-loop backoff cleared it.
type listenerHandle struct {
	cancel  context.CancelFunc
	stopped chan struct{}
}

func (m *Manager) Run(ctx context.Context) {
	if m.PollInterval <= 0 {
		m.PollInterval = 5 * time.Second
	}
	if m.ProbeTimeout <= 0 {
		m.ProbeTimeout = 2 * time.Second
	}
	if m.ListenHost == "" {
		m.ListenHost = "0.0.0.0"
	}
	if m.ListenBasePort <= 0 {
		m.ListenBasePort = 9443
	}
	if m.HTTPClient == nil {
		m.HTTPClient = &http.Client{Timeout: 10 * time.Second}
	}
	if m.listeners == nil {
		m.listeners = map[string]*listenerHandle{}
	}
	if m.ports == nil {
		m.ports = map[string]int{}
	}
	if m.ServiceCfg.Enabled {
		cl, err := k8ssvc.NewInClusterClient()
		if err != nil {
			logging.Info(ctx, m.Log, "k8s_service_management_disabled", "error", err.Error(),
				"note", "FABRIC_K8S_SERVICE_MANAGE_ENABLED=1 requires running in-cluster with a mounted ServiceAccount; tunnel/StreamOpen is unaffected")
		} else {
			m.k8sClient = cl
		}
	}

	t := time.NewTicker(m.PollInterval)
	defer t.Stop()
	m.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			m.stopAll()
			return
		case <-t.C:
			m.tick(ctx)
		}
	}
}

func (m *Manager) tick(ctx context.Context) {
	regs, err := m.fetch(ctx)
	if err != nil {
		logging.Info(ctx, m.Log, "registration_watch_failed", "error", err.Error())
		return
	}
	var listenRegs []Registration
	var customer []Registration
	for _, r := range regs {
		if r.State != "Active" {
			continue
		}
		switch r.DestinationKind {
		case "PLATFORM_SERVICE", "PLATFORM_RESOURCE":
			// A2 / B3: customer app dials Agent listener → StreamOpen → Gateway → platform.
			listenRegs = append(listenRegs, r)
		case "CUSTOMER_SERVICE", "CUSTOMER_RESOURCE":
			// A4 / B2: hairpin origin also needs a local listener (Spec §8.4 / §8.6).
			// Destination side is AgentDial on (possibly another) Agent after Gateway authz.
			listenRegs = append(listenRegs, r)
			customer = append(customer, r)
		}
	}
	sort.Slice(listenRegs, func(i, j int) bool { return listenRegs[i].ID < listenRegs[j].ID })
	if !m.DisableListeners {
		m.syncListeners(ctx, listenRegs)
		if m.k8sClient != nil {
			m.reconcileService(ctx, m.portsSnapshot())
		}
	}
	if !m.DisableProbes {
		for _, r := range customer {
			m.probeAndReport(ctx, r)
		}
	}
}

func (m *Manager) syncListeners(ctx context.Context, listenRegs []Registration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := map[string]Registration{}
	for _, r := range listenRegs {
		want[r.ID] = r
	}
	// Phase 1: cancel all removed listeners
	var removed []string
	for id, h := range m.listeners {
		if _, ok := want[id]; !ok {
			h.cancel()
			removed = append(removed, id)
		}
	}
	// Phase 2: wait for all to stop (bounded, concurrent — not sequential)
	deadline := time.After(2 * time.Second)
	for _, id := range removed {
		h := m.listeners[id]
		select {
		case <-h.stopped:
		case <-deadline:
			logging.Info(ctx, m.Log, "listener_stop_wait_timeout", "registration_id", id)
		}
		delete(m.listeners, id)
		delete(m.ports, id)
		logging.Info(ctx, m.Log, "listener_removed", "registration_id", id)
	}
	// Assign stable ports: keep existing; new regs get the lowest free port >= base.
	used := map[int]bool{}
	for _, p := range m.ports {
		used[p] = true
	}
	nextFree := func() int {
		p := m.ListenBasePort
		for used[p] {
			p++
		}
		used[p] = true
		return p
	}
	for _, r := range listenRegs {
		if _, ok := m.listeners[r.ID]; ok {
			continue
		}
		port := nextFree()
		m.ports[r.ID] = port
		addr := fmt.Sprintf("%s:%d", m.ListenHost, port)
		lctx, cancel := context.WithCancel(ctx)
		stopped := make(chan struct{})
		m.listeners[r.ID] = &listenerHandle{cancel: cancel, stopped: stopped}
		sessFn := m.Session
		go func(reg Registration, listenAddr string, c context.Context) {
			defer close(stopped)
			for {
				select {
				case <-c.Done():
					return
				default:
				}
				sess := sessFn()
				if sess == nil || sess.Yamux == nil {
					select {
					case <-c.Done():
						return
					case <-time.After(time.Second):
					}
					continue
				}
				err := listener.Serve(c, m.Log, sess, listener.Config{
					ListenAddr:       listenAddr,
					TenantID:         m.TenantID,
					RegistrationID:   reg.ID,
					ConnectivityType: stream.ConnectivityType(reg.ConnectivityType),
					EvidencePath:     m.EvidencePath,
				})
				if c.Err() != nil {
					return
				}
				if err != nil {
					logging.Info(c, m.Log, "listener_restart",
						"registration_id", reg.ID,
						"error", err.Error(),
					)
					select {
					case <-c.Done():
						return
					case <-time.After(time.Second):
					}
				}
			}
		}(r, addr, lctx)
		logging.Info(ctx, m.Log, "listener_scheduled",
			"registration_id", r.ID,
			"addr", addr,
			"destination_kind", r.DestinationKind,
		)
	}
}

func (m *Manager) stopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, h := range m.listeners {
		h.cancel()
		delete(m.listeners, id)
		delete(m.ports, id)
	}
}

func (m *Manager) probeAndReport(ctx context.Context, r Registration) {
	if m.AgentID == "" || r.Host == "" || r.Port == 0 {
		return
	}
	// L2 §G.1: reachable=true|false|unknown (timeout / inconclusive → unknown).
	reachable := "unknown"
	addr := fmt.Sprintf("%s:%d", r.Host, r.Port)
	d := net.Dialer{Timeout: m.ProbeTimeout}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err == nil {
		_ = c.Close()
		reachable = "true"
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		reachable = "unknown"
	} else if ctx.Err() != nil {
		reachable = "unknown"
	} else {
		reachable = "false"
	}
	body, _ := json.Marshal(map[string]any{
		"agent_id":            m.AgentID,
		"condition":           "Probe",
		"reachable":           reachable,
		"observed_generation": r.Generation,
	})
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		m.ControlPlaneURL+"/v1/registrations/"+r.ID+"/observed",
		bytes.NewReader(body),
	)
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ABLV-Actor", "agent")
	m.applyAuth(req)
	res, err := m.HTTPClient.Do(req)
	if err != nil {
		logging.Debug(ctx, m.Log, "observed_report_failed", "error", err.Error())
		return
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	logging.Debug(ctx, m.Log, "observed_reported",
		"registration_id", r.ID,
		"reachable", reachable,
	)
}

func (m *Manager) fetch(ctx context.Context) ([]Registration, error) {
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		m.ControlPlaneURL+"/v1/tenants/"+m.TenantID+"/registrations",
		nil,
	)
	if err != nil {
		return nil, err
	}
	m.applyAuth(req)
	res, err := m.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("list registrations status=%d body=%s", res.StatusCode, string(b))
	}
	var out struct {
		Registrations []Registration `json:"registrations"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Registrations, nil
}

func (m *Manager) applyAuth(req *http.Request) {
	// No FABRIC_CONTROL_PLANE_TOKEN env fallback: main.go always wires
	// SetAuth to apiTok.SetAuthHeader (the cptoken Store backing the
	// scoped Agent API bearer -- G-CRED-1). An env-var fallback here
	// would be a second, inconsistent credential path that cptoken
	// itself dropped when SeedFromEnv was removed; keeping a Manager-
	// local equivalent alive was the one place that inconsistency could
	// still creep back in (e.g. an operator setting the writer/CP env
	// var by accident and getting silently-scoped-wrong auth instead of
	// an obvious "no credential configured" failure).
	if m.SetAuth != nil {
		m.SetAuth(req)
	}
}
