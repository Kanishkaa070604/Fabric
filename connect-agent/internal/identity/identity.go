// Package identity defines the substrate-neutral contract for where an
// Agent instance's credentials live. Every substrate (Kubernetes, VM,
// ECS, Docker) shares the same Agent binary and protocol; the only thing
// that differs is *where identity is durably persisted*. That's the seam
// this package draws.
//
// Design goal: introduce new backing stores (Kubernetes Secret today;
// cloud KMS, Vault, etc. later) without touching tunnel.Dial, certlife,
// cptoken, or main.go's control flow. Every Store implementation
// guarantees the local file paths returned by Paths() stay in sync with
// whatever the real backing store is -- so existing file-based readers
// never need to change.
package identity

import (
	"context"
	"errors"
)

// ErrNoIdentity is returned by Load when this Agent instance has never
// enrolled (no cert, no agent-id, anywhere the Store looked -- including
// a remote backing store, if any). Callers should treat this exactly like
// today's "no local tls.crt/tls.key" case: run the enroll flow.
var ErrNoIdentity = errors.New("identity: no identity enrolled yet")

// Identity is everything that identifies one Agent instance to the
// control plane and Gateway.
type Identity struct {
	AgentID  string
	CertPEM  []byte
	KeyPEM   []byte
	// APIToken is optional until the first successful leaf-PoP pull
	// (cptoken.PullCurrent / refresh loop). Empty is normal at first boot
	// after enroll; watch/observed soft-fail until a bearer lands.
	APIToken string
}

// FilePaths are the local filesystem locations a Store guarantees are
// present and current after Load/SaveCert/SaveAPIToken return. Existing
// code (tunnel.Dial's tls.LoadX509KeyPair, certlife's x509.ParseCertificate,
// cptoken's file read) keeps reading/writing these exact paths -- it has
// no idea whether the Store behind them is a plain directory or a
// Kubernetes Secret being mirrored to disk.
type FilePaths struct {
	CertFile     string
	KeyFile      string
	AgentIDFile  string
	APITokenFile string
}

// Store is the pluggable identity backend. See file.Store (plain disk,
// today's behavior byte-for-byte) and k8ssecret.Store (Kubernetes Secret,
// with the same disk paths kept as a local cache) for the two shipped
// implementations.
type Store interface {
	// Load returns the current identity. Implementations that have a
	// remote source of truth (e.g. a Kubernetes Secret) must check that
	// source when the local cache is missing or incomplete -- this is
	// what lets identity survive a pod recreate without hostPath: the
	// local emptyDir is gone, but Load() re-fetches from the Secret and
	// re-populates the cache before returning.
	//
	// Returns ErrNoIdentity if no identity exists anywhere this Store
	// knows to look.
	Load(ctx context.Context) (*Identity, error)

	// SaveCert persists a newly issued or rotated leaf certificate --
	// called once right after enroll, and again on every auto-rotation
	// or manual FABRIC_AGENT_ROTATE=1 cycle. Must leave Paths().CertFile /
	// KeyFile holding exactly this cert/key afterward.
	SaveCert(ctx context.Context, agentID string, certPEM, keyPEM []byte) error

	// SaveAPIToken persists a refreshed Agent API bearer (G-CRED-1 pull).
	// Called from cptoken's refresh loop after every successful pull.
	SaveAPIToken(ctx context.Context, token string) error

	// Paths returns the local filesystem paths this Store keeps in sync.
	// Safe to call before any Load/Save -- the paths themselves don't
	// change, only what's in the files at those paths.
	Paths() FilePaths
}
