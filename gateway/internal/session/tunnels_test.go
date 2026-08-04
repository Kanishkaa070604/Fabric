package session_test

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/abluva/fabric/gateway/internal/session"
	"github.com/hashicorp/yamux"
)

func yamuxPair(t *testing.T) (server, client *yamux.Session) {
	t.Helper()
	c1, c2 := net.Pipe()
	t.Cleanup(func() { _ = c1.Close(); _ = c2.Close() })
	srvDone := make(chan *yamux.Session, 1)
	go func() {
		s, err := yamux.Server(c2, yamux.DefaultConfig())
		if err != nil {
			t.Errorf("server: %v", err)
			return
		}
		srvDone <- s
	}()
	cli, err := yamux.Client(c1, yamux.DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	srv := <-srvDone
	t.Cleanup(func() { _ = cli.Close(); _ = srv.Close() })
	return srv, cli
}

func TestBindAgentIDThenDial(t *testing.T) {
	server, client := yamuxPair(t)
	reg := session.NewTunnelRegistry()
	const fp = "deadbeef"
	const aid = "agent-1"
	reg.Put(fp, "", "tenant-1", server)
	reg.BindAgentID(fp, aid, "tenant-1")

	go func() {
		st, err := client.AcceptStream()
		if err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, st)
		_ = st.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	st, err := reg.DialAgent(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	if reg.OpenStreamCount(aid) != 1 {
		t.Fatalf("open count want 1 got %d", reg.OpenStreamCount(aid))
	}
	_ = st.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if reg.OpenStreamCount(aid) == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("open count did not drop after close")
}

func TestRemoveStaleSessionDoesNotWipeNew(t *testing.T) {
	oldSrv, _ := yamuxPair(t)
	newSrv, newCli := yamuxPair(t)
	reg := session.NewTunnelRegistry()
	const fp = "fp1"
	const aid = "a1"
	reg.Put(fp, aid, "t1", oldSrv)
	reg.Put(fp, aid, "t1", newSrv) // supersedes old

	// Simulate old AcceptStream teardown.
	reg.Remove(fp, aid, oldSrv)

	go func() {
		st, err := newCli.AcceptStream()
		if err != nil {
			return
		}
		_ = st.Close()
	}()
	st, err := reg.DialAgent(context.Background(), aid)
	if err != nil {
		t.Fatalf("new session should still dial: %v", err)
	}
	_ = st.Close()
}

func TestCloseByCertAndTenant(t *testing.T) {
	srv, _ := yamuxPair(t)
	reg := session.NewTunnelRegistry()
	reg.Put("fp", "aid", "tenant-x", srv)
	if !reg.CloseByCertFP("fp") {
		t.Fatal("expected close by cert")
	}
	// Second pair for tenant close
	srv2, _ := yamuxPair(t)
	reg.Put("fp2", "aid2", "tenant-y", srv2)
	if n := reg.CloseByTenant("tenant-y"); n != 1 {
		t.Fatalf("close by tenant want 1 got %d", n)
	}
}
