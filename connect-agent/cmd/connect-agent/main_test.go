package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/config"
	"github.com/abluva/fabric/connect-agent/internal/enroll/bootstrap"
	"github.com/abluva/fabric/connect-agent/internal/identity"
	"github.com/abluva/fabric/connect-agent/internal/identity/file"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(discardWriter{}, nil))
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

func genLeafPEM(t *testing.T) (certPEM, keyPEM []byte) {
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

// TestEnsureIdentity_PreMintedCert_BindsFingerprint_NotCSR is the direct
// regression test for smoke-lifecycle.sh's scenario: a leaf cert+key is
// placed on disk by hand before first boot (no agent-id yet). ensureIdentity
// must bind by fingerprint and must NOT generate a fresh CSR that would
// silently replace the pre-minted cert the test script asserts against by
// its known fingerprint.
func TestEnsureIdentity_PreMintedCert_BindsFingerprint_NotCSR(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	preMintedCert, preMintedKey := genLeafPEM(t)
	paths := store.Paths()
	if err := os.MkdirAll(filepath.Dir(paths.CertFile), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(paths.CertFile, preMintedCert, 0o600); err != nil {
		t.Fatalf("write pre-minted cert: %v", err)
	}
	if err := os.WriteFile(paths.KeyFile, preMintedKey, 0o600); err != nil {
		t.Fatalf("write pre-minted key: %v", err)
	}

	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode enroll body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"agt_fp_1","state":"PendingApproval"}`))
	}))
	defer srv.Close()

	cfg := config.Config{TenantID: "ten_1", Substrate: "kubernetes"}
	method := bootstrap.Method{Token: "boot-tok"}

	agentID, err := ensureIdentity(context.Background(), discardLogger(), cfg, srv.URL, store, method)
	if err != nil {
		t.Fatalf("ensureIdentity: %v", err)
	}
	if agentID != "agt_fp_1" {
		t.Errorf("agentID = %q, want agt_fp_1", agentID)
	}

	// The critical assertion: enroll must have been called with
	// cert_fingerprint_sha256 set (fingerprint bind), and *not* with
	// csr_pem (which would mean a fresh keypair was generated, discarding
	// the pre-minted one).
	if gotBody["cert_fingerprint_sha256"] == nil || gotBody["cert_fingerprint_sha256"] == "" {
		t.Errorf("enroll body missing cert_fingerprint_sha256: %v", gotBody)
	}
	if _, hasCSR := gotBody["csr_pem"]; hasCSR {
		t.Errorf("enroll body should not include csr_pem for a pre-minted cert bind: %v", gotBody)
	}

	// The pre-minted cert/key on disk must be byte-for-byte unchanged --
	// this is the actual regression: a naive "always CSR" rewrite would
	// have overwritten these with a freshly generated keypair.
	onDiskCert, _ := os.ReadFile(paths.CertFile)
	onDiskKey, _ := os.ReadFile(paths.KeyFile)
	if string(onDiskCert) != string(preMintedCert) {
		t.Error("pre-minted cert was overwritten -- fingerprint bind must preserve the original cert")
	}
	if string(onDiskKey) != string(preMintedKey) {
		t.Error("pre-minted key was overwritten -- fingerprint bind must preserve the original key")
	}
}

// TestEnsureIdentity_PreMintedCert_NoEnrollMethod_ToleratesAndContinues
// mirrors the old "enroll_skipped_or_failed ... continuing to tunnel
// dial" tolerance: local dial-only smoke can have a pre-minted cert with
// no bootstrap token at all, and ensureIdentity must not fail closed in
// that case (only a fresh-CSR path with no cert on disk does).
func TestEnsureIdentity_PreMintedCert_NoEnrollMethod_ToleratesAndContinues(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	preMintedCert, preMintedKey := genLeafPEM(t)
	paths := store.Paths()
	if err := os.MkdirAll(filepath.Dir(paths.CertFile), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	_ = os.WriteFile(paths.CertFile, preMintedCert, 0o600)
	_ = os.WriteFile(paths.KeyFile, preMintedKey, 0o600)

	cfg := config.Config{TenantID: "ten_1", Substrate: "kubernetes"}
	method := bootstrap.Method{} // no token configured

	agentID, err := ensureIdentity(context.Background(), discardLogger(), cfg, "http://unused", store, method)
	if err != nil {
		t.Fatalf("ensureIdentity should tolerate a missing enroll method when a pre-minted cert exists, got: %v", err)
	}
	if agentID != "" {
		t.Errorf("agentID = %q, want empty (no control-plane binding happened)", agentID)
	}
}

// TestEnsureIdentity_NoCertAtAll_NoEnrollMethod_FailsClosed is the fresh-
// install case: nothing on disk, no bootstrap token. This must fail
// closed (matches the old "!hasLeaf" branch's os.Exit(1)).
func TestEnsureIdentity_NoCertAtAll_NoEnrollMethod_FailsClosed(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	cfg := config.Config{TenantID: "ten_1", Substrate: "kubernetes"}
	method := bootstrap.Method{}

	_, err := ensureIdentity(context.Background(), discardLogger(), cfg, "http://unused", store, method)
	if err == nil {
		t.Fatal("expected an error with no cert and no enroll method, got nil")
	}
}

// TestEnsureIdentity_NoCertAtAll_GeneratesCSR is the normal fresh-install
// path: no cert on disk, valid bootstrap token -- must generate a CSR.
func TestEnsureIdentity_NoCertAtAll_GeneratesCSR(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")

	var gotBody map[string]any
	newCert, newKey := genLeafPEM(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode enroll body: %v", err)
		}
		resp, _ := json.Marshal(map[string]string{
			"id":              "agt_csr_1",
			"state":           "PendingApproval",
			"certificate_pem": string(newCert),
		})
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	cfg := config.Config{TenantID: "ten_1", Substrate: "kubernetes"}
	method := bootstrap.Method{Token: "boot-tok"}

	agentID, err := ensureIdentity(context.Background(), discardLogger(), cfg, srv.URL, store, method)
	if err != nil {
		t.Fatalf("ensureIdentity: %v", err)
	}
	if agentID != "agt_csr_1" {
		t.Errorf("agentID = %q, want agt_csr_1", agentID)
	}
	if _, hasCSR := gotBody["csr_pem"]; !hasCSR {
		t.Errorf("enroll body missing csr_pem for a fresh install: %v", gotBody)
	}
	if gotBody["cert_fingerprint_sha256"] != nil && gotBody["cert_fingerprint_sha256"] != "" {
		t.Errorf("enroll body should not include a fingerprint for a fresh CSR install: %v", gotBody)
	}

	id, lerr := store.Load(context.Background())
	if lerr != nil {
		t.Fatalf("Load after fresh enroll: %v", lerr)
	}
	if string(id.CertPEM) != string(newCert) {
		t.Error("stored cert does not match the control-plane-issued cert")
	}
	_ = newKey // key was generated locally, never sent to the server
}

// TestEnsureIdentity_AlreadyHasIdentity_SkipsEnroll covers the steady-state
// restart case: identity.Store already has a leaf -- no enroll call at
// all, regardless of which enroll.Method is configured.
func TestEnsureIdentity_AlreadyHasIdentity_SkipsEnroll(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	certPEM, keyPEM := genLeafPEM(t)
	if err := store.SaveCert(context.Background(), "agt_existing", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}

	enrollCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		enrollCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := config.Config{TenantID: "ten_1", Substrate: "kubernetes"}
	method := bootstrap.Method{Token: "boot-tok"}

	agentID, err := ensureIdentity(context.Background(), discardLogger(), cfg, srv.URL, store, method)
	if err != nil {
		t.Fatalf("ensureIdentity: %v", err)
	}
	if agentID != "agt_existing" {
		t.Errorf("agentID = %q, want agt_existing (from existing identity, no enroll)", agentID)
	}
	if enrollCalled {
		t.Error("enroll was called even though identity already existed")
	}
}

// TestNewIdentityStore_DefaultsToFile confirms an unconfigured
// FABRIC_IDENTITY_STORE behaves exactly as before this abstraction existed.
func TestNewIdentityStore_DefaultsToFile(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{CertDir: filepath.Join(dir, "tls"), AgentIDPath: filepath.Join(dir, "agent-id")}
	store, err := newIdentityStore(cfg)
	if err != nil {
		t.Fatalf("newIdentityStore: %v", err)
	}
	if _, ok := store.(*file.Store); !ok {
		t.Errorf("default IdentityStore = %T, want *file.Store", store)
	}
}

// TestNewIdentityStore_UnknownKindErrors confirms a typo'd
// FABRIC_IDENTITY_STORE fails closed at startup rather than silently
// falling back to something unexpected.
func TestNewIdentityStore_UnknownKindErrors(t *testing.T) {
	cfg := config.Config{IdentityStore: "not-a-real-store"}
	if _, err := newIdentityStore(cfg); err == nil {
		t.Fatal("expected an error for an unknown identity store kind, got nil")
	}
}

var _ identity.Store = (*file.Store)(nil) // compile-time interface check
