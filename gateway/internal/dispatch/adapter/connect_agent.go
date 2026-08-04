package adapter

import (
	"context"
	"fmt"
	"io"

	"github.com/abluva/fabric/gateway/internal/stream"
)

// ConnectAgentAdapter opens a stream on an existing agent tunnel (selected upstream).
// Tunnel dial is injected to keep this package free of yamux details.
type TunnelDialer func(ctx context.Context, agentID string) (io.ReadWriteCloser, error)

type ConnectAgentAdapter struct {
	Dial TunnelDialer
}

func (a *ConnectAgentAdapter) Kind() string { return "CONNECT_AGENT" }

func (a *ConnectAgentAdapter) Connect(ctx context.Context, dest Destination) (io.ReadWriteCloser, error) {
	if a.Dial == nil {
		return nil, fmt.Errorf("connect_agent: dialer not configured")
	}
	if dest.AgentID == "" {
		return nil, fmt.Errorf("connect_agent: agent_id required")
	}
	if dest.Host == "" || dest.Port == 0 {
		return nil, fmt.Errorf("connect_agent: host/port required on registration")
	}
	st, err := a.Dial(ctx, dest.AgentID)
	if err != nil {
		return nil, err
	}
	if err := stream.WriteMessage(st, stream.AgentDial{
		RegistrationID: dest.RegistrationID,
		Host:           dest.Host,
		Port:           dest.Port,
	}); err != nil {
		_ = st.Close()
		return nil, fmt.Errorf("connect_agent: write dial target: %w", err)
	}
	return st, nil
}
