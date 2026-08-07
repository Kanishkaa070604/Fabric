// Package evidence verifies optional StreamOpen workload_evidence bytes
// for audit attribution (L3-EVID-01). Missing evidence is allowed; present
// but invalid evidence is a hard reject when the tenant strategy is armed.
package evidence

import (
	"context"
	"fmt"
)

// Trust is the Gateway view of CP evidence_trust (authz-context).
type Trust struct {
	Strategy     string
	OIDCEnabled  bool
	IssuerURL    string
	JWKSURI      string
	Audience     string
	AllowedAlgs  []string
	CABundlePEM  string
}

// Attribution is logged on successful verify (never used for allowlists in v1).
type Attribution struct {
	Strategy string
	Subject  string
	Issuer   string
	Audience string
	Extra    map[string]string
}

// Result of Verify.
type Result struct {
	// Absent: no bytes and that is OK.
	Absent bool
	// Skipped: strategy none or k8s OIDC not yet enabled (discovery pending).
	Skipped bool
	// Attribution set when verified OK.
	Attribution *Attribution
}

var (
	// ErrInvalidEvidence means bytes were present but failed verification.
	ErrInvalidEvidence = fmt.Errorf("workload_evidence_invalid")
)

// Verifier selects a strategy implementation.
type Verifier struct {
	OIDC *OIDCVerifier
}

func NewVerifier() *Verifier {
	return &Verifier{OIDC: NewOIDCVerifier()}
}

// Verify applies tenant trust to opaque evidence bytes.
func (v *Verifier) Verify(ctx context.Context, trust Trust, raw []byte) (*Result, error) {
	if trust.Strategy == "" || trust.Strategy == "none" {
		return &Result{Skipped: true}, nil
	}
	if len(raw) == 0 {
		return &Result{Absent: true}, nil
	}
	switch trust.Strategy {
	case "kubernetes_oidc":
		if !trust.OIDCEnabled || trust.JWKSURI == "" || trust.IssuerURL == "" {
			// Strategy selected but discovery not green — do not treat
			// tokens as verified; ignore presence (same as skipped).
			return &Result{Skipped: true}, nil
		}
		attr, err := v.OIDC.Verify(ctx, trust, raw)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidEvidence, err)
		}
		return &Result{Attribution: attr}, nil
	case "ecs_task_identity":
		return nil, fmt.Errorf("%w: ecs_task_identity not implemented", ErrInvalidEvidence)
	default:
		return nil, fmt.Errorf("%w: unknown strategy %q", ErrInvalidEvidence, trust.Strategy)
	}
}
