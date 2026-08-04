package quota_test

import (
	"errors"
	"testing"

	"github.com/abluva/fabric/gateway/internal/quota"
)

func TestTunnelAndStreamQuotas(t *testing.T) {
	tr := quota.NewTracker()
	lim := quota.Limits{MaxTunnels: 1, MaxConcurrentStreams: 2, MaxStreamOpenPerSec: 100}
	if err := tr.TryAddTunnel("t1", lim); err != nil {
		t.Fatal(err)
	}
	if err := tr.TryAddTunnel("t1", lim); err == nil {
		t.Fatal("expected max_tunnels")
	}
	tr.ReleaseTunnel("t1")
	if err := tr.TryAddTunnel("t1", lim); err != nil {
		t.Fatal(err)
	}

	r1, err := tr.TryOpenStream("t1", lim)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := tr.TryOpenStream("t1", lim)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tr.TryOpenStream("t1", lim)
	if err == nil {
		t.Fatal("expected max_concurrent_streams")
	}
	// L2 §J.3: concurrent-stream exhaustion must be distinguishable from
	// rate exhaustion so callers can map to UNAUTHORIZED vs RETRY_LATER.
	if !errors.Is(err, quota.ErrConcurrentExceeded) {
		t.Fatalf("expected ErrConcurrentExceeded, got %v", err)
	}
	if errors.Is(err, quota.ErrRateExceeded) {
		t.Fatalf("did not expect ErrRateExceeded, got %v", err)
	}
	r1()
	r2()
}

func TestStreamOpenRate(t *testing.T) {
	tr := quota.NewTracker()
	lim := quota.Limits{MaxTunnels: 10, MaxConcurrentStreams: 100, MaxStreamOpenPerSec: 2}
	r1, err := tr.TryOpenStream("t", lim)
	if err != nil {
		t.Fatal(err)
	}
	defer r1()
	r2, err := tr.TryOpenStream("t", lim)
	if err != nil {
		t.Fatal(err)
	}
	defer r2()
	_, err = tr.TryOpenStream("t", lim)
	if err == nil {
		t.Fatal("expected rate limit")
	}
	if !errors.Is(err, quota.ErrRateExceeded) {
		t.Fatalf("expected ErrRateExceeded, got %v", err)
	}
}
