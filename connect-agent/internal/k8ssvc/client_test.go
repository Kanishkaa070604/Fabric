package k8ssvc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
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

func TestEnsureService_PatchesExistingService(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	desired := Service{
		Metadata: ObjectMeta{
			Name:        "connect-agent",
			Labels:      map[string]string{"app": "connect-agent"},
			Annotations: map[string]string{"fabric.abluva.io/registration-ports": `{"a":9443}`},
		},
		Spec: ServiceSpec{
			Selector:              map[string]string{"app": "connect-agent"},
			Ports:                 []ServicePort{{Name: "r-a", Protocol: "TCP", Port: 9443, TargetPort: 9443}},
			InternalTrafficPolicy: "Local",
		},
	}
	if err := c.EnsureService(context.Background(), "fabric-edge", desired); err != nil {
		t.Fatalf("EnsureService: %v", err)
	}
	if gotMethod != http.MethodPatch {
		t.Errorf("method = %q, want PATCH", gotMethod)
	}
	if gotPath != "/api/v1/namespaces/fabric-edge/services/connect-agent" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Bearer fake-token" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	var patch map[string]any
	if err := json.Unmarshal(gotBody, &patch); err != nil {
		t.Fatalf("unmarshal patch body: %v", err)
	}
	spec, ok := patch["spec"].(map[string]any)
	if !ok {
		t.Fatalf("patch body missing spec: %v", patch)
	}
	if spec["internalTrafficPolicy"] != "Local" {
		t.Errorf("internalTrafficPolicy = %v, want Local", spec["internalTrafficPolicy"])
	}
}

func TestEnsureService_CreatesWhenMissing(t *testing.T) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPatch:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","status":"Failure","reason":"NotFound"}`))
		case http.MethodPost:
			body, _ := io.ReadAll(r.Body)
			var svc Service
			if err := json.Unmarshal(body, &svc); err != nil {
				t.Errorf("unmarshal create body: %v", err)
			}
			if svc.Metadata.Namespace != "fabric-edge" {
				t.Errorf("create body namespace = %q, want fabric-edge", svc.Metadata.Namespace)
			}
			if svc.APIVersion != "v1" || svc.Kind != "Service" {
				t.Errorf("create body apiVersion/kind = %q/%q", svc.APIVersion, svc.Kind)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	desired := Service{
		Metadata: ObjectMeta{Name: "connect-agent"},
		Spec: ServiceSpec{
			Ports:                 []ServicePort{{Port: 9443, TargetPort: 9443}},
			InternalTrafficPolicy: "Local",
		},
	}
	if err := c.EnsureService(context.Background(), "fabric-edge", desired); err != nil {
		t.Fatalf("EnsureService: %v", err)
	}
	if len(calls) != 2 || calls[0] != "PATCH /api/v1/namespaces/fabric-edge/services/connect-agent" || calls[1] != "POST /api/v1/namespaces/fabric-edge/services" {
		t.Errorf("unexpected call sequence: %v", calls)
	}
}

func TestEnsureService_CreateRaceTreatedAsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPost:
			// Simulates another process having created it in between our
			// PATCH's 404 and this POST.
			w.WriteHeader(http.StatusConflict)
		}
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	desired := Service{Metadata: ObjectMeta{Name: "connect-agent"}}
	if err := c.EnsureService(context.Background(), "fabric-edge", desired); err != nil {
		t.Fatalf("EnsureService should treat a create-race 409 as success, got: %v", err)
	}
}

func TestEnsureService_PatchServerErrorReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	desired := Service{Metadata: ObjectMeta{Name: "connect-agent"}}
	err := c.EnsureService(context.Background(), "fabric-edge", desired)
	if err == nil {
		t.Fatal("expected an error on a 500 response, got nil")
	}
}

func TestEnsureSecret_CreateRacePatchAlsoFails_ReturnsError(t *testing.T) {
	var patchCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			patchCalls++
			if patchCalls == 1 {
				// Initial PATCH: Secret doesn't exist yet -- reach the create path.
				w.WriteHeader(http.StatusNotFound)
				return
			}
			// Create-race follow-up PATCH also fails.
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("boom"))
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
		}
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	desired := Secret{Metadata: SecretMeta{Name: "connect-agent-identity-node1"}}
	err := c.EnsureSecret(context.Background(), "fabric-edge", desired)
	if err == nil {
		t.Fatal("EnsureSecret should surface an error when both the initial PATCH-404 path and the create-race follow-up PATCH fail")
	}
}
