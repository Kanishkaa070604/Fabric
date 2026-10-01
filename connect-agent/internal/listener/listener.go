package listener

import (
	"context"
	"fmt"
	"net"
	"os"

	"log/slog"

	"github.com/abluva/fabric/connect-agent/internal/logging"
	"github.com/abluva/fabric/connect-agent/internal/relay"
	"github.com/abluva/fabric/connect-agent/internal/stream"
	"github.com/abluva/fabric/connect-agent/internal/tunnel"
)

type Config struct {
	ListenAddr       string
	TenantID         string
	RegistrationID   string
	ConnectivityType stream.ConnectivityType
	EvidencePath     string
}

func Serve(ctx context.Context, log *slog.Logger, sess *tunnel.Session, cfg Config) error {
	if sess == nil || sess.Yamux == nil {
		return fmt.Errorf("nil session or yamux")
	}
	ln, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	logging.Info(ctx, log, "listener_started",
		"layer", "agent.listener",
		"addr", cfg.ListenAddr,
		"registration_id", cfg.RegistrationID,
		"connectivity_type", cfg.ConnectivityType,
	)

	errCh := make(chan error, 1)
	sem := make(chan struct{}, 256) // max concurrent outbound handlers
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				errCh <- err
				return
			}
			sem <- struct{}{}
			go func(c net.Conn) {
				defer func() { <-sem }()
				handleLocal(ctx, log, sess, c, cfg)
			}(c)
		}
	}()

	select {
	case <-ctx.Done():
		_ = ln.Close()
		return nil
	case <-sess.Yamux.CloseChan():
		_ = ln.Close()
		return fmt.Errorf("yamux session closed")
	case err := <-errCh:
		select {
		case <-ctx.Done():
			return nil
		default:
			logging.Error(ctx, log, "listener_accept_failed", err)
			return err
		}
	}
}

func handleLocal(parent context.Context, log *slog.Logger, sess *tunnel.Session, local net.Conn, cfg Config) {
	defer local.Close()
	ctx := logging.WithFields(parent, logging.Fields{
		Layer:          "agent.forward",
		TenantID:       cfg.TenantID,
		RegistrationID: cfg.RegistrationID,
	})

	remote, err := sess.Yamux.OpenStream()
	if err != nil {
		logging.Error(ctx, log, "yamux_open_failed", err)
		return
	}
	defer remote.Close()

	var evidence []byte
	if cfg.EvidencePath != "" {
		if b, err := os.ReadFile(cfg.EvidencePath); err == nil {
			evidence = b
		}
	}

	open := stream.StreamOpen{
		TenantID:         cfg.TenantID,
		RegistrationID:   cfg.RegistrationID,
		ConnectivityType: cfg.ConnectivityType,
		WorkloadEvidence: evidence,
		ProtocolVersion:  stream.CurrentProtocolVersion,
	}
	if err := stream.WriteMessage(remote, open); err != nil {
		logging.Error(ctx, log, "stream_open_write_failed", err)
		return
	}
	var result stream.StreamOpenResult
	if err := stream.ReadMessage(remote, &result); err != nil {
		logging.Error(ctx, log, "stream_open_result_read_failed", err)
		return
	}
	if result.Outcome != stream.OutcomeAccepted {
		logging.Info(ctx, log, "stream_open_rejected",
			"outcome", result.Outcome,
			"reason", result.Reason,
			"correlation_id", result.CorrelationID,
		)
		return
	}
	logging.Info(ctx, log, "stream_open_accepted", "correlation_id", result.CorrelationID)

	relay.Bidirectional(remote, local)
	logging.Debug(ctx, log, "forward_closed")
}

