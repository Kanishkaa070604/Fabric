// Package k8ssecret implements identity.Store backed by a Kubernetes
// Secret, with a local file cache so existing readers (tunnel.Dial's
// tls.LoadX509KeyPair, certlife, cptoken) keep using file paths.
//
// The Secret is the durable source of truth (survives pod delete / rollout
// / drain without hostPath or PSA exceptions). emptyDir is only a cache.
// If the Secret is lost (namespace wipe, RBAC misconfig), Load returns
// ErrNoIdentity and the Agent re-enrolls — see Architecture-Resolutions
// Part 9. Writes are Secret-first, then cache: a failed push must not
// leave the cache ahead of the durable store.
package k8ssecret

import (
	"context"
	"fmt"
	"strings"

	"github.com/abluva/fabric/connect-agent/internal/identity"
	"github.com/abluva/fabric/connect-agent/internal/identity/file"
	"github.com/abluva/fabric/connect-agent/internal/k8ssvc"
)

const (
	keyAgentID  = "agent-id"
	keyCertPEM  = "tls.crt"
	keyKeyPEM   = "tls.key"
	keyAPIToken = "agent-api.token"
)

// Store persists identity in a Kubernetes Secret, mirroring every write
// to a local file cache (via an embedded file.Store) so the rest of the
// Agent's code -- which only knows about file paths -- needs zero changes.
type Store struct {
	Client    *k8ssvc.Client
	Namespace string
	// SecretName should be unique per Agent instance. For a DaemonSet,
	// callers derive this from the node name (e.g.
	// "connect-agent-identity-<node-name>") so two pods never share one
	// Secret and stomp each other's leaf. See NameForNode.
	SecretName string

	// cache is the local file mirror. Never nil after New().
	cache *file.Store
}

// NameForNode derives a per-node Secret name for a DaemonSet deployment.
// Kubernetes object names are lowercase-DNS-label; node names already are
// in practice, but this defensively lowercases and truncates to the 253
// char object-name limit (Secret names are far short of that in practice,
// this is just a safety clamp, not an expected code path).
func NameForNode(prefix, nodeName string) string {
	name := strings.ToLower(prefix + "-" + nodeName)
	if len(name) > 253 {
		name = name[:253]
	}
	name = strings.TrimRight(name, "-")
	return name
}

// New builds a Store. cacheDir is where the local file mirror lives
// (typically an emptyDir -- it's a cache, not the source of truth, so it
// no longer needs to be hostPath).
func New(client *k8ssvc.Client, namespace, secretName, cacheDir, agentIDPath, apiTokenPath string) *Store {
	return &Store{
		Client:     client,
		Namespace:  namespace,
		SecretName: secretName,
		cache:      file.New(cacheDir, agentIDPath, apiTokenPath),
	}
}

func (s *Store) Paths() identity.FilePaths {
	return s.cache.Paths()
}

// Load checks the local cache first (fast path, no API call on every
// startup when the cache is already warm), then falls back to fetching
// the Secret and repopulating the cache. This ordering matters for the
// case the whole design exists to fix: a pod recreate wipes the emptyDir
// cache, so the very first Load after a rollout deliberately misses the
// cache and pulls from the Secret instead of returning ErrNoIdentity.
func (s *Store) Load(ctx context.Context) (*identity.Identity, error) {
	if id, err := s.cache.Load(ctx); err == nil {
		return id, nil
	}
	sec, err := s.Client.GetSecret(ctx, s.Namespace, s.SecretName)
	if err != nil {
		return nil, fmt.Errorf("identity/k8ssecret: get secret: %w", err)
	}
	if sec == nil || len(sec.Data) == 0 {
		return nil, identity.ErrNoIdentity
	}
	agentID := string(sec.Data[keyAgentID])
	certPEM := sec.Data[keyCertPEM]
	keyPEM := sec.Data[keyKeyPEM]
	if agentID == "" || len(certPEM) == 0 || len(keyPEM) == 0 {
		return nil, identity.ErrNoIdentity
	}
	// Warm the cache so subsequent reads (tunnel.Dial reloading on every
	// reconnect, certlife's periodic remaining-life check) hit disk, not
	// the API server, without needing their own Store-awareness.
	if err := s.cache.SaveCert(ctx, agentID, certPEM, keyPEM); err != nil {
		return nil, fmt.Errorf("identity/k8ssecret: warm cache: %w", err)
	}
	apiToken := string(sec.Data[keyAPIToken])
	if apiToken != "" {
		if err := s.cache.SaveAPIToken(ctx, apiToken); err != nil {
			return nil, fmt.Errorf("identity/k8ssecret: warm token cache: %w", err)
		}
	}
	return &identity.Identity{
		AgentID:  agentID,
		CertPEM:  certPEM,
		KeyPEM:   keyPEM,
		APIToken: apiToken,
	}, nil
}

// SaveCert pushes the Secret first, then the local cache. Ordering matters
// for debugging identity drift:
//
//	Secret OK, cache fail → Load may still warm from Secret; CP FP matches Secret.
//	Cache-first (wrong) → readers use a newer leaf than Secret/CP; pod recreate
//	regresses to the old Secret while callers think SaveCert already succeeded.
func (s *Store) SaveCert(ctx context.Context, agentID string, certPEM, keyPEM []byte) error {
	if err := s.pushSecret(ctx, map[string][]byte{
		keyAgentID: []byte(agentID),
		keyCertPEM: certPEM,
		keyKeyPEM:  keyPEM,
	}); err != nil {
		return fmt.Errorf("push secret before cache write: %w", err)
	}
	return s.cache.SaveCert(ctx, agentID, certPEM, keyPEM)
}

// SaveAPIToken pushes the Secret first, then the local cache -- see
// SaveCert's doc comment for why this ordering matters.
func (s *Store) SaveAPIToken(ctx context.Context, token string) error {
	// Include cert data if available in cache, so a create (Secret doesn't
	// exist yet) produces a complete Secret rather than a token-only one
	// that would make Load() return ErrNoIdentity until SaveCert runs.
	data := map[string][]byte{
		keyAPIToken: []byte(strings.TrimSpace(token)),
	}
	if id, err := s.cache.Load(ctx); err == nil {
		if len(id.CertPEM) > 0 {
			data[keyCertPEM] = id.CertPEM
		}
		if len(id.KeyPEM) > 0 {
			data[keyKeyPEM] = id.KeyPEM
		}
		if id.AgentID != "" {
			data[keyAgentID] = []byte(id.AgentID)
		}
	}
	if err := s.pushSecret(ctx, data); err != nil {
		return fmt.Errorf("push secret before cache write: %w", err)
	}
	return s.cache.SaveAPIToken(ctx, token)
}

// pushSecret merge-patches only the given keys. EnsureSecret's PATCH is a
// JSON Merge Patch (RFC 7396) at the top level of `data`, which means a
// call that only sets keyAPIToken leaves tls.crt/tls.key/agent-id
// untouched -- SaveCert and SaveAPIToken never clobber each other even
// though they're called from independent loops (certlife's rotation timer
// vs cptoken's bearer refresh timer) that can interleave.
func (s *Store) pushSecret(ctx context.Context, data map[string][]byte) error {
	return s.Client.EnsureSecret(ctx, s.Namespace, k8ssvc.Secret{
		Metadata: k8ssvc.SecretMeta{
			Name:   s.SecretName,
			Labels: map[string]string{"fabric.abluva.io/managed-by": "connect-agent"},
		},
		Type: "Opaque",
		Data: data,
	})
}
