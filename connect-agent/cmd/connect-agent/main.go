package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"log/slog"
	mrand "math/rand"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/abluva/fabric/connect-agent/internal/certlife"
	"github.com/abluva/fabric/connect-agent/internal/config"
	"github.com/abluva/fabric/connect-agent/internal/cptoken"
	"github.com/abluva/fabric/connect-agent/internal/enroll"
	"github.com/abluva/fabric/connect-agent/internal/enroll/bootstrap"
	"github.com/abluva/fabric/connect-agent/internal/identity"
	"github.com/abluva/fabric/connect-agent/internal/identity/file"
	"github.com/abluva/fabric/connect-agent/internal/identity/k8ssecret"
	"github.com/abluva/fabric/connect-agent/internal/inbound"
	"github.com/abluva/fabric/connect-agent/internal/k8ssvc"
	"github.com/abluva/fabric/connect-agent/internal/listener"
	"github.com/abluva/fabric/connect-agent/internal/logging"
	"github.com/abluva/fabric/connect-agent/internal/stream"
	"github.com/abluva/fabric/connect-agent/internal/tunnel"
	"github.com/abluva/fabric/connect-agent/internal/watch"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "health", "ready":
			os.Exit(0)
		}
	}

	log := logging.New("connect-agent")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = logging.WithFields(ctx, logging.Fields{Component: "connect-agent", Layer: "main"})

	cfg, err := config.Load()
	if err != nil {
		logging.Error(ctx, log, "config_load_failed", err)
		os.Exit(1)
	}
	ctx = logging.WithFields(ctx, logging.Fields{TenantID: cfg.TenantID})

	store, err := newIdentityStore(cfg)
	if err != nil {
		logging.Error(ctx, log, "identity_store_init_failed", err)
		os.Exit(1)
	}
	paths := store.Paths()
	caFile := cfg.CAFile
	cp := os.Getenv("FABRIC_CONTROL_PLANE_URL")

	// G-CRED-1: Agent derives its bearer from the leaf cert after enrollment
	// via PoP pull. No Day-1 seed needed — the bearer is refreshed every
	// FABRIC_AGENT_TOKEN_REFRESH (1h) via cptoken.StartRefreshLoop. This
	// Store always routes through identity.Store so both the local cache
	// and any backing Secret stay in sync on every successful write.
	apiTok := &cptoken.Store{Path: paths.APITokenFile, IdentityStore: store}

	// Declared here (before any rotation code below) so both the manual
	// FABRIC_AGENT_ROTATE=1 path and certlife.StartLoop's automatic path can
	// reference forceReconnect -- the manual path never actually needs to
	// call it (rotation there runs before the tunnel has dialed for the
	// first time, so the first dial already picks up the new leaf), but
	// declaring the mutex/getSess/setSess/forceReconnect trio in one place
	// keeps the tunnel-session lifecycle self-contained instead of split
	// across two disconnected blocks.
	var sessMu sync.RWMutex
	var live *tunnel.Session
	getSess := func() *tunnel.Session {
		sessMu.RLock()
		defer sessMu.RUnlock()
		return live
	}
	setSess := func(s *tunnel.Session) {
		sessMu.Lock()
		live = s
		sessMu.Unlock()
	}
	// forceReconnect closes whatever tunnel session is currently live,
	// which triggers sess.Yamux.CloseChan() in the dial loop below and
	// makes it redial promptly (same short reconnect-delay+jitter as any
	// other disconnect, not a long idle wait -- tunnel.Dial always
	// reloads the cert file fresh, so the new dial picks up whatever
	// certlife.RotateLeaf just persisted). Without this, a rotated leaf
	// sits on disk unused by the live tunnel until it happens to
	// disconnect on its own; wiring this into certlife.Config.Reconnect
	// turns the overlap window CP grants the prior fingerprint into a
	// safety margin instead of the only thing keeping StreamOpen authz
	// working between rotation and the next natural reconnect.
	forceReconnect := func() {
		if s := getSess(); s != nil {
			_ = s.Close()
		}
	}

	enrollMethod := bootstrap.Method{Token: os.Getenv("FABRIC_BOOTSTRAP_TOKEN")}
	agentID, err := ensureIdentity(ctx, log, cfg, cp, store, enrollMethod)
	if err != nil {
		logging.Error(ctx, log, "identity_unavailable", err)
		os.Exit(1)
	}

	// G-CRED-1: after leaf exists, pull scoped bearer (leaf PoP).
	// Best-effort at startup; if it fails, the refresh loop will retry.
	// Rotate no longer depends on this succeeding first (PoP-on-rotate).
	if agentID != "" && cp != "" {
		if perr := apiTok.PullCurrent(ctx, cp, agentID, paths.CertFile, paths.KeyFile); perr != nil {
			logging.Info(ctx, log, "agent_api_token_pull_deferred",
				"error", perr.Error(),
				"note", "continuing; refresh loop will retry")
		} else {
			logging.Info(ctx, log, "agent_api_token_pulled", "path", apiTok.Path)
		}
		apiTok.StartRefreshLoop(ctx, cp, agentID, paths.CertFile, paths.KeyFile, func(msg string, kv ...any) {
			logging.Info(ctx, log, msg, kv...)
		})
	}

	// Manual mid-life rotate: FABRIC_AGENT_ROTATE=1 (emergency/compromise
	// only -- routine rotation is certlife.StartLoop below, always on).
	// Since rotate is now authenticated via leaf PoP (not just the bearer),
	// this works even if PullCurrent above soft-failed and no bearer is on
	// disk — the PoP over the current leaf's private key is the
	// authorization mechanism for agent-role callers. The bearer, when
	// present, is still sent as a secondary/audit header (defense in depth).
	if os.Getenv("FABRIC_AGENT_ROTATE") == "1" && agentID != "" && cp != "" {
		if rerr := certlife.RotateLeaf(ctx, cp, agentID, store, apiTok); rerr != nil {
			logging.Error(ctx, log, "cert_rotate_failed", rerr,
				"note", "if pop_signature_invalid: leaf private key on disk may not match CP-bound fingerprint; re-enroll this Agent")
			os.Exit(1)
		}
		logging.Info(ctx, log, "cert_rotated", "agent_id", agentID, "note", "new leaf persisted; tunnel will use on next dial")
	}

	// Automatic leaf rotation (industry pattern: Teleport tbot / SPIRE /
	// Vault Agent). Always on -- short-lived certs (7d default) make
	// identity loss cheap everywhere, so there's no substrate-specific
	// reason to gate this behind an opt-in flag.
	if certlife.Enabled() && agentID != "" && cp != "" {
		go certlife.StartLoop(ctx, log, certlife.Config{
			ControlPlaneURL: cp,
			AgentID:         agentID,
			Store:           store,
			APIToken:        apiTok,
			CheckInterval:   certlife.ParseCheckInterval(),
			RenewAt:         0.5,
			Reconnect:       forceReconnect,
		})
	}

	certFP, err := fingerprintFile(paths.CertFile)
	if err != nil {
		logging.Error(ctx, log, "cert_fingerprint_failed", err, "path", paths.CertFile)
		os.Exit(1)
	}
	if !fileExists(caFile) {
		logging.Error(ctx, log, "ca_missing", fmt.Errorf("CA trust file required"), "path", caFile)
		os.Exit(1)
	}

	smokeReg := os.Getenv("FABRIC_SMOKE_REGISTRATION_ID")
	if cp != "" {
		wm := &watch.Manager{
			Log:              log,
			ControlPlaneURL:  cp,
			TenantID:         cfg.TenantID,
			AgentID:          agentID,
			ListenBasePort:   getenvInt("FABRIC_LISTEN_BASE_PORT", 9443),
			ListenHost:       getenv("FABRIC_LISTEN_HOST", "0.0.0.0"),
			DisableListeners: smokeReg != "",
			DisableProbes:    smokeReg != "",
			EvidencePath:     cfg.EvidencePath,
			Session:          getSess,
			ServiceCfg:       loadServiceConfig(),
			SetAuth:          apiTok.SetAuthHeader,
		}
		if smokeReg != "" {
			logging.Info(ctx, log, "smoke_registration_override",
				"registration_id", smokeReg,
				"note", "FABRIC_SMOKE_* owns StreamOpen listener + observed; production omits FABRIC_SMOKE_*",
			)
		}
		go wm.Run(ctx)
	}
	if smokeReg != "" {
		addr := getenv("FABRIC_SMOKE_LISTEN", "127.0.0.1:9443")
		go func() {
			for {
				if ctx.Err() != nil {
					return
				}
				sess := getSess()
				if sess == nil {
					time.Sleep(500 * time.Millisecond)
					continue
				}
				err := listener.Serve(ctx, log, sess, listener.Config{
					ListenAddr:     addr,
					TenantID:       cfg.TenantID,
					RegistrationID: smokeReg,
					// Real (non-smoke) listeners derive this per-registration from
					// watch.go's reg.ConnectivityType; the smoke listener defaults to
					// SERVICE but a script may override it (e.g. to exercise a
					// PLATFORM_RESOURCE/CUSTOMER_RESOURCE registration, Spec §8 B3/B1)
					// via FABRIC_SMOKE_CONNECTIVITY_TYPE.
					ConnectivityType: stream.ConnectivityType(getenv("FABRIC_SMOKE_CONNECTIVITY_TYPE", string(stream.TypeService))),
					EvidencePath:     cfg.EvidencePath,
				})
				if ctx.Err() != nil {
					return
				}
				if err != nil {
					logging.Error(ctx, log, "smoke_listener_failed", err)
					time.Sleep(time.Second)
				}
			}
		}()
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		cancel()
	}()

	backoff := time.Second
	for {
		if ctx.Err() != nil {
			logging.Info(ctx, log, "agent_shutdown")
			return
		}
		sess, err := tunnel.Dial(ctx, log, cfg.GatewayAddress, cfg.TLSServerName, paths.CertFile, paths.KeyFile, caFile, cfg.YamuxKeepAlive, cfg.ConnectionWriteTO)
		if err != nil {
			delay := reconnectDelay(backoff)
			logging.Error(ctx, log, "tunnel_dial_failed", err, "retry_in", delay.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			backoff = nextBackoff(backoff)
			continue
		}
		backoff = time.Second
		setSess(sess)
		// tunnel.Dial always reloads the cert file fresh, so a mid-life
		// rotation IS picked up functionally on the next reconnect -- but
		// certFP (logging only) was computed once at startup and never
		// refreshed, so every agent_running line after a rotation kept
		// reporting the original fingerprint. Recompute after every
		// successful dial so it always reflects whichever cert just
		// authenticated the tunnel (the Gateway logs its fingerprint
		// live off the wire on every connection).
		if fp, ferr := fingerprintFile(paths.CertFile); ferr == nil {
			certFP = fp
		} else {
			logging.Info(ctx, log, "cert_fingerprint_recompute_failed", "error", ferr.Error())
		}
		logging.Info(ctx, log, "agent_running", "cert_fp", certFP)

		sessCtx, sessCancel := context.WithCancel(ctx)
		go func() {
			if err := inbound.Serve(sessCtx, log, sess); err != nil && sessCtx.Err() == nil {
				logging.Error(sessCtx, log, "inbound_accept_failed", err)
			}
			sessCancel()
		}()

		// Block until yamux dies or process cancel.
		select {
		case <-ctx.Done():
			sessCancel()
			_ = sess.Close()
			setSess(nil)
			logging.Info(ctx, log, "agent_shutdown")
			return
		case <-sess.Yamux.CloseChan():
			sessCancel()
			_ = sess.Close()
			setSess(nil)
			delay := reconnectDelay(backoff)
			logging.Info(ctx, log, "tunnel_disconnected", "note", "reconnecting with backoff+jitter", "retry_in", delay.String())
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			backoff = nextBackoff(backoff)
		}
	}
}

// newIdentityStore is the one place that knows about every concrete
// identity.Store implementation. Adding a new substrate-specific Store
// (cloud KMS, Vault, etc.) means adding one case here -- nothing else in
// main.go, certlife, or cptoken needs to change, because they only ever
// see the identity.Store interface.
func newIdentityStore(cfg config.Config) (identity.Store, error) {
	switch cfg.IdentityStore {
	case "kubernetes":
		client, err := k8ssvc.NewInClusterClient()
		if err != nil {
			return nil, fmt.Errorf("identity store 'kubernetes' requires running in-cluster: %w", err)
		}
		ns := cfg.IdentityNamespace
		if ns == "" {
			ns = k8ssvc.Namespace()
		}
		if ns == "" {
			return nil, fmt.Errorf("identity store 'kubernetes': could not determine namespace (set FABRIC_IDENTITY_NAMESPACE)")
		}
		secretName := k8ssecret.NameForNode(cfg.IdentitySecretPrefix, cfg.NodeName)
		return k8ssecret.New(client, ns, secretName, cfg.CertDir, cfg.AgentIDPath, ""), nil
	case "file", "":
		return file.New(cfg.CertDir, cfg.AgentIDPath, ""), nil
	default:
		return nil, fmt.Errorf("unknown FABRIC_IDENTITY_STORE %q", cfg.IdentityStore)
	}
}

// ensureIdentity is the substrate-neutral replacement for the old
// hasLeaf/agentID file-existence branching: try Store.Load(); if that
// comes back empty, enroll via the configured enroll.Method and persist
// the result through the same Store. Every substrate and every future
// enroll.Method funnels through this one function.
//
// One legacy wrinkle preserved on purpose: if a leaf cert+key already
// exists locally (pre-minted -- local smoke/dev only, never a real
// substrate) but the Store has no agent-id yet, this binds by certificate
// fingerprint instead of generating a fresh CSR, so it never overwrites a
// hand-placed cert. See bindPreMintedFingerprint.
func ensureIdentity(ctx context.Context, log *slog.Logger, cfg config.Config, controlPlaneURL string, store identity.Store, method enroll.Method) (agentID string, err error) {
	id, loadErr := store.Load(ctx)
	if loadErr == nil {
		logging.Info(ctx, log, "enroll_skipped_have_identity",
			"agent_id", id.AgentID,
			"note", "identity store already has a leaf; not re-enrolling")
		return id.AgentID, nil
	}
	if loadErr != identity.ErrNoIdentity {
		return "", fmt.Errorf("load identity: %w", loadErr)
	}

	paths := store.Paths()
	if fileExists(paths.CertFile) && fileExists(paths.KeyFile) {
		return bindPreMintedFingerprint(ctx, log, cfg, controlPlaneURL, store, method, paths)
	}

	// No cert anywhere: must enroll via CSR. A usable enroll method is
	// required -- fail closed, matching the old "!hasLeaf" branch's
	// os.Exit(1) on a missing bootstrap token.
	creds, credErr := method.Credentials(ctx)
	if credErr != nil {
		return "", fmt.Errorf("no identity and no usable enroll method: %w", credErr)
	}
	if controlPlaneURL == "" {
		return "", fmt.Errorf("FABRIC_CONTROL_PLANE_URL is required to enroll")
	}

	key, csrPEM, kerr := bootstrap.GenerateKeyAndCSR()
	if kerr != nil {
		return "", fmt.Errorf("generate CSR: %w", kerr)
	}
	logging.Info(ctx, log, "enroll_starting", "layer", "agent.bootstrap", "mode", "csr", "enroll_method", creds.Method, "substrate", cfg.Substrate)
	res, eerr := bootstrap.Enroll(ctx, controlPlaneURL, cfg.TenantID, creds, "", csrPEM, cfg.Substrate, cfg.SubstrateFingerprint, "")
	if eerr != nil {
		return "", fmt.Errorf("enroll: %w", eerr)
	}
	if res.CertificatePEM == "" {
		return "", fmt.Errorf("enroll: control plane returned no certificate_pem")
	}
	keyPEM := bootstrap.MarshalPrivateKeyPEM(key)
	if serr := store.SaveCert(ctx, res.AgentID, []byte(res.CertificatePEM), keyPEM); serr != nil {
		return "", fmt.Errorf("persist enrolled leaf: %w", serr)
	}
	logging.Info(ctx, log, "enroll_submitted",
		"agent_id", res.AgentID,
		"state", res.State,
		"note", "PendingApproval blocks StreamOpen until tenant admin approves (unless auto_approve_agents)",
	)
	return res.AgentID, nil
}

// bindPreMintedFingerprint handles the local-smoke-only case: a leaf
// cert+key was placed on disk by hand (or copied in by a test harness)
// before first boot, and no agent-id exists yet. It binds that exact
// cert's fingerprint to a new agent row rather than generating a new
// keypair -- generating a new CSR here would silently replace the
// pre-minted cert a smoke script is asserting against by its known
// fingerprint.
//
// Failure tolerance is deliberately loose here, matching this repo's
// pre-refactor behavior: a missing enroll method, missing control-plane
// URL, or a failed enroll call all log and return ("", nil) rather than
// a hard error, so the Agent still proceeds to dial the tunnel with
// whatever pre-minted cert is already on disk (useful for local dial-only
// smoke that never needs a control-plane-known agent_id). Only a failure
// to even read/fingerprint the pre-minted files themselves is fatal.
func bindPreMintedFingerprint(ctx context.Context, log *slog.Logger, cfg config.Config, controlPlaneURL string, store identity.Store, method enroll.Method, paths identity.FilePaths) (string, error) {
	certPEM, cerr := os.ReadFile(paths.CertFile)
	if cerr != nil {
		return "", fmt.Errorf("read pre-minted cert: %w", cerr)
	}
	keyPEM, kerr := os.ReadFile(paths.KeyFile)
	if kerr != nil {
		return "", fmt.Errorf("read pre-minted key: %w", kerr)
	}
	certFP, ferr := fingerprintFile(paths.CertFile)
	if ferr != nil {
		return "", fmt.Errorf("fingerprint pre-minted cert: %w", ferr)
	}

	creds, credErr := method.Credentials(ctx)
	if credErr != nil {
		logging.Info(ctx, log, "enroll_skipped_no_enroll_method",
			"note", "pre-minted cert present; continuing to tunnel dial without a control-plane agent_id")
		return "", nil
	}
	if controlPlaneURL == "" {
		logging.Info(ctx, log, "enroll_skipped_no_control_plane",
			"note", "pre-minted cert present; continuing to tunnel dial without a control-plane agent_id")
		return "", nil
	}

	logging.Info(ctx, log, "enroll_starting", "layer", "agent.bootstrap", "mode", "fingerprint", "cert_fp", certFP, "substrate", cfg.Substrate)
	res, eerr := bootstrap.Enroll(ctx, controlPlaneURL, cfg.TenantID, creds, certFP, "", cfg.Substrate, cfg.SubstrateFingerprint, "")
	if eerr != nil {
		logging.Info(ctx, log, "enroll_skipped_or_failed",
			"error", eerr.Error(),
			"note", "continuing to tunnel dial; if this is first boot, check bootstrap token")
		return "", nil
	}
	// Re-save the identical, already-on-disk cert+key -- this call exists
	// to persist the agent_id (and, for identity/k8ssecret, to push this
	// pre-minted material into the backing Secret too), not to replace
	// the cert itself.
	if serr := store.SaveCert(ctx, res.AgentID, certPEM, keyPEM); serr != nil {
		return "", fmt.Errorf("persist agent_id after fingerprint bind: %w", serr)
	}
	logging.Info(ctx, log, "enroll_submitted",
		"agent_id", res.AgentID,
		"state", res.State,
		"note", "PendingApproval blocks StreamOpen until tenant admin approves (unless auto_approve_agents)",
	)
	return res.AgentID, nil
}

// reconnectDelay applies equal jitter over [backoff/2, backoff] (L2-Design §H.3).
func reconnectDelay(backoff time.Duration) time.Duration {
	if backoff <= 0 {
		return time.Second
	}
	half := backoff / 2
	if half <= 0 {
		return backoff
	}
	return half + time.Duration(mrand.Int63n(int64(half)+1))
}

func nextBackoff(backoff time.Duration) time.Duration {
	if backoff < 30*time.Second {
		return backoff * 2
	}
	return backoff
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

func fingerprintFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(b)
	der := b
	if block != nil {
		der = block.Bytes
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:]), nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
		return def
	}
	return n
}

// loadServiceConfig reads the (opt-in, default off) in-cluster Service
// management flags -- see watch.ServiceConfig's doc comment and the "no
// Kubernetes Service routing exists for more than one registration per
// tenant" bug write-up for why this exists. Off by default: it requires
// RBAC (create/patch on Service in this namespace, see
// deploy/connect-agent/daemonset.yaml's Role/RoleBinding) that a customer
// must explicitly grant, same posture as the NetworkPolicy ACL templates.
func loadServiceConfig() watch.ServiceConfig {
	enabled := getenv("FABRIC_K8S_SERVICE_MANAGE_ENABLED", "") == "1"
	ns := getenv("FABRIC_K8S_SERVICE_NAMESPACE", k8ssvc.Namespace())
	return watch.ServiceConfig{
		Enabled:   enabled,
		Name:      getenv("FABRIC_K8S_SERVICE_NAME", "connect-agent"),
		Namespace: ns,
		Selector:  parseSelector(getenv("FABRIC_K8S_SERVICE_SELECTOR", "app=connect-agent")),
	}
}

// parseSelector turns "k1=v1,k2=v2" into a label map. Malformed entries
// (no "=", empty key) are skipped rather than erroring the whole process
// over a packaging typo -- reconcileService will simply produce a Service
// with fewer/no selector keys, which the next EnsureService call's
// annotations/logs make visible, same "log and keep going" posture as
// every other best-effort loop here.
func parseSelector(s string) map[string]string {
	out := map[string]string{}
	for _, pair := range strings.Split(s, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if !ok || k == "" {
			continue
		}
		out[k] = v
	}
	return out
}
