package adapter

import (
	"context"
	"fmt"
	"io"
	"net"
	"time"
)

// PlatformConnectorAdapter dials platform-side resources after Gateway authz (Spec §8.7 B3).
// Spec §8.5 B1 (Platform→Platform Resource) does not use the Gateway; that path is ztunnel →
// Platform Connector outside this binary. Credentials are never taken from the stream —
// host/port come from the Registration only.
type PlatformConnectorAdapter struct {
	// DialTimeout bounds the dial to the platform resource (e.g. an
	// OCI-managed Postgres). Without it, a network black-hole (dropped
	// SYN rather than a fast RST) hangs on the OS-level default -- the
	// caller's ctx alone does not bound this: the Gateway's own top-level
	// context has no deadline. Zero disables the bound (falls back to ctx only).
	DialTimeout time.Duration
}

func (a *PlatformConnectorAdapter) Kind() string { return "PLATFORM_CONNECTOR" }

func (a *PlatformConnectorAdapter) Connect(ctx context.Context, dest Destination) (io.ReadWriteCloser, error) {
	if dest.Host == "" || dest.Port == 0 {
		return nil, fmt.Errorf("platform_connector: host/port required from registration")
	}
	if a.DialTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, a.DialTimeout)
		defer cancel()
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", dest.Host, dest.Port))
	if err != nil {
		return nil, fmt.Errorf("platform_connector: dial: %w", err)
	}
	return conn, nil
}
