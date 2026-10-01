package adapter

import (
	"context"
	"fmt"
	"io"
	"net"
	"time"
)

// DirectEndpointAdapter dials a Fabric DNS name (A2 platform service destination).
type DirectEndpointAdapter struct {
	// DialTimeout bounds the dial (see PlatformConnectorAdapter.DialTimeout
	// for why this can't just rely on ctx). Zero disables the bound.
	DialTimeout time.Duration
}

func (a *DirectEndpointAdapter) Kind() string { return "DIRECT_ENDPOINT" }

func (a *DirectEndpointAdapter) Connect(ctx context.Context, dest Destination) (io.ReadWriteCloser, error) {
	if dest.Host == "" || dest.Port == 0 {
		return nil, fmt.Errorf("direct_endpoint: host/port required")
	}
	if a.DialTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, a.DialTimeout)
		defer cancel()
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", dest.Host, dest.Port))
	if err != nil {
		return nil, fmt.Errorf("direct_endpoint: dial: %w", err)
	}
	return conn, nil
}
