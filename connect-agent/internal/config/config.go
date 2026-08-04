package config

import (
	"fmt"
	"os"
	"time"
)

type Config struct {
	GatewayAddress    string
	TLSServerName     string
	TenantID          string
	AgentIDPath       string
	// CertDir holds the per-instance leaf (tls.crt + tls.key) -- and, for
	// IdentityStore=="kubernetes", the *local cache* of whatever's in the
	// backing Secret, not the sole source of truth. See internal/identity.
	CertDir string
	// CAFile is the Platform trust bundle (shared Secret / CA-only mount).
	// Defaults to CertDir/ca.crt for single-directory local layouts.
	CAFile            string
	EvidencePath      string
	LogLevel          string
	// YamuxKeepAlive / ConnectionWriteTO are the Agent-side yamux timers
	// (defaults 30s / 10s). Mirror Gateway's FABRIC_YAMUX_KEEPALIVE and
	// FABRIC_YAMUX_WRITE_TIMEOUT. Keep keepalive comfortably below any NLB
	// / NAT idle timeout on the Agent→Gateway path, or the middlebox will
	// drop the TCP session before yamux pings and the Agent will flap.
	YamuxKeepAlive    time.Duration
	ConnectionWriteTO time.Duration
	// Substrate identifies the runtime kind this Agent enrolls from
	// (kubernetes | ecs | vm). SubstrateFingerprint is the optional Spec
	// §10.1 strict-binding value (cluster UID / cloud account) the tenant
	// declared at onboarding; only enforced when the tenant enabled it.
	Substrate            string
	SubstrateFingerprint string

	// IdentityStore selects the identity.Store implementation: "file"
	// (plain disk -- VM, ECS, Docker, or a Kubernetes install still on
	// hostPath) or "kubernetes" (Secret-backed; see PRODUCTION-READINESS
	// D2 / Architecture-Resolutions.md Part 9). Default "file" needs no
	// extra RBAC so an unconfigured Agent keeps the classic disk layout.
	IdentityStore string
	// IdentityNamespace / IdentitySecretPrefix / NodeName are only used
	// when IdentityStore=="kubernetes". NodeName should come from the
	// pod's downward API (fieldRef: spec.nodeName) so each DaemonSet
	// replica gets its own Secret -- see identity/k8ssecret.NameForNode.
	IdentityNamespace    string
	IdentitySecretPrefix string
	NodeName             string
}

func Load() (Config, error) {
	certDir := getenv("FABRIC_AGENT_CERT_DIR", "/etc/connect-agent/tls")
	cfg := Config{
		GatewayAddress:       getenv("FABRIC_GATEWAY_ADDRESS", ""),
		TLSServerName:        getenv("FABRIC_TLS_SERVER_NAME", ""),
		TenantID:             getenv("FABRIC_TENANT_ID", ""),
		AgentIDPath:          getenv("FABRIC_AGENT_ID_PATH", "/var/run/abluva/agent-id"),
		CertDir:              certDir,
		CAFile:               getenv("FABRIC_AGENT_CA_FILE", certDir+"/ca.crt"),
		EvidencePath:         getenv("FABRIC_EVIDENCE_PATH", "/var/run/abluva/evidence/token"),
		LogLevel:             getenv("FABRIC_LOG_LEVEL", "info"),
		YamuxKeepAlive:       parseDuration("FABRIC_YAMUX_KEEPALIVE", 30*time.Second),
		ConnectionWriteTO:    parseDuration("FABRIC_YAMUX_WRITE_TIMEOUT", 10*time.Second),
		Substrate:            getenv("FABRIC_SUBSTRATE", "kubernetes"),
		SubstrateFingerprint: getenv("FABRIC_SUBSTRATE_FINGERPRINT", ""),
		IdentityStore:        getenv("FABRIC_IDENTITY_STORE", "file"),
		IdentityNamespace:    getenv("FABRIC_IDENTITY_NAMESPACE", ""),
		IdentitySecretPrefix: getenv("FABRIC_IDENTITY_SECRET_PREFIX", "connect-agent-identity"),
		NodeName:             getenv("FABRIC_NODE_NAME", ""),
	}
	if cfg.GatewayAddress == "" {
		return cfg, fmt.Errorf("FABRIC_GATEWAY_ADDRESS is required")
	}
	if cfg.TenantID == "" {
		return cfg, fmt.Errorf("FABRIC_TENANT_ID is required")
	}
	if cfg.IdentityStore != "file" && cfg.IdentityStore != "kubernetes" {
		return cfg, fmt.Errorf("FABRIC_IDENTITY_STORE must be 'file' or 'kubernetes', got %q", cfg.IdentityStore)
	}
	if cfg.IdentityStore == "kubernetes" && cfg.NodeName == "" {
		return cfg, fmt.Errorf("FABRIC_NODE_NAME is required when FABRIC_IDENTITY_STORE=kubernetes (set via downward API fieldRef: spec.nodeName)")
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// parseDuration reads a Go duration string from an env var (e.g. "30s",
// "1m"). Returns def if unset or unparseable — matching the same
// "default unless explicitly overridden" pattern as getenv.
func parseDuration(envKey string, def time.Duration) time.Duration {
	raw := os.Getenv(envKey)
	if raw == "" {
		return def
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return def
	}
	return d
}
