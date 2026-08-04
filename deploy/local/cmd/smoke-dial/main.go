package main

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"os"
	"time"
)

// smoke-dial opens an mTLS connection to Ghostunnel (Gateway front).
func main() {
	addr := env("FABRIC_GATEWAY_ADDRESS", "127.0.0.1:18443")
	certFile := env("FABRIC_AGENT_CERT", "certs/agent.crt")
	keyFile := env("FABRIC_AGENT_KEY", "certs/agent.key")
	caFile := env("FABRIC_CA_CERT", "certs/ca.crt")

	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	must(err)
	caPEM, err := os.ReadFile(caFile)
	must(err)
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		must(fmt.Errorf("parse ca"))
	}

	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	must(err)
	sum := sha256.Sum256(leaf.Raw)
	fp := hex.EncodeToString(sum[:])
	fmt.Println("agent_cert_sha256=" + fp)

	conn, err := tls.Dial("tcp", addr, &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      pool,
		MinVersion:   tls.VersionTLS13,
		ServerName:   env("FABRIC_TLS_SERVER_NAME", "fabric-gateway"),
	})
	must(err)
	defer conn.Close()
	fmt.Println("tls_handshake_ok addr=" + addr)
	time.Sleep(2 * time.Second)
	fmt.Println("smoke_dial_held_ok")
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
