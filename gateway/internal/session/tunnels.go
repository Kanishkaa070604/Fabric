package session

import (
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/hashicorp/yamux"
)

// TunnelRegistry tracks live agent yamux sessions for CONNECT_AGENT outbound
// (A3/A4/B2 hairpin). Keyed by agent_id once known; also by cert fingerprint
// until control-plane resolves the agent.
//
// Remove/Put are session-identity safe: an older reconnect teardown cannot
// wipe a newer live session for the same cert/agent.
type TunnelRegistry struct {
	mu             sync.RWMutex
	byAgentID      map[string]*yamux.Session
	byCertFP       map[string]*yamux.Session
	agentForCert   map[string]string // cert_fp -> agent_id
	tenantForCert  map[string]string // cert_fp -> tenant_id
	tenantForAgent map[string]string
	openStreams    map[string]int // agent_id -> Gateway→Agent open stream count
	sessGen        map[*yamux.Session]uint64
	nextGen        uint64
}

func NewTunnelRegistry() *TunnelRegistry {
	return &TunnelRegistry{
		byAgentID:      map[string]*yamux.Session{},
		byCertFP:       map[string]*yamux.Session{},
		agentForCert:   map[string]string{},
		tenantForCert:  map[string]string{},
		tenantForAgent: map[string]string{},
		openStreams:    map[string]int{},
		sessGen:        map[*yamux.Session]uint64{},
	}
}

func (r *TunnelRegistry) Put(certFP, agentID, tenantID string, sess *yamux.Session) {
	var superseded []*yamux.Session
	r.mu.Lock()
	if sess != nil {
		if _, ok := r.sessGen[sess]; !ok {
			r.nextGen++
			r.sessGen[sess] = r.nextGen
		}
	}
	if certFP != "" {
		if cur, ok := r.byCertFP[certFP]; ok && cur != nil && cur != sess {
			superseded = append(superseded, cur)
		}
		r.byCertFP[certFP] = sess
		if agentID != "" {
			r.agentForCert[certFP] = agentID
		}
		if tenantID != "" {
			r.tenantForCert[certFP] = tenantID
		}
	}
	if agentID != "" {
		if cur, ok := r.byAgentID[agentID]; ok && cur != nil && cur != sess {
			superseded = append(superseded, cur)
		}
		r.byAgentID[agentID] = sess
		if tenantID != "" {
			r.tenantForAgent[agentID] = tenantID
		}
	}
	r.mu.Unlock()
	for _, old := range uniqueSessions(superseded) {
		_ = old.Close()
	}
}

// BindAgentID attaches an agent_id to an existing cert-keyed session
// (enroll/approve completed after the tunnel was already up).
func (r *TunnelRegistry) BindAgentID(certFP, agentID, tenantID string) {
	if certFP == "" || agentID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.agentForCert[certFP] = agentID
	if tenantID != "" {
		r.tenantForCert[certFP] = tenantID
		r.tenantForAgent[agentID] = tenantID
	}
	if sess, ok := r.byCertFP[certFP]; ok {
		r.byAgentID[agentID] = sess
	}
}

func (r *TunnelRegistry) Remove(certFP, agentID string, sess *yamux.Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if certFP != "" {
		if cur, ok := r.byCertFP[certFP]; ok && cur == sess {
			delete(r.byCertFP, certFP)
			delete(r.agentForCert, certFP)
			delete(r.tenantForCert, certFP)
		}
	}
	if agentID != "" {
		if cur, ok := r.byAgentID[agentID]; ok && cur == sess {
			delete(r.byAgentID, agentID)
			delete(r.tenantForAgent, agentID)
			delete(r.openStreams, agentID)
		}
	}
	delete(r.sessGen, sess)
}

func (r *TunnelRegistry) OpenStreamCount(agentID string) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.openStreams[agentID]
}

// CloseByCertFP force-closes the live yamux session for a revoked agent cert.
func (r *TunnelRegistry) CloseByCertFP(certFP string) bool {
	r.mu.RLock()
	sess := r.byCertFP[certFP]
	r.mu.RUnlock()
	if sess == nil {
		return false
	}
	_ = sess.Close()
	return true
}

// CloseByTenant force-closes all live tunnels for a suspended tenant.
func (r *TunnelRegistry) CloseByTenant(tenantID string) int {
	if tenantID == "" {
		return 0
	}
	r.mu.RLock()
	var sessions []*yamux.Session
	seen := map[*yamux.Session]struct{}{}
	for fp, tid := range r.tenantForCert {
		if tid != tenantID {
			continue
		}
		if sess := r.byCertFP[fp]; sess != nil {
			if _, ok := seen[sess]; !ok {
				seen[sess] = struct{}{}
				sessions = append(sessions, sess)
			}
		}
	}
	for aid, tid := range r.tenantForAgent {
		if tid != tenantID {
			continue
		}
		if sess := r.byAgentID[aid]; sess != nil {
			if _, ok := seen[sess]; !ok {
				seen[sess] = struct{}{}
				sessions = append(sessions, sess)
			}
		}
	}
	r.mu.RUnlock()
	for _, s := range sessions {
		_ = s.Close()
	}
	return len(sessions)
}

// Snapshot returns cert fingerprints and tenant ids for security reconcile.
func (r *TunnelRegistry) Snapshot() (certs []string, tenants []string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	seenT := map[string]struct{}{}
	for fp, tid := range r.tenantForCert {
		certs = append(certs, fp)
		if tid != "" {
			if _, ok := seenT[tid]; !ok {
				seenT[tid] = struct{}{}
				tenants = append(tenants, tid)
			}
		}
	}
	return certs, tenants
}

// DialAgent opens a yamux stream toward the selected agent (Gateway→Agent).
func (r *TunnelRegistry) DialAgent(_ context.Context, agentID string) (io.ReadWriteCloser, error) {
	r.mu.Lock()
	sess := r.byAgentID[agentID]
	if sess == nil {
		for fp, aid := range r.agentForCert {
			if aid == agentID {
				sess = r.byCertFP[fp]
				if sess != nil {
					r.byAgentID[agentID] = sess
				}
				break
			}
		}
	}
	if sess == nil {
		r.mu.Unlock()
		return nil, fmt.Errorf("tunnel_registry: no live tunnel for agent_id=%s", agentID)
	}
	// Hold generation so a Remove of this exact session can race safely with OpenStream.
	gen := r.sessGen[sess]
	r.openStreams[agentID]++
	r.mu.Unlock()

	st, err := sess.OpenStream()
	if err != nil {
		r.mu.Lock()
		// Only decrement if this session is still the registered one (or gen matches).
		if cur := r.byAgentID[agentID]; cur == sess || r.sessGen[sess] == gen {
			r.openStreams[agentID]--
			if r.openStreams[agentID] <= 0 {
				delete(r.openStreams, agentID)
			}
		}
		r.mu.Unlock()
		return nil, fmt.Errorf("tunnel_registry: open stream: %w", err)
	}
	return &countedStream{ReadWriteCloser: st, reg: r, agentID: agentID, sess: sess}, nil
}

type countedStream struct {
	io.ReadWriteCloser
	reg     *TunnelRegistry
	agentID string
	sess    *yamux.Session
	once    sync.Once
}

func (c *countedStream) Close() error {
	c.once.Do(func() {
		c.reg.mu.Lock()
		if cur := c.reg.byAgentID[c.agentID]; cur == c.sess || cur == nil {
			c.reg.openStreams[c.agentID]--
			if c.reg.openStreams[c.agentID] <= 0 {
				delete(c.reg.openStreams, c.agentID)
			}
		}
		c.reg.mu.Unlock()
	})
	return c.ReadWriteCloser.Close()
}

func uniqueSessions(in []*yamux.Session) []*yamux.Session {
	seen := map[*yamux.Session]struct{}{}
	var out []*yamux.Session
	for _, s := range in {
		if s == nil {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
