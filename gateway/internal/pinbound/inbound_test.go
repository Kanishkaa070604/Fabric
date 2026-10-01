package pinbound_test

import (
	"testing"

	"github.com/abluva/fabric/gateway/internal/pinbound"
)

func TestParseInboundHost(t *testing.T) {
	tid, rid, err := pinbound.ParseInboundHost(
		"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.11111111-2222-3333-4444-555555555555.connect.fabric",
		"connect.fabric",
	)
	if err != nil {
		t.Fatal(err)
	}
	if rid != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatalf("reg=%s", rid)
	}
	if tid != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("tenant=%s", tid)
	}
	if _, _, err := pinbound.ParseInboundHost("bad", "connect.fabric"); err == nil {
		t.Fatal("expected error")
	}
}
