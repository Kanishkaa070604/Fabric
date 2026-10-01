// Package file implements identity.Store on a plain local directory.
// This is today's behavior (tls.crt/tls.key/agent-id/agent-api.token as
// separate files) ported byte-for-byte behind the identity.Store
// interface -- no behavior change for VM, ECS, or Docker substrates, and
// no behavior change for Kubernetes installs that keep using hostPath.
package file

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/abluva/fabric/connect-agent/internal/identity"
)

// Store persists identity as plain files under a directory. Safe for any
// substrate where the directory itself is the durability guarantee
// (hostPath on Kubernetes, local disk on a VM, task-ephemeral storage on
// ECS, a bind mount under Docker).
type Store struct {
	CertDir     string
	AgentIDPath string
	// APITokenPath defaults to CertDir/agent-api.token when empty.
	APITokenPath string
}

// New builds a file-backed Store. agentIDPath and apiTokenPath may be
// empty to use the conventional locations under certDir.
func New(certDir, agentIDPath, apiTokenPath string) *Store {
	if agentIDPath == "" {
		agentIDPath = filepath.Join(certDir, "..", "agent-id")
	}
	if apiTokenPath == "" {
		apiTokenPath = filepath.Join(certDir, "agent-api.token")
	}
	return &Store{CertDir: certDir, AgentIDPath: agentIDPath, APITokenPath: apiTokenPath}
}

func (s *Store) Paths() identity.FilePaths {
	return identity.FilePaths{
		CertFile:     filepath.Join(s.CertDir, "tls.crt"),
		KeyFile:      filepath.Join(s.CertDir, "tls.key"),
		AgentIDFile:  s.AgentIDPath,
		APITokenFile: s.APITokenPath,
	}
}

func (s *Store) Load(_ context.Context) (*identity.Identity, error) {
	p := s.Paths()
	agentID := readTrimmed(p.AgentIDFile)
	certPEM, certErr := os.ReadFile(p.CertFile)
	keyPEM, keyErr := os.ReadFile(p.KeyFile)
	if certErr != nil || keyErr != nil {
		// No leaf on disk at all -- this is the "brand new install" or
		// "identity volume wiped" case. Same signal either way: enroll.
		if agentID == "" {
			return nil, identity.ErrNoIdentity
		}
		// agent-id present but cert/key missing is the documented
		// cert-loss case (Architecture-Resolutions.md "cert missing,
		// agent-id present") -- still ErrNoIdentity; the caller decides
		// whether a bootstrap window is still open or this fails closed.
		return nil, identity.ErrNoIdentity
	}
	if agentID == "" {
		return nil, identity.ErrNoIdentity
	}
	// Validate the cert parses -- a truncated/corrupt file on disk should
	// surface as "no usable identity", not a confusing TLS dial failure
	// three layers away.
	if _, err := parseLeaf(certPEM); err != nil {
		return nil, fmt.Errorf("identity/file: stored cert unreadable: %w", err)
	}
	return &identity.Identity{
		AgentID:  agentID,
		CertPEM:  certPEM,
		KeyPEM:   keyPEM,
		APIToken: readTrimmed(p.APITokenFile),
	}, nil
}

func (s *Store) SaveCert(_ context.Context, agentID string, certPEM, keyPEM []byte) error {
	p := s.Paths()
	if err := os.MkdirAll(s.CertDir, 0o700); err != nil {
		return fmt.Errorf("mkdir cert dir: %w", err)
	}
	// Atomic write: temp file + rename prevents corrupt partial writes on crash
	if err := atomicWrite(p.CertFile, certPEM); err != nil {
		return fmt.Errorf("write cert: %w", err)
	}
	if err := atomicWrite(p.KeyFile, keyPEM); err != nil {
		return fmt.Errorf("write key: %w", err)
	}
	if agentID != "" {
		if err := os.MkdirAll(filepath.Dir(p.AgentIDFile), 0o755); err != nil {
			return fmt.Errorf("mkdir agent-id dir: %w", err)
		}
		if err := os.WriteFile(p.AgentIDFile, []byte(agentID), 0o600); err != nil {
			return fmt.Errorf("write agent-id: %w", err)
		}
	}
	return nil
}

func (s *Store) SaveAPIToken(_ context.Context, token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("identity/file: empty api token")
	}
	p := s.Paths()
	if err := os.MkdirAll(filepath.Dir(p.APITokenFile), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p.APITokenFile, []byte(token+"\n"), 0o600)
}

func readTrimmed(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func parseLeaf(certPEM []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(certPEM)
	var der []byte
	if block != nil {
		der = block.Bytes
	} else {
		der = certPEM
	}
	return x509.ParseCertificate(der)
}

// atomicWrite writes data to a temp file in the same directory then renames
// it over the target — atomic on POSIX, prevents half-written files on crash.
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".fabric-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
