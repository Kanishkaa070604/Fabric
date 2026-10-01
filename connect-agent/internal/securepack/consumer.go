package securepack

import (
	"context"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/abluva/fabric/securepack-lease/access"
	"github.com/abluva/fabric/securepack-lease/consumer"
	"github.com/abluva/fabric/securepack-lease/lease"
)

// Config carries everything the pack-lease consumer needs from the agent.
type Config struct {
	ControlPlaneURL string
	AgentID         string
	TenantID        string
	PackID          string
	AgentVersion    string
	// CertFile / KeyFile are the leaf paths (rotation-safe: read per request).
	CertFile string
	KeyFile  string
	// VendorKeyFile holds the pinned ES256 lease-signing public key, as SPKI
	// (PEM or raw DER). The Agent ships/mounts this so a compromised control
	// plane cannot mint leases it will trust.
	VendorKeyFile string
	// SetAuth injects the optional Agent bearer (defense-in-depth; leaf PoP is
	// mandatory regardless). Wire to cptoken.Store.SetAuthHeader. May be nil.
	SetAuth func(*http.Request)
	// Decompressor reverses the pack's compression_alg for PackAccess. Defaults
	// to access.NoopDecompressor (handles "none"); swap for a zstd impl when the
	// producer compresses. The firewall can also supply its own.
	Decompressor access.Decompressor
	// LogFn is an optional structured log hook (msg, key/value pairs).
	LogFn func(msg string, kv ...any)
}

// Handle is returned by Start. It is the ONE place the runtime firewall and any
// other in-process consumer obtain their view of the pack lease:
//
//   - Gate() → a LicenseGate for the hot-path "am I licensed now?" check
//     (nanosecond, DEK-free). Every consumer, including non-firewall agents,
//     uses this to decide whether to operate.
//   - Access() → a PackAccess for decrypted, decompressed pack content,
//     materialized on version change. The firewall's rule engine consumes the
//     read-only ContentView returned by Access().Content() and parses it once
//     per version behind this boundary.
//
// The firewall is NOT in this repo; this Handle is the integration seam it plugs
// into. Manager/Refresher are exposed for advanced control (force-acquire,
// inspection) but most consumers only need Gate()/Access().
type Handle struct {
	Refresher *consumer.Refresher
	Manager   *lease.Manager
	gate      *access.LicenseGate
	pack      *access.PackAccess
}

// Gate returns the hot-path licensing check for this Agent's pack lease.
func (h *Handle) Gate() *access.LicenseGate { return h.gate }

// Access returns the decrypted-pack accessor. Content() returns a read-only
// plaintext view and re-decrypts only on version change.
func (h *Handle) Access() *access.PackAccess { return h.pack }

// Start assembles the lease Manager (pinned vendor key + leaf signer + HTTP
// transport) and a Refresher, launches the refresh loop as a goroutine, and
// returns once the loop is running. The loop honors ctx and returns on cancel.
//
// The leaf certificate PEM is read once at start for the request body; the leaf
// PRIVATE key is read per-sign by LeafSigner (rotation-safe). If the cert
// rotates, a future enhancement can re-read it per request, but the cert PEM in
// the request is only used to locate the leaf — the signature (over the private
// key, read fresh) is what authenticates, so a stale cert PEM would simply fail
// verification and trigger a retry rather than a security issue.
func Start(ctx context.Context, cfg Config) (*Handle, error) {
	if cfg.ControlPlaneURL == "" || cfg.AgentID == "" {
		return nil, fmt.Errorf("securepack: ControlPlaneURL and AgentID are required")
	}
	certPEM, err := os.ReadFile(cfg.CertFile)
	if err != nil {
		return nil, fmt.Errorf("securepack: read leaf cert: %w", err)
	}
	vendorKey, err := loadVendorKey(cfg.VendorKeyFile)
	if err != nil {
		return nil, err
	}

	transport := &consumer.HTTPTransport{
		BaseURL:        cfg.ControlPlaneURL,
		AgentID:        cfg.AgentID,
		PackID:         cfg.PackID,
		CertificatePEM: string(certPEM),
		AgentVersion:   cfg.AgentVersion,
		HTTPClient:     &http.Client{Timeout: 15 * time.Second},
		SetAuth:        cfg.SetAuth,
	}

	mgr, err := lease.NewManager(lease.Config{
		VendorKey:  vendorKey,
		LeafSigner: NewLeafSigner(cfg.KeyFile),
		Transport:  transport,
		OnVersionChange: func(oldV, newV uint64) {
			if cfg.LogFn != nil {
				cfg.LogFn("pack_lease_version_change", "old", oldV, "new", newV)
			}
		},
	})
	if err != nil {
		return nil, fmt.Errorf("securepack: new manager: %w", err)
	}

	ref := &consumer.Refresher{
		Manager:      mgr,
		AgentID:      cfg.AgentID,
		TenantID:     cfg.TenantID,
		PackID:       cfg.PackID,
		AgentVersion: cfg.AgentVersion,
		OnError: func(e error) {
			if cfg.LogFn != nil {
				cfg.LogFn("pack_lease_acquire_failed", "error", e.Error())
			}
		},
	}
	go func() {
		_ = ref.Run(ctx) // returns on ctx cancel
	}()

	guard := mgr.Guard()
	return &Handle{
		Refresher: ref,
		Manager:   mgr,
		gate:      access.NewLicenseGate(guard),
		pack:      access.NewPackAccess(guard, access.Options{Decompressor: cfg.Decompressor}),
	}, nil
}

// loadVendorKey reads a pinned ES256 SPKI public key from a file that is either
// PEM ("-----BEGIN PUBLIC KEY-----") or raw DER.
func loadVendorKey(path string) (lease.VendorKey, error) {
	if path == "" {
		return nil, fmt.Errorf("securepack: vendor key file is required (FABRIC_PACK_VENDOR_KEY_FILE)")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("securepack: read vendor key: %w", err)
	}
	der := raw
	if block, _ := pem.Decode(raw); block != nil {
		der = block.Bytes
	}
	vk, err := consumer.ParseVendorKey(der)
	if err != nil {
		return nil, fmt.Errorf("securepack: %w", err)
	}
	return vk, nil
}
