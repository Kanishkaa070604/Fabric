package authorize

import (
	"context"
	"errors"
	"testing"

	"github.com/abluva/fabric/gateway/internal/quota"
)

// fakeStore is a minimal, fully-controllable Store for exercising
// Authorizer's decision logic without a real control-plane. ADR-002 makes
// this the sole authorization point, so every branch here matters.
//
// It implements the single-method Store interface (FetchAuthzContext) that
// replaced the previous five separate methods -- see authorize.go's
// AuthzContext doc comment for why: one control-plane round trip already
// returns everything a decision needs, so Authorizer (and this fake) only
// ever makes/handles one call per decision.
type fakeStore struct {
	reg            *Registration
	regErr         error
	eligibleAgents []Agent
	eligibleErr    error
	revoked        bool
	revokedErr     error
	suspended      bool
	suspendedErr   error
	limits         QuotaLimits
	limitsErr      error
	// agentApproved defaults to true so existing tests that don't care
	// about approval state (most of them) don't need to opt in.
	agentApproved bool
	agentState    string
	fetchErr      error
}

func (s *fakeStore) FetchAuthzContext(ctx context.Context, tenantID, registrationID, certFingerprint, agentID string) (*AuthzContext, error) {
	if s.fetchErr != nil {
		return nil, s.fetchErr
	}
	if s.regErr != nil {
		return nil, s.regErr
	}
	if s.eligibleErr != nil {
		return nil, s.eligibleErr
	}
	if s.revokedErr != nil {
		return nil, s.revokedErr
	}
	if s.suspendedErr != nil {
		return nil, s.suspendedErr
	}
	if s.limitsErr != nil {
		return nil, s.limitsErr
	}
	return &AuthzContext{
		Registration:    s.reg,
		EligibleAgents:  s.eligibleAgents,
		TenantSuspended: s.suspended,
		CertRevoked:     s.revoked,
		Quotas:          s.limits,
		AgentApproved:   s.agentApproved,
		AgentState:      s.agentState,
	}, nil
}

func activeReg(kind, connType string) *Registration {
	return &Registration{
		ID:               "reg-1",
		TenantID:         "tenant-1",
		State:            "Active",
		ConnectivityType: connType,
		DestinationKind:  kind,
		Generation:       1,
	}
}

func TestAuthorizeStream_NotApproved(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrPendingApproval) {
		t.Fatalf("want ErrPendingApproval, got %v", err)
	}
}

func TestAuthorizeStream_LookupFailureIsRetryable(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{fetchErr: errors.New("dial tcp: connection refused")}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrLookupFailed) {
		t.Fatalf("want ErrLookupFailed for a transport/infra error, got %v", err)
	}
}

func TestAuthorizeStream_RevokedCert(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{agentApproved: true, revoked: true}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized for revoked cert, got %v", err)
	}
}

func TestAuthorizeStream_SuspendedTenant(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{agentApproved: true, suspended: true}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized for suspended tenant, got %v", err)
	}
}

func TestAuthorizeStream_RegistrationNotFound(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{agentApproved: true, reg: nil}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestAuthorizeStream_RegistrationNotActive(t *testing.T) {
	reg := activeReg("PLATFORM_SERVICE", "SERVICE")
	reg.State = "Deleting"
	a := &Authorizer{Store: &fakeStore{agentApproved: true, reg: reg}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized for non-Active registration, got %v", err)
	}
}

func TestAuthorizeStream_ConnectivityTypeMismatch(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{agentApproved: true, reg: activeReg("PLATFORM_SERVICE", "SERVICE")}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "RESOURCE", "fp")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized for connectivity_type mismatch, got %v", err)
	}
}

// ADR-008 / the fail-closed fix: an unrecognized destination_kind must never
// be silently treated as any adapter (previously defaulted to DIRECT_ENDPOINT).
func TestAuthorizeStream_UnknownDestinationKindFailsClosed(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{agentApproved: true, reg: activeReg("SOME_FUTURE_KIND", "SERVICE")}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized for unknown destination_kind, got %v", err)
	}
}

func TestAuthorizeStream_PlatformResourceNoAgentNeeded(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{agentApproved: true, reg: activeReg("PLATFORM_RESOURCE", "RESOURCE")}}
	d, err := a.AuthorizeStream(context.Background(), "t1", "r1", "RESOURCE", "fp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.AdapterKind != "PLATFORM_CONNECTOR" {
		t.Fatalf("want PLATFORM_CONNECTOR, got %s", d.AdapterKind)
	}
	if d.AgentID != "" {
		t.Fatalf("PLATFORM_CONNECTOR must not select an agent, got %q", d.AgentID)
	}
}

func TestAuthorizeStream_ConnectAgentNoEligibleAgents(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{agentApproved: true, reg: activeReg("CUSTOMER_SERVICE", "SERVICE")}}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrDestinationUnavail) {
		t.Fatalf("want ErrDestinationUnavail, got %v", err)
	}
}

func TestAuthorizeStream_ConnectAgentPicksLeastLoaded(t *testing.T) {
	agents := []Agent{{ID: "agent-a"}, {ID: "agent-b"}, {ID: "agent-c"}}
	loads := map[string]int{"agent-a": 5, "agent-b": 1, "agent-c": 9}
	a := &Authorizer{
		Store: &fakeStore{
			agentApproved:  true,
			reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
			eligibleAgents: agents,
		},
		OpenStreams: func(id string) int { return loads[id] },
	}
	d, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.AgentID != "agent-b" {
		t.Fatalf("want least-loaded agent-b, got %s", d.AgentID)
	}
}

func TestAuthorizeStream_QuotaExceededWrapsConcurrentSentinel(t *testing.T) {
	tracker := quota.NewTracker()
	// Exhaust the single slot so the peek-only checkStreamQuota trips.
	if _, err := tracker.TryOpenStream("t1", quota.Limits{MaxConcurrentStreams: 1}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	a := &Authorizer{
		Store:  &fakeStore{agentApproved: true, limits: QuotaLimits{MaxConcurrentStreams: 1}},
		Quotas: tracker,
	}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	if !errors.Is(err, quota.ErrConcurrentExceeded) {
		t.Fatalf("want wrapped quota.ErrConcurrentExceeded (for RETRY_LATER vs UNAUTHORIZED mapping), got %v", err)
	}
}

func TestAuthorizeInbound_RejectsNonCustomerDestination(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{reg: activeReg("PLATFORM_SERVICE", "SERVICE")}}
	_, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized for non-CUSTOMER_* inbound target, got %v", err)
	}
}

func TestAuthorizeInbound_SuspendedTenant(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{suspended: true}}
	_, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized for suspended tenant, got %v", err)
	}
}

func TestAuthorizeInbound_AcceptsCustomerServiceAndSelectsAgent(t *testing.T) {
	a := &Authorizer{Store: &fakeStore{
		reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
		eligibleAgents: []Agent{{ID: "agent-x"}},
	}}
	d, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.AdapterKind != "CONNECT_AGENT" || d.AgentID != "agent-x" {
		t.Fatalf("want CONNECT_AGENT/agent-x, got %s/%s", d.AdapterKind, d.AgentID)
	}
}

func TestReserveStream_WrapsQuotaSentinelsForWireMapping(t *testing.T) {
	tracker := quota.NewTracker()
	a := &Authorizer{Quotas: tracker}
	lim := QuotaLimits{MaxStreamOpenPerSec: 1, MaxConcurrentStreams: 50}
	// First reserve succeeds and consumes the 1/sec rate budget.
	release, err := a.ReserveStream(context.Background(), "t1", lim)
	if err != nil {
		t.Fatalf("first reserve should succeed: %v", err)
	}
	defer release()

	_, err = a.ReserveStream(context.Background(), "t1", lim)
	if !errors.Is(err, ErrQuotaExceeded) || !errors.Is(err, quota.ErrRateExceeded) {
		t.Fatalf("want ErrQuotaExceeded wrapping quota.ErrRateExceeded, got %v", err)
	}
}

func TestReserveTunnel_WrapsQuotaError(t *testing.T) {
	tracker := quota.NewTracker()
	a := &Authorizer{
		Store:  &fakeStore{limits: QuotaLimits{MaxTunnels: 1}},
		Quotas: tracker,
	}
	if err := a.ReserveTunnel(context.Background(), "t1"); err != nil {
		t.Fatalf("first tunnel should succeed: %v", err)
	}
	defer a.ReleaseTunnel("t1")

	err := a.ReserveTunnel(context.Background(), "t1")
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded for tunnel cap, got %v", err)
	}
}

func TestMapDestinationKind(t *testing.T) {
	cases := map[string]string{
		"CUSTOMER_SERVICE":  "CONNECT_AGENT",
		"CUSTOMER_RESOURCE": "CONNECT_AGENT",
		"PLATFORM_RESOURCE": "PLATFORM_CONNECTOR",
		"PLATFORM_SERVICE":  "DIRECT_ENDPOINT",
		"BOGUS":             "",
		"":                  "",
	}
	for in, want := range cases {
		if got := mapDestinationKind(in); got != want {
			t.Errorf("mapDestinationKind(%q) = %q, want %q", in, got, want)
		}
	}
}

// A TunnelRegistry is per-process, but inbound requests arrive through a load
// balancer that picks any replica. The control plane knowing an Agent is
// "connected" therefore does not tell the receiving replica whether it holds
// that Agent's tunnel. These tests pin the selection rule that keeps a replica
// from choosing an Agent it cannot dial.
func TestSelectAgentPrefersLocallyOwnedTunnels(t *testing.T) {
	agents := []Agent{{ID: "agent-remote"}, {ID: "agent-local"}}
	a := &Authorizer{
		Store: &fakeStore{
			agentApproved:  true,
			reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
			eligibleAgents: agents,
		},
		HasLocalTunnel: func(id string) bool { return id == "agent-local" },
	}

	d, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// agent-remote is first in the eligible list and would have been chosen by
	// the old load-balance-only rule.
	if d.AgentID != "agent-local" {
		t.Fatalf("expected the locally-owned agent, got %q", d.AgentID)
	}
}

func TestSelectAgentStillLoadBalancesAmongLocalTunnels(t *testing.T) {
	agents := []Agent{{ID: "a"}, {ID: "b"}, {ID: "remote"}}
	loads := map[string]int{"a": 9, "b": 1, "remote": 0}
	a := &Authorizer{
		Store: &fakeStore{
			agentApproved:  true,
			reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
			eligibleAgents: agents,
		},
		OpenStreams:    func(id string) int { return loads[id] },
		HasLocalTunnel: func(id string) bool { return id != "remote" },
	}

	d, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// "remote" has the fewest streams but is unreachable; among the reachable
	// pair, least-loaded still wins.
	if d.AgentID != "b" {
		t.Fatalf("expected least-loaded local agent b, got %q", d.AgentID)
	}
}

func TestSelectAgentReportsTunnelElsewhereNotDestinationUnavailable(t *testing.T) {
	a := &Authorizer{
		Store: &fakeStore{
			agentApproved:  true,
			reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
			eligibleAgents: []Agent{{ID: "agent-on-sibling"}},
		},
		HasLocalTunnel: func(string) bool { return false },
	}

	_, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if !errors.Is(err, ErrTunnelElsewhere) {
		t.Fatalf("want ErrTunnelElsewhere, got %v", err)
	}
	// Must NOT be destination_unavailable: the customer has a healthy Agent, so
	// that would point an operator at the wrong side of the system and tell the
	// caller to give up instead of retrying.
	if errors.Is(err, ErrDestinationUnavail) {
		t.Fatal("tunnel-elsewhere must not present as destination_unavailable")
	}
}

// No eligible agents at all is a genuinely different condition and must keep
// reporting destination_unavailable.
func TestSelectAgentNoEligibleAgentsStillDestinationUnavailable(t *testing.T) {
	a := &Authorizer{
		Store: &fakeStore{
			agentApproved:  true,
			reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
			eligibleAgents: nil,
		},
		HasLocalTunnel: func(string) bool { return false },
	}
	_, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if !errors.Is(err, ErrDestinationUnavail) {
		t.Fatalf("want ErrDestinationUnavail, got %v", err)
	}
}

// Single-replica deployments and unit tests leave HasLocalTunnel nil, which
// must behave exactly as before.
func TestSelectAgentNilHasLocalTunnelSelectsAsBefore(t *testing.T) {
	a := &Authorizer{
		Store: &fakeStore{
			agentApproved:  true,
			reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
			eligibleAgents: []Agent{{ID: "only"}},
		},
	}
	d, err := a.AuthorizeInbound(context.Background(), "t1", "r1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.AgentID != "only" {
		t.Fatalf("got %q", d.AgentID)
	}
}

// The hairpin path (Gateway dials back into an Agent for a CUSTOMER_*
// destination) has the same ownership constraint as inbound.
func TestAuthorizeStreamHairpinAlsoRespectsOwnership(t *testing.T) {
	a := &Authorizer{
		Store: &fakeStore{
			agentApproved:  true,
			reg:            activeReg("CUSTOMER_SERVICE", "SERVICE"),
			eligibleAgents: []Agent{{ID: "agent-on-sibling"}},
		},
		HasLocalTunnel: func(string) bool { return false },
	}
	_, err := a.AuthorizeStream(context.Background(), "t1", "r1", "SERVICE", "fp")
	if !errors.Is(err, ErrTunnelElsewhere) {
		t.Fatalf("want ErrTunnelElsewhere on the hairpin path too, got %v", err)
	}
}
