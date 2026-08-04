package k8ssecret

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/identity"
	"github.com/abluva/fabric/connect-agent/internal/k8ssvc"
)

func writeTestToken(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("fake-token\n"), 0o600); err != nil {
		t.Fatalf("write test token: %v", err)
	}
	return path
}

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

func TestNameForNode(t *testing.T) {
	got := NameForNode("connect-agent-identity", "Node-01.example.com")
	want := "connect-agent-identity-node-01.example.com"
	if got != want {
		t.Errorf("NameForNode = %q, want %q", got, want)
	}
}

func TestLoad_NoSecretYet_ReturnsErrNoIdentity(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	client := k8ssvc.NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	dir := t.TempDir()
	s := New(client, "fabric-edge", "connect-agent-identity-node1", dir, filepath.Join(dir, "..", "agent-id"), "")

	_, err := s.Load(context.Background())
	if err != identity.ErrNoIdentity {
		t.Fatalf("Load with no Secret: got %v, want ErrNoIdentity", err)
	}
}

func TestSaveCert_PushesToSecretAndWarmsCache(t *testing.T) {
	var lastPatchBody []byte
	var lastMethod, lastPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastMethod = r.Method
		lastPath = r.URL.Path
		switch r.Method {
		case http.MethodPatch:
			lastPatchBody, _ = io.ReadAll(r.Body)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	}))
	defer srv.Close()

	client := k8ssvc.NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	dir := t.TempDir()
	s := New(client, "fabric-edge", "connect-agent-identity-node1", dir, filepath.Join(dir, "..", "agent-id"), "")

	certPEM, keyPEM := testLeafPEM(t)
	if err := s.SaveCert(context.Background(), "agt_42", certPEM, keyPEM); err != nil {
		t.Fatalf("SaveCert: %v", err)
	}

	if lastMethod != http.MethodPatch {
		t.Errorf("method = %q, want PATCH", lastMethod)
	}
	if lastPath != "/api/v1/namespaces/fabric-edge/secrets/connect-agent-identity-node1" {
		t.Errorf("path = %q", lastPath)
	}
	var patch struct {
		Data map[string][]byte `json:"data"`
	}
	if err := json.Unmarshal(lastPatchBody, &patch); err != nil {
		t.Fatalf("unmarshal patch body: %v", err)
	}
	if string(patch.Data[keyAgentID]) != "agt_42" {
		t.Errorf("pushed agent-id = %q, want agt_42", string(patch.Data[keyAgentID]))
	}
	if string(patch.Data[keyCertPEM]) != string(certPEM) {
		t.Errorf("pushed tls.crt mismatch")
	}

	// Local cache should be warm too -- Load should now succeed without
	// another API call (the fake server would error on any further
	// request other than the PATCH already asserted above, since this
	// handler doesn't expect a GET).
	id, err := s.Load(context.Background())
	if err != nil {
		t.Fatalf("Load after SaveCert (should hit warm cache): %v", err)
	}
	if id.AgentID != "agt_42" {
		t.Errorf("cached AgentID = %q, want agt_42", id.AgentID)
	}
}

func TestLoad_CacheMiss_FallsBackToSecret(t *testing.T) {
	certPEM, keyPEM := testLeafPEM(t)
	// Marshal through the real k8ssvc.Secret type so []byte fields get the
	// same base64 wire encoding the real Kubernetes API server produces
	// (encoding/json base64-encodes []byte automatically) -- a plain
	// map[string]string here would send unencoded strings and fail to
	// round-trip through GetSecret's json.Unmarshal, unlike a real cluster.
	fakeSecret := k8ssvc.Secret{
		Metadata: k8ssvc.SecretMeta{Name: "connect-agent-identity-node1"},
		Data: map[string][]byte{
			keyAgentID: []byte("agt_from_secret"),
			keyCertPEM: certPEM,
			keyKeyPEM:  keyPEM,
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("unexpected method %s (want GET fallback)", r.Method)
		}
		b, _ := json.Marshal(fakeSecret)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)
	}))
	defer srv.Close()

	client := k8ssvc.NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	dir := t.TempDir()
	// Deliberately do NOT SaveCert first -- local cache is cold, exactly
	// the "pod recreated, emptyDir cache gone" scenario this Store exists
	// to fix. Load must fall through to the Secret, not return
	// ErrNoIdentity.
	s := New(client, "fabric-edge", "connect-agent-identity-node1", dir, filepath.Join(dir, "..", "agent-id"), "")

	id, err := s.Load(context.Background())
	if err != nil {
		t.Fatalf("Load with cold cache: %v", err)
	}
	if id.AgentID != "agt_from_secret" {
		t.Errorf("AgentID = %q, want agt_from_secret", id.AgentID)
	}
	if string(id.CertPEM) != string(certPEM) {
		t.Errorf("CertPEM mismatch after fallback")
	}

	// Cache should now be warmed -- Paths().CertFile should hold the
	// fetched cert (this is the guarantee tunnel.Dial relies on).
	p := s.Paths()
	on, rerr := os.ReadFile(p.CertFile)
	if rerr != nil {
		t.Fatalf("read warmed cache cert: %v", rerr)
	}
	if string(on) != string(certPEM) {
		t.Errorf("warmed cache file mismatch")
	}
}

// TestSaveCert_SecretPushFailure_DoesNotUpdateCache is the regression for
// the durability gap: if the Secret push fails, the local cache (which
// tunnel.Dial and certlife read directly, without going through this
// Store) must NOT already hold the new cert. Cache-then-Secret ordering
// would let a pod recreate load a durable Secret that's now behind what
// every in-process reader believed was already saved.
func TestSaveCert_SecretPushFailure_DoesNotUpdateCache(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate the Secret API being unreachable/erroring for every
		// verb SaveCert's push path can take (PATCH then POST fallback).
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := k8ssvc.NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	dir := t.TempDir()
	s := New(client, "fabric-edge", "connect-agent-identity-node1", dir, filepath.Join(dir, "..", "agent-id"), "")

	// Seed the cache with an OLD cert first (as if a prior successful
	// SaveCert had run), so we can tell whether the failed call below
	// overwrote it.
	oldCertPEM, oldKeyPEM := testLeafPEM(t)
	if err := s.cache.SaveCert(context.Background(), "agt_old", oldCertPEM, oldKeyPEM); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	newCertPEM, newKeyPEM := testLeafPEM(t)
	err := s.SaveCert(context.Background(), "agt_new", newCertPEM, newKeyPEM)
	if err == nil {
		t.Fatal("SaveCert should have failed when the Secret push errors")
	}

	// The local cache must still hold the OLD cert -- not the new one --
	// because the Secret (source of truth) never actually got the new one.
	p := s.Paths()
	onDisk, rerr := os.ReadFile(p.CertFile)
	if rerr != nil {
		t.Fatalf("read cache cert: %v", rerr)
	}
	if string(onDisk) != string(oldCertPEM) {
		t.Error("cache was updated with the new cert despite the Secret push failing -- durability gap regressed")
	}
	if string(onDisk) == string(newCertPEM) {
		t.Error("cache holds the new (unpersisted) cert -- Secret push failure must not leak into the local cache")
	}
}

func TestSaveAPIToken_DoesNotClobberCertKeys(t *testing.T) {
	// pushSecret's merge patch must only ever touch the keys it's given --
	// SaveAPIToken should never send tls.crt/tls.key/agent-id, so a
	// concurrent SaveCert from another loop is never clobbered.
	var lastPatchBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastPatchBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	client := k8ssvc.NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	dir := t.TempDir()
	s := New(client, "fabric-edge", "connect-agent-identity-node1", dir, filepath.Join(dir, "..", "agent-id"), "")

	if err := s.SaveAPIToken(context.Background(), "bearer-xyz"); err != nil {
		t.Fatalf("SaveAPIToken: %v", err)
	}
	var patch struct {
		Data map[string][]byte `json:"data"`
	}
	if err := json.Unmarshal(lastPatchBody, &patch); err != nil {
		t.Fatalf("unmarshal patch: %v", err)
	}
	if len(patch.Data) != 1 {
		t.Errorf("patch touched %d keys, want exactly 1 (agent-api.token): %v", len(patch.Data), patch.Data)
	}
	if string(patch.Data[keyAPIToken]) != "bearer-xyz" {
		t.Errorf("pushed token = %q, want bearer-xyz", string(patch.Data[keyAPIToken]))
	}
}
