package file

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/identity"
)

func TestLoad_NoIdentityWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	s := New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	_, err := s.Load(context.Background())
	if err != identity.ErrNoIdentity {
		t.Fatalf("Load on empty dir: got %v, want ErrNoIdentity", err)
	}
}

func TestSaveCert_ThenLoad_RoundTrips(t *testing.T) {
	dir := t.TempDir()
	s := New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	certPEM, keyPEM := testLeafPEM(t)

	if err := s.SaveCert(context.Background(), "agt_123", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}

	id, err := s.Load(context.Background())
	if err != nil {
		t.Fatalf("Load after SaveCert: %v", err)
	}
	if id.AgentID != "agt_123" {
		t.Errorf("AgentID = %q, want agt_123", id.AgentID)
	}
	if string(id.CertPEM) != string(certPEM) {
		t.Errorf("CertPEM mismatch")
	}
	if string(id.KeyPEM) != string(keyPEM) {
		t.Errorf("KeyPEM mismatch")
	}
	if id.APIToken != "" {
		t.Errorf("APIToken = %q, want empty (never saved)", id.APIToken)
	}
}

func TestSaveAPIToken_ThenLoad_IncludesToken(t *testing.T) {
	dir := t.TempDir()
	s := New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	certPEM, keyPEM := testLeafPEM(t)
	if err := s.SaveCert(context.Background(), "agt_1", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}
	if err := s.SaveAPIToken(context.Background(), "  bearer-abc  \n"); err != nil {
		t.Fatalf("SaveAPIToken: %v", err)
	}
	id, err := s.Load(context.Background())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if id.APIToken != "bearer-abc" {
		t.Errorf("APIToken = %q, want trimmed bearer-abc", id.APIToken)
	}
}

func TestLoad_AgentIDPresentCertMissing_IsNoIdentity(t *testing.T) {
	// Documented cert-loss case (Architecture-Resolutions.md): agent-id
	// survives but tls.crt/tls.key are gone. Must be treated the same as
	// "no identity at all" -- the caller decides whether a bootstrap
	// window is still open, not this Store.
	dir := t.TempDir()
	idPath := filepath.Join(dir, "agent-id")
	if err := os.WriteFile(idPath, []byte("agt_orphan"), 0o600); err != nil {
		t.Fatalf("seed agent-id: %v", err)
	}
	s := New(filepath.Join(dir, "tls"), idPath, "")
	_, err := s.Load(context.Background())
	if err != identity.ErrNoIdentity {
		t.Fatalf("Load with agent-id but no cert: got %v, want ErrNoIdentity", err)
	}
}

func TestPaths_AreStable(t *testing.T) {
	dir := t.TempDir()
	s := New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), filepath.Join(dir, "tls", "agent-api.token"))
	p1 := s.Paths()
	p2 := s.Paths()
	if p1 != p2 {
		t.Errorf("Paths() not stable across calls: %+v vs %+v", p1, p2)
	}
	if p1.CertFile != filepath.Join(dir, "tls", "tls.crt") {
		t.Errorf("CertFile = %q", p1.CertFile)
	}
}

// testLeafPEM returns a throwaway self-signed cert + key PEM. file.Store's
// Load parses the cert (to fail loud on a truncated/corrupt file), so
// tests need something that actually parses, not just PEM-shaped bytes.
func testLeafPEM(t *testing.T) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test-agent"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return certPEM, keyPEM
}
