package session_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/abluva/fabric/gateway/internal/session"
	"github.com/abluva/fabric/gateway/internal/store"
)

// nopCloser lets the test track close calls without a real net.Conn.
type nopCloser struct{ closed chan struct{} }

func newNopCloser() *nopCloser { return &nopCloser{closed: make(chan struct{})} }
func (c *nopCloser) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}
func (c *nopCloser) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// authzContextFixture mirrors store.authzContext's wire shape (that type is
// package-private, so the fixture is duplicated here deliberately).
type authzContextFixture struct {
	Registration       *regFixture `json:"registration"`
	TenantSuspended    bool        `json:"tenant_suspended"`
	TenantSuspendCause string      `json:"tenant_suspend_cause,omitempty"`
}

type regFixture struct {
	ID       string
	TenantID string
	State    string
}

// newAuthzFixtureServer serves /v1/internal/authz-context from an in-memory
// table keyed by "tenant_id|registration_id", so ReconcileRegistrationDrain
// can be exercised against a real *store.HTTPStore without a control-plane.
func newAuthzFixtureServer(t *testing.T, byKey map[string]authzContextFixture) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		key := q.Get("tenant_id") + "|" + q.Get("registration_id")
		fx, ok := byKey[key]
		if !ok {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(authzContextFixture{})
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(fx)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestReconcileRegistrationDrainClosesAfterGraceOnDeleting(t *testing.T) {
	srv := newAuthzFixtureServer(t, map[string]authzContextFixture{
		"tenant-1|reg-deleting": {Registration: &regFixture{ID: "reg-deleting", TenantID: "tenant-1", State: "Deleting"}},
		"tenant-1|reg-active":   {Registration: &regFixture{ID: "reg-active", TenantID: "tenant-1", State: "Active"}},
	})

	h := &session.Handler{
		Log:     slog.Default(),
		Store:   store.NewHTTPStore(srv.URL, ""),
		Tunnels: session.NewTunnelRegistry(),
		Streams: session.NewStreamRegistry(),
	}

	deleting := newNopCloser()
	active := newNopCloser()
	untrackDel := h.Streams.Track("tenant-1", "reg-deleting", deleting)
	untrackAct := h.Streams.Track("tenant-1", "reg-active", active)
	defer untrackDel()
	defer untrackAct()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go h.ReconcileRegistrationDrain(ctx, 20*time.Millisecond, 80*time.Millisecond)

	// Before the grace window elapses, nothing should be closed yet.
	time.Sleep(30 * time.Millisecond)
	if deleting.isClosed() {
		t.Fatal("stream for Deleting registration closed before grace window elapsed")
	}

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if deleting.isClosed() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !deleting.isClosed() {
		t.Fatal("expected stream for Deleting registration to be force-closed after grace window")
	}
	if active.isClosed() {
		t.Fatal("stream for unrelated Active registration must never be closed by the drain loop")
	}
}

func TestReconcileRegistrationDrainLeavesUpdatingAlone(t *testing.T) {
	srv := newAuthzFixtureServer(t, map[string]authzContextFixture{
		"tenant-2|reg-updating": {Registration: &regFixture{ID: "reg-updating", TenantID: "tenant-2", State: "Updating"}},
	})
	h := &session.Handler{
		Log:     slog.Default(),
		Store:   store.NewHTTPStore(srv.URL, ""),
		Tunnels: session.NewTunnelRegistry(),
		Streams: session.NewStreamRegistry(),
	}
	updating := newNopCloser()
	untrack := h.Streams.Track("tenant-2", "reg-updating", updating)
	defer untrack()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	go h.ReconcileRegistrationDrain(ctx, 20*time.Millisecond, 50*time.Millisecond)
	<-ctx.Done()
	time.Sleep(20 * time.Millisecond)

	if updating.isClosed() {
		t.Fatal("L2 §G.3 row 2: streams on an Updating registration must keep running on their pre-update config, never force-closed by this loop")
	}
}

func TestReconcileRegistrationDrainBillingSuspendDrainsThenCloses(t *testing.T) {
	srv := newAuthzFixtureServer(t, map[string]authzContextFixture{
		"tenant-3|": {TenantSuspended: true, TenantSuspendCause: "billing"},
	})
	tunnels := session.NewTunnelRegistry()
	yamuxSrv, _ := yamuxPair(t)
	tunnels.Put("fp-3", "agent-3", "tenant-3", yamuxSrv)

	h := &session.Handler{
		Log:     slog.Default(),
		Store:   store.NewHTTPStore(srv.URL, ""),
		Tunnels: tunnels,
		Streams: session.NewStreamRegistry(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go h.ReconcileRegistrationDrain(ctx, 20*time.Millisecond, 80*time.Millisecond)

	time.Sleep(30 * time.Millisecond)
	if yamuxSrv.IsClosed() {
		t.Fatal("billing-suspended tenant's tunnel closed before grace window elapsed")
	}

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if yamuxSrv.IsClosed() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !yamuxSrv.IsClosed() {
		t.Fatal("expected billing-suspended tenant's tunnel to be force-closed after grace window (L2 §G.3 row 3)")
	}
}
