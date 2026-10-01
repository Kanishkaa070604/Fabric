package pinbound

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/abluva/fabric/gateway/internal/dispatch/adapter"
	"github.com/abluva/fabric/gateway/internal/dispatch/authorize"
	"github.com/abluva/fabric/gateway/internal/logging"
)

// Server accepts platform→customer TCP (G-A3-1). Clients dial with TLS SNI
// `<registration_id>.<tenant_id>.<DomainSuffix>` (default connect.fabric).
type Server struct {
	Log          *slog.Logger
	ListenAddr   string
	CertFile     string
	KeyFile      string
	DomainSuffix string // e.g. connect.fabric
	Authorizer   *authorize.Authorizer
	Adapters     *adapter.Registry
}

func (s *Server) Run(ctx context.Context) error {
	if s.ListenAddr == "" {
		return nil
	}
	suffix := s.DomainSuffix
	if suffix == "" {
		suffix = "connect.fabric"
	}
	cert, err := tls.LoadX509KeyPair(s.CertFile, s.KeyFile)
	if err != nil {
		return fmt.Errorf("inbound tls load: %w", err)
	}
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
	}
	ln, err := tls.Listen("tcp", s.ListenAddr, tlsCfg)
	if err != nil {
		return fmt.Errorf("inbound listen: %w", err)
	}
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	logging.Info(ctx, s.Log, "platform_inbound_listening",
		"addr", s.ListenAddr,
		"domain_suffix", suffix,
	)
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return err
			}
		}
		go s.handle(ctx, conn, suffix)
	}
}

func (s *Server) handle(parent context.Context, conn net.Conn, suffix string) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		return
	}
	if err := tlsConn.Handshake(); err != nil {
		logging.Debug(parent, s.Log, "inbound_handshake_failed", "error", err.Error())
		return
	}
	_ = conn.SetDeadline(time.Time{})
	sni := tlsConn.ConnectionState().ServerName
	tenantID, regID, err := ParseInboundHost(sni, suffix)
	if err != nil {
		logging.Info(parent, s.Log, "inbound_host_rejected", "sni", sni, "error", err.Error())
		return
	}
	ctx := logging.WithFields(parent, logging.Fields{
		Layer:          "gateway.inbound",
		TenantID:       tenantID,
		RegistrationID: regID,
	})
	logging.Info(ctx, s.Log, "inbound_accepted", "sni", sni)

	decision, err := s.Authorizer.AuthorizeInbound(ctx, tenantID, regID)
	if err != nil {
		logging.Info(ctx, s.Log, "inbound_denied", "reason", err.Error())
		return
	}
	release, err := s.Authorizer.ReserveStream(ctx, tenantID, decision.Quotas)
	if err != nil {
		logging.Info(ctx, s.Log, "inbound_denied", "reason", err.Error())
		return
	}
	defer release()
	ad, ok := s.Adapters.Get(decision.AdapterKind)
	if !ok {
		logging.Info(ctx, s.Log, "inbound_denied", "reason", "no adapter")
		return
	}
	dest := adapter.Destination{
		Kind:           decision.AdapterKind,
		TenantID:       tenantID,
		RegistrationID: regID,
		Host:           decision.Registration.Host,
		Port:           decision.Registration.Port,
		AgentID:        decision.AgentID,
	}
	ctx = logging.WithFields(ctx, logging.Fields{AgentID: decision.AgentID})
	downstream, err := ad.Connect(ctx, dest)
	if err != nil {
		logging.Error(ctx, s.Log, "inbound_adapter_failed", err)
		return
	}
	defer downstream.Close()
	logging.Info(ctx, s.Log, "inbound_relay_start", "adapter", decision.AdapterKind)
	relay(ctx, s.Log, conn, downstream)
}

// ParseInboundHost parses `<registration_id>.<tenant_id>.<suffix>`.
func ParseInboundHost(host, suffix string) (tenantID, registrationID string, err error) {
	host = strings.TrimSpace(strings.ToLower(host))
	host = strings.TrimSuffix(host, ".")
	suffix = strings.TrimSpace(strings.ToLower(suffix))
	suffix = strings.TrimPrefix(suffix, ".")
	if host == "" || suffix == "" {
		return "", "", errors.New("empty host or suffix")
	}
	if !strings.HasSuffix(host, "."+suffix) {
		return "", "", fmt.Errorf("host %q missing suffix %q", host, suffix)
	}
	head := strings.TrimSuffix(host, "."+suffix)
	// registration_id and tenant_id are UUIDs (contain hyphens, no dots).
	parts := strings.Split(head, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("host %q want <reg_id>.<tenant_id>.%s", host, suffix)
	}
	return parts[1], parts[0], nil
}

// closeWriter mirrors gateway/internal/session/handler.go's relay: wait for
// both directions to finish before returning (rather than the first one),
// half-closing each destination as its own source direction EOFs so the
// other, still-open direction can keep draining instead of being cut off.
type closeWriter interface {
	CloseWrite() error
}

func relay(ctx context.Context, log *slog.Logger, a, b io.ReadWriteCloser) {
	var wg sync.WaitGroup
	wg.Add(2)
	copyHalf := func(dst, src io.ReadWriteCloser) {
		defer wg.Done()
		_, err := io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
		if err != nil && !errors.Is(err, io.EOF) {
			logging.Debug(ctx, log, "inbound_relay_half_closed", "error", err.Error())
		}
	}
	go copyHalf(a, b)
	go copyHalf(b, a)
	wg.Wait()
}
