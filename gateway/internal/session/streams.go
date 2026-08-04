package session

import (
	"io"
	"sync"
	"time"
)

// RegKey identifies one (tenant, registration) pair with live streams.
type RegKey struct {
	TenantID       string
	RegistrationID string
}

// StreamRegistry tracks individual live data-plane streams by the
// (tenant, registration) they were authorized against. This is deliberately
// finer-grained than TunnelRegistry (which tracks whole tunnels): L2 §G.3
// requires that a Deleting Registration's in-flight streams eventually drain
// on their own, without touching that same tenant's other, unrelated,
// still-Active registrations sharing the same tunnel. Closing a whole tunnel
// (TunnelRegistry.CloseByTenant/CloseByCertFP) is only spec-correct for the
// tenant-wide / cert-wide security cases — never for a single Registration.
type StreamRegistry struct {
	mu      sync.Mutex
	next    uint64
	streams map[uint64]*trackedStream
}

type trackedStream struct {
	tenantID       string
	registrationID string
	openedAt       time.Time
	closer         io.Closer
}

func NewStreamRegistry() *StreamRegistry {
	return &StreamRegistry{streams: map[uint64]*trackedStream{}}
}

// Track registers a live stream and returns an untrack func. Callers must
// call it exactly once when the stream ends on its own (normal completion),
// so it stops being a candidate for CloseByRegistration.
func (r *StreamRegistry) Track(tenantID, registrationID string, closer io.Closer) (untrack func()) {
	r.mu.Lock()
	id := r.next
	r.next++
	r.streams[id] = &trackedStream{
		tenantID:       tenantID,
		registrationID: registrationID,
		openedAt:       time.Now(),
		closer:         closer,
	}
	r.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			r.mu.Lock()
			delete(r.streams, id)
			r.mu.Unlock()
		})
	}
}

// CloseByRegistration force-closes every currently-tracked stream for one
// (tenant, registration) pair. Used once a non-routable registration's drain
// grace period elapses (L2 §G.3 row 1).
func (r *StreamRegistry) CloseByRegistration(tenantID, registrationID string) int {
	r.mu.Lock()
	var toClose []io.Closer
	for id, s := range r.streams {
		if s.tenantID == tenantID && s.registrationID == registrationID {
			toClose = append(toClose, s.closer)
			delete(r.streams, id)
		}
	}
	r.mu.Unlock()
	for _, c := range toClose {
		_ = c.Close()
	}
	return len(toClose)
}

// LiveRegistrations returns every distinct (tenant, registration) pair with
// at least one currently-open stream, for the drain-reconcile loop to scan.
func (r *StreamRegistry) LiveRegistrations() []RegKey {
	r.mu.Lock()
	defer r.mu.Unlock()
	seen := map[RegKey]struct{}{}
	var out []RegKey
	for _, s := range r.streams {
		if s.registrationID == "" {
			continue
		}
		k := RegKey{TenantID: s.tenantID, RegistrationID: s.registrationID}
		if _, ok := seen[k]; !ok {
			seen[k] = struct{}{}
			out = append(out, k)
		}
	}
	return out
}

// Count returns the number of currently-tracked streams (tests/observability).
func (r *StreamRegistry) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.streams)
}

// biCloser closes both sides of a relayed stream (the yamux stream back to
// the Agent/customer, and the destination connection) exactly once.
type biCloser struct{ a, b io.Closer }

func (c biCloser) Close() error {
	_ = c.a.Close()
	return c.b.Close()
}
