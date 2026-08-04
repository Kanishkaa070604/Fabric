package terminate_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"math/big"
	"net"
	"testing"
	"time"

	proxyproto "github.com/pires/go-proxyproto"

	"github.com/abluva/fabric/gateway/internal/terminate"
)

// Asserts our parser matches Ghostunnel docs for --proxy-protocol-mode=tls-full:
// PP2_TYPE_SSL (0x20) = 5-byte sub-header + nested PP2_SUBTYPE_SSL_CLIENT_CERT (0x28) DER.
func TestIdentityFromGhostunnelTLSFullTLVs(t *testing.T) {
	der, wantFP := mustLeafCert(t)

	sslPayload := make([]byte, 0, 5+3+len(der)+3+8)
	sslPayload = append(sslPayload, 0x07)       // flags: SSL + cert on conn + cert on session
	sslPayload = append(sslPayload, 0, 0, 0, 0) // verify = 0
	sslPayload = append(sslPayload, encodeTLV(0x28, der)...)
	sslPayload = append(sslPayload, encodeTLV(0x22, []byte("agent-1"))...)

	hdr := &proxyproto.Header{
		Version:           2,
		Command:           proxyproto.PROXY,
		TransportProtocol: proxyproto.TCPv4,
		SourceAddr:        &net.TCPAddr{IP: net.ParseIP("10.0.0.1"), Port: 40000},
		DestinationAddr:   &net.TCPAddr{IP: net.ParseIP("10.0.0.2"), Port: 8443},
	}
	if err := hdr.SetTLVs([]proxyproto.TLV{{Type: proxyproto.PP2_TYPE_SSL, Value: sslPayload}}); err != nil {
		t.Fatal(err)
	}

	id, err := terminate.IdentityFromHeader(hdr, "10.0.0.1:40000")
	if err != nil {
		t.Fatalf("IdentityFromHeader: %v", err)
	}
	if id.CertFingerprint != wantFP {
		t.Fatalf("fingerprint got=%s want=%s", id.CertFingerprint, wantFP)
	}
	if id.CertCN != "test-agent" && id.CertCN != "agent-1" {
		t.Fatalf("CN got=%q", id.CertCN)
	}
}

func encodeTLV(typ byte, value []byte) []byte {
	out := make([]byte, 3+len(value))
	out[0] = typ
	binary.BigEndian.PutUint16(out[1:3], uint16(len(value)))
	copy(out[3:], value)
	return out
}

func mustLeafCert(t *testing.T) (der []byte, fp string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test-agent"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err = x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return der, hex.EncodeToString(sum[:])
}

// Regression: go-proxyproto's default 256-byte bufio cannot Peek() a tls-full header
// that carries a real client certificate (~900+ bytes).
func TestWrapListenerLargeTLSFullHeader(t *testing.T) {
	der, wantFP := mustLeafCert(t)

	sslPayload := make([]byte, 0, 5+3+len(der))
	sslPayload = append(sslPayload, 0x07)
	sslPayload = append(sslPayload, 0, 0, 0, 0)
	sslPayload = append(sslPayload, encodeTLV(0x28, der)...)

	hdr := &proxyproto.Header{
		Version:           2,
		Command:           proxyproto.PROXY,
		TransportProtocol: proxyproto.TCPv4,
		SourceAddr:        &net.TCPAddr{IP: net.ParseIP("10.0.0.1"), Port: 40000},
		DestinationAddr:   &net.TCPAddr{IP: net.ParseIP("10.0.0.2"), Port: 8443},
	}
	if err := hdr.SetTLVs([]proxyproto.TLV{{Type: proxyproto.PP2_TYPE_SSL, Value: sslPayload}}); err != nil {
		t.Fatal(err)
	}
	raw, err := hdr.Format()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 256 {
		t.Fatalf("expected header >256 bytes for regression, got %d", len(raw))
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	pln := terminate.WrapListener(ln)

	errCh := make(chan error, 1)
	go func() {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			errCh <- err
			return
		}
		defer c.Close()
		_, err = c.Write(raw)
		errCh <- err
		time.Sleep(200 * time.Millisecond)
	}()

	conn, err := pln.Accept()
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	defer conn.Close()
	id, err := terminate.IdentityFromConn(conn)
	if err != nil {
		t.Fatalf("IdentityFromConn: %v", err)
	}
	if id.CertFingerprint != wantFP {
		t.Fatalf("fp got=%s want=%s", id.CertFingerprint, wantFP)
	}
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
}
