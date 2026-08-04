package authorize

import (
	"context"
	"errors"
	"fmt"

	"github.com/abluva/fabric/gateway/internal/quota"
)

var (
	ErrUnauthorized       = errors.New("unauthorized")
	ErrNotFound           = errors.New("not_found")
	ErrPendingApproval    = errors.New("pending_approval")
	ErrQuotaExceeded      = errors.New("quota_exceeded")
	ErrDestinationUnavail = errors.New("destination_unavailable")
	// ErrLookupFailed wraps a transport/infra failure talking to the
	// control-plane's authz-context endpoint. It is distinct from the
	// Err* deny sentinels above: a lookup failure isn't an authorization
	// decision at all, so callers (handler.go's mapAuthzError) should map
	// it to RETRY_LATER rather than UNAUTHORIZED.
	ErrLookupFailed = errors.New("authz_lookup_failed")
)

type Registration struct {
	ID               string
	TenantID         string
	State            string
	ConnectivityType string
	DestinationKind  string
	Host             string
	Port             int
	Generation       int64
}

type Agent struct {
	ID              string
	TenantID        string
	State           string // Connected | PendingApproval | ...
	CertFingerprint string `json:"CertFingerprint,omitempty"`
}

type QuotaLimits struct {
	MaxTunnels           int `json:"max_tunnels"`
	MaxConcurrentStreams int `json:"max_concurrent_streams"`
	MaxStreamOpenPerSec  int `json:"max_stream_open_per_sec"`
}

// AuthzContext is everything a single StreamOpen/inbound-dial decision
// needs. The control-plane's /v1/internal/authz-context endpoint already
// returns all of this in one response; Store.FetchAuthzContext exists so
// Authorizer only has to make ONE call per decision instead of one per
// field (registration, eligible agents, revocation, suspension, quotas,
// and agent-approval used to each be separate Store methods, each doing
// its own round trip).
type AuthzContext struct {
	Registration       *Registration
	EligibleAgents     []Agent
	TenantSuspended    bool
	TenantSuspendCause string
	CertRevoked        bool
	CertRevokeCause    string
	Quotas             QuotaLimits
	AgentApproved      bool
	AgentState         string
	AgentID            string
}

type Store interface {
	// FetchAuthzContext is the single round trip backing every
	// AuthorizeStream/AuthorizeInbound/ReserveStream/ReserveTunnel
	// decision. registrationID, certFingerprint, and agentID may be
	// empty when not applicable to the caller (e.g. ReserveTunnel only
	// needs tenant-level quotas, so it passes "" for the other three).
	FetchAuthzContext(ctx context.Context, tenantID, registrationID, certFingerprint, agentID string) (*AuthzContext, error)
}

type Decision struct {
	Registration  *Registration
	AgentID       string
	AdapterKind   string
	CorrelationID string
	Reason        string
	// AgentState carries the agent's approval state through even on a
	// denial (ErrPendingApproval), so callers can log/report it without a
	// second lookup.
	AgentState string
	// Quotas is threaded through from the single FetchAuthzContext call
	// so ReserveStream doesn't need its own extra round trip.
	Quotas QuotaLimits
}

// Authorizer is the sole registration authorization point (ADR-002).
type Authorizer struct {
	Store Store
	// OpenStreams optionally returns Gateway→Agent open stream counts for tie-break.
	OpenStreams func(agentID string) int
	// Quotas enforces live L3-GW-02 caps (nil = skip live enforcement).
	Quotas *quota.Tracker
}

// AuthorizeStream makes one FetchAuthzContext call and evaluates every
// check (agent approval, revocation, suspension, quota, registration
// state/type, destination/agent selection) against that single snapshot.
// Previously this same decision cost 6-7 separate control-plane round
// trips (one per check, each hitting the same authz-context endpoint
// independently) -- see AuthzContext's doc comment.
func (a *Authorizer) AuthorizeStream(ctx context.Context, tenantID, registrationID, connectivityType, agentCertFP string) (*Decision, error) {
	actx, err := a.Store.FetchAuthzContext(ctx, tenantID, registrationID, agentCertFP, "")
	if err != nil {
		return &Decision{}, fmt.Errorf("%w: %v", ErrLookupFailed, err)
	}
	d := &Decision{AgentState: actx.AgentState, Quotas: actx.Quotas}

	if !actx.AgentApproved {
		reason := "no agent matches tenant_id + certificate presented on this tunnel"
		if actx.AgentState != "" {
			reason = fmt.Sprintf("agent state=%s; data plane requires approval", actx.AgentState)
		}
		return d, fmt.Errorf("%w: %s", ErrPendingApproval, reason)
	}
	if actx.CertRevoked {
		return d, fmt.Errorf("%w: certificate revoked", ErrUnauthorized)
	}
	if actx.TenantSuspended {
		return d, fmt.Errorf("%w: tenant suspended", ErrUnauthorized)
	}
	if err := a.checkStreamQuota(tenantID, actx.Quotas); err != nil {
		return d, err
	}
	reg := actx.Registration
	if reg == nil {
		return d, fmt.Errorf("%w: registration not found", ErrNotFound)
	}
	d.Registration = reg
	if reg.State != "Active" {
		return d, fmt.Errorf("%w: registration state=%s", ErrUnauthorized, reg.State)
	}
	if connectivityType != "" && reg.ConnectivityType != connectivityType {
		return d, fmt.Errorf("%w: connectivity_type mismatch", ErrUnauthorized)
	}

	adapterKind := mapDestinationKind(reg.DestinationKind)
	if adapterKind == "" {
		return d, fmt.Errorf("%w: unknown destination_kind %s", ErrUnauthorized, reg.DestinationKind)
	}
	d.AdapterKind = adapterKind

	if adapterKind == "CONNECT_AGENT" {
		if len(actx.EligibleAgents) == 0 {
			return d, ErrDestinationUnavail
		}
		chosen := pickAgent(actx.EligibleAgents, a.OpenStreams)
		d.AgentID = chosen.ID
	}
	return d, nil
}

// AuthorizeInbound authorizes a platform→customer dial (G-A3-1).
func (a *Authorizer) AuthorizeInbound(ctx context.Context, tenantID, registrationID string) (*Decision, error) {
	actx, err := a.Store.FetchAuthzContext(ctx, tenantID, registrationID, "", "")
	if err != nil {
		return &Decision{}, fmt.Errorf("%w: %v", ErrLookupFailed, err)
	}
	d := &Decision{Quotas: actx.Quotas}

	if actx.TenantSuspended {
		return d, fmt.Errorf("%w: tenant suspended", ErrUnauthorized)
	}
	if err := a.checkStreamQuota(tenantID, actx.Quotas); err != nil {
		return d, err
	}
	reg := actx.Registration
	if reg == nil {
		return d, fmt.Errorf("%w: registration not found", ErrNotFound)
	}
	d.Registration = reg
	if reg.State != "Active" {
		return d, fmt.Errorf("%w: registration state=%s", ErrUnauthorized, reg.State)
	}
	adapterKind := mapDestinationKind(reg.DestinationKind)
	if adapterKind != "CONNECT_AGENT" {
		return d, fmt.Errorf("%w: inbound requires CUSTOMER_* destination, got %s", ErrUnauthorized, reg.DestinationKind)
	}
	d.AdapterKind = adapterKind
	if len(actx.EligibleAgents) == 0 {
		return d, ErrDestinationUnavail
	}
	chosen := pickAgent(actx.EligibleAgents, a.OpenStreams)
	d.AgentID = chosen.ID
	return d, nil
}

// checkStreamQuota is a peek-only check against limits already fetched by
// the caller (no store call here): fail closed if already at/over cap so
// we don't accept then fail. The actual reserve happens in ReserveStream
// after the ACCEPTED path starts relay.
func (a *Authorizer) checkStreamQuota(tenantID string, lim QuotaLimits) error {
	if a.Quotas == nil {
		return nil
	}
	if lim.MaxConcurrentStreams > 0 && a.Quotas.StreamCount(tenantID) >= lim.MaxConcurrentStreams {
		return fmt.Errorf("%w: %w (%d)", ErrQuotaExceeded, quota.ErrConcurrentExceeded, lim.MaxConcurrentStreams)
	}
	return nil
}

// ReserveStream reserves a live stream slot (call after authz succeeds).
// lim comes from the Decision returned by AuthorizeStream/AuthorizeInbound
// -- no separate store call needed here.
func (a *Authorizer) ReserveStream(ctx context.Context, tenantID string, lim QuotaLimits) (release func(), err error) {
	if a.Quotas == nil {
		return func() {}, nil
	}
	rel, err := a.Quotas.TryOpenStream(tenantID, quota.Limits{
		MaxTunnels:           lim.MaxTunnels,
		MaxConcurrentStreams: lim.MaxConcurrentStreams,
		MaxStreamOpenPerSec:  lim.MaxStreamOpenPerSec,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrQuotaExceeded, err)
	}
	return rel, nil
}

// ReserveTunnel reserves one tunnel slot for a new agent session (not per
// stream). FetchAuthzContext failure returns ErrLookupFailed — callers in
// session.Handler must defer bind/retry, not treat it as quota denial.
func (a *Authorizer) ReserveTunnel(ctx context.Context, tenantID string) error {
	if a.Quotas == nil || tenantID == "" {
		return nil
	}
	actx, err := a.Store.FetchAuthzContext(ctx, tenantID, "", "", "")
	if err != nil {
		return fmt.Errorf("%w: %v", ErrLookupFailed, err)
	}
	if err := a.Quotas.TryAddTunnel(tenantID, quota.Limits{
		MaxTunnels:           actx.Quotas.MaxTunnels,
		MaxConcurrentStreams: actx.Quotas.MaxConcurrentStreams,
		MaxStreamOpenPerSec:  actx.Quotas.MaxStreamOpenPerSec,
	}); err != nil {
		return fmt.Errorf("%w: %v", ErrQuotaExceeded, err)
	}
	return nil
}

func (a *Authorizer) ReleaseTunnel(tenantID string) {
	if a.Quotas != nil {
		a.Quotas.ReleaseTunnel(tenantID)
	}
}

func pickAgent(agents []Agent, openStreams func(string) int) Agent {
	chosen := agents[0]
	if openStreams != nil && len(agents) > 1 {
		best := openStreams(chosen.ID)
		for _, ag := range agents[1:] {
			n := openStreams(ag.ID)
			if n < best {
				chosen = ag
				best = n
			}
		}
	}
	return chosen
}

func mapDestinationKind(k string) string {
	switch k {
	case "CUSTOMER_SERVICE", "CUSTOMER_RESOURCE":
		return "CONNECT_AGENT"
	case "PLATFORM_RESOURCE":
		return "PLATFORM_CONNECTOR"
	case "PLATFORM_SERVICE":
		return "DIRECT_ENDPOINT"
	default:
		// ADR-008: never invent an adapter; unknown kinds must fail closed.
		return ""
	}
}
