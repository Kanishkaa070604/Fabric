package quota

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// L2 §J.3: "Quota exhaustion returns RETRY_LATER (rate) or a specific
// UNAUTHORIZED/quota reason string for audit — never a silent drop."
// These sentinels let callers (authorize/session) pick the correct wire
// outcome without parsing error strings.
var (
	ErrRateExceeded       = errors.New("max_stream_open_per_sec exceeded")
	ErrConcurrentExceeded = errors.New("max_concurrent_streams exceeded")
)

// Limits are per-tenant caps from control-plane (ablv_tenant_connect).
type Limits struct {
	MaxTunnels           int
	MaxConcurrentStreams int
	MaxStreamOpenPerSec  int
}

// rateWindow is the sliding window TryOpenStream counts opens inside.
// SweepIdleOpens deletes any map entry whose newest timestamp is older
// than this — same cutoff TryOpenStream itself uses when pruning.
const rateWindow = time.Second

// Tracker enforces L3-GW-02 at the Gateway (source of truth for live usage).
type Tracker struct {
	mu      sync.Mutex
	tunnels map[string]int // tenant_id -> live yamux sessions
	streams map[string]int // tenant_id -> live data streams
	// rate: sliding 1s window of stream-open timestamps.
	// Entries are cleaned by SweepIdleOpens (and by TryOpenStream itself
	// when that tenant calls again) — without the sweep, a tenant that
	// opened at least one stream and then went quiet would leave a
	// permanent map entry for the Gateway process lifetime.
	opens map[string][]time.Time
}

func NewTracker() *Tracker {
	return &Tracker{
		tunnels: map[string]int{},
		streams: map[string]int{},
		opens:   map[string][]time.Time{},
	}
}

func (t *Tracker) TunnelCount(tenantID string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.tunnels[tenantID]
}

func (t *Tracker) StreamCount(tenantID string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.streams[tenantID]
}

// OpensEntryCount returns how many tenants currently have an opens-map
// entry. Test/observability only — not used on the hot path.
func (t *Tracker) OpensEntryCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.opens)
}

// TryAddTunnel reserves a tunnel slot. Call ReleaseTunnel when the session ends
// or if Put is aborted. Replacing an existing session for the same identity
// should ReleaseTunnel the old one first (registry handles close).
func (t *Tracker) TryAddTunnel(tenantID string, lim Limits) error {
	if tenantID == "" {
		return nil
	}
	max := lim.MaxTunnels
	if max <= 0 {
		max = 50
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tunnels[tenantID] >= max {
		return fmt.Errorf("max_tunnels exceeded (%d)", max)
	}
	t.tunnels[tenantID]++
	return nil
}

func (t *Tracker) ReleaseTunnel(tenantID string) {
	if tenantID == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.tunnels[tenantID]--
	if t.tunnels[tenantID] <= 0 {
		delete(t.tunnels, tenantID)
	}
}

// TryOpenStream reserves a concurrent stream + rate token. Caller must invoke
// the returned release exactly once when the stream ends (or on failure after reserve).
func (t *Tracker) TryOpenStream(tenantID string, lim Limits) (release func(), err error) {
	if tenantID == "" {
		return func() {}, nil
	}
	maxStreams := lim.MaxConcurrentStreams
	if maxStreams <= 0 {
		maxStreams = 2000
	}
	maxRate := lim.MaxStreamOpenPerSec
	if maxRate <= 0 {
		maxRate = 100
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()

	// Rate: count opens in the last 1s.
	cut := now.Add(-rateWindow)
	var kept []time.Time
	for _, ts := range t.opens[tenantID] {
		if ts.After(cut) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= maxRate {
		return nil, fmt.Errorf("%w (%d)", ErrRateExceeded, maxRate)
	}
	if t.streams[tenantID] >= maxStreams {
		return nil, fmt.Errorf("%w (%d)", ErrConcurrentExceeded, maxStreams)
	}
	// kept always gains `now` below, so this path never stores an empty
	// slice — the idle-tenant leak is that a tenant who never calls again
	// leaves its last (non-empty) entry sitting forever. SweepIdleOpens
	// is what deletes that; ReleaseTunnel / the stream releaser already
	// delete() their own maps on zero, which is the pattern this map
	// was missing.
	kept = append(kept, now)
	t.opens[tenantID] = kept
	t.streams[tenantID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			t.mu.Lock()
			t.streams[tenantID]--
			if t.streams[tenantID] <= 0 {
				delete(t.streams, tenantID)
			}
			t.mu.Unlock()
		})
	}, nil
}

// SweepIdleOpens deletes any opens-map entry whose newest timestamp is
// older than the rate window. Safe to call any time: a tenant still
// opening streams will have a fresh timestamp and be left alone; a
// tenant that went quiet (or was offboarded) loses its leftover entry
// within one sweep interval of its last open aging out. Returns how
// many entries were removed.
func (t *Tracker) SweepIdleOpens(now time.Time) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	cut := now.Add(-rateWindow)
	removed := 0
	for tenantID, stamps := range t.opens {
		hasFresh := false
		for _, ts := range stamps {
			if ts.After(cut) {
				hasFresh = true
				break
			}
		}
		if !hasFresh {
			delete(t.opens, tenantID)
			removed++
		}
	}
	return removed
}

// RunOpensSweep periodically calls SweepIdleOpens. every defaults to 30s
// if non-positive — far coarser than the 1s rate window (so we aren't
// competing with TryOpenStream's own per-call prune) but frequent enough
// that a Gateway up for months across tenant churn doesn't accumulate
// one opens entry per ever-seen tenant. Stops when ctx is cancelled.
func (t *Tracker) RunOpensSweep(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 30 * time.Second
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			t.SweepIdleOpens(time.Now())
		}
	}
}
