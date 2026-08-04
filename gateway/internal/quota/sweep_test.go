package quota

import (
	"testing"
	"time"
)

// A tenant that opens a stream and then goes quiet must not leave a
// permanent opens-map entry for the Gateway process lifetime — that was
// the slow unbounded growth relative to cumulative distinct tenants.
// Seeded directly (package-internal) so we don't depend on sleeping past
// the real 1s rate window.
func TestSweepIdleOpensRemovesQuietTenants(t *testing.T) {
	tr := NewTracker()
	past := time.Now().Add(-2 * time.Second)
	tr.mu.Lock()
	tr.opens["churned-tenant"] = []time.Time{past}
	tr.mu.Unlock()

	if n := tr.OpensEntryCount(); n != 1 {
		t.Fatalf("seeded OpensEntryCount=%d, want 1", n)
	}

	// Sweep at "now" where past is outside the window → entry gone.
	if removed := tr.SweepIdleOpens(time.Now()); removed != 1 {
		t.Fatalf("sweep after window removed %d, want 1", removed)
	}
	if n := tr.OpensEntryCount(); n != 0 {
		t.Fatalf("after sweep OpensEntryCount=%d, want 0", n)
	}
}

func TestSweepIdleOpensLeavesFreshEntries(t *testing.T) {
	tr := NewTracker()
	now := time.Now()
	tr.mu.Lock()
	tr.opens["idle"] = []time.Time{now.Add(-2 * time.Second)}
	tr.opens["active"] = []time.Time{now.Add(-100 * time.Millisecond)}
	tr.mu.Unlock()

	removed := tr.SweepIdleOpens(now)
	if removed != 1 {
		t.Fatalf("removed %d, want 1 (only idle)", removed)
	}
	if n := tr.OpensEntryCount(); n != 1 {
		t.Fatalf("OpensEntryCount=%d, want 1 (active remains)", n)
	}

	// Inside the window, a just-opened tenant must not be swept — that
	// would break rate limiting for a still-active burst.
	if removed := tr.SweepIdleOpens(now); removed != 0 {
		t.Fatalf("second sweep inside window removed %d, want 0", removed)
	}
}

func TestSweepIdleOpensEmptyMap(t *testing.T) {
	tr := NewTracker()
	if removed := tr.SweepIdleOpens(time.Now()); removed != 0 {
		t.Fatalf("empty map removed %d, want 0", removed)
	}
}
