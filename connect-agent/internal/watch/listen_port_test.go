package watch

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestReportListenPort_PostsObservedBody(t *testing.T) {
	var mu sync.Mutex
	var gotPath string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	m := &Manager{
		Log:             slog.Default(),
		ControlPlaneURL: srv.URL,
		AgentID:         "agent-1",
		HTTPClient:      srv.Client(),
	}
	reg := Registration{
		ID:         "11111111-1111-1111-1111-111111111111",
		Generation: 3,
	}
	m.reportListenPort(context.Background(), reg, 9444)

	mu.Lock()
	defer mu.Unlock()
	if gotPath != "/v1/registrations/"+reg.ID+"/observed" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotBody["condition"] != "Listener" {
		t.Errorf("condition = %v", gotBody["condition"])
	}
	if gotBody["reachable"] != "true" {
		t.Errorf("reachable = %v", gotBody["reachable"])
	}
	if gotBody["observed_generation"] != float64(3) {
		t.Errorf("observed_generation = %v", gotBody["observed_generation"])
	}
	if gotBody["listen_port"] != float64(9444) {
		t.Errorf("listen_port = %v, want 9444", gotBody["listen_port"])
	}
}

func TestProbeAndReport_PreservesListenPort(t *testing.T) {
	var mu sync.Mutex
	var gotBody map[string]any

	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer cp.Close()

	// Accept a TCP dial so reachable=true.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	host, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}

	m := &Manager{
		Log:             slog.Default(),
		ControlPlaneURL: cp.URL,
		AgentID:         "agent-1",
		HTTPClient:      cp.Client(),
		ProbeTimeout:    time.Second,
		ports:           map[string]int{"reg-1": 9444},
	}
	m.probeAndReport(context.Background(), Registration{
		ID:         "reg-1",
		Host:       host,
		Port:       port,
		Generation: 1,
	})

	mu.Lock()
	defer mu.Unlock()
	if gotBody["listen_port"] != float64(9444) {
		t.Fatalf("probe body missing listen_port: %+v", gotBody)
	}
	if gotBody["reachable"] != "true" {
		t.Errorf("reachable = %v", gotBody["reachable"])
	}
}

func TestReportListenPort_SkipsInvalid(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	m := &Manager{
		Log:             slog.Default(),
		ControlPlaneURL: srv.URL,
		AgentID:         "agent-1",
		HTTPClient:      srv.Client(),
	}
	m.reportListenPort(context.Background(), Registration{ID: "r1"}, 0)
	if called {
		t.Fatal("expected no POST for listen_port=0")
	}
}
