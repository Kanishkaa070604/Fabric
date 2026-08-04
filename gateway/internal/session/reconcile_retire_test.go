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

// retireFixtureServer serves both /v1/internal/agent-by-cert (used by
// lookupAgentByCert / lookupAgentByCertAny) and /v1/internal/authz-context
// (used by Store.AgentApproval / IsRevoked / CertRevokeCause) from an
// in-memory table keyed by cert fingerprint, so ReconcileSecurity's
// Retired-agent check can be exercised against a real *store.HTTPStore
// without a control-plane.
//
// Deliberately mirrors the real control-plane's exclusion (memory.ts /
// sequelize.ts findAgentByCertFingerprint): a Retired agent 404s on the
// plain lookup and is only resolvable with include_retired=1, exactly like
// the real server.ts handler. An earlier version of this fixture ignored
// state/include_retired entirely and always returned 200 -- which meant this
// test kept passing even while the real code path was dead (the real CP
// lookup filtered Retired agents out, so ReconcileSecurity could never find
// one to force-close). Getting this fixture wrong is exactly how that gap
// went undetected by unit tests; only a live run against the real store
// surfaced it.
func retireFixtureServer(t *testing.T, byCertFP map[string]struct {
	AgentID    string
	TenantID   string
	AgentState string
}) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fp := r.URL.Query().Get("cert_fingerprint")
		includeRetired := r.URL.Query().Get("include_retired") == "1"
		fx, ok := byCertFP[fp]
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/internal/agent-by-cert":
			if !ok || (fx.AgentState == "Retired" && !includeRetired) {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"agent_id":  fx.AgentID,
				"tenant_id": fx.TenantID,
				"state":     fx.AgentState,
			})
		case "/v1/internal/authz-context":
			w.WriteHeader(http.StatusOK)
			if !ok {
				_ = json.NewEncoder(w).Encode(map[string]any{})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_approved": fx.AgentState == "Connected" || fx.AgentState == "Degraded",
				"agent_state":    fx.AgentState,
			})
		default:
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// L2 §A.3: Retired is terminal with no recovery path. A Retired agent's live
// yamux session must be force-closed by ReconcileSecurity's poll, not merely
// excluded from future eligible-agent selection -- otherwise a decommissioned
// agent could keep an open tunnel (and keep being dialed via a stale
// TunnelRegistry entry) indefinitely after an admin retires it.
func TestReconcileSecurityForceClosesRetiredAgentTunnel(t *testing.T) {
	srv := retireFixtureServer(t, map[string]struct {
		AgentID    string
		TenantID   string
		AgentState string
	}{
		"fp-retired":   {AgentID: "agent-retired", TenantID: "tenant-1", AgentState: "Retired"},
		"fp-connected": {AgentID: "agent-connected", TenantID: "tenant-1", AgentState: "Connected"},
	})

	tunnels := session.NewTunnelRegistry()
	retiredSess, _ := yamuxPair(t)
	connectedSess, _ := yamuxPair(t)
	tunnels.Put("fp-retired", "agent-retired", "tenant-1", retiredSess)
	tunnels.Put("fp-connected", "agent-connected", "tenant-1", connectedSess)

	h := &session.Handler{
		Log:        slog.Default(),
		Store:      store.NewHTTPStore(srv.URL, ""),
		Tunnels:    tunnels,
		Streams:    session.NewStreamRegistry(),
		CPURL:      srv.URL,
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go h.ReconcileSecurity(ctx, 20*time.Millisecond)

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if retiredSess.IsClosed() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !retiredSess.IsClosed() {
		t.Fatal("expected Retired agent's tunnel to be force-closed by ReconcileSecurity")
	}
	if connectedSess.IsClosed() {
		t.Fatal("Connected agent's tunnel must never be force-closed by the Retired check")
	}
}
