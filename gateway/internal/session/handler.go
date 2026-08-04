package session

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hashicorp/yamux"

	"github.com/abluva/fabric/gateway/internal/dispatch/adapter"
	"github.com/abluva/fabric/gateway/internal/dispatch/authorize"
	"github.com/abluva/fabric/gateway/internal/logging"
	"github.com/abluva/fabric/gateway/internal/quota"
	"github.com/abluva/fabric/gateway/internal/store"
	"github.com/abluva/fabric/gateway/internal/stream"
	"github.com/abluva/fabric/gateway/internal/terminate"
)

type Handler struct {
	Log        *slog.Logger
	Authorizer *authorize.Authorizer
	Adapters   *adapter.Registry
	Store      *store.HTTPStore
	Tunnels    *TunnelRegistry
	Streams    *StreamRegistry
	KeepAlive  time.Duration
	WriteTO    time.Duration
	CPURL      string
	HTTPClient *http.Client

	// draining and inFlight implement Level 1 §12's graceful-shutdown step:
	// once draining is set, no new streams are dispatched (existing ones are
	// left alone to finish); inFlight lets main() bound how long it waits for
	// them before exiting.
	draining atomic.Bool
	inFlight sync.WaitGroup
}

func NewHandler(
	log *slog.Logger,
	authz *authorize.Authorizer,
	adapters *adapter.Registry,
	st *store.HTTPStore,
	tunnels *TunnelRegistry,
	cpURL string,
	keepAlive, writeTO time.Duration,
) *Handler {
	return &Handler{
		Log:        log,
		Authorizer: authz,
		Adapters:   adapters,
		Store:      st,
		Tunnels:    tunnels,
		Streams:    NewStreamRegistry(),
		KeepAlive:  keepAlive,
		WriteTO:    writeTO,
		CPURL:      cpURL,
		HTTPClient: &http.Client{Timeout: 5 * time.Second},
	}
}

// BeginDraining stops the Handler from dispatching any new stream (existing
// in-flight ones are left to finish/drain). Call on receipt of a shutdown
// signal, before closing the listener.
func (h *Handler) BeginDraining() {
	h.draining.Store(true)
}

// AwaitDrain blocks until every in-flight stream finishes or grace elapses,
// whichever comes first (Level 1 §12 graceful shutdown, bounded).
func (h *Handler) AwaitDrain(grace time.Duration) {
	done := make(chan struct{})
	go func() {
		h.inFlight.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(grace):
	}
}

// boundIdentity holds the (ctx, agentID, tenantID) triple ServeConn learns
// about its tunnel's owning agent/tenant, either immediately at accept
// time or later via tryBind's poll loop. It exists purely to make that
// triple safe to share between ServeConn's main goroutine (writer) and its
// heartbeat goroutine (reader) -- see the data-race comment at its call
// site in ServeConn.
type boundIdentity struct {
	mu       sync.Mutex
	ctx      context.Context
	agentID  string
	tenantID string
}

func (b *boundIdentity) set(ctx context.Context, agentID, tenantID string) {
	b.mu.Lock()
	b.ctx, b.agentID, b.tenantID = ctx, agentID, tenantID
	b.mu.Unlock()
}

func (b *boundIdentity) get() (ctx context.Context, agentID, tenantID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ctx, b.agentID, b.tenantID
}

func (h *Handler) ServeConn(parent context.Context, conn net.Conn) {
	defer conn.Close()

	corr := newID()
	ctx := logging.WithFields(parent, logging.Fields{
		Component:     "gateway",
		Layer:         "gateway.terminate",
		CorrelationID: corr,
	})

	id, err := terminate.IdentityFromConn(conn)
	if err != nil {
		logging.Error(ctx, h.Log, "proxy_identity_failed", err)
		return
	}
	ctx = logging.WithFields(ctx, logging.Fields{Layer: "gateway.session"})
	logging.Info(ctx, h.Log, "agent_tunnel_accepted",
		"source", id.SourceAddr,
		"cert_cn", id.CertCN,
		"cert_fp", id.CertFingerprint,
	)

	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = h.KeepAlive
	cfg.ConnectionWriteTimeout = h.WriteTO
	// L2 §J.1: set StreamOpenTimeout explicitly (do not rely on library default).
	cfg.StreamOpenTimeout = h.WriteTO

	sess, err := yamux.Server(conn, cfg)
	if err != nil {
		logging.Error(ctx, h.Log, "yamux_server_failed", err)
		return
	}
	defer sess.Close()

	// bound holds agentID/tenantID/ctx behind a mutex. The main ServeConn
	// goroutine below writes these (at accept time and, later, from
	// tryBind on the poll path) while the heartbeat goroutine started
	// further down reads them on every tick -- plain local variables here
	// would be a data race (the previous state of this code): concurrent
	// unsynchronized read/write of agentID/tenantID (strings) is undefined
	// behavior, and ctx (an interface value, i.e. a {type, data} pointer
	// pair) can be torn mid-read, which can crash the process outright
	// rather than just observing a stale value.
	bound := &boundIdentity{ctx: ctx}
	tunnelReserved := false
	reserveTunnel := func(tid string) error {
		if tid == "" || tunnelReserved {
			return nil
		}
		if err := h.Authorizer.ReserveTunnel(ctx, tid); err != nil {
			return err
		}
		tunnelReserved = true
		return nil
	}
	if id.CertFingerprint != "" {
		if aid, tid, err := h.lookupAgentByCert(ctx, id.CertFingerprint); err == nil {
			if revoked, err := h.Store.IsRevoked(ctx, tid, id.CertFingerprint); err == nil && revoked {
				logging.Info(ctx, h.Log, "tunnel_rejected", "reason", "certificate revoked")
				return
			}
			if err := reserveTunnel(tid); err != nil {
				// ReserveTunnel needs FetchAuthzContext for quota limits.
				// ErrLookupFailed = CP unreachable → keep the accepted
				// tunnel unbound; tryBind retries every 500ms. Any other
				// error (quota exceeded) is fatal for this session.
				if errors.Is(err, authorize.ErrLookupFailed) {
					logging.Info(ctx, h.Log, "tunnel_reserve_deferred",
						"error", err.Error(),
						"path", "accept",
						"note", "CP unreachable for quota; tryBind will retry")
					h.Tunnels.Put(id.CertFingerprint, "", "", sess)
				} else {
					logging.Info(ctx, h.Log, "tunnel_quota_denied", "reason", err.Error(), "path", "accept")
					return
				}
			} else {
				h.Tunnels.Put(id.CertFingerprint, aid, tid, sess)
				h.reportTunnelRetry(ctx, tid, aid, id.CertFingerprint, "up")
				ctx = logging.WithFields(ctx, logging.Fields{AgentID: aid, TenantID: tid})
				bound.set(ctx, aid, tid)
				logging.Info(ctx, h.Log, "agent_tunnel_bound", "agent_id", aid, "path", "accept")
			}
		} else {
			h.Tunnels.Put(id.CertFingerprint, "", "", sess)
			logging.Info(ctx, h.Log, "agent_lookup_deferred", "error", err.Error())
		}
	}
	defer func() {
		_, agentID, tenantID := bound.get()
		h.Tunnels.Remove(id.CertFingerprint, agentID, sess)
		if tunnelReserved {
			h.Authorizer.ReleaseTunnel(tenantID)
		}
		if tenantID != "" && agentID != "" {
			h.reportTunnelRetry(ctx, tenantID, agentID, id.CertFingerprint, "down")
		}
	}()

	// Bind may race enroll: dial often lands before agent-by-cert exists.
	// AcceptStream blocks, so we must poll independently or CONNECT_AGENT
	// never learns agent_id / tunnel-event "up" never fires.
	tryBind := func() (quotaDenied bool) {
		if _, agentID, _ := bound.get(); agentID != "" || id.CertFingerprint == "" {
			return false
		}
		aid, tid, err := h.lookupAgentByCert(ctx, id.CertFingerprint)
		if err != nil {
			return false
		}
		if revoked, err := h.Store.IsRevoked(ctx, tid, id.CertFingerprint); err == nil && revoked {
			logging.Info(ctx, h.Log, "tunnel_rejected", "reason", "certificate revoked")
			return true
		}
		if err := reserveTunnel(tid); err != nil {
			// Same policy as accept-time reserve above.
			if errors.Is(err, authorize.ErrLookupFailed) {
				logging.Info(ctx, h.Log, "tunnel_reserve_deferred",
					"error", err.Error(),
					"path", "poll",
					"note", "CP unreachable for quota; will retry next bind tick")
				return false
			}
			logging.Info(ctx, h.Log, "tunnel_quota_denied", "reason", err.Error(), "path", "poll")
			return true
		}
		h.Tunnels.BindAgentID(id.CertFingerprint, aid, tid)
		h.Tunnels.Put(id.CertFingerprint, aid, tid, sess)
		h.reportTunnelRetry(ctx, tid, aid, id.CertFingerprint, "up")
		ctx = logging.WithFields(ctx, logging.Fields{AgentID: aid, TenantID: tid})
		bound.set(ctx, aid, tid)
		logging.Info(ctx, h.Log, "agent_tunnel_bound", "agent_id", aid, "path", "poll")
		return false
	}

	// CP heartbeats are independent of yamux keepalive: keepalive can be long
	// for idle tunnels, but last_heartbeat_at must stay fresh vs the watchdog.
	hbEvery := h.KeepAlive
	if hbEvery <= 0 || hbEvery > 15*time.Second {
		hbEvery = 15 * time.Second
	}
	hbStop := make(chan struct{})
	defer close(hbStop)
	go func() {
		t := time.NewTicker(hbEvery)
		defer t.Stop()
		for {
			select {
			case <-hbStop:
				return
			case <-t.C:
				if hbCtx, agentID, tenantID := bound.get(); agentID != "" && tenantID != "" {
					_ = h.reportTunnel(hbCtx, tenantID, agentID, id.CertFingerprint, "heartbeat")
				}
			}
		}
	}()

	type acceptResult struct {
		st  *yamux.Stream
		err error
	}
	acceptCh := make(chan acceptResult, 1)
	// acceptDone unblocks this producer goroutine if ServeConn returns
	// while it's stuck trying to hand off a stream nobody will ever read
	// (e.g. tryBind() denies the tunnel and the main loop `return`s right
	// after AcceptStream succeeds but before the send is received). Without
	// this, the goroutine -- and the yamux stream it's holding -- leaked
	// until the whole session eventually died.
	acceptDone := make(chan struct{})
	defer close(acceptDone)
	go func() {
		for {
			st, err := sess.AcceptStream()
			select {
			case acceptCh <- acceptResult{st: st, err: err}:
			case <-acceptDone:
				if err == nil && st != nil {
					_ = st.Close()
				}
				return
			}
			if err != nil {
				return
			}
		}
	}()

	bindTick := time.NewTicker(500 * time.Millisecond)
	defer bindTick.Stop()

	for {
		select {
		case <-bindTick.C:
			if tryBind() {
				return
			}
		case ar := <-acceptCh:
			if ar.err != nil {
				if !errors.Is(ar.err, io.EOF) && !errors.Is(ar.err, yamux.ErrSessionShutdown) {
					logging.Error(ctx, h.Log, "yamux_accept_failed", ar.err)
				}
				return
			}
			if tryBind() {
				_ = ar.st.Close()
				return
			}
			if h.draining.Load() {
				// Level 1 §12: refuse new streams on this replica; leave the
				// yamux session up until process exit so in-flight relays
				// can finish. Prefer a protocol RETRY_LATER so the Agent
				// logs stream_open_rejected (reason=gateway_draining) instead
				// of a raw EOF on ReadMessage — the app dial still fails once,
				// but ops can tell "rolling update" from "tunnel death".
				// If StreamOpen has not arrived yet, close without a result.
				logging.Info(ctx, h.Log, "stream_refused_draining")
				var open stream.StreamOpen
				if rerr := stream.ReadMessage(ar.st, &open); rerr == nil {
					_ = stream.WriteMessage(ar.st, stream.StreamOpenResult{
						Outcome:       stream.OutcomeRetryLater,
						Reason:        "gateway_draining",
						CorrelationID: logging.FromContext(ctx).CorrelationID,
					})
				}
				_ = ar.st.Close()
				continue
			}
			go h.handleStream(ctx, id, ar.st)
		}
	}
}

// ReconcileSecurity periodically force-closes tunnels that violate live revoke/suspend.
func (h *Handler) ReconcileSecurity(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 2 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			certs, tenants := h.Tunnels.Snapshot()
			for _, tid := range tenants {
				suspended, err := h.Store.TenantSuspended(ctx, tid)
				if err != nil || !suspended {
					continue
				}
				// L2 §G.3: billing/policy suspension drains in-flight work
				// (same as routine deletion); only a security-cause suspension
				// force-closes immediately. New streams are refused either way
				// via AuthorizeStream's unconditional tenant_suspended check.
				cause, err := h.Store.TenantSuspendCause(ctx, tid)
				if err != nil || cause != "security" {
					continue
				}
				n := h.Tunnels.CloseByTenant(tid)
				if n > 0 {
					logging.Info(ctx, h.Log, "security_force_close_tenant", "tenant_id", tid, "tunnels", n, "cause", cause)
				}
			}
			for _, fp := range certs {
				// Snapshot is fingerprint-only; resolve agent/tenant via CP
				// then IsRevoked. Use include_retired lookup: accept-time
				// lookup excludes Retired so a retired cert cannot rebind a
				// *new* tunnel, but this loop must still find an already-live
				// Retired tunnel or force-close never runs for that FP.
				aid, tid, state, err := h.lookupAgentByCertAny(ctx, fp)
				if err != nil || tid == "" {
					continue
				}
				// L2 §A.3: Retired is terminal with no recovery path -- unlike a
				// billing suspend or a routine decommission-cause revoke, there is
				// no legitimate reason for a Retired agent's tunnel to still be
				// live, so this force-closes immediately rather than waiting on a
				// drain grace window (mirrors the "fail safe" default elsewhere in
				// this loop, not a new policy).
				if state == "Retired" {
					if h.Tunnels.CloseByCertFP(fp) {
						logging.Info(ctx, h.Log, "retired_agent_force_close", "cert_fp", fp, "tenant_id", tid, "agent_id", aid)
					}
					continue
				}
				revoked, err := h.Store.IsRevoked(ctx, tid, fp)
				// CP unreachable → skip this FP this tick (fail-open for
				// *existing* tunnels). New StreamOpens still get RETRY_LATER
				// via AuthorizeStream/ErrLookupFailed. Next tick retries.
				if err != nil || !revoked {
					continue
				}
				// L2 §D.3: a routine decommission may drain gracefully; only a
				// security-triggered revocation force-closes with no drain window.
				cause, err := h.Store.CertRevokeCause(ctx, tid, fp)
				if err != nil || cause != "security" {
					continue
				}
				if h.Tunnels.CloseByCertFP(fp) {
					logging.Info(ctx, h.Log, "security_force_close_cert", "cert_fp", fp, "tenant_id", tid, "cause", cause)
				}
			}
		}
	}
}

// ReconcileRegistrationDrain implements L2 §G.3 rows 1 and 3: a Registration
// that has left Active (Deleting/Deleted/Failed/not-found) drains naturally,
// then is force-closed after a bounded grace window; a billing-suspended
// tenant behaves the same way, tenant-wide. Registrations in Updating are
// deliberately left untouched (row 2 -- existing streams keep running on
// their pre-update configuration until they complete on their own).
// Security-cause suspension/revocation is handled immediately, with no
// grace window, by ReconcileSecurity -- this loop only ever fires for the
// routine/billing causes.
func (h *Handler) ReconcileRegistrationDrain(ctx context.Context, every, grace time.Duration) {
	if every <= 0 {
		every = 10 * time.Second
	}
	if grace <= 0 {
		grace = 3 * time.Minute
	}
	notRoutableSince := map[RegKey]time.Time{}
	billingSuspendedSince := map[string]time.Time{}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now()

			for _, k := range h.Streams.LiveRegistrations() {
				reg, err := h.Store.GetRegistration(ctx, k.TenantID, k.RegistrationID)
				nonRoutable := err != nil || reg == nil || (reg.State != "Active" && reg.State != "Updating")
				if !nonRoutable {
					delete(notRoutableSince, k)
					continue
				}
				since, seen := notRoutableSince[k]
				if !seen {
					notRoutableSince[k] = now
					continue
				}
				if now.Sub(since) >= grace {
					n := h.Streams.CloseByRegistration(k.TenantID, k.RegistrationID)
					delete(notRoutableSince, k)
					if n > 0 {
						logging.Info(ctx, h.Log, "registration_drain_grace_elapsed",
							"tenant_id", k.TenantID, "registration_id", k.RegistrationID, "streams_closed", n)
					}
				}
			}

			_, tenants := h.Tunnels.Snapshot()
			liveTenants := map[string]struct{}{}
			for _, tid := range tenants {
				liveTenants[tid] = struct{}{}
				suspended, err := h.Store.TenantSuspended(ctx, tid)
				if err != nil || !suspended {
					delete(billingSuspendedSince, tid)
					continue
				}
				cause, err := h.Store.TenantSuspendCause(ctx, tid)
				if err != nil || cause == "security" {
					// Security cause: ReconcileSecurity already force-closes
					// this immediately, with no drain window.
					delete(billingSuspendedSince, tid)
					continue
				}
				since, seen := billingSuspendedSince[tid]
				if !seen {
					billingSuspendedSince[tid] = now
					continue
				}
				if now.Sub(since) >= grace {
					n := h.Tunnels.CloseByTenant(tid)
					delete(billingSuspendedSince, tid)
					if n > 0 {
						logging.Info(ctx, h.Log, "billing_suspend_drain_grace_elapsed", "tenant_id", tid, "tunnels", n)
					}
				}
			}
			for tid := range billingSuspendedSince {
				if _, ok := liveTenants[tid]; !ok {
					delete(billingSuspendedSince, tid)
				}
			}
		}
	}
}

func (h *Handler) handleStream(parent context.Context, id terminate.Identity, sc *yamux.Stream) {
	defer sc.Close()
	streamID := newID()
	ctx := logging.WithFields(parent, logging.Fields{
		Layer:    "gateway.stream",
		StreamID: streamID,
	})

	var open stream.StreamOpen
	if err := stream.ReadMessage(sc, &open); err != nil {
		logging.Error(ctx, h.Log, "stream_open_read_failed", err)
		return
	}
	ctx = logging.WithFields(ctx, logging.Fields{
		TenantID:       open.TenantID,
		RegistrationID: open.RegistrationID,
		Layer:          "gateway.authz",
	})
	logging.Info(ctx, h.Log, "stream_open_received",
		"connectivity_type", open.ConnectivityType,
		"protocol_version", open.ProtocolVersion,
		"evidence_bytes", len(open.WorkloadEvidence),
	)

	// L2 §J.4: Gateway supports the current and immediately prior protocol
	// version. outcome stays within the L2 §J.3 enum (no dedicated value for
	// this) — UNAUTHORIZED with a specific reason is the spec-correct choice,
	// same as any other "specific rejection reason" case in §G.2/§J.3.
	if open.ProtocolVersion < stream.MinSupportedProtocolVersion || open.ProtocolVersion > stream.CurrentProtocolVersion {
		reason := fmt.Sprintf("unsupported protocol_version=%d (supported %d-%d)",
			open.ProtocolVersion, stream.MinSupportedProtocolVersion, stream.CurrentProtocolVersion)
		logging.Info(ctx, h.Log, "stream_denied", "outcome", stream.OutcomeUnauthorized, "reason", reason)
		_ = stream.WriteMessage(sc, stream.StreamOpenResult{
			Outcome:       stream.OutcomeUnauthorized,
			Reason:        reason,
			CorrelationID: logging.FromContext(ctx).CorrelationID,
		})
		return
	}

	// Single FetchAuthzContext via AuthorizeStream: approval, revoke,
	// suspend, quotas, registration, and eligible-agent selection.
	decision, err := h.Authorizer.AuthorizeStream(
		ctx,
		open.TenantID,
		open.RegistrationID,
		string(open.ConnectivityType),
		id.CertFingerprint,
	)
	if err != nil {
		if errors.Is(err, authorize.ErrLookupFailed) {
			logging.Error(ctx, h.Log, "authz_context_lookup_failed", err)
			_ = stream.WriteMessage(sc, stream.StreamOpenResult{
				Outcome:       stream.OutcomeRetryLater,
				Reason:        "authorization lookup failed",
				CorrelationID: logging.FromContext(ctx).CorrelationID,
			})
			return
		}
		out, reason := mapAuthzError(err)
		logging.Info(ctx, h.Log, "stream_denied",
			"outcome", out,
			"reason", reason,
			"agent_state", decision.AgentState,
		)
		// Security-cause denials also tear down the initiator tunnel immediately
		// (L3-GW-03 / L2 §D.3, §G.3). Billing suspension and routine-decommission
		// revocation drain instead — force-close would exceed spec.
		if errors.Is(err, authorize.ErrUnauthorized) {
			low := strings.ToLower(reason)
			if strings.Contains(low, "certificate revoked") && id.CertFingerprint != "" {
				cause, cerr := h.Store.CertRevokeCause(ctx, open.TenantID, id.CertFingerprint)
				if cerr == nil && cause == "security" && h.Tunnels.CloseByCertFP(id.CertFingerprint) {
					logging.Info(ctx, h.Log, "tunnel_force_close", "reason", "certificate revoked", "cause", cause)
				}
			}
			if strings.Contains(low, "tenant suspended") && open.TenantID != "" {
				cause, cerr := h.Store.TenantSuspendCause(ctx, open.TenantID)
				if cerr == nil && cause == "security" {
					if n := h.Tunnels.CloseByTenant(open.TenantID); n > 0 {
						logging.Info(ctx, h.Log, "tunnel_force_close", "reason", "tenant suspended", "tunnels", n, "cause", cause)
					}
				}
			}
		}
		_ = stream.WriteMessage(sc, stream.StreamOpenResult{
			Outcome:       out,
			Reason:        reason,
			CorrelationID: logging.FromContext(ctx).CorrelationID,
		})
		return
	}

	releaseStream, err := h.Authorizer.ReserveStream(ctx, open.TenantID, decision.Quotas)
	if err != nil {
		out, reason := mapAuthzError(err)
		logging.Info(ctx, h.Log, "stream_denied", "outcome", out, "reason", reason)
		_ = stream.WriteMessage(sc, stream.StreamOpenResult{
			Outcome:       out,
			Reason:        reason,
			CorrelationID: logging.FromContext(ctx).CorrelationID,
		})
		return
	}
	defer releaseStream()

	ad, ok := h.Adapters.Get(decision.AdapterKind)
	if !ok {
		_ = stream.WriteMessage(sc, stream.StreamOpenResult{
			Outcome:       stream.OutcomeDestinationUnavailable,
			Reason:        "no adapter for kind " + decision.AdapterKind,
			CorrelationID: logging.FromContext(ctx).CorrelationID,
		})
		return
	}

	dest := adapter.Destination{
		Kind:           decision.AdapterKind,
		TenantID:       open.TenantID,
		RegistrationID: open.RegistrationID,
		Host:           decision.Registration.Host,
		Port:           decision.Registration.Port,
		AgentID:        decision.AgentID,
	}

	ctx = logging.WithFields(ctx, logging.Fields{Layer: "gateway.dispatch", AgentID: decision.AgentID})
	downstream, err := ad.Connect(ctx, dest)
	if err != nil {
		logging.Error(ctx, h.Log, "adapter_connect_failed", err, "adapter", decision.AdapterKind)
		_ = stream.WriteMessage(sc, stream.StreamOpenResult{
			Outcome:       stream.OutcomeDestinationUnavailable,
			Reason:        err.Error(),
			CorrelationID: logging.FromContext(ctx).CorrelationID,
		})
		return
	}
	defer downstream.Close()

	if err := stream.WriteMessage(sc, stream.StreamOpenResult{
		Outcome:       stream.OutcomeAccepted,
		Reason:        "ok",
		CorrelationID: logging.FromContext(ctx).CorrelationID,
	}); err != nil {
		logging.Error(ctx, h.Log, "stream_open_result_write_failed", err)
		return
	}

	logging.Info(ctx, h.Log, "stream_accepted",
		"adapter", decision.AdapterKind,
		"selected_agent_id", decision.AgentID,
	)

	// L2 §G.3 rows 1/3: track this stream by (tenant, registration) so the
	// drain-reconcile loop can selectively force-close it once the owning
	// Registration leaves Active (Deleting/Deleted/Failed) or the tenant is
	// billing-suspended, after the grace window -- without touching this
	// tenant's other, unrelated registrations on the same tunnel.
	untrack := h.Streams.Track(open.TenantID, open.RegistrationID, biCloser{sc, downstream})
	defer untrack()

	// Level 1 §12 graceful shutdown: let main() bound how long it waits for
	// this relay to finish before the process exits.
	h.inFlight.Add(1)
	defer h.inFlight.Done()

	ctx = logging.WithFields(ctx, logging.Fields{Layer: "gateway.relay"})
	relay(ctx, h.Log, sc, downstream)
}

func (h *Handler) lookupAgentByCert(ctx context.Context, certFP string) (agentID, tenantID string, err error) {
	return h.lookupAgentByCertWith(ctx, certFP, false)
}

// lookupAgentByCertAny is like lookupAgentByCert but also resolves Retired
// (soft-deleted) agents. ReconcileSecurity (L2 §A.3) needs this specifically
// to find a Retired agent BY its still-live tunnel's cert fingerprint and
// force-close it -- the strict lookup used everywhere else intentionally
// excludes Retired agents so a *new* tunnel dial from a retired cert doesn't
// rebind at accept time.
func (h *Handler) lookupAgentByCertAny(ctx context.Context, certFP string) (agentID, tenantID, state string, err error) {
	agentID, tenantID, state, err = h.lookupAgentByCertWithState(ctx, certFP, true)
	return
}

func (h *Handler) lookupAgentByCertWith(ctx context.Context, certFP string, includeRetired bool) (agentID, tenantID string, err error) {
	agentID, tenantID, _, err = h.lookupAgentByCertWithState(ctx, certFP, includeRetired)
	return
}

func (h *Handler) lookupAgentByCertWithState(ctx context.Context, certFP string, includeRetired bool) (agentID, tenantID, state string, err error) {
	if h.CPURL == "" || certFP == "" {
		return "", "", "", fmt.Errorf("lookup unavailable")
	}
	q := "?cert_fingerprint=" + url.QueryEscape(certFP)
	if includeRetired {
		q += "&include_retired=1"
	}
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		h.CPURL+"/v1/internal/agent-by-cert"+q,
		nil,
	)
	if err != nil {
		return "", "", "", err
	}
	if h.Store != nil && h.Store.Token != "" {
		req.Header.Set("Authorization", "Bearer "+h.Store.Token)
	}
	res, err := h.HTTPClient.Do(req)
	if err != nil {
		return "", "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return "", "", "", fmt.Errorf("agent_not_found")
	}
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		return "", "", "", fmt.Errorf("agent-by-cert status=%d body=%s", res.StatusCode, string(b))
	}
	var out struct {
		AgentID  string `json:"agent_id"`
		TenantID string `json:"tenant_id"`
		State    string `json:"state"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", "", "", err
	}
	if out.AgentID == "" || out.TenantID == "" {
		return "", "", "", fmt.Errorf("agent-by-cert incomplete")
	}
	return out.AgentID, out.TenantID, out.State, nil
}

func (h *Handler) reportTunnelRetry(ctx context.Context, tenantID, agentID, certFP, event string) {
	var last error
	for i := 0; i < 3; i++ {
		last = h.reportTunnel(ctx, tenantID, agentID, certFP, event)
		if last == nil {
			return
		}
		time.Sleep(time.Duration(i+1) * 100 * time.Millisecond)
	}
	logging.Error(ctx, h.Log, "tunnel_event_failed", last, "event", event, "agent_id", agentID)
}

func (h *Handler) reportTunnel(ctx context.Context, tenantID, agentID, certFP, event string) error {
	if h.CPURL == "" {
		return nil
	}
	body, _ := json.Marshal(map[string]string{
		"tenant_id":        tenantID,
		"agent_id":         agentID,
		"cert_fingerprint": certFP,
		"event":            event,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.CPURL+"/v1/agents/tunnel-event", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ABLV-Actor", "gateway")
	if h.Store != nil && h.Store.Token != "" {
		req.Header.Set("Authorization", "Bearer "+h.Store.Token)
	}
	res, err := h.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		b, _ := io.ReadAll(res.Body)
		return fmt.Errorf("tunnel-event status=%d body=%s", res.StatusCode, string(b))
	}
	return nil
}

// closeWriter is implemented by *net.TCPConn (the adapter side of every
// relayed stream) and lets us signal "no more data from me" without tearing
// down the whole connection. *yamux.Stream does not implement it, but its
// own Close() already behaves as a graceful half-close for this purpose:
// per yamux's Stream.Read, "LocalClose only prohibits further local writes.
// Handle reads normally." -- so falling back to plain Close() below is
// correct for that side too.
type closeWriter interface {
	CloseWrite() error
}

// relay copies both directions between a and b and only returns once BOTH
// have finished. The previous version returned as soon as the FIRST
// io.Copy saw EOF, which then let the caller's deferred a.Close()/b.Close()
// fire immediately -- abruptly killing whichever direction was still
// mid-flight. Any real duplex protocol where one side finishes before the
// other (Postgres query/response boundaries, HTTP keep-alive, bulk/COPY
// uploads) could lose already-buffered bytes on the still-open direction.
// Half-closing the finished direction's destination (instead of a full
// close) lets that still-open direction keep draining to its own natural
// completion.
func relay(ctx context.Context, log *slog.Logger, a, b io.ReadWriteCloser) {
	var wg sync.WaitGroup
	wg.Add(2)
	copyHalf := func(dst, src io.ReadWriteCloser) {
		defer wg.Done()
		_, err := io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
		if err != nil && !errors.Is(err, io.EOF) {
			logging.Debug(ctx, log, "relay_half_closed", "error", err.Error())
		}
	}
	go copyHalf(a, b)
	go copyHalf(b, a)
	wg.Wait()
	logging.Debug(ctx, log, "relay_closed")
}

// mapAuthzError maps an authorize/quota error to the L2 §J.3 wire enum, which
// is exactly ACCEPTED | UNAUTHORIZED | NOT_FOUND | DESTINATION_UNAVAILABLE |
// RETRY_LATER — there is no PENDING_APPROVAL value on the wire; UNAUTHORIZED
// with a specific reason string is the spec-correct mapping for that case.
func mapAuthzError(err error) (stream.Outcome, string) {
	switch {
	case errors.Is(err, authorize.ErrLookupFailed):
		// Infra/transport failure talking to the control plane, not an
		// authorization decision -- RETRY_LATER, not UNAUTHORIZED.
		return stream.OutcomeRetryLater, err.Error()
	case errors.Is(err, authorize.ErrPendingApproval):
		return stream.OutcomeUnauthorized, err.Error()
	case errors.Is(err, authorize.ErrNotFound):
		return stream.OutcomeNotFound, err.Error()
	case errors.Is(err, authorize.ErrDestinationUnavail):
		return stream.OutcomeDestinationUnavailable, err.Error()
	case errors.Is(err, authorize.ErrQuotaExceeded):
		// §J.2.5 / §J.3: rate-limit exhaustion is transient (RETRY_LATER);
		// concurrent-stream-cap exhaustion gets a specific UNAUTHORIZED/quota
		// reason for audit rather than a blanket "try again".
		if errors.Is(err, quota.ErrRateExceeded) {
			return stream.OutcomeRetryLater, err.Error()
		}
		return stream.OutcomeUnauthorized, err.Error()
	default:
		return stream.OutcomeUnauthorized, err.Error()
	}
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
