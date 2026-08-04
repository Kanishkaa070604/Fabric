package certlife

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/cptoken"
)

// DefaultCertOverlapSeconds mirrors control-plane DEFAULT_CERT_OVERLAP_SECONDS
// (control-plane/src/store/types.ts): how long the prior leaf FP stays
// accepted after rotate. Go and TS cannot share one constant; keep them
// equal by convention. The rotate request always sends overlap_seconds
// explicitly, so drift only matters if a caller omits it server-side.
// StartLoop's persistRetryInterval must stay well under this window.
const DefaultCertOverlapSeconds = 300

// leafDER extracts DER bytes from a cert file's contents, tolerating a
// PEM wrapper or raw DER -- mirrors the same tolerance the rest of this
// codebase (main.go's fingerprintFile, identity/file.Store) already uses
// for cert files that might have been hand-placed without a PEM wrapper.
func leafDER(b []byte) []byte {
	block, _ := pem.Decode(b)
	if block != nil {
		return block.Bytes
	}
	return b
}

// requestRotatedCert calls POST /v1/agents/:id/rotate, authenticated by
// leaf PoP over the currently-stored (pre-rotation) cert/key -- see
// RotateLeaf's doc comment for why bearer-only auth isn't sufficient here.
// apiTok is still attached when available (defense in depth / audit
// trail via the same bearer other Agent->CP calls use), but the
// control-plane's authorization decision for this endpoint is the PoP
// signature, not the bearer.
func requestRotatedCert(ctx context.Context, controlPlaneURL, agentID, csrPEM string, currentCertPEM, currentKeyPEM []byte, apiTok *cptoken.Store) (string, error) {
	signedAt, sigB64, err := cptoken.SignPoP(agentID, currentKeyPEM)
	if err != nil {
		return "", fmt.Errorf("sign rotate pop: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"csr_pem":         csrPEM,
		"overlap_seconds": DefaultCertOverlapSeconds,
		"certificate_pem": string(currentCertPEM),
		"signed_at":       signedAt,
		"signature_b64":   sigB64,
	})
	if err != nil {
		return "", fmt.Errorf("marshal rotate request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		controlPlaneURL+"/v1/agents/"+agentID+"/rotate", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ABLV-Actor", "agent")
	if apiTok != nil {
		apiTok.SetAuthHeader(req)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", fmt.Errorf("read rotate response: %w", err)
	}
	if res.StatusCode >= 300 {
		return "", fmt.Errorf("rotate status=%d body=%s", res.StatusCode, string(body))
	}

	var out struct {
		CertificatePEM string `json:"certificate_pem"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.CertificatePEM == "" {
		return "", fmt.Errorf("rotate missing certificate_pem")
	}
	return out.CertificatePEM, nil
}

// Enabled returns true when auto-rotation should run. Unconditional by
// default -- with short-lived certs (7d), identity loss is cheap
// (re-enroll takes seconds), so there is no substrate-specific reason to
// gate this behind an opt-in flag the way the old hostPath-only design
// needed. Set FABRIC_CERT_AUTO_ROTATE=0 only as a debugging escape hatch.
func Enabled() bool {
	return os.Getenv("FABRIC_CERT_AUTO_ROTATE") != "0"
}

// ParseCheckInterval reads FABRIC_CERT_CHECK_INTERVAL (default 1h).
// For 7-day TTL, 1h check is fine (rotate at 3.5d, 84 checks before threshold).
// For a future 24h TTL, consider 15m checks.
func ParseCheckInterval() time.Duration {
	raw := os.Getenv("FABRIC_CERT_CHECK_INTERVAL")
	if raw == "" {
		return time.Hour
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return time.Hour
	}
	return d
}
