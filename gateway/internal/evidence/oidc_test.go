package evidence

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOIDCVerifier_OK(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	kid := "test-kid"
	n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())
	jwks := map[string]any{
		"keys": []map[string]string{
			{"kty": "RSA", "kid": kid, "n": n, "e": e, "alg": "RS256", "use": "sig"},
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	defer srv.Close()

	iss := "https://kubernetes.default.svc"
	aud := "abluva-connect"
	now := time.Now().Unix()
	hdr, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iss": iss,
		"sub": "system:serviceaccount:app:caller",
		"aud": aud,
		"exp": now + 3600,
		"iat": now,
	})
	p1 := base64.RawURLEncoding.EncodeToString(hdr)
	p2 := base64.RawURLEncoding.EncodeToString(claims)
	signed := p1 + "." + p2
	sum := sha256.Sum256([]byte(signed))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	token := signed + "." + base64.RawURLEncoding.EncodeToString(sig)

	v := NewVerifier()
	res, err := v.Verify(context.Background(), Trust{
		Strategy:    "kubernetes_oidc",
		OIDCEnabled: true,
		IssuerURL:   iss,
		JWKSURI:     srv.URL,
		Audience:    aud,
		AllowedAlgs: []string{"RS256"},
	}, []byte(token))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if res.Attribution == nil || res.Attribution.Subject != "system:serviceaccount:app:caller" {
		t.Fatalf("attr=%+v", res.Attribution)
	}
	if res.Attribution.Extra["service_account"] != "caller" {
		t.Fatalf("sa=%v", res.Attribution.Extra)
	}
}

func TestVerifier_AbsentOK(t *testing.T) {
	v := NewVerifier()
	res, err := v.Verify(context.Background(), Trust{
		Strategy:    "kubernetes_oidc",
		OIDCEnabled: true,
		IssuerURL:   "https://x",
		JWKSURI:     "https://x/jwks",
	}, nil)
	if err != nil || !res.Absent {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestVerifier_BadTokenReject(t *testing.T) {
	v := NewVerifier()
	_, err := v.Verify(context.Background(), Trust{
		Strategy:    "kubernetes_oidc",
		OIDCEnabled: true,
		IssuerURL:   "https://x",
		JWKSURI:     "https://example.invalid/jwks",
		Audience:    "abluva-connect",
		AllowedAlgs: []string{"RS256"},
	}, []byte("not.a.jwt"))
	if err == nil {
		t.Fatal("expected error")
	}
}
