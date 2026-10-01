package config_test

import (
	"strings"
	"testing"

	"github.com/abluva/fabric/gateway/internal/config"
)

// The revoke listener can force-close a tenant's tunnels, so a half-configured
// pair (listener on, no token) must stop the process rather than quietly expose
// an unauthenticated endpoint. Startup is the right place: it happens before the
// listener binds, and it is louder than a warning in a log nobody tails.
func TestLoadRejectsRevokePushListenerWithoutToken(t *testing.T) {
	t.Setenv("FABRIC_REVOKE_PUSH_LISTEN", "0.0.0.0:9090")
	t.Setenv("FABRIC_REVOKE_PUSH_TOKEN", "")

	_, err := config.Load()
	if err == nil {
		t.Fatal("expected Load to reject a revoke listener with no token")
	}
	// The message has to name both variables: an operator reading only the
	// error should know what to set without opening the source.
	for _, want := range []string{"FABRIC_REVOKE_PUSH_LISTEN", "FABRIC_REVOKE_PUSH_TOKEN"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %s, got: %v", want, err)
		}
	}
}

func TestLoadAcceptsRevokePushListenerWithToken(t *testing.T) {
	t.Setenv("FABRIC_REVOKE_PUSH_LISTEN", "0.0.0.0:9090")
	t.Setenv("FABRIC_REVOKE_PUSH_TOKEN", "a-token")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.RevokePushListen != "0.0.0.0:9090" || cfg.RevokePushToken != "a-token" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

// Poll-only revocation stays fully supported: ReconcileSecurity is the reliable
// path and push is only a latency optimisation, so no listener means no token
// requirement.
func TestLoadAllowsPollOnlyRevocation(t *testing.T) {
	t.Setenv("FABRIC_REVOKE_PUSH_LISTEN", "")
	t.Setenv("FABRIC_REVOKE_PUSH_TOKEN", "")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("poll-only revocation must be allowed, got: %v", err)
	}
	if cfg.RevokePushListen != "" {
		t.Fatalf("expected push disabled, got %q", cfg.RevokePushListen)
	}
}

func TestInboundDomainDefaultMatchesControlPlane(t *testing.T) {
	t.Setenv("FABRIC_REVOKE_PUSH_LISTEN", "")
	t.Setenv("FABRIC_GATEWAY_INBOUND_DOMAIN", "")

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	// Must stay identical to the control plane's default in
	// control-plane/src/store/types.ts -- the CP builds inbound hostnames with
	// this suffix and the Gateway matches incoming SNI against it, so a
	// mismatch makes every Platform->Customer dial miss. Production overrides
	// both to connect.abluva.com via env.
	if cfg.InboundDomainSuffix != "connect.fabric" {
		t.Fatalf("inbound domain default drifted: %q", cfg.InboundDomainSuffix)
	}
}
