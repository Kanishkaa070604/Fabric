package stream

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

type ConnectivityType string

const (
	TypeService  ConnectivityType = "SERVICE"
	TypeResource ConnectivityType = "RESOURCE"
)

type StreamOpen struct {
	TenantID         string           `json:"tenant_id"`
	RegistrationID   string           `json:"registration_id"`
	ConnectivityType ConnectivityType `json:"connectivity_type"`
	WorkloadEvidence []byte           `json:"workload_evidence,omitempty"`
	ProtocolVersion  uint32           `json:"protocol_version"`
}

// L2 §J.4: this Agent build's protocol_version. Must stay within
// [gateway.MinSupportedProtocolVersion, gateway.CurrentProtocolVersion].
const CurrentProtocolVersion uint32 = 1

// Outcome is the L2 §J.3 wire enum — exactly these five values, no more.
// A denial that is really "pending approval" or "unsupported version" comes
// back as UNAUTHORIZED with a specific `reason` string; there is no separate
// wire value for either case (see gateway/internal/stream/framing.go).
type Outcome string

const (
	OutcomeAccepted               Outcome = "ACCEPTED"
	OutcomeUnauthorized           Outcome = "UNAUTHORIZED"
	OutcomeNotFound               Outcome = "NOT_FOUND"
	OutcomeDestinationUnavailable Outcome = "DESTINATION_UNAVAILABLE"
	OutcomeRetryLater             Outcome = "RETRY_LATER"
)

type StreamOpenResult struct {
	Outcome       Outcome `json:"outcome"`
	Reason        string  `json:"reason,omitempty"`
	CorrelationID string  `json:"correlation_id,omitempty"`
}

// AgentDial is the first frame on a Gateway→Agent CONNECT_AGENT stream.
type AgentDial struct {
	RegistrationID string `json:"registration_id"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
}

func WriteMessage(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(b)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func ReadMessage(r io.Reader, v any) error {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > 1<<20 {
		return fmt.Errorf("stream: invalid frame length %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return err
	}
	return json.Unmarshal(buf, v)
}
