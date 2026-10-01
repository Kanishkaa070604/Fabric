package stream

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// Wire format v1 scaffold: 4-byte big-endian length + JSON payload.
// Swap to protobuf without changing field semantics (connectivity-proto).

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

// L2 §J.4 Versioning: "the Gateway can support the current and immediately
// prior version concurrently for a defined deprecation window". v1 is the
// only version defined so far, so Min == Current; bump Current (and, on the
// next release after that, Min) when a new wire version ships.
const (
	CurrentProtocolVersion      uint32 = 1
	MinSupportedProtocolVersion uint32 = 1
)

// Outcome is the L2 §J.3 wire enum — exactly these five values, no more.
// PENDING_APPROVAL is deliberately NOT a wire value: §J.3 defines only
// ACCEPTED | UNAUTHORIZED | NOT_FOUND | DESTINATION_UNAVAILABLE | RETRY_LATER,
// so "agent pending approval" and "protocol version unsupported" are both
// carried as UNAUTHORIZED with a specific `reason` string instead (the same
// "specific rejection reason" principle §G.2 already requires for other
// non-generic denials).
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

// AgentDial is written by Gateway on a CONNECT_AGENT (Gateway→Agent) yamux stream
// before byte relay. Agent accepts the stream, dials Host:Port, then relays.
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
