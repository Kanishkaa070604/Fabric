package adapter

import (
	"context"
	"io"
)

// Destination is resolved after Gateway authorization (ADR-008).
type Destination struct {
	Kind           string // CONNECT_AGENT | PLATFORM_CONNECTOR | DIRECT_ENDPOINT
	TenantID       string
	RegistrationID string
	Host           string
	Port           int
	AgentID        string // when Kind == CONNECT_AGENT
}

// Adapter opens a byte stream to a destination. New kinds = new implementations.
type Adapter interface {
	Kind() string
	Connect(ctx context.Context, dest Destination) (io.ReadWriteCloser, error)
}

// Registry selects an adapter by destination kind (pluggable).
type Registry struct {
	byKind map[string]Adapter
}

func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{byKind: map[string]Adapter{}}
	for _, a := range adapters {
		r.byKind[a.Kind()] = a
	}
	return r
}

func (r *Registry) Get(kind string) (Adapter, bool) {
	a, ok := r.byKind[kind]
	return a, ok
}
