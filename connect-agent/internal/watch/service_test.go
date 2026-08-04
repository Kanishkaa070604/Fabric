package watch

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/abluva/fabric/connect-agent/internal/k8ssvc"
)

func TestBuildDesiredService_OnePortPerRegistration(t *testing.T) {
	cfg := ServiceConfig{
		Enabled:   true,
		Name:      "connect-agent",
		Namespace: "fabric-edge",
		Selector:  map[string]string{"app": "connect-agent"},
	}
	ports := map[string]int{
		"reg-1111": 9443,
		"reg-2222": 9444,
		"reg-3333": 9445,
	}
	svc := buildDesiredService(cfg, ports)

	if svc.Metadata.Name != "connect-agent" || svc.Metadata.Namespace != "fabric-edge" {
		t.Fatalf("unexpected metadata: %+v", svc.Metadata)
	}
	if len(svc.Spec.Ports) != 3 {
		t.Fatalf("got %d ports, want one per registration (3): %+v", len(svc.Spec.Ports), svc.Spec.Ports)
	}
	if svc.Spec.InternalTrafficPolicy != "Local" {
		t.Errorf("InternalTrafficPolicy = %q, want Local -- see bug write-up finding 2", svc.Spec.InternalTrafficPolicy)
	}
	if svc.Spec.Selector["app"] != "connect-agent" {
		t.Errorf("selector not carried through: %+v", svc.Spec.Selector)
	}

	seenPorts := map[int32]bool{}
	seenNames := map[string]bool{}
	for _, p := range svc.Spec.Ports {
		if p.Port != p.TargetPort {
			t.Errorf("port %d != targetPort %d, must match (no remapping)", p.Port, p.TargetPort)
		}
		if p.Protocol != "TCP" {
			t.Errorf("protocol = %q, want TCP", p.Protocol)
		}
		if seenPorts[p.Port] {
			t.Errorf("duplicate port %d in Service spec", p.Port)
		}
		seenPorts[p.Port] = true
		if seenNames[p.Name] {
			t.Errorf("duplicate port name %q in Service spec", p.Name)
		}
		seenNames[p.Name] = true
		if len(p.Name) > 15 {
			t.Errorf("port name %q exceeds Kubernetes' 15-char IANA_SVC_NAME limit", p.Name)
		}
	}
	for id, port := range ports {
		if !seenPorts[int32(port)] {
			t.Errorf("registration %s's port %d missing from Service spec", id, port)
		}
	}
}

func TestBuildDesiredService_AnnotationCarriesFullRegistrationIDs(t *testing.T) {
	cfg := ServiceConfig{Name: "connect-agent", Namespace: "fabric-edge"}
	ports := map[string]int{
		"11111111-1111-1111-1111-111111111111": 9443,
		"22222222-2222-2222-2222-222222222222": 9444,
	}
	svc := buildDesiredService(cfg, ports)

	raw, ok := svc.Metadata.Annotations[registrationPortsAnnotation]
	if !ok {
		t.Fatalf("missing %s annotation", registrationPortsAnnotation)
	}
	var decoded map[string]int
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("annotation not valid JSON: %v", err)
	}
	if decoded["11111111-1111-1111-1111-111111111111"] != 9443 {
		t.Errorf("annotation missing/wrong for reg 1: %+v", decoded)
	}
	if decoded["22222222-2222-2222-2222-222222222222"] != 9444 {
		t.Errorf("annotation missing/wrong for reg 2: %+v", decoded)
	}
}

func TestBuildDesiredService_EmptyPortsStillProducesValidService(t *testing.T) {
	svc := buildDesiredService(ServiceConfig{Name: "connect-agent", Namespace: "fabric-edge"}, map[string]int{})
	if len(svc.Spec.Ports) != 0 {
		t.Errorf("expected zero ports, got %d", len(svc.Spec.Ports))
	}
	if svc.Spec.InternalTrafficPolicy != "Local" {
		t.Errorf("InternalTrafficPolicy must stay Local even with no ports yet")
	}
}

func TestBuildDesiredService_DeterministicAcrossCalls(t *testing.T) {
	cfg := ServiceConfig{Name: "connect-agent", Namespace: "fabric-edge"}
	ports := map[string]int{"reg-a": 9443, "reg-b": 9444, "reg-c": 9445}
	first := buildDesiredService(cfg, ports)
	second := buildDesiredService(cfg, ports)
	b1, _ := json.Marshal(first.Spec.Ports)
	b2, _ := json.Marshal(second.Spec.Ports)
	if string(b1) != string(b2) {
		t.Errorf("buildDesiredService is not deterministic across identical inputs:\n%s\nvs\n%s", b1, b2)
	}
}

func TestUniquePortName_DedupesCollisionsRatherThanOverwriting(t *testing.T) {
	// Two IDs that normalize to the same first characters after
	// truncation -- exercises the collision-suffix path directly rather
	// than relying on finding two real UUIDs that happen to collide.
	used := map[string]bool{}
	n1 := uniquePortName("aaaaaaaaaaaaaaaaaaaaaaaa", used)
	used[n1] = true
	n2 := uniquePortName("aaaaaaaaaaaaaaaaaaaaaaab", used)
	if n1 == n2 {
		t.Fatalf("expected distinct names, got %q twice", n1)
	}
	if len(n1) > 15 || len(n2) > 15 {
		t.Errorf("port names exceed 15 chars: %q, %q", n1, n2)
	}
}

func TestReconcileService_CallsEnsureServiceWithCurrentPorts(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		gotBody = buf[:n]
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenPath, []byte("fake"), 0o600); err != nil {
		t.Fatalf("write token: %v", err)
	}
	cl := k8ssvc.NewClientForTest(srv.URL, srv.Client(), tokenPath)

	m := &Manager{
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		ServiceCfg: ServiceConfig{Name: "connect-agent", Namespace: "fabric-edge", Selector: map[string]string{"app": "connect-agent"}},
	}
	m.k8sClient = cl
	m.reconcileService(context.Background(), map[string]int{"reg-1": 9443})

	if len(gotBody) == 0 {
		t.Fatal("expected EnsureService to make an HTTP call, got no body")
	}
}
