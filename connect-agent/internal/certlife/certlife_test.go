package certlife

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/identity"
	"github.com/abluva/fabric/connect-agent/internal/identity/file"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(discardWriter{}, nil))
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

func genLeaf(t *testing.T, notBefore time.Time, ttl time.Duration) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test-agent"},
		NotBefore:    notBefore,
		NotAfter:     notBefore.Add(ttl),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return certPEM, keyPEM
}

func TestMaybeRotate_FreshCert_NoRotation(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	// 7-day cert, just issued -- remaining life is ~100% of TTL, well
	// above the 50% RenewAt threshold.
	certPEM, keyPEM := genLeaf(t, time.Now(), 7*24*time.Hour)
	if err := store.SaveCert(context.Background(), "agt_1", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}

	rotateCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rotateCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := Config{ControlPlaneURL: srv.URL, AgentID: "agt_1", Store: store, RenewAt: 0.5}
	if err := maybeRotate(context.Background(), discardLogger(), cfg); err != nil {
		t.Fatalf("maybeRotate: %v", err)
	}
	if rotateCalled {
		t.Error("rotate endpoint was called for a fresh cert; should not have been")
	}
}

func TestMaybeRotate_PastThreshold_TriggersRotation(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	// 7-day cert issued 5 days ago -- remaining life (~2d) is below 50% of
	// the 7-day TTL (3.5d threshold), so this must trigger rotation.
	certPEM, keyPEM := genLeaf(t, time.Now().Add(-5*24*time.Hour), 7*24*time.Hour)
	if err := store.SaveCert(context.Background(), "agt_1", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}
	oldCertPEM := certPEM

	var rotateCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rotateCalls++
		newCert, _ := genLeaf(t, time.Now(), 7*24*time.Hour)
		resp, _ := json.Marshal(map[string]string{"certificate_pem": string(newCert)})
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	cfg := Config{ControlPlaneURL: srv.URL, AgentID: "agt_1", Store: store, RenewAt: 0.5}
	if err := maybeRotate(context.Background(), discardLogger(), cfg); err != nil {
		t.Fatalf("maybeRotate: %v", err)
	}
	if rotateCalls != 1 {
		t.Fatalf("rotate endpoint called %d times, want exactly 1", rotateCalls)
	}

	id, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load after rotation: %v", err)
	}
	if string(id.CertPEM) == string(oldCertPEM) {
		t.Error("cert was not actually replaced after rotation")
	}
}

func TestMaybeRotate_PastThreshold_InvokesReconnectOnSuccess(t *testing.T) {
	// Regression: certlife.Config.Reconnect must actually be called after
	// a successful rotation -- this is what turns the CP's overlap window
	// into a safety margin instead of the only thing keeping StreamOpen
	// authz working between rotation and the tunnel's next natural
	// reconnect. main.go wires this to closing the live tunnel.Session,
	// but nothing here previously proved the wiring fires at all.
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	certPEM, keyPEM := genLeaf(t, time.Now().Add(-5*24*time.Hour), 7*24*time.Hour)
	if err := store.SaveCert(context.Background(), "agt_1", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		newCert, _ := genLeaf(t, time.Now(), 7*24*time.Hour)
		resp, _ := json.Marshal(map[string]string{"certificate_pem": string(newCert)})
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	reconnectCalls := 0
	cfg := Config{
		ControlPlaneURL: srv.URL,
		AgentID:         "agt_1",
		Store:           store,
		RenewAt:         0.5,
		Reconnect:       func() { reconnectCalls++ },
	}
	if err := maybeRotate(context.Background(), discardLogger(), cfg); err != nil {
		t.Fatalf("maybeRotate: %v", err)
	}
	if reconnectCalls != 1 {
		t.Fatalf("Reconnect called %d times after successful rotation, want exactly 1", reconnectCalls)
	}
}

func TestMaybeRotate_FreshCert_DoesNotInvokeReconnect(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	certPEM, keyPEM := genLeaf(t, time.Now(), 7*24*time.Hour)
	if err := store.SaveCert(context.Background(), "agt_1", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("rotate endpoint should not have been called for a fresh cert")
	}))
	defer srv.Close()

	reconnectCalls := 0
	cfg := Config{
		ControlPlaneURL: srv.URL,
		AgentID:         "agt_1",
		Store:           store,
		RenewAt:         0.5,
		Reconnect:       func() { reconnectCalls++ },
	}
	if err := maybeRotate(context.Background(), discardLogger(), cfg); err != nil {
		t.Fatalf("maybeRotate: %v", err)
	}
	if reconnectCalls != 0 {
		t.Errorf("Reconnect called %d times when no rotation was due, want 0", reconnectCalls)
	}
}

func TestMaybeRotate_RotateFails_DoesNotInvokeReconnect(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	certPEM, keyPEM := genLeaf(t, time.Now().Add(-5*24*time.Hour), 7*24*time.Hour)
	if err := store.SaveCert(context.Background(), "agt_1", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	reconnectCalls := 0
	cfg := Config{
		ControlPlaneURL: srv.URL,
		AgentID:         "agt_1",
		Store:           store,
		RenewAt:         0.5,
		Reconnect:       func() { reconnectCalls++ },
	}
	if err := maybeRotate(context.Background(), discardLogger(), cfg); err == nil {
		t.Fatal("maybeRotate should have returned an error when the rotate call fails")
	}
	if reconnectCalls != 0 {
		t.Errorf("Reconnect called %d times after a FAILED rotation, want 0 -- forcing a reconnect onto a leaf that was never actually rotated would be wrong", reconnectCalls)
	}
}

func TestRotateLeaf_PersistsThroughStore(t *testing.T) {
	dir := t.TempDir()
	store := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")

	// RotateLeaf signs PoP over the currently stored leaf (L3-PKI-01a), so
	// identity must already exist — matching production (post-enroll only).
	oldCertPEM, oldKeyPEM := genLeaf(t, time.Now(), 24*time.Hour)
	if err := store.SaveCert(context.Background(), "agt_9", oldCertPEM, oldKeyPEM); err != nil {
		t.Fatalf("seed SaveCert: %v", err)
	}

	newCert, _ := genLeaf(t, time.Now(), 24*time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents/agt_9/rotate" {
			t.Errorf("path = %s", r.URL.Path)
		}
		resp, _ := json.Marshal(map[string]string{"certificate_pem": string(newCert)})
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	if err := RotateLeaf(context.Background(), srv.URL, "agt_9", store, nil); err != nil {
		t.Fatalf("RotateLeaf: %v", err)
	}

	id, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if id.AgentID != "agt_9" {
		t.Errorf("AgentID = %q, want agt_9 (rotate keeps agent_id)", id.AgentID)
	}
	if string(id.CertPEM) != string(newCert) {
		t.Error("stored cert does not match rotated cert")
	}
}

// failSaveStore wraps a Store so SaveCert fails after N successes. Used to
// prove RotateLeaf returns *persistFailedError with the issued PEMs when
// CP succeeds but local persist does not — StartLoop must retry persist
// only, not call CP again.
type failSaveStore struct {
	inner      *file.Store
	failAfter  int
	saveCalls  int
	lastFail   error
}

func (s *failSaveStore) Load(ctx context.Context) (*identity.Identity, error) {
	return s.inner.Load(ctx)
}
func (s *failSaveStore) SaveAPIToken(ctx context.Context, token string) error {
	return s.inner.SaveAPIToken(ctx, token)
}
func (s *failSaveStore) Paths() identity.FilePaths { return s.inner.Paths() }
func (s *failSaveStore) SaveCert(ctx context.Context, agentID string, certPEM, keyPEM []byte) error {
	s.saveCalls++
	if s.saveCalls > s.failAfter {
		s.lastFail = errors.New("simulated persist failure")
		return s.lastFail
	}
	return s.inner.SaveCert(ctx, agentID, certPEM, keyPEM)
}

func TestRotateLeaf_SaveCertFail_ReturnsPersistFailedError(t *testing.T) {
	dir := t.TempDir()
	inner := file.New(filepath.Join(dir, "tls"), filepath.Join(dir, "agent-id"), "")
	store := &failSaveStore{inner: inner, failAfter: 1} // seed SaveCert OK; rotate SaveCert fails

	oldCertPEM, oldKeyPEM := genLeaf(t, time.Now(), 24*time.Hour)
	if err := store.SaveCert(context.Background(), "agt_pf", oldCertPEM, oldKeyPEM); err != nil {
		t.Fatalf("seed: %v", err)
	}

	newCert, _ := genLeaf(t, time.Now(), 24*time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp, _ := json.Marshal(map[string]string{"certificate_pem": string(newCert)})
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	err := RotateLeaf(context.Background(), srv.URL, "agt_pf", store, nil)
	if err == nil {
		t.Fatal("expected persistFailedError when SaveCert fails after CP rotate")
	}
	var pf *persistFailedError
	if !errors.As(err, &pf) {
		t.Fatalf("got %T %v, want *persistFailedError", err, err)
	}
	if pf.AgentID != "agt_pf" {
		t.Errorf("AgentID = %q", pf.AgentID)
	}
	if string(pf.CertPEM) != string(newCert) {
		t.Error("persistFailedError must carry the CP-issued cert for persist-only retry")
	}
	if len(pf.KeyPEM) == 0 {
		t.Error("persistFailedError must carry the new private key")
	}
	// Disk must still hold the old leaf — callers retry SaveCert with pf.*.
	id, loadErr := inner.Load(context.Background())
	if loadErr != nil {
		t.Fatalf("Load after failed persist: %v", loadErr)
	}
	if string(id.CertPEM) != string(oldCertPEM) {
		t.Error("on-disk cert should remain the pre-rotate leaf when SaveCert fails")
	}
}

func TestEnabled_DefaultOn(t *testing.T) {
	t.Setenv("FABRIC_CERT_AUTO_ROTATE", "")
	if !Enabled() {
		t.Error("Enabled() should default to true (auto-rotation on by default)")
	}
}

func TestEnabled_ExplicitlyDisabled(t *testing.T) {
	t.Setenv("FABRIC_CERT_AUTO_ROTATE", "0")
	if Enabled() {
		t.Error("Enabled() should be false when FABRIC_CERT_AUTO_ROTATE=0")
	}
}

func TestParseCheckInterval_Default(t *testing.T) {
	t.Setenv("FABRIC_CERT_CHECK_INTERVAL", "")
	if got := ParseCheckInterval(); got != time.Hour {
		t.Errorf("ParseCheckInterval default = %v, want 1h", got)
	}
}

func TestParseCheckInterval_Custom(t *testing.T) {
	t.Setenv("FABRIC_CERT_CHECK_INTERVAL", "15m")
	if got := ParseCheckInterval(); got != 15*time.Minute {
		t.Errorf("ParseCheckInterval = %v, want 15m", got)
	}
}
