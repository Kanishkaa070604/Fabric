package config

import (
	"fmt"
	"os"
	"time"
)

// Config is non-secret runtime configuration. Secrets come from Access API.
type Config struct {
	ListenUnixSocket      string
	GhostunnelListen      string
	InboundListen         string // G-A3-1 platform inbound TLS (empty = disabled)
	InboundTLSCert        string
	InboundTLSKey         string
	InboundDomainSuffix   string
	LogLevel              string
	AccessURL             string
	PlatformTenantID      string
	PlatformEnvironmentID string
	VaultPrefix           string
	PGSchema              string
	TablePrefix           string
	TenantsTable          string
	TenantsIDColumn       string
	YamuxKeepAlive        time.Duration
	ConnectionWriteTO     time.Duration
	// L2 §D.3 revocation push half: internal listener CP notifies on
	// security suspend/revoke. Empty = push disabled (poll-only via
	// ReconcileSecurity, which always still runs as the reliable fallback).
	RevokePushListen string
	RevokePushToken  string
	// L2 §G.3 rows 1/3: bounded grace window before a Deleting registration's
	// (or a billing-suspended tenant's) in-flight streams are force-closed.
	// "a few minutes" per spec; default chosen accordingly.
	DrainGrace time.Duration
	// Level 1 §12 Runtime Contract graceful shutdown: bounded window on
	// SIGTERM to let in-flight relays finish before the process exits.
	ShutdownGrace time.Duration
	// DestinationDialTimeout bounds PLATFORM_SERVICE/PLATFORM_RESOURCE dials
	// (adapter/direct_endpoint.go, adapter/platform_connector.go). Without
	// it, a dial that never gets a SYN-ACK/RST (a security group silently
	// dropping packets rather than rejecting) can hang for the OS-level
	// default -- potentially minutes -- holding an already quota-reserved
	// stream slot and a goroutine open the whole time.
	DestinationDialTimeout time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		ListenUnixSocket:      getenv("FABRIC_GATEWAY_UNIX_SOCKET", "/var/run/fabric/gateway.sock"),
		GhostunnelListen:      getenv("FABRIC_GHOSTUNNEL_LISTEN", "0.0.0.0:8443"),
		InboundListen:         getenv("FABRIC_GATEWAY_INBOUND_LISTEN", ""),
		InboundTLSCert:        getenv("FABRIC_GATEWAY_INBOUND_TLS_CERT", ""),
		InboundTLSKey:         getenv("FABRIC_GATEWAY_INBOUND_TLS_KEY", ""),
		InboundDomainSuffix:   getenv("FABRIC_GATEWAY_INBOUND_DOMAIN", "connect.fabric"),
		LogLevel:              getenv("FABRIC_LOG_LEVEL", "info"),
		AccessURL:             getenv("ABLV_ACCESS_URL", ""),
		PlatformTenantID:      getenv("ABLV_PLATFORM_TENANT_ID", ""),
		PlatformEnvironmentID: getenv("ABLV_PLATFORM_ENVIRONMENT_ID", ""),
		VaultPrefix:           getenv("FABRIC_VAULT_PREFIX", "ablv-fabric"),
		PGSchema:              getenv("FABRIC_PG_SCHEMA", "public"),
		TablePrefix:           getenv("FABRIC_TABLE_PREFIX", "ablv_"),
		TenantsTable:          getenv("FABRIC_TENANTS_TABLE", "ablv_tenants"),
		TenantsIDColumn:       getenv("FABRIC_TENANTS_ID_COLUMN", "tenant_id"),
		// Quota defaults live on ablv_tenant_connect (50/2000/100); Gateway enforces live usage.
		YamuxKeepAlive:    getenvDuration("FABRIC_YAMUX_KEEPALIVE", 30*time.Second),
		ConnectionWriteTO: getenvDuration("FABRIC_YAMUX_WRITE_TIMEOUT", 10*time.Second),
		RevokePushListen:  getenv("FABRIC_REVOKE_PUSH_LISTEN", ""),
		RevokePushToken:   getenv("FABRIC_REVOKE_PUSH_TOKEN", ""),
		DrainGrace:             getenvDuration("FABRIC_REGISTRATION_DRAIN_GRACE", 3*time.Minute),
		ShutdownGrace:          getenvDuration("FABRIC_SHUTDOWN_GRACE", 25*time.Second),
		DestinationDialTimeout: getenvDuration("FABRIC_DESTINATION_DIAL_TIMEOUT", 10*time.Second),
	}
	if cfg.AccessURL == "" && os.Getenv("FABRIC_REQUIRE_ACCESS_URL") == "1" {
		return cfg, fmt.Errorf("ABLV_ACCESS_URL is required (non-secret config)")
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvDuration(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
