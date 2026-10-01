package session

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/abluva/fabric/gateway/internal/logging"
)

// revokePushBody mirrors control-plane/src/gatewayPush.ts RevokePushBody.
type revokePushBody struct {
	TenantID        string `json:"tenant_id"`
	CertFingerprint string `json:"cert_fingerprint,omitempty"`
	Cause           string `json:"cause"`
	Kind            string `json:"kind"`
}

// ServeRevokePush runs the push half of L2 §D.3's revocation transport: an
// internal-only listener the control-plane calls immediately after a
// security-cause suspend/revoke commits, so the affected tunnel(s) close
// well before the next ReconcileSecurity poll tick. It is deliberately not
// the sole mechanism — ReconcileSecurity keeps polling regardless, so a
// missed or failed push (Gateway replica restarting, network blip) still
// self-heals within one poll interval.
//
// addr == "" disables the listener (poll-only revocation, as before).
//
// A non-empty addr requires a non-empty token. config.Load already rejects
// that combination at startup; this is the second gate so the listener cannot
// come up unauthenticated through any other call path.
func (h *Handler) ServeRevokePush(ctx context.Context, addr, token string) error {
	if addr == "" {
		return nil
	}
	if token == "" {
		return fmt.Errorf("revoke push listener %s requires a non-empty token", addr)
	}
	expected := []byte(token)
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/revoke", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		// Constant-time: a plain != on a secret leaks its prefix through
		// response timing, and this endpoint is reachable in-cluster.
		got := []byte(bearerToken(r))
		if subtle.ConstantTimeCompare(got, expected) != 1 {
			logging.Warn(ctx, h.Log, "revoke_push_unauthorized",
				"remote", r.RemoteAddr,
				// Whether a bearer was sent at all separates "misconfigured
				// caller" from "something is probing this port".
				"presented_token", len(got) > 0,
			)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body revokePushBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		h.handleRevokePush(ctx, body)
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{Addr: addr, Handler: mux}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	// No "auth" field: authentication is now unconditional, so logging whether
	// it is on would only ever print true.
	logging.Info(ctx, h.Log, "revoke_push_listening", "addr", addr)
	err := srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (h *Handler) handleRevokePush(ctx context.Context, body revokePushBody) {
	// Poll-only fallback (ReconcileSecurity) already treats a missing/non-"security"
	// cause as "do not force-close"; the push handler applies the same rule so the
	// two paths can never disagree.
	if body.Cause != "security" {
		return
	}
	switch body.Kind {
	case "cert_revoke":
		if body.CertFingerprint != "" && h.Tunnels.CloseByCertFP(body.CertFingerprint) {
			logging.Info(ctx, h.Log, "security_force_close_cert", "cert_fp", body.CertFingerprint, "tenant_id", body.TenantID, "cause", body.Cause, "via", "push")
		}
	case "tenant_suspend":
		if n := h.Tunnels.CloseByTenant(body.TenantID); n > 0 {
			logging.Info(ctx, h.Log, "security_force_close_tenant", "tenant_id", body.TenantID, "tunnels", n, "cause", body.Cause, "via", "push")
		}
	}
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && h[:len(prefix)] == prefix {
		return h[len(prefix):]
	}
	return ""
}
