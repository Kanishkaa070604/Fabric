package main

import (
	"context"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/abluva/fabric/gateway/internal/config"
	"github.com/abluva/fabric/gateway/internal/dispatch/adapter"
	"github.com/abluva/fabric/gateway/internal/dispatch/authorize"
	"github.com/abluva/fabric/gateway/internal/logging"
	"github.com/abluva/fabric/gateway/internal/pinbound"
	"github.com/abluva/fabric/gateway/internal/quota"
	"github.com/abluva/fabric/gateway/internal/session"
	"github.com/abluva/fabric/gateway/internal/store"
	"github.com/abluva/fabric/gateway/internal/terminate"
)

func main() {
	log := logging.New("gateway")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = logging.WithFields(ctx, logging.Fields{
		Component: "gateway",
		Layer:     "main",
	})

	cfg, err := config.Load()
	if err != nil {
		logging.Error(ctx, log, "config_load_failed", err)
		os.Exit(1)
	}

	cpURL := os.Getenv("FABRIC_CONTROL_PLANE_URL")
	if cpURL == "" {
		logging.Error(ctx, log, "config_missing", nil, "key", "FABRIC_CONTROL_PLANE_URL")
		os.Exit(1)
	}
	cpToken := os.Getenv("FABRIC_CONTROL_PLANE_TOKEN")

	st := store.NewHTTPStore(cpURL, cpToken)
	quotas := quota.NewTracker()
	authz := &authorize.Authorizer{Store: st, Quotas: quotas}
	tunnels := session.NewTunnelRegistry()
	authz.OpenStreams = tunnels.OpenStreamCount
	adapters := adapter.NewRegistry(
		&adapter.ConnectAgentAdapter{Dial: tunnels.DialAgent},
		&adapter.PlatformConnectorAdapter{DialTimeout: cfg.DestinationDialTimeout},
		&adapter.DirectEndpointAdapter{DialTimeout: cfg.DestinationDialTimeout},
	)
	h := session.NewHandler(log, authz, adapters, st, tunnels, cpURL, cfg.YamuxKeepAlive, cfg.ConnectionWriteTO)

	if err := os.Remove(cfg.ListenUnixSocket); err != nil && !os.IsNotExist(err) {
		logging.Info(ctx, log, "unix_socket_remove_warning", "path", cfg.ListenUnixSocket, "error", err.Error())
	}
	ln, err := net.Listen("unix", cfg.ListenUnixSocket)
	if err != nil {
		logging.Error(ctx, log, "unix_listen_failed", err, "path", cfg.ListenUnixSocket)
		os.Exit(1)
	}
	defer ln.Close()
	if err := os.Chmod(cfg.ListenUnixSocket, 0o666); err != nil {
		logging.Error(ctx, log, "unix_chmod_failed", err, "path", cfg.ListenUnixSocket)
		os.Exit(1)
	}
	pln := terminate.WrapListener(ln)

	logging.Info(ctx, log, "gateway_listening",
		"unix_socket", cfg.ListenUnixSocket,
		"control_plane", cpURL,
		"ghostunnel_listen", cfg.GhostunnelListen,
		"inbound_listen", cfg.InboundListen,
		"cp_auth", cpToken != "",
	)

	errCh := make(chan error, 2)
	go func() {
		for {
			conn, err := pln.Accept()
			if err != nil {
				errCh <- err
				return
			}
			go h.ServeConn(ctx, conn)
		}
	}()
	go h.ReconcileSecurity(ctx, 2*time.Second)
	go h.ReconcileRegistrationDrain(ctx, 10*time.Second, cfg.DrainGrace)
	// Drop opens-map entries for tenants that have gone quiet (rate-window
	// timestamps aged out). Without this, every tenant that ever opened a
	// stream left a permanent entry for the Gateway process lifetime —
	// tunnels/streams already delete() on zero; opens was the one map
	// in quota.Tracker that didn't. See SweepIdleOpens.
	go quotas.RunOpensSweep(ctx, 30*time.Second)

	if cfg.RevokePushListen != "" {
		go func() {
			if err := h.ServeRevokePush(ctx, cfg.RevokePushListen, cfg.RevokePushToken); err != nil && ctx.Err() == nil {
				logging.Error(ctx, log, "revoke_push_listen_failed", err, "addr", cfg.RevokePushListen)
			}
		}()
	}

	if cfg.InboundListen != "" {
		if cfg.InboundTLSCert == "" || cfg.InboundTLSKey == "" {
			logging.Error(ctx, log, "inbound_tls_missing", nil,
				"note", "FABRIC_GATEWAY_INBOUND_TLS_CERT/KEY required when inbound listen is set")
			os.Exit(1)
		}
		inbound := &pinbound.Server{
			Log:          log,
			ListenAddr:   cfg.InboundListen,
			CertFile:     cfg.InboundTLSCert,
			KeyFile:      cfg.InboundTLSKey,
			DomainSuffix: cfg.InboundDomainSuffix,
			Authorizer:   authz,
			Adapters:     adapters,
		}
		go func() {
			if err := inbound.Run(ctx); err != nil && ctx.Err() == nil {
				errCh <- err
			}
		}()
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sigCh:
		// Level 1 §12 graceful shutdown, bounded by cfg.ShutdownGrace:
		// (1) stop accepting new agent tunnels; (2) stop dispatching new
		// streams on tunnels already established; (3) give in-flight
		// relays a bounded window to finish before the process exits.
		// Existing tunnels are not force-closed here -- Agents reconnect
		// on their own backoff (Level 1 §9) once this instance actually
		// exits, exactly as L2 §H.2 describes for a Gateway restart.
		logging.Info(ctx, log, "gateway_shutdown_starting", "grace", cfg.ShutdownGrace.String())
		_ = pln.Close()
		h.BeginDraining()
		h.AwaitDrain(cfg.ShutdownGrace)
		logging.Info(ctx, log, "gateway_shutdown_drained")
		cancel()
	case err := <-errCh:
		logging.Error(ctx, log, "accept_loop_failed", err)
		cancel()
		os.Exit(1)
	}
}
