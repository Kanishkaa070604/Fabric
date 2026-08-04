package k8ssvc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetSecret_NotFoundReturnsNilNil(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	sec, err := c.GetSecret(context.Background(), "fabric-edge", "missing")
	if err != nil {
		t.Fatalf("GetSecret 404: got err %v, want nil", err)
	}
	if sec != nil {
		t.Fatalf("GetSecret 404: got %+v, want nil", sec)
	}
}

func TestGetSecret_DecodesData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/api/v1/namespaces/fabric-edge/secrets/connect-agent-id" {
			t.Errorf("path = %s", r.URL.Path)
		}
		body := Secret{
			Metadata: SecretMeta{Name: "connect-agent-id"},
			Data:     map[string][]byte{"agent-id": []byte("agt_1")},
		}
		b, _ := json.Marshal(body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	sec, err := c.GetSecret(context.Background(), "fabric-edge", "connect-agent-id")
	if err != nil {
		t.Fatalf("GetSecret: %v", err)
	}
	if sec == nil {
		t.Fatal("GetSecret: got nil Secret, want a value")
	}
	if string(sec.Data["agent-id"]) != "agt_1" {
		t.Errorf("Data[agent-id] = %q, want agt_1", string(sec.Data["agent-id"]))
	}
}

func TestEnsureSecret_PatchesExisting(t *testing.T) {
	var gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	err := c.EnsureSecret(context.Background(), "fabric-edge", Secret{
		Metadata: SecretMeta{Name: "connect-agent-id"},
		Data:     map[string][]byte{"agent-id": []byte("agt_1")},
	})
	if err != nil {
		t.Fatalf("EnsureSecret: %v", err)
	}
	if gotMethod != http.MethodPatch {
		t.Errorf("method = %s, want PATCH", gotMethod)
	}
}

func TestEnsureSecret_CreatesWhenMissing(t *testing.T) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPatch:
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPost:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	err := c.EnsureSecret(context.Background(), "fabric-edge", Secret{
		Metadata: SecretMeta{Name: "connect-agent-id"},
	})
	if err != nil {
		t.Fatalf("EnsureSecret: %v", err)
	}
	if len(calls) != 2 || calls[0] != "PATCH /api/v1/namespaces/fabric-edge/secrets/connect-agent-id" || calls[1] != "POST /api/v1/namespaces/fabric-edge/secrets" {
		t.Errorf("unexpected call sequence: %v", calls)
	}
}

// TestEnsureSecret_CreateRace_FollowsUpWithPatch is the regression for
// P2#4: unlike EnsureService (whose 409-is-success shortcut is safe
// because Service reconciliation re-runs on every poll tick regardless of
// who wins), a Secret create-race must follow up with a PATCH so the
// race loser's own data actually gets merged onto whatever the winner
// created, instead of being silently dropped while its caller
// (SaveCert/SaveAPIToken -- one-shot calls, not recurring ticks) believes
// the save succeeded.
func TestEnsureSecret_CreateRace_FollowsUpWithPatch(t *testing.T) {
	var calls []string
	var finalPatchBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.Method {
		case http.MethodPatch:
			if len(calls) == 1 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			body, _ := io.ReadAll(r.Body)
			finalPatchBody = body
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
		}
	}))
	defer srv.Close()

	c := NewClientForTest(srv.URL, srv.Client(), writeTestToken(t))
	err := c.EnsureSecret(context.Background(), "fabric-edge", Secret{
		Metadata: SecretMeta{Name: "x"},
		Data:     map[string][]byte{"agent-id": []byte("agt_1")},
	})
	if err != nil {
		t.Fatalf("EnsureSecret should follow up a create-race 409 with a PATCH, got error: %v", err)
	}
	if len(calls) != 3 {
		t.Fatalf("expected PATCH, POST, PATCH (3 calls), got %v", calls)
	}
	var patch struct {
		Data map[string][]byte `json:"data"`
	}
	if err := json.Unmarshal(finalPatchBody, &patch); err != nil {
		t.Fatalf("unmarshal follow-up patch body: %v", err)
	}
	if string(patch.Data["agent-id"]) != "agt_1" {
		t.Error("follow-up PATCH did not carry the race loser's own data -- it would have been silently dropped")
	}
}
