// Package securepack wires the connect-agent's identity into the Secure Pack
// lease consumer (github.com/abluva/fabric/securepack-lease). It is the only
// place connect-agent depends on that module, keeping the coupling in one file.
package securepack

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
)

// LeafSigner implements securepack-lease's lease.LeafSigner over the Agent's
// existing RSA leaf. It signs the canonical PackLeaseRequestSigningV1 bytes with
// RSA-SHA256/PKCS#1v1.5 — the same key and scheme the control plane's shared
// verifyAgentLeaf primitive verifies against.
//
// The private key is read FRESH from disk on every sign, never cached: the
// certlife rotation loop rewrites tls.key in place, and a captured key would go
// stale after a rotation. Reading per-sign mirrors how cptoken.PullCurrent and
// tunnel.Dial stay rotation-safe.
type LeafSigner struct {
	// KeyFile is the leaf private key path (identity.Store Paths().KeyFile).
	KeyFile string
}

// NewLeafSigner builds a signer bound to a leaf key file path.
func NewLeafSigner(keyFile string) *LeafSigner {
	return &LeafSigner{KeyFile: keyFile}
}

// SignLeaseRequest signs the canonical lease-request bytes. The caller (the
// lease Manager) supplies the exact bytes from EncodePackLeaseRequestSigningV1,
// so this never re-encodes — it only hashes and signs.
func (s *LeafSigner) SignLeaseRequest(_ context.Context, canonicalBytes []byte) ([]byte, error) {
	keyPEM, err := os.ReadFile(s.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("securepack: read leaf key: %w", err)
	}
	key, err := parseRSAPrivateKey(keyPEM)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(canonicalBytes)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return nil, fmt.Errorf("securepack: sign lease request: %w", err)
	}
	return sig, nil
}

// parseRSAPrivateKey accepts PKCS#1 then PKCS#8, matching cptoken.parseRSAPrivateKey.
// Duplicated here (~10 lines) rather than exported from cptoken to avoid widening
// that package's API for one caller; the leaf format is fixed, so this cannot drift.
func parseRSAPrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("securepack: no PEM block in leaf key file")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("securepack: parse leaf key: %w", err)
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("securepack: leaf key is not RSA")
	}
	return rk, nil
}
