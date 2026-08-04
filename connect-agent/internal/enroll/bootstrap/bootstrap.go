// Package bootstrap implements enroll.Method for the opaque
// bootstrap-token flow this repo ships today (FABRIC_BOOTSTRAP_TOKEN), and
// hosts the shared Enroll() HTTP call every enroll.Method ultimately drives.
package bootstrap

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/enroll"
)

// Method reads FABRIC_BOOTSTRAP_TOKEN and presents it verbatim as the
// enroll credential. This is today's only shipped enroll.Method.
type Method struct {
	Token string
}

func (m Method) Credentials(_ context.Context) (enroll.Credentials, error) {
	if m.Token == "" {
		return enroll.Credentials{}, fmt.Errorf("bootstrap: no token configured")
	}
	return enroll.Credentials{Method: "bootstrap_token", BootstrapToken: m.Token}, nil
}

// EnrollResult is what the control plane's POST /v1/agents/enroll returns.
type EnrollResult struct {
	AgentID        string
	State          string
	CertificatePEM string
}

// Enroll performs the shared enroll HTTP call. Every enroll.Method's
// Credentials feed into this one function -- a future cloud-attestation
// Method changes what Credentials.Method/fields carry, not this
// request/response handling, retry behavior, or error surface.
//
// certFP is set for the fingerprint-only re-bind path (pre-minted local
// leaf, e.g. smoke harnesses); csrPEM is set for the normal "generate a
// key locally, ask the control plane to sign it" path. Exactly one should
// be non-empty; Enroll() itself doesn't enforce that -- the control plane
// does (csr_or_cert_fingerprint_required).
//
// Wire field stays "join_method" (not renamed to match this Go package):
// that's the control plane's HTTP contract, already shipped and tested
// server-side (control-plane/src/http/server.ts reads it as an opaque,
// currently-audit-only field) -- renaming a wire field is a server+client
// coordinated change, deliberately kept separate from this Go-side
// package rename.
func Enroll(ctx context.Context, controlPlaneURL, tenantID string, creds enroll.Credentials, certFP, csrPEM, substrate, substrateFingerprint, controlPlaneToken string) (EnrollResult, error) {
	reqBody := map[string]string{
		"tenant_id":   tenantID,
		"substrate":   substrate,
		"join_method": creds.Method,
	}
	if creds.BootstrapToken != "" {
		reqBody["bootstrap_token"] = creds.BootstrapToken
	}
	if certFP != "" {
		reqBody["cert_fingerprint_sha256"] = certFP
	}
	if csrPEM != "" {
		reqBody["csr_pem"] = csrPEM
	}
	if substrateFingerprint != "" {
		reqBody["substrate_fingerprint"] = substrateFingerprint
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return EnrollResult{}, fmt.Errorf("marshal enroll request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, controlPlaneURL+"/v1/agents/enroll", bytes.NewReader(payload))
	if err != nil {
		return EnrollResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ABLV-Actor", "agent")
	// Enroll uses the Day-1 seed bearer from env (no leaf PoP yet -- there
	// is no leaf until this call succeeds).
	if controlPlaneToken != "" {
		req.Header.Set("Authorization", "Bearer "+controlPlaneToken)
	}
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return EnrollResult{}, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return EnrollResult{}, fmt.Errorf("read enroll response: %w", err)
	}
	if res.StatusCode >= 300 {
		return EnrollResult{}, fmt.Errorf("enroll status=%d body=%s", res.StatusCode, string(body))
	}
	var out struct {
		ID             string `json:"id"`
		State          string `json:"state"`
		CertificatePEM string `json:"certificate_pem"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return EnrollResult{}, err
	}
	return EnrollResult{AgentID: out.ID, State: out.State, CertificatePEM: out.CertificatePEM}, nil
}

// GenerateKeyAndCSR is shared by the enroll and rotate paths -- both need
// a fresh RSA keypair and a matching CSR, and neither is an enroll.Method
// concern (rotate never re-proves enroll.Credentials, only enroll does).
func GenerateKeyAndCSR() (*rsa.PrivateKey, string, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, "", err
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "fabric-edge"},
	}, key)
	if err != nil {
		return nil, "", err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
	return key, string(pemBytes), nil
}

// MarshalPrivateKeyPEM encodes an RSA private key as PKCS#1 PEM -- the
// same format main.go, certlife, and this package's own callers already
// write to disk.
func MarshalPrivateKeyPEM(key *rsa.PrivateKey) []byte {
	der := x509.MarshalPKCS1PrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: der})
}
