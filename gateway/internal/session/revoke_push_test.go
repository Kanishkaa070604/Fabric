package session_test

import (
	"log/slog"
	"testing"

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
