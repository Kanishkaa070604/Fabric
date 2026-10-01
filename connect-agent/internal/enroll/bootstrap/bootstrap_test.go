package bootstrap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/abluva/fabric/connect-agent/internal/enroll"
)

func TestMethod_Credentials_ReturnsToken(t *testing.T) {
	m := Method{Token: "boot-abc"}
	creds, err := m.Credentials(context.Background())
	if err != nil {
		t.Fatalf("Credentials: %v", err)
	}
	if creds.Method != "bootstrap_token" {
		t.Errorf("Method = %q, want bootstrap_token", creds.Method)
	}
	if creds.BootstrapToken != "boot-abc" {
		t.Errorf("BootstrapToken = %q, want boot-abc", creds.BootstrapToken)
	}
}

func TestMethod_Credentials_EmptyTokenErrors(t *testing.T) {
	m := Method{}
	_, err := m.Credentials(context.Background())
	if err == nil {
		t.Fatal("expected an error for an empty bootstrap token, got nil")
	}
}

func TestEnroll_SendsJoinMethodAndCredentials(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents/enroll" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"agt_1","state":"PendingApproval","certificate_pem":"CERT"}`))
	}))
	defer srv.Close()

	creds := enroll.Credentials{Method: "bootstrap_token", BootstrapToken: "tok-1"}
	res, err := Enroll(context.Background(), srv.URL, "ten_1", creds, "", "CSR", "kubernetes", "", "seed-bearer")
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if res.AgentID != "agt_1" || res.State != "PendingApproval" || res.CertificatePEM != "CERT" {
		t.Errorf("unexpected result: %+v", res)
	}
	if gotBody["join_method"] != "bootstrap_token" {
		t.Errorf("join_method = %v, want bootstrap_token", gotBody["join_method"])
	}
	if gotBody["bootstrap_token"] != "tok-1" {
		t.Errorf("bootstrap_token = %v, want tok-1", gotBody["bootstrap_token"])
	}
	if gotBody["csr_pem"] != "CSR" {
		t.Errorf("csr_pem = %v, want CSR", gotBody["csr_pem"])
	}
	if gotBody["substrate"] != "kubernetes" {
		t.Errorf("substrate = %v, want kubernetes", gotBody["substrate"])
	}
}

func TestEnroll_NonSuccessStatusReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bootstrap_token_invalid"}`))
	}))
	defer srv.Close()

	creds := enroll.Credentials{Method: "bootstrap_token", BootstrapToken: "bad"}
	_, err := Enroll(context.Background(), srv.URL, "ten_1", creds, "", "CSR", "kubernetes", "", "")
	if err == nil {
		t.Fatal("expected an error on 400 response, got nil")
	}
}

func TestGenerateKeyAndCSR_ProducesParseablePEM(t *testing.T) {
	_, csrPEM, err := GenerateKeyAndCSR()
	if err != nil {
		t.Fatalf("GenerateKeyAndCSR: %v", err)
	}
	if csrPEM == "" {
		t.Fatal("csrPEM is empty")
	}
}
