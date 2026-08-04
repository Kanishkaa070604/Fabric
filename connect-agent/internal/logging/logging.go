package logging

import (
	"context"
	"log/slog"
	"os"
	"strings"
)

type ctxKey struct{}

type Fields struct {
	CorrelationID  string
	TenantID       string
	RegistrationID string
	AgentID        string
	StreamID       string
	Layer          string
	Component      string
}

func WithFields(ctx context.Context, f Fields) context.Context {
	existing, _ := ctx.Value(ctxKey{}).(Fields)
	merged := existing
	if f.CorrelationID != "" {
		merged.CorrelationID = f.CorrelationID
	}
	if f.TenantID != "" {
		merged.TenantID = f.TenantID
	}
	if f.RegistrationID != "" {
		merged.RegistrationID = f.RegistrationID
	}
	if f.AgentID != "" {
		merged.AgentID = f.AgentID
	}
	if f.StreamID != "" {
		merged.StreamID = f.StreamID
	}
	if f.Layer != "" {
		merged.Layer = f.Layer
	}
	if f.Component != "" {
		merged.Component = f.Component
	}
	return context.WithValue(ctx, ctxKey{}, merged)
}

func FromContext(ctx context.Context) Fields {
	f, _ := ctx.Value(ctxKey{}).(Fields)
	return f
}

func New(component string) *slog.Logger {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("FABRIC_LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	return slog.New(h).With("component", component)
}

func Attrs(f Fields) []any {
	out := make([]any, 0, 12)
	if f.Component != "" {
		out = append(out, "component", f.Component)
	}
	if f.Layer != "" {
		out = append(out, "layer", f.Layer)
	}
	if f.CorrelationID != "" {
		out = append(out, "correlation_id", f.CorrelationID)
	}
	if f.TenantID != "" {
		out = append(out, "tenant_id", f.TenantID)
	}
	if f.RegistrationID != "" {
		out = append(out, "registration_id", f.RegistrationID)
	}
	if f.AgentID != "" {
		out = append(out, "agent_id", f.AgentID)
	}
	if f.StreamID != "" {
		out = append(out, "stream_id", f.StreamID)
	}
	return out
}

func Info(ctx context.Context, log *slog.Logger, msg string, kv ...any) {
	f := FromContext(ctx)
	log.Info(msg, append(Attrs(f), kv...)...)
}

func Error(ctx context.Context, log *slog.Logger, msg string, err error, kv ...any) {
	f := FromContext(ctx)
	args := append(Attrs(f), kv...)
	if err != nil {
		args = append(args, "error", err.Error())
	}
	log.Error(msg, args...)
}

func Debug(ctx context.Context, log *slog.Logger, msg string, kv ...any) {
	f := FromContext(ctx)
	log.Debug(msg, append(Attrs(f), kv...)...)
}
