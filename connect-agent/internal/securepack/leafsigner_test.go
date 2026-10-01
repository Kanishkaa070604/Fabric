package securepack

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func writeKey(t *testing.T, dir string, pkcs8 bool) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var der []byte
	var typ string
	if pkcs8 {
		der, err = x509.MarshalPKCS8PrivateKey(key)
		typ = "PRIVATE KEY"
	} else {
		der = x509.MarshalPKCS1PrivateKey(key)
		typ = "RSA PRIVATE KEY"
	}
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "tls.key")
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return key, p
}

func TestLeafSignerSignsVerifiably(t *testing.T) {
	for _, pkcs8 := range []bool{false, true} {
		dir := t.TempDir()
		key, path := writeKey(t, dir, pkcs8)
		signer := NewLeafSigner(path)

		canonical := []byte("canonical-pack-lease-request-bytes")
		sig, err := signer.SignLeaseRequest(context.Background(), canonical)
		if err != nil {
			t.Fatalf("sign (pkcs8=%v): %v", pkcs8, err)
		}
		sum := sha256.Sum256(canonical)
		if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, sum[:], sig); err != nil {
			t.Fatalf("verify (pkcs8=%v): %v", pkcs8, err)
		}
	}
}

func TestLeafSignerReadsKeyFreshEachSign(t *testing.T) {
	dir := t.TempDir()
	key1, path := writeKey(t, dir, false)
	signer := NewLeafSigner(path)
	canonical := []byte("bytes")

	sig1, err := signer.SignLeaseRequest(context.Background(), canonical)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(canonical)
	if err := rsa.VerifyPKCS1v15(&key1.PublicKey, crypto.SHA256, sum[:], sig1); err != nil {
		t.Fatal(err)
	}

	// Rotate the key on disk; the signer must pick up the new one (no cache).
	key2, _ := writeKey(t, dir, false)
	sig2, err := signer.SignLeaseRequest(context.Background(), canonical)
	if err != nil {
		t.Fatal(err)
	}
	if err := rsa.VerifyPKCS1v15(&key2.PublicKey, crypto.SHA256, sum[:], sig2); err != nil {
		t.Fatal("signature after rotation does not verify against the new key")
	}
	// And must NOT verify against the old key.
	if err := rsa.VerifyPKCS1v15(&key1.PublicKey, crypto.SHA256, sum[:], sig2); err == nil {
		t.Fatal("post-rotation signature unexpectedly verified against the old key")
	}
}

func TestLeafSignerMissingKeyErrors(t *testing.T) {
	signer := NewLeafSigner(filepath.Join(t.TempDir(), "nope.key"))
	if _, err := signer.SignLeaseRequest(context.Background(), []byte("x")); err == nil {
		t.Fatal("expected error for missing key file")
	}
}
