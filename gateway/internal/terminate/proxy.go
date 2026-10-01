package terminate

import (
	"bufio"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net"

	proxyproto "github.com/pires/go-proxyproto"
)

// Identity extracted from Ghostunnel PROXY protocol v2 with --proxy-protocol-mode=tls-full.
// Docs: https://ghostunnel.dev/docs/networking/proxy-protocol/
//
// Ghostunnel (≥ v1.10.0) sends PP2_TYPE_SSL (0x20) with a 5-byte sub-header, then nested
// TLVs. In tls-full mode with a client cert, nested PP2_SUBTYPE_SSL_CLIENT_CERT (0x28)
// carries the full DER certificate. PP2_SUBTYPE_SSL_CN (0x22) may carry the CN.
type Identity struct {
	SourceAddr      string
	CertFingerprint string
	CertCN          string
	RawCertDER      []byte
}

const (
	pp2ClientCert = proxyproto.PP2Type(0x28)
	// tls-full headers include the full client cert DER and routinely exceed 256 bytes.
	// go-proxyproto.NewConn hardcodes a 256-byte bufio buffer; Peek(headerLen) then fails
	// with ErrBufferFull for real Ghostunnel certs. Use a buffer large enough for a leaf cert.
	proxyHeaderBufSize = 64 * 1024
)

// connWithHeader is a net.Conn that has already consumed a PROXY v2 header.
type connWithHeader struct {
	net.Conn
	br  *bufio.Reader
	hdr *proxyproto.Header
}

func (c *connWithHeader) Read(b []byte) (int, error) {
	return c.br.Read(b)
}

func (c *connWithHeader) ProxyHeader() *proxyproto.Header {
	return c.hdr
}

type proxyListener struct {
	net.Listener
}

// WrapListener returns a listener that reads PROXY protocol v2 before Accept returns.
func WrapListener(ln net.Listener) net.Listener {
	return &proxyListener{Listener: ln}
}

func (l *proxyListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	br := bufio.NewReaderSize(c, proxyHeaderBufSize)
	hdr, err := proxyproto.Read(br)
	if err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("terminate: read PROXY header: %w", err)
	}
	if hdr == nil {
		_ = c.Close()
		return nil, fmt.Errorf("terminate: missing PROXY header")
	}
	return &connWithHeader{Conn: c, br: br, hdr: hdr}, nil
}

// IdentityFromConn recovers client cert material from PROXY TLVs.
// Returns an error if the Ghostunnel tls-full client certificate TLV is missing —
// Gateway must fail closed rather than accept anonymous tunnels.
func IdentityFromConn(conn net.Conn) (Identity, error) {
	id := Identity{}
	var hdr *proxyproto.Header
	switch c := conn.(type) {
	case *connWithHeader:
		hdr = c.ProxyHeader()
	case *proxyproto.Conn:
		hdr = c.ProxyHeader()
		if hdr == nil {
			// Surface parse/policy errors that ProxyHeader() otherwise swallows.
			if _, err := c.Read(nil); err != nil && err != io.EOF {
				return id, fmt.Errorf("terminate: PROXY header: %w", err)
			}
			return id, fmt.Errorf("terminate: missing PROXY header")
		}
	default:
		return id, fmt.Errorf("terminate: expected PROXY-wrapped conn (set Ghostunnel --proxy-protocol-mode=tls-full)")
	}
	if hdr == nil {
		return id, fmt.Errorf("terminate: missing PROXY header")
	}
	src := ""
	if hdr.SourceAddr != nil {
		src = hdr.SourceAddr.String()
	} else if addr := conn.RemoteAddr(); addr != nil {
		src = addr.String()
	}
	return IdentityFromHeader(hdr, src)
}

// IdentityFromHeader parses Ghostunnel tls-full PROXY v2 TLVs (testable without a live socket).
func IdentityFromHeader(hdr *proxyproto.Header, sourceAddr string) (Identity, error) {
	id := Identity{SourceAddr: sourceAddr}
	tlvs, err := hdr.TLVs()
	if err != nil {
		return id, fmt.Errorf("terminate: parse PROXY TLVs: %w", err)
	}

	for _, tlv := range tlvs {
		if tlv.Type == proxyproto.PP2_TYPE_SSL {
			if err := parseSSLContainer(&id, tlv.Value); err != nil {
				return id, err
			}
			continue
		}
		if tlv.Type == pp2ClientCert {
			if err := applyCertDER(&id, tlv.Value); err != nil {
				return id, err
			}
		}
		if tlv.Type == proxyproto.PP2_SUBTYPE_SSL_CN && len(tlv.Value) > 0 && id.CertCN == "" {
			id.CertCN = string(tlv.Value)
		}
	}

	if id.CertFingerprint == "" {
		return id, fmt.Errorf("terminate: no client certificate in PROXY TLVs (require Ghostunnel v1.10+ --proxy-protocol-mode=tls-full and a client cert)")
	}
	return id, nil
}

// parseSSLContainer implements Ghostunnel's PP2_TYPE_SSL layout:
// 1 byte client flags + 4 byte verify + nested TLVs.
func parseSSLContainer(id *Identity, value []byte) error {
	if len(value) < 5 {
		return fmt.Errorf("terminate: SSL TLV too short")
	}
	nested, err := proxyproto.SplitTLVs(value[5:])
	if err != nil {
		return fmt.Errorf("terminate: nested SSL TLVs: %w", err)
	}
	for _, n := range nested {
		switch n.Type {
		case proxyproto.PP2_SUBTYPE_SSL_CN:
			if len(n.Value) > 0 && id.CertCN == "" {
				id.CertCN = string(n.Value)
			}
		case pp2ClientCert:
			if err := applyCertDER(id, n.Value); err != nil {
				return err
			}
		}
	}
	return nil
}

func applyCertDER(id *Identity, der []byte) error {
	if len(der) == 0 {
		return fmt.Errorf("terminate: empty client cert TLV")
	}
	cert, err := tryParseCert(der)
	if err != nil {
		return fmt.Errorf("terminate: parse client cert DER: %w", err)
	}
	id.RawCertDER = cert.Raw
	if id.CertCN == "" {
		id.CertCN = cert.Subject.CommonName
	}
	sum := sha256.Sum256(cert.Raw)
	id.CertFingerprint = hex.EncodeToString(sum[:])
	return nil
}

func tryParseCert(b []byte) (*x509.Certificate, error) {
	if cert, err := x509.ParseCertificate(b); err == nil {
		return cert, nil
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, fmt.Errorf("not a certificate")
	}
	return x509.ParseCertificate(block.Bytes)
}
