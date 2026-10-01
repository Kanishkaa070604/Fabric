// Package certlife implements automatic leaf certificate rotation for the
// Connect Agent. Industry pattern (Teleport tbot / SPIRE / Vault Agent):
// agent-side loop checks remaining cert life → requests a new cert at
// ~50% of TTL → persists via identity.Store → forces tunnel reconnect so
// the new leaf is presented promptly.
//
// Substrate-neutral: this package only talks to identity.Store. main.go
// chooses file.Store vs k8ssecret.Store; certlife does not care which.
package certlife

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/cptoken"
	"github.com/abluva/fabric/connect-agent/internal/enroll/bootstrap"
	"github.com/abluva/fabric/connect-agent/internal/identity"
	"github.com/abluva/fabric/connect-agent/internal/logging"
)

// persistRetryInterval is how soon StartLoop retries after a rotation
// failure. Must stay well under DefaultCertOverlapSeconds (300s): CP keeps
// only one prior fingerprint, and after that window the on-disk leaf can
// no longer authenticate rotate (PoP) or StreamOpen authz.
const persistRetryInterval = 30 * time.Second

// Config for the auto-rotation loop.
type Config struct {
	ControlPlaneURL string
	AgentID         string
	Store           identity.Store
	APIToken        *cptoken.Store

	// CheckInterval is how often to inspect remaining cert life when
	// healthy. Default 1h. Override via FABRIC_CERT_CHECK_INTERVAL for
	// short-TTL certs. Failures temporarily shorten to persistRetryInterval.
	CheckInterval time.Duration

	// RenewAt is the fraction of total TTL at which to trigger rotation.
	// Industry standard: 0.5 (SPIRE) to 0.66 (Vault). Default: 0.5.
	RenewAt float64

	// Reconnect, if set, is called after the new leaf is persisted so the
	// live tunnel redials on it immediately. Without it, the tunnel keeps
	// presenting the old leaf until a natural disconnect; StreamOpen still
	// works during CP's prior-FP overlap (DEFAULT_CERT_OVERLAP_SECONDS),
	// but that window is a safety margin, not the intended cutover path.
	// Nil is fine in tests or when no tunnel is up yet.
	Reconnect func()
}

// StartLoop runs the auto-rotation goroutine until ctx is cancelled.
// Call as `go certlife.StartLoop(...)`.
//
// Steady-state tick:
//  1. Load leaf via Config.Store; compute remaining life vs RenewAt.
//  2. If still fresh, restore CheckInterval and wait.
//  3. Else RotateLeaf (CSR + PoP → CP → SaveCert).
//  4. On success: Reconnect (if set), restore CheckInterval.
//
// Failure handling (debug this when you see cert_auto_rotate_* logs):
//   - Pre-commit failures (CP unreachable, PoP reject, etc.): shorten the
//     ticker to persistRetryInterval and retry a full RotateLeaf.
//   - Post-commit SaveCert failure (*persistFailedError): CP already has
//     the new FP. Cache the PEM and on later ticks retry SaveCert ONLY —
//     never call CP again for that issuance. A second CP rotate would
//     overwrite the single prior-FP slot and drop the leaf still on disk /
//     on the wire, leaving the Agent unable to PoP or pass authz even
//     inside the original overlap window.
//
// Log cues: cert_auto_rotate_persist_pending → persist-only retries;
// cert_auto_rotate_persist_retry_failed → identity store still broken;
// cert_auto_rotate_persist_retry_success → leaf on disk, reconnect fired.
func StartLoop(ctx context.Context, log *slog.Logger, cfg Config) {
	if cfg.CheckInterval <= 0 {
		cfg.CheckInterval = time.Hour
	}
	if cfg.RenewAt <= 0 || cfg.RenewAt >= 1 {
		cfg.RenewAt = 0.5
	}

	ctx = logging.WithFields(ctx, logging.Fields{Layer: "agent.certlife"})
	logging.Info(ctx, log, "cert_auto_rotate_started",
		"check_interval", cfg.CheckInterval.String(),
		"renew_at_fraction", cfg.RenewAt,
		"persist_retry_interval", persistRetryInterval.String(),
	)

	// Spread the first check so a fleet restart does not stampede CP.
	jitter := time.Duration(rand.Int63n(int64(cfg.CheckInterval/4) + 1))
	select {
	case <-ctx.Done():
		return
	case <-time.After(jitter):
	}

	ticker := time.NewTicker(cfg.CheckInterval)
	defer ticker.Stop()

	// pending*: PEM from a CP rotate that succeeded but SaveCert failed.
	// Next ticks must persist this material only (see StartLoop doc).
	var pendingCert, pendingKey []byte
	var pendingAgentID string

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if len(pendingCert) > 0 {
				if err := cfg.Store.SaveCert(ctx, pendingAgentID, pendingCert, pendingKey); err != nil {
					logging.Error(ctx, log, "cert_auto_rotate_persist_retry_failed", err,
						"agent_id", pendingAgentID,
						"note", "identity store still rejecting write; retrying persist only (no CP rotate)")
					ticker.Reset(persistRetryInterval)
					continue
				}
				logging.Info(ctx, log, "cert_auto_rotate_persist_retry_success",
					"agent_id", pendingAgentID,
					"note", "pending leaf written; reconnecting tunnel onto it")
				pendingCert, pendingKey, pendingAgentID = nil, nil, ""
				if cfg.Reconnect != nil {
					cfg.Reconnect()
				}
				ticker.Reset(cfg.CheckInterval)
				continue
			}

			if err := maybeRotate(ctx, log, cfg); err != nil {
				logging.Error(ctx, log, "cert_auto_rotate_check_failed", err)
				var pf *persistFailedError
				if errors.As(err, &pf) {
					pendingCert = pf.CertPEM
					pendingKey = pf.KeyPEM
					pendingAgentID = pf.AgentID
					logging.Info(ctx, log, "cert_auto_rotate_persist_pending",
						"agent_id", pf.AgentID,
						"note", "CP already committed new FP; next ticks retry SaveCert only")
				}
				ticker.Reset(persistRetryInterval)
			} else {
				ticker.Reset(cfg.CheckInterval)
			}
		}
	}
}

func maybeRotate(ctx context.Context, log *slog.Logger, cfg Config) error {
	remaining, totalTTL, notAfter, err := certLifeInfo(ctx, cfg.Store)
	if err != nil {
		return fmt.Errorf("read cert life: %w", err)
	}

	threshold := time.Duration(float64(totalTTL) * (1.0 - cfg.RenewAt))
	if remaining > threshold {
		return nil
	}

	logging.Info(ctx, log, "cert_auto_rotate_triggered",
		"remaining", remaining.String(),
		"threshold", threshold.String(),
		"not_after", notAfter.Format(time.RFC3339),
		"total_ttl", totalTTL.String(),
	)

	if err := RotateLeaf(ctx, cfg.ControlPlaneURL, cfg.AgentID, cfg.Store, cfg.APIToken); err != nil {
		logging.Error(ctx, log, "cert_auto_rotate_failed", err,
			"note", "see StartLoop: persist failures become persist-only retries; other errors retry full rotate")
		return err
	}

	if cfg.Reconnect != nil {
		logging.Info(ctx, log, "cert_auto_rotate_reconnecting",
			"agent_id", cfg.AgentID,
			"note", "forcing tunnel redial onto the new leaf")
		cfg.Reconnect()
	}

	logging.Info(ctx, log, "cert_auto_rotate_success",
		"agent_id", cfg.AgentID,
		"note", "new leaf persisted; tunnel reconnected onto it",
	)
	return nil
}

// certLifeInfo returns remaining life, total TTL, and NotAfter for the
// currently stored cert.
func certLifeInfo(ctx context.Context, store identity.Store) (remaining, totalTTL time.Duration, notAfter time.Time, err error) {
	id, err := store.Load(ctx)
	if err != nil {
		return 0, 0, time.Time{}, err
	}
	cert, err := parseCert(id.CertPEM)
	if err != nil {
		return 0, 0, time.Time{}, err
	}
	now := time.Now()
	totalTTL = cert.NotAfter.Sub(cert.NotBefore)
	remaining = cert.NotAfter.Sub(now)
	if remaining < 0 {
		remaining = 0
	}
	return remaining, totalTTL, cert.NotAfter, nil
}

func parseCert(certPEM []byte) (*x509.Certificate, error) {
	return x509.ParseCertificate(leafDER(certPEM))
}

// persistFailedError means CP issued a new leaf but identity.Store.SaveCert
// failed. CertPEM/KeyPEM are the issued material so the caller can retry
// persist without a second CP rotate (which would stomp the prior-FP slot).
//
// StartLoop detects this via errors.As and switches to persist-only retries.
type persistFailedError struct {
	Err     error
	CertPEM []byte
	KeyPEM  []byte
	AgentID string
}

func (e *persistFailedError) Error() string {
	return fmt.Sprintf("persist rotated leaf: %v", e.Err)
}

func (e *persistFailedError) Unwrap() error { return e.Err }

// RotateLeaf generates a keypair + CSR, calls CP rotate (leaf PoP), and
// persists the new leaf via identity.Store.
//
// Used by StartLoop and by FABRIC_AGENT_ROTATE=1 in main — one implementation
// for automatic and emergency paths.
//
// Auth (L3-PKI-01a): PoP over the currently stored leaf private key, not
// the tenant-scoped Agent API bearer alone. The bearer is shared across
// DaemonSet replicas; binding to this agent's leaf prevents a sibling from
// rotating a cert it does not hold. Same PoP scheme as api-token/current.
//
// If CP succeeds and SaveCert fails, returns *persistFailedError with the
// PEMs so StartLoop can persist-only retry.
func RotateLeaf(ctx context.Context, controlPlaneURL, agentID string, store identity.Store, apiTok *cptoken.Store) error {
	id, err := store.Load(ctx)
	if err != nil {
		return fmt.Errorf("load current identity for rotate PoP: %w", err)
	}

	key, csrPEM, err := bootstrap.GenerateKeyAndCSR()
	if err != nil {
		return err
	}

	certPEM, err := requestRotatedCert(ctx, controlPlaneURL, agentID, csrPEM, id.CertPEM, id.KeyPEM, apiTok)
	if err != nil {
		return err
	}

	keyPEM := bootstrap.MarshalPrivateKeyPEM(key)
	if err := store.SaveCert(ctx, agentID, []byte(certPEM), keyPEM); err != nil {
		return &persistFailedError{
			Err:     err,
			CertPEM: []byte(certPEM),
			KeyPEM:  keyPEM,
			AgentID: agentID,
		}
	}
	return nil
}
