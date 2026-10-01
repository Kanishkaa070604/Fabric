package inbound

import (
	"context"
	"fmt"
	"io"
	"net"
	"time"

	"log/slog"

	"github.com/abluva/fabric/connect-agent/internal/logging"
	"github.com/abluva/fabric/connect-agent/internal/relay"
	"github.com/abluva/fabric/connect-agent/internal/stream"
	"github.com/abluva/fabric/connect-agent/internal/tunnel"
)

// Serve accepts Gateway→Agent yamux streams (CONNECT_AGENT / A3/A4/B2).
// Each stream starts with AgentDial (host:port), then byte-relays to that TCP target.
func Serve(ctx context.Context, log *slog.Logger, sess *tunnel.Session) error {
	sem := make(chan struct{}, 256) // max concurrent inbound handlers
	for {
		st, err := sess.Yamux.AcceptStream()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return err
			}
		}
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			handle(ctx, log, st)
		}()
	}
}

func handle(parent context.Context, log *slog.Logger, st io.ReadWriteCloser) {
	defer st.Close()
	ctx := logging.WithFields(parent, logging.Fields{Layer: "agent.inbound"})

	var dial stream.AgentDial
	if err := stream.ReadMessage(st, &dial); err != nil {
		logging.Error(ctx, log, "inbound_dial_read_failed", err)
		return
	}
	if dial.Host == "" || dial.Port == 0 {
		logging.Error(ctx, log, "inbound_dial_invalid", fmt.Errorf("host/port required"),
			"registration_id", dial.RegistrationID)
		return
	}
	addr := fmt.Sprintf("%s:%d", dial.Host, dial.Port)
	logging.Info(ctx, log, "inbound_dialing",
		"registration_id", dial.RegistrationID,
		"addr", addr,
	)

	d := net.Dialer{Timeout: 10 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		logging.Error(ctx, log, "inbound_dial_failed", err, "addr", addr)
		return
	}
	defer conn.Close()

	relay.Bidirectional(conn, st)
	logging.Debug(ctx, log, "inbound_closed", "registration_id", dial.RegistrationID)
}

