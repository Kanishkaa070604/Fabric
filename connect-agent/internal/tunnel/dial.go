package tunnel

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"time"

	"github.com/hashicorp/yamux"

	"github.com/abluva/fabric/connect-agent/internal/logging"
	"log/slog"
)

type Session struct {
	Yamux *yamux.Session
	Conn  *tls.Conn
}

func Dial(ctx context.Context, log *slog.Logger, gatewayAddr, serverName, certFile, keyFile, caFile string, keepAlive, writeTO time.Duration) (*Session, error) {
	ctx = logging.WithFields(ctx, logging.Fields{Layer: "agent.tunnel"})
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load agent cert: %w", err)
	}
	rootPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("load ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(rootPEM) {
		return nil, fmt.Errorf("parse ca pem")
	}

	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      pool,
		MinVersion:   tls.VersionTLS13,
	}
	if serverName != "" {
		tlsCfg.ServerName = serverName
	}

	d := tls.Dialer{Config: tlsCfg}
	logging.Info(ctx, log, "dialing_gateway", "addr", gatewayAddr, "server_name", serverName)
	dialCtx, dialCancel := context.WithTimeout(ctx, 30*time.Second)
	defer dialCancel()
	conn, err := d.DialContext(dialCtx, "tcp", gatewayAddr)
	if err != nil {
		return nil, fmt.Errorf("tls dial: %w", err)
	}
	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		_ = conn.Close()
		return nil, fmt.Errorf("expected tls.Conn")
	}

	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = keepAlive
	cfg.ConnectionWriteTimeout = writeTO
	// L2 §J.1: set StreamOpenTimeout explicitly (do not rely on library default).
	cfg.StreamOpenTimeout = writeTO
	sess, err := yamux.Client(tlsConn, cfg)
	if err != nil {
		_ = tlsConn.Close()
		return nil, fmt.Errorf("yamux client: %w", err)
	}
	logging.Info(ctx, log, "tunnel_ready")
	return &Session{Yamux: sess, Conn: tlsConn}, nil
}

func (s *Session) Close() error {
	if s.Yamux != nil {
		_ = s.Yamux.Close()
	}
	if s.Conn != nil {
		return s.Conn.Close()
	}
	return nil
}
