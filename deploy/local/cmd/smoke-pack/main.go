// smoke-pack drives the REAL Secure Pack consumer against a running control
// plane, proving the full cross-language lease flow end to end:
//
//   producer (CP HTTP routes) → lease request (leaf-signed) → verify+open
//   (pinned vendor key) → Guard licensed → PackAccess decrypts → assert plaintext.
//
// It uses the shipped securepack-lease consumer (HTTPTransport + Manager +
// Refresher + LicenseGate + PackAccess) and a leaf-key LeafSigner — the same
// path connect-agent runs — so a pass means the assembled system works, not
// just the units.
//
// Inputs (env): everything the CP-side shell wrapper (smoke-pack.sh) has already
// set up — an enrolled+approved agent's leaf, the pinned vendor SPKI, an active
// pack version, and the plaintext that version was staged with.
package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"time"

	"github.com/abluva/fabric/securepack-lease/access"
	"github.com/abluva/fabric/securepack-lease/consumer"
	"github.com/abluva/fabric/securepack-lease/lease"
)

// leafSigner signs the canonical lease-request bytes with the agent's RSA leaf,
// exactly as connect-agent/internal/securepack.LeafSigner does.
type leafSigner struct{ keyFile string }

func (s leafSigner) SignLeaseRequest(_ context.Context, canonical []byte) ([]byte, error) {
	pemBytes, err := os.ReadFile(s.keyFile)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("no PEM block in %s", s.keyFile)
	}
	var key *rsa.PrivateKey
	if k, e := x509.ParsePKCS1PrivateKey(block.Bytes); e == nil {
		key = k
	} else {
		k2, e2 := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e2 != nil {
			return nil, e2
		}
		var ok bool
		key, ok = k2.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("leaf key is not RSA")
		}
	}
	sum := sha256.Sum256(canonical)
	return rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
}

func must(name, v string) string {
	if v == "" {
		fmt.Fprintf(os.Stderr, "smoke-pack: missing required env %s\n", name)
		os.Exit(2)
	}
	return v
}

func main() {
	cpURL := must("SMOKE_CP_URL", os.Getenv("SMOKE_CP_URL"))
	agentID := must("SMOKE_AGENT_ID", os.Getenv("SMOKE_AGENT_ID"))
	tenantID := must("SMOKE_TENANT_ID", os.Getenv("SMOKE_TENANT_ID"))
	packID := must("SMOKE_PACK_ID", os.Getenv("SMOKE_PACK_ID"))
	certFile := must("SMOKE_LEAF_CERT", os.Getenv("SMOKE_LEAF_CERT"))
	keyFile := must("SMOKE_LEAF_KEY", os.Getenv("SMOKE_LEAF_KEY"))
	vendorHex := must("SMOKE_VENDOR_SPKI_HEX", os.Getenv("SMOKE_VENDOR_SPKI_HEX"))
	wantPlaintext := must("SMOKE_EXPECT_PLAINTEXT", os.Getenv("SMOKE_EXPECT_PLAINTEXT"))

	spki, err := hex.DecodeString(vendorHex)
	if err != nil {
		fail("decode vendor SPKI hex: %v", err)
	}
	vendorKey, err := consumer.ParseVendorKey(spki)
	if err != nil {
		fail("parse vendor key: %v", err)
	}
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		fail("read leaf cert: %v", err)
	}

	transport := &consumer.HTTPTransport{
		BaseURL:        cpURL,
		AgentID:        agentID,
		PackID:         packID,
		CertificatePEM: string(certPEM),
		AgentVersion:   "1.8.3",
		RequestTimeout: 15 * time.Second,
	}
	mgr, err := lease.NewManager(lease.Config{
		VendorKey:  vendorKey,
		LeafSigner: leafSigner{keyFile: keyFile},
		Transport:  transport,
	})
	if err != nil {
		fail("new manager: %v", err)
	}
	ref := &consumer.Refresher{
		Manager: mgr, AgentID: agentID, TenantID: tenantID, PackID: packID, AgentVersion: "1.8.3",
	}
	gate := access.NewLicenseGate(mgr.Guard())
	pack := access.NewPackAccess(mgr.Guard(), access.Options{}) // NoopDecompressor ("none")

	// 1) Before acquisition the gate must DENY (fail-closed).
	if gate.Allowed() {
		fail("gate allowed before any lease was acquired")
	}
	fmt.Println("[smoke-pack] gate denies before lease  ✓")

	// 2) Acquire one lease through the real path.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	snap, err := ref.AcquireOnce(ctx)
	if err != nil {
		fail("AcquireOnce: %v", err)
	}
	fmt.Printf("[smoke-pack] lease acquired: version=%d dek=%dB  ✓\n", snap.Lease.PackVersion, len(snap.Dek))

	// 3) Gate must now ALLOW.
	if d := gate.Check(); !d.Allowed {
		fail("gate denied after acquisition: %s", d.Reason)
	}
	fmt.Println("[smoke-pack] gate allows after lease   ✓")

	// 4) PackAccess must decrypt to the exact plaintext the version was staged with.
	got, ver, err := pack.Content()
	if err != nil {
		fail("PackAccess.Content: %v", err)
	}
	if string(got) != wantPlaintext {
		fail("decrypted content mismatch:\n got  %q\n want %q", string(got), wantPlaintext)
	}
	fmt.Printf("[smoke-pack] decrypted pack matches staged plaintext (version=%d, %dB)  ✓\n", ver, len(got))

	// 5) Renewal at the same version must NOT re-ship the ciphertext (bandwidth).
	// The Manager now holds a snapshot, so the second AcquireOnce sends
	// known_pack_version_id; the CP omits ciphertext; the Manager reuses cache
	// and still decrypts to the same plaintext.
	snap2, err := ref.AcquireOnce(ctx)
	if err != nil {
		fail("second AcquireOnce (renewal): %v", err)
	}
	if len(snap2.Ciphertext) == 0 {
		fail("renewal snapshot lost its ciphertext (cache reuse failed)")
	}
	got2, _, err := pack.Content()
	if err != nil {
		fail("PackAccess.Content after renewal: %v", err)
	}
	if string(got2) != wantPlaintext {
		fail("post-renewal content mismatch: %q", string(got2))
	}
	fmt.Println("[smoke-pack] renewal reused cached ciphertext (conditional delivery)  ✓")

	fmt.Println("[smoke-pack] PASS — end-to-end pack lease + decrypt + conditional-ciphertext renewal verified")
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[smoke-pack] FAIL: "+format+"\n", args...)
	os.Exit(1)
}
