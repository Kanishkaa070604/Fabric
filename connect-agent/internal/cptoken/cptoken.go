// Package cptoken implements G-CRED-1 / L3-CRED-01: Agent API bearer,
// refreshed via leaf-authenticated pull from the control plane.
//
// Substrate-neutral: reads/writes go through a local file path exactly as
// before (every identity.Store implementation guarantees that path stays
// in sync with wherever the real backing store is -- see
// internal/identity's package doc), plus an optional identity.Store
// reference so a write here also reaches a remote backing store (e.g. a
// Kubernetes Secret) when one is configured, not just the local cache.
package cptoken

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/identity"
)

// Store holds the scoped Agent API bearer on disk (not process env).
type Store struct {
	Path       string
	mu         sync.RWMutex
	cached     string
	HTTPClient *http.Client

	// IdentityStore receives every successful Write. main.go always sets
	// this to whatever identity.Store the substrate resolved to (file.Store
	// on VM/ECS/Docker, k8ssecret.Store on Kubernetes) -- routing every
	// substrate through the one Store.SaveAPIToken call, rather than
	// special-casing "kubernetes" here and falling back to a duplicate
	// plain-file write for everything else, means there's exactly one
	// code path that decides what "persist this bearer" means, and
	// file.Store's own SaveAPIToken already does the identical plain
	// write this field's fallback used to. Nil is still handled (Write
	// falls back to writing s.Path directly) for callers/tests that don't
	// wire an identity.Store at all.
	IdentityStore identity.Store
}

// DefaultPath is under the identity volume next to the leaf.
func DefaultPath(certDir string) string {
	if p := os.Getenv("FABRIC_AGENT_API_TOKEN_FILE"); p != "" {
		return p
	}
	return filepath.Join(certDir, "agent-api.token")
}

// Read returns the current bearer (file, then in-memory cache).
func (s *Store) Read() (string, error) {
	s.mu.RLock()
	c := s.cached
	s.mu.RUnlock()
	if c != "" {
		return c, nil
	}
	b, err := os.ReadFile(s.Path)
	if err == nil {
		tok := strings.TrimSpace(string(b))
		if tok != "" {
			s.mu.Lock()
			s.cached = tok
			s.mu.Unlock()
			return tok, nil
		}
	}
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	return "", nil
}

// Write persists the bearer and updates the cache. When IdentityStore is
// set (the normal case -- see its doc comment), persistence is delegated
// to it entirely: every implementation's SaveAPIToken writes s.Path
// itself (file.Store plainly; k8ssecret.Store via its embedded file.Store
// cache, then also pushes the Secret), so Write does not also write
// s.Path directly in that case, to avoid two independent writers racing
// the same file. IdentityStore nil (no Store wired at all) is the only
// case Write falls back to writing s.Path itself.
func (s *Store) Write(tok string) error {
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return fmt.Errorf("empty token")
	}
	if s.IdentityStore != nil {
		if err := s.IdentityStore.SaveAPIToken(context.Background(), tok); err != nil {
			return fmt.Errorf("persist bearer to identity store: %w", err)
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(s.Path, []byte(tok+"\n"), 0o600); err != nil {
			return err
		}
	}
	s.mu.Lock()
	s.cached = tok
	s.mu.Unlock()
	return nil
}

// SetAuthHeader sets Authorization from the local file (re-read each call).
func (s *Store) SetAuthHeader(req *http.Request) {
	tok, err := s.Read()
	if err != nil || tok == "" {
		return
	}
	req.Header.Set("Authorization", "Bearer "+tok)
}

// DefaultTokenOverlapSeconds mirrors control-plane's
// DEFAULT_TOKEN_OVERLAP_SECONDS (control-plane/src/store/types.ts) -- see
// certlife.DefaultCertOverlapSeconds's doc comment for why this is named
// here instead of left as a bare literal, and why the two languages can't
// literally share one constant.
const DefaultTokenOverlapSeconds = 3600

// PullCurrent asks CP for a fresh bearer, authenticated by leaf PoP
// (no prior bearer required). Re-issues with overlap on the server so other
// Agent instances keep working until they pull.
func (s *Store) PullCurrent(ctx context.Context, controlPlaneURL, agentID, certFile, keyFile string) error {
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return fmt.Errorf("read cert: %w", err)
	}
	keyPEM, err := os.ReadFile(keyFile)
	if err != nil {
		return fmt.Errorf("read key: %w", err)
	}
	signedAt, sigB64, err := SignPoP(agentID, keyPEM)
	if err != nil {
		return err
	}
	// D1: present current bearer when we have one so CP can reuse it (no mint)
	// until near expiry — stops N instances stomping a single prior slot.
	reqBody := map[string]any{
		"certificate_pem": string(certPEM),
		"signed_at":       signedAt,
		"signature_b64":   sigB64,
		"overlap_seconds": DefaultTokenOverlapSeconds, // D5-A: keep ≥ refresh interval (default refresh 1h)
	}
	if cur, rerr := s.Read(); rerr == nil && strings.TrimSpace(cur) != "" {
		reqBody["current_agent_api_token"] = strings.TrimSpace(cur)
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("marshal api-token request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(controlPlaneURL, "/")+"/v1/agents/"+agentID+"/api-token/current",
		bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ABLV-Actor", "agent")
	client := s.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	respBody, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("read api-token response: %w", err)
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("api-token/current status=%d body=%s", res.StatusCode, string(respBody))
	}
	var out struct {
		AgentAPIToken string `json:"agent_api_token"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return err
	}
	if out.AgentAPIToken == "" {
		return fmt.Errorf("api-token/current missing agent_api_token")
	}
	return s.Write(out.AgentAPIToken)
}

// StartRefreshLoop pulls on an interval (default 1h). Interval "0" disables.
// With CP reuse-if-fresh, most ticks are a cheap no-op (same bearer returned);
// minting only happens near expiry or force_renew — so sub-hourly refresh is unnecessary.
func (s *Store) StartRefreshLoop(ctx context.Context, controlPlaneURL, agentID, certFile, keyFile string, logFn func(msg string, kv ...any)) {
	raw := strings.TrimSpace(os.Getenv("FABRIC_AGENT_TOKEN_REFRESH"))
	if raw == "0" {
		return
	}
	d := time.Hour
	if raw != "" {
		if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
			d = parsed
		}
	}
	if logFn != nil {
		logFn("agent_api_token_refresh_loop", "interval", d.String())
	}
	t := time.NewTicker(d)
	go func() {
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := s.PullCurrent(ctx, controlPlaneURL, agentID, certFile, keyFile); err != nil {
					if logFn != nil {
						logFn("agent_api_token_refresh_failed", "error", err.Error())
					}
					continue
				}
				if logFn != nil {
					logFn("agent_api_token_refreshed", "path", s.Path)
				}
			}
		}
	}()
}

// SignPoP produces the leaf proof-of-possession signature this package's
// own api-token/current pull uses, and that certlife.RotateLeaf also
// needs (L3-PKI-01a) so mid-life rotation is bound to "whoever holds this
// agent_id's leaf private key," not just "whoever holds the tenant's
// shared Agent API bearer." Exported so certlife doesn't need its own
// copy of the RSA-SHA256/PKCS#1v1.5 signing logic or the wire message
// format (`agentID\nsignedAt`) -- both call sites must stay byte-for-byte
// identical with verifyAgentLeafPop on the control-plane side.
func SignPoP(agentID string, keyPEM []byte) (signedAt int64, signatureB64 string, err error) {
	key, err := parseRSAPrivateKey(keyPEM)
	if err != nil {
		return 0, "", err
	}
	signedAt = time.Now().Unix()
	msg := fmt.Sprintf("%s\n%d", agentID, signedAt)
	sum := sha256.Sum256([]byte(msg))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return 0, "", fmt.Errorf("sign pop: %w", err)
	}
	return signedAt, base64.StdEncoding.EncodeToString(sig), nil
}

func parseRSAPrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("no PEM block in key file")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("not an RSA private key")
	}
	return rk, nil
}
