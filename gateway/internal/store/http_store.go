package store

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/abluva/fabric/gateway/internal/dispatch/authorize"
)

// HTTPStore reads authorization data from control-plane (Gateway remains read-only to DB).
type HTTPStore struct {
	BaseURL    string
	Token      string // FABRIC_CONTROL_PLANE_TOKEN bearer (optional)
	HTTPClient *http.Client
}

func NewHTTPStore(baseURL, token string) *HTTPStore {
	return &HTTPStore{
		BaseURL: baseURL,
		Token:   token,
		HTTPClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

type authzContext struct {
	Registration       *authorize.Registration `json:"registration"`
	EligibleAgents     []authorize.Agent       `json:"eligible_agents"`
	TenantSuspended    bool                    `json:"tenant_suspended"`
	TenantSuspendCause string                  `json:"tenant_suspend_cause,omitempty"`
	CertRevoked        bool                    `json:"cert_revoked"`
	CertRevokeCause    string                  `json:"cert_revoke_cause,omitempty"`
	Quotas             authorize.QuotaLimits   `json:"quotas"`
	QuotaOK            bool                    `json:"quota_ok"`
	QuotaReason        string                  `json:"quota_reason,omitempty"`
	AgentApproved      bool                    `json:"agent_approved"`
	AgentState         string                  `json:"agent_state,omitempty"`
	AgentID            string                  `json:"agent_id,omitempty"`
}

func (s *HTTPStore) fetch(ctx context.Context, tenantID, registrationID, certFP, agentID string) (*authzContext, error) {
	u, err := url.Parse(s.BaseURL + "/v1/internal/authz-context")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("tenant_id", tenantID)
	q.Set("registration_id", registrationID)
	if certFP != "" {
		q.Set("cert_fingerprint", certFP)
	}
	if agentID != "" {
		q.Set("agent_id", agentID)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	s.applyAuth(req)
	res, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("authz-context status=%d", res.StatusCode)
	}
	var out authzContext
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *HTTPStore) applyAuth(req *http.Request) {
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
}

func (s *HTTPStore) GetRegistration(ctx context.Context, tenantID, registrationID string) (*authorize.Registration, error) {
	c, err := s.fetch(ctx, tenantID, registrationID, "", "")
	if err != nil {
		return nil, err
	}
	if c.Registration == nil {
		return nil, fmt.Errorf("registration not found")
	}
	return c.Registration, nil
}

func (s *HTTPStore) ListEligibleAgents(ctx context.Context, tenantID, registrationID string, generation int64) ([]authorize.Agent, error) {
	c, err := s.fetch(ctx, tenantID, registrationID, "", "")
	if err != nil {
		return nil, err
	}
	_ = generation
	return c.EligibleAgents, nil
}

func (s *HTTPStore) IsRevoked(ctx context.Context, tenantID, certFingerprint string) (bool, error) {
	c, err := s.fetch(ctx, tenantID, "", certFingerprint, "")
	if err != nil {
		return false, err
	}
	return c.CertRevoked, nil
}

func (s *HTTPStore) TenantSuspended(ctx context.Context, tenantID string) (bool, error) {
	c, err := s.fetch(ctx, tenantID, "", "", "")
	if err != nil {
		return false, err
	}
	return c.TenantSuspended, nil
}

// TenantSuspendCause returns the L2 §G.3 cause ("billing" | "security").
// Only meaningful when the tenant is suspended; defaults to "security"
// (fail safe → force-close) if the control-plane omits it.
func (s *HTTPStore) TenantSuspendCause(ctx context.Context, tenantID string) (string, error) {
	c, err := s.fetch(ctx, tenantID, "", "", "")
	if err != nil {
		return "security", err
	}
	if c.TenantSuspendCause == "" {
		return "security", nil
	}
	return c.TenantSuspendCause, nil
}

// CertRevokeCause returns the L2 §D.3 cause ("decommission" | "security").
// Only meaningful when the certificate is revoked; defaults to "security"
// (fail safe → immediate teardown, no drain) if omitted.
func (s *HTTPStore) CertRevokeCause(ctx context.Context, tenantID, certFingerprint string) (string, error) {
	c, err := s.fetch(ctx, tenantID, "", certFingerprint, "")
	if err != nil {
		return "security", err
	}
	if c.CertRevokeCause == "" {
		return "security", nil
	}
	return c.CertRevokeCause, nil
}

func (s *HTTPStore) GetQuotaLimits(ctx context.Context, tenantID string) (authorize.QuotaLimits, error) {
	c, err := s.fetch(ctx, tenantID, "", "", "")
	if err != nil {
		return authorize.QuotaLimits{}, err
	}
	lim := c.Quotas
	if lim.MaxTunnels <= 0 {
		lim.MaxTunnels = 50
	}
	if lim.MaxConcurrentStreams <= 0 {
		lim.MaxConcurrentStreams = 2000
	}
	if lim.MaxStreamOpenPerSec <= 0 {
		lim.MaxStreamOpenPerSec = 100
	}
	return lim, nil
}

// AgentApproval looks up whether the connecting agent may open data streams.
func (s *HTTPStore) AgentApproval(ctx context.Context, tenantID, agentID, certFP string) (approved bool, state string, err error) {
	c, err := s.fetch(ctx, tenantID, "", certFP, agentID)
	if err != nil {
		return false, "", err
	}
	return c.AgentApproved, c.AgentState, nil
}

// FetchAuthzContext is the single call backing authorize.Store: one
// /v1/internal/authz-context round trip already returns registration,
// eligible agents, revocation, suspension, quotas, and agent-approval
// together. Authorizer.AuthorizeStream previously fanned this same
// endpoint out into 6-7 separate calls (one per convenience method above)
// for a single StreamOpen decision, ~7x-ing load on the control plane's
// hot authz path for no benefit -- this is the fix: one fetch, reused for
// every check in that decision.
func (s *HTTPStore) FetchAuthzContext(ctx context.Context, tenantID, registrationID, certFP, agentID string) (*authorize.AuthzContext, error) {
	c, err := s.fetch(ctx, tenantID, registrationID, certFP, agentID)
	if err != nil {
		return nil, err
	}
	lim := c.Quotas
	if lim.MaxTunnels <= 0 {
		lim.MaxTunnels = 50
	}
	if lim.MaxConcurrentStreams <= 0 {
		lim.MaxConcurrentStreams = 2000
	}
	if lim.MaxStreamOpenPerSec <= 0 {
		lim.MaxStreamOpenPerSec = 100
	}
	return &authorize.AuthzContext{
		Registration:       c.Registration,
		EligibleAgents:     c.EligibleAgents,
		TenantSuspended:    c.TenantSuspended,
		TenantSuspendCause: c.TenantSuspendCause,
		CertRevoked:        c.CertRevoked,
		CertRevokeCause:    c.CertRevokeCause,
		Quotas:             lim,
		AgentApproved:      c.AgentApproved,
		AgentState:         c.AgentState,
		AgentID:            c.AgentID,
	}, nil
}
