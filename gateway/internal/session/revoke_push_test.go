package session_test

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/abluva/fabric/gateway/internal/session"
)

// exportedRevokePush lets the black-box test package drive the same code
// path ServeRevokePush's HTTP handler calls, without standing up a listener.
func exportedRevokePush(h *session.Handler, tenantID, certFP, cause, kind string) {
	session.HandleRevokePushForTest(h, tenantID, certFP, cause, kind)
}

func TestHandleRevokePushForceClosesOnlyOnSecurityCause(t *testing.T) {
	srv, _ := yamuxPair(t)
	reg := session.NewTunnelRegistry()
	reg.Put("fp1", "agent-1", "tenant-1", srv)

	h := &session.Handler{Log: slog.Default(), Tunnels: reg}

	// Decommission cause must NOT force-close (L2 §D.3 drains instead).
	exportedRevokePush(h, "tenant-1", "fp1", "decommission", "cert_revoke")
	if srv.IsClosed() {
		t.Fatal("expected tunnel still live after decommission-cause push (no force-close)")
	}

	// Security cause force-closes immediately.
	srv2, _ := yamuxPair(t)
	reg.Put("fp2", "agent-2", "tenant-2", srv2)
	exportedRevokePush(h, "tenant-2", "fp2", "security", "cert_revoke")
	if !srv2.IsClosed() {
		t.Fatal("expected tunnel force-closed by security-cause push")
	}
}

func TestHandleRevokePushTenantSuspend(t *testing.T) {
	srv, _ := yamuxPair(t)
	reg := session.NewTunnelRegistry()
	reg.Put("fp3", "agent-3", "tenant-3", srv)
	h := &session.Handler{Log: slog.Default(), Tunnels: reg}

	// Billing suspend must drain, not force-close.
	exportedRevokePush(h, "tenant-3", "", "billing", "tenant_suspend")
	if srv.IsClosed() {
		t.Fatal("expected tunnel still live after billing-cause push")
	}
}

// The revoke listener force-closes tunnels, so anything that can reach it can
// disconnect a tenant. It must never come up without authentication: config
// rejects the half-configured pair at startup (see config package tests), and
// ServeRevokePush refuses as a second gate for any other call path.
func TestServeRevokePushRefusesEmptyToken(t *testing.T) {
	h := &session.Handler{Log: slog.Default(), Tunnels: session.NewTunnelRegistry()}

	if err := h.ServeRevokePush(context.Background(), "127.0.0.1:0", ""); err == nil {
		t.Fatal("expected ServeRevokePush to refuse a listener with no token")
	}

	// addr == "" is the supported way to disable push entirely (poll-only
	// revocation via ReconcileSecurity), and must stay a clean no-op.
	if err := h.ServeRevokePush(context.Background(), "", ""); err != nil {
		t.Fatalf("empty addr should disable the listener without error, got %v", err)
	}
}

func TestRevokePushRequiresMatchingBearer(t *testing.T) {
	srv, _ := yamuxPair(t)
	reg := session.NewTunnelRegistry()
	reg.Put("fp-auth", "agent-auth", "tenant-auth", srv)
	h := &session.Handler{Log: slog.Default(), Tunnels: reg}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = h.ServeRevokePush(ctx, addr, "right-token") }()

	url := "http://" + addr + "/internal/revoke"
	body := `{"tenant_id":"tenant-auth","cert_fingerprint":"fp-auth","cause":"security","kind":"cert_revoke"}`

	// Wait for the listener to accept connections.
	var ready bool
	for i := 0; i < 50; i++ {
		c, derr := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if derr == nil {
			_ = c.Close()
			ready = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("revoke push listener never came up")
	}

	post := func(token string) int {
		req, rerr := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
		if rerr != nil {
			t.Fatal(rerr)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, perr := http.DefaultClient.Do(req)
		if perr != nil {
			t.Fatal(perr)
		}
		defer res.Body.Close()
		return res.StatusCode
	}

	if got := post(""); got != http.StatusUnauthorized {
		t.Fatalf("no bearer: want 401, got %d", got)
	}
	if got := post("wrong-token"); got != http.StatusUnauthorized {
		t.Fatalf("wrong bearer: want 401, got %d", got)
	}
	if srv.IsClosed() {
		t.Fatal("unauthenticated push must not have closed the tunnel")
	}

	if got := post("right-token"); got != http.StatusOK {
		t.Fatalf("correct bearer: want 200, got %d", got)
	}
	if !srv.IsClosed() {
		t.Fatal("authenticated security-cause push should have force-closed the tunnel")
	}
}
