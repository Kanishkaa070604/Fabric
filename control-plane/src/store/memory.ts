import { parseDurationMs } from "../duration";
import {
  AGENT_TRANSITIONS,
  REG_TRANSITIONS,
  assertTransition,
  cryptoRandom,
  hashAgentApiToken,
  hashBootstrapToken,
  newId,
  type Agent,
  type AgentState,
  type AuthzContext,
  type FabricStore,
  type Registration,
  type RegistrationState,
  type RevokeCause,
  type SuspendCause,
  type TenantConnect,
  type WorkloadEvidenceStrategy,
  addRevokedFingerprint,
  isAgentStale,
  DEFAULT_CERT_OVERLAP_SECONDS,
  DEFAULT_TOKEN_OVERLAP_SECONDS,
  evidenceTrustFromTenant,
  filterEligibleAgents,
  slugifyDisplayName,
} from "./types";

// L2 §G.1: bounded window (from the registration's current generation taking
// effect) during which a CUSTOMER_* agent with no matching-generation probe
// yet is still treated as eligible ("unknown"), not excluded. Covers the
// unavoidable gap between a registration going Active (or an Update bumping
// its generation) and the Agent's next watch-loop probe tick.
const PROBE_GRACE_MS = parseDurationMs(process.env.FABRIC_PROBE_GRACE, 15_000);

export type {
  Agent,
  AgentState,
  AuthzContext,
  FabricStore,
  Registration,
  RegistrationState,
  RevokeCause,
  SuspendCause,
  TenantConnect,
} from "./types";

/**
 * Bootstrap token default TTL, configurable via FABRIC_BOOTSTRAP_TTL env.
 * Default: 7 days (10080 minutes) — gives the customer a comfortable
 * window to complete their Day-1 install without rushing or calling back
 * for a re-issue. Old default was 45 minutes, which was too tight for
 * real multi-node rollouts.
 */
function bootstrapTtlMinutes(): number {
  const raw = (process.env.FABRIC_BOOTSTRAP_TTL || "").trim();
  if (!raw) return 7 * 24 * 60; // 7 days
  const ms = parseDurationMs(raw, 7 * 24 * 60 * 60_000);
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * In-memory store for local tests and FABRIC_STORE=memory.
 * Same state rules as SequelizeStore.
 */
export class MemoryStore implements FabricStore {
  tenants = new Map<string, TenantConnect>();
  agents = new Map<string, Agent>();
  registrations = new Map<string, Registration>();
  /** raw token -> tenant; multi-redeem until expiry (hash also on tenant row) */
  bootstrapTokens = new Map<string, { tenant_id: string; expires_at: Date }>();
  /** raw Agent API token -> tenant (L3-CTL-01a); hash also on tenant row */
  agentApiTokens = new Map<string, { tenant_id: string; expires_at: Date | null }>();

  async ensureTenant(tenantId: string, actor: string): Promise<TenantConnect> {
    let t = this.tenants.get(tenantId);
    if (!t) {
      const now = new Date();
      t = {
        tenant_id: tenantId,
        auto_approve_agents: true,
        max_tunnels: 50,
        max_concurrent_streams: 2000,
        max_stream_open_per_sec: 100,
        suspended: false,
        suspended_cause: null,
        revoked_cert_fingerprints: [],
        revoked_cert_causes: {},
        strict_substrate_binding: false,
        expected_substrate_fingerprint: null,
        workload_evidence_strategy: "none",
        workload_evidence_config: {},
        oidc_enabled: false,
        oidc_issuer_url: null,
        oidc_jwks_uri: null,
        oidc_audience: "abluva-connect",
        oidc_allowed_algs: ["RS256"],
        oidc_ca_bundle_pem: null,
        oidc_last_discovery_ok_at: null,
        oidc_last_discovery_error: null,
        bootstrap_token_hash: null,
        bootstrap_expires_at: null,
        agent_api_token_hash: null,
        agent_api_token_expires_at: null,
        prior_agent_api_token_hash: null,
        prior_agent_api_token_valid_until: null,
        created_at: now,
        created_by: actor,
        updated_at: now,
        updated_by: actor,
      };
      this.tenants.set(tenantId, t);
    }
    return t;
  }

  async getTenant(tenantId: string): Promise<TenantConnect | undefined> {
    return this.tenants.get(tenantId);
  }

  async listAllTenantIds(): Promise<string[]> {
    return [...this.tenants.keys()];
  }

  async issueBootstrapToken(
    tenantId: string,
    actor: string,
    ttlMinutes = bootstrapTtlMinutes()
  ): Promise<string> {
    await this.ensureTenant(tenantId, actor);
    // Replace any outstanding token for this tenant.
    for (const [raw, row] of this.bootstrapTokens) {
      if (row.tenant_id === tenantId) this.bootstrapTokens.delete(raw);
    }
    const raw = cryptoRandom(24);
    const expires = new Date(Date.now() + ttlMinutes * 60_000);
    this.bootstrapTokens.set(raw, { tenant_id: tenantId, expires_at: expires });
    const t = this.tenants.get(tenantId)!;
    t.bootstrap_token_hash = hashBootstrapToken(raw);
    t.bootstrap_expires_at = expires;
    t.updated_at = new Date();
    t.updated_by = actor;
    return raw;
  }

  async revokeBootstrapToken(
    tenantId: string,
    actor: string
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    for (const [raw, row] of this.bootstrapTokens) {
      if (row.tenant_id === tenantId) this.bootstrapTokens.delete(raw);
    }
    t.bootstrap_token_hash = null;
    t.bootstrap_expires_at = null;
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async issueAgentApiToken(
    tenantId: string,
    actor: string,
    ttlMinutes = 365 * 24 * 60,
    opts?: { overlap_seconds?: number }
  ): Promise<string> {
    await this.ensureTenant(tenantId, actor);
    const overlap = Math.max(0, opts?.overlap_seconds ?? 0);
    const t = this.tenants.get(tenantId)!;
    const prevHash = t.agent_api_token_hash;
    // Drop raw map entries that are neither current nor becoming prior.
    if (overlap <= 0) {
      for (const [raw, row] of this.agentApiTokens) {
        if (row.tenant_id === tenantId) this.agentApiTokens.delete(raw);
      }
      t.prior_agent_api_token_hash = null;
      t.prior_agent_api_token_valid_until = null;
    } else if (prevHash) {
      t.prior_agent_api_token_hash = prevHash;
      t.prior_agent_api_token_valid_until = new Date(Date.now() + overlap * 1000);
    }
    const raw = cryptoRandom(32);
    const expires =
      ttlMinutes <= 0 ? null : new Date(Date.now() + ttlMinutes * 60_000);
    this.agentApiTokens.set(raw, { tenant_id: tenantId, expires_at: expires });
    t.agent_api_token_hash = hashAgentApiToken(raw);
    t.agent_api_token_expires_at = expires;
    t.updated_at = new Date();
    t.updated_by = actor;
    return raw;
  }

  async revokeAgentApiToken(
    tenantId: string,
    actor: string
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    for (const [raw, row] of this.agentApiTokens) {
      if (row.tenant_id === tenantId) this.agentApiTokens.delete(raw);
    }
    t.agent_api_token_hash = null;
    t.agent_api_token_expires_at = null;
    t.prior_agent_api_token_hash = null;
    t.prior_agent_api_token_valid_until = null;
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async resolveAgentApiToken(raw: string): Promise<string | undefined> {
    if (!raw) return undefined;
    const row = this.agentApiTokens.get(raw);
    if (row) {
      if (row.expires_at && row.expires_at.getTime() < Date.now()) {
        this.agentApiTokens.delete(raw);
        return undefined;
      }
      return row.tenant_id;
    }
    const hash = hashAgentApiToken(raw);
    const now = Date.now();
    for (const t of this.tenants.values()) {
      if (
        t.agent_api_token_hash &&
        t.agent_api_token_hash.equals(hash) &&
        (!t.agent_api_token_expires_at ||
          t.agent_api_token_expires_at.getTime() >= now)
      ) {
        return t.tenant_id;
      }
      if (
        t.prior_agent_api_token_hash &&
        t.prior_agent_api_token_hash.equals(hash) &&
        t.prior_agent_api_token_valid_until &&
        t.prior_agent_api_token_valid_until.getTime() >= now
      ) {
        return t.tenant_id;
      }
    }
    return undefined;
  }

  /**
   * L3-AGT-02 Phase A: validate bootstrap token without consuming it.
   * Multi-redeem until bootstrap_expires_at; early kill = revokeBootstrapToken.
   */
  private consumeBootstrapToken(raw: string): string {
    const row = this.bootstrapTokens.get(raw);
    if (!row) throw new Error("bootstrap_token_invalid");
    if (row.expires_at.getTime() < Date.now()) {
      this.bootstrapTokens.delete(raw);
      const t = this.tenants.get(row.tenant_id);
      if (t) {
        t.bootstrap_token_hash = null;
        t.bootstrap_expires_at = null;
      }
      throw new Error("bootstrap_token_expired");
    }
    return row.tenant_id;
  }

  async enrollAgent(input: {
    tenant_id: string;
    bootstrap_token: string;
    substrate: string;
    substrate_fingerprint?: string;
    cert_fingerprint_sha256?: string;
    cert_not_after?: Date | null;
    actor: string;
  }): Promise<Agent> {
    const tenantId = this.consumeBootstrapToken(input.bootstrap_token);
    if (tenantId !== input.tenant_id) {
      throw new Error("bootstrap_token_tenant_mismatch");
    }
    const t = await this.ensureTenant(tenantId, input.actor);
    if (t.suspended) throw new Error("tenant_suspended");
    // Spec §10.1 Phase 1 optional strict substrate binding: reject enrollment
    // from a substrate the tenant did not declare at onboarding.
    if (t.strict_substrate_binding) {
      if (
        !input.substrate_fingerprint ||
        input.substrate_fingerprint !== t.expected_substrate_fingerprint
      ) {
        throw new Error("substrate_binding_mismatch");
      }
    }
    if (input.cert_fingerprint_sha256) {
      for (const existing of this.agents.values()) {
        if (
          existing.tenant_id === tenantId &&
          existing.cert_fingerprint_sha256 === input.cert_fingerprint_sha256 &&
          !existing.deleted_at &&
          existing.state !== "Retired"
        ) {
          throw new Error("agent_cert_fingerprint_conflict");
        }
      }
    }

    const now = new Date();
    const id = newId();
    let state: AgentState = "PendingApproval";
    let approvedAt: Date | null = null;
    let approvedBy: string | null = null;
    if (t.auto_approve_agents) {
      state = "Connecting";
      approvedAt = now;
      approvedBy = "auto_approve_agents";
    }
    const agent: Agent = {
      id,
      tenant_id: tenantId,
      state,
      substrate: input.substrate,
      substrate_fingerprint: input.substrate_fingerprint ?? null,
      cert_fingerprint_sha256: input.cert_fingerprint_sha256 ?? null,
      cert_not_after: input.cert_not_after ?? null,
      prior_cert_fingerprint_sha256: null,
      prior_cert_valid_until: null,
      enrollment_approved_at: approvedAt,
      enrollment_approved_by: approvedBy,
      last_heartbeat_at: now,
      tunnel_state: null,
      deleted_at: null,
      created_at: now,
      created_by: input.actor,
      updated_at: now,
      updated_by: input.actor,
    };
    this.agents.set(id, agent);
    return agent;
  }

  async rotateAgentCert(input: {
    agent_id: string;
    cert_fingerprint_sha256: string;
    cert_not_after?: Date | null;
    actor: string;
    overlap_seconds?: number;
  }): Promise<{ agent: Agent; previous_fingerprint: string | null }> {
    const a = this.agents.get(input.agent_id);
    if (!a || a.deleted_at || a.state === "Retired") {
      throw new Error("agent_not_found");
    }
    const prev = a.cert_fingerprint_sha256;
    if (prev === input.cert_fingerprint_sha256) {
      throw new Error("cert_fingerprint_unchanged");
    }
    for (const existing of this.agents.values()) {
      if (
        existing.id !== a.id &&
        existing.tenant_id === a.tenant_id &&
        existing.cert_fingerprint_sha256 === input.cert_fingerprint_sha256 &&
        !existing.deleted_at &&
        existing.state !== "Retired"
      ) {
        throw new Error("agent_cert_fingerprint_conflict");
      }
    }
    const overlap = input.overlap_seconds ?? DEFAULT_CERT_OVERLAP_SECONDS;
    a.prior_cert_fingerprint_sha256 = prev;
    a.prior_cert_valid_until =
      prev && overlap > 0
        ? new Date(Date.now() + overlap * 1000)
        : null;
    a.cert_fingerprint_sha256 = input.cert_fingerprint_sha256;
    a.cert_not_after = input.cert_not_after ?? null;
    a.updated_at = new Date();
    a.updated_by = input.actor;
    if (prev && overlap <= 0) {
      await this.revokeCertFingerprint(
        a.tenant_id,
        prev,
        input.actor,
        "decommission"
      );
      a.prior_cert_fingerprint_sha256 = null;
      a.prior_cert_valid_until = null;
    }
    return { agent: a, previous_fingerprint: prev };
  }

  async getAgent(agentId: string): Promise<Agent | undefined> {
    return this.agents.get(agentId);
  }

  async transitionAgent(
    agentId: string,
    to: AgentState,
    actor: string
  ): Promise<Agent> {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("agent_not_found");
    assertTransition("agent", a.state, to, AGENT_TRANSITIONS);
    a.state = to;
    a.updated_at = new Date();
    a.updated_by = actor;
    if (to === "PendingApproval") {
      a.enrollment_approved_at = null;
      a.enrollment_approved_by = null;
    }
    return a;
  }

  async approveAgent(agentId: string, actor: string): Promise<Agent> {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("agent_not_found");
    if (a.deleted_at) throw new Error("agent_deleted");
    if (a.state !== "PendingApproval") {
      throw new Error(`agent_approve_invalid_state: ${a.state}`);
    }
    a.enrollment_approved_at = new Date();
    a.enrollment_approved_by = actor;
    await this.transitionAgent(agentId, "Connecting", actor);
    if (a.tunnel_state === "up" || a.tunnel_state === "up_pending_approval") {
      a.tunnel_state = "up";
      return this.transitionAgent(agentId, "Connected", actor);
    }
    return this.agents.get(agentId)!;
  }

  async findAgentByCertFingerprint(
    certFingerprint: string
  ): Promise<Agent | undefined> {
    return this.matchAgentByFp(certFingerprint, { excludeRetired: true });
  }

  async findAgentByCertFingerprintAny(
    certFingerprint: string
  ): Promise<Agent | undefined> {
    for (const a of this.agents.values()) {
      if (a.cert_fingerprint_sha256 === certFingerprint) return a;
      if (a.prior_cert_fingerprint_sha256 === certFingerprint) return a;
    }
    return undefined;
  }

  /**
   * Single-source in-memory fingerprint match with prior-FP overlap.
   * Used by findAgentByCertFingerprint, authzContext's cert_fingerprint
   * branch, and reportTunnel's cert_fingerprint fallback -- these MUST
   * all share one code path so rotation overlap semantics can't diverge
   * between them (the prior-FP P0 bug was exactly this kind of drift).
   *
   * Options:
   * - excludeRetired (default true): normal authorization path; a
   *   Retired agent's cert must not rebind at accept time.
   * - tenantScope: when set, only matches agents in this tenant (used
   *   by reportTunnel and authzContext where tenant is known).
   */
  private matchAgentByFp(
    certFingerprint: string,
    opts?: { excludeRetired?: boolean; tenantScope?: string }
  ): Agent | undefined {
    const excludeRetired = opts?.excludeRetired !== false;
    const now = Date.now();
    for (const a of this.agents.values()) {
      if (excludeRetired && (a.deleted_at || a.state === "Retired")) continue;
      if (opts?.tenantScope && a.tenant_id !== opts.tenantScope) continue;
      if (a.cert_fingerprint_sha256 === certFingerprint) return a;
      if (
        a.prior_cert_fingerprint_sha256 === certFingerprint &&
        a.prior_cert_valid_until &&
        a.prior_cert_valid_until.getTime() >= now
      ) {
        return a;
      }
    }
    return undefined;
  }

  async retireAgent(agentId: string, actor: string): Promise<Agent> {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("agent_not_found");
    if (a.state === "Retired") return a;
    await this.transitionAgent(agentId, "Retired", actor);
    a.deleted_at = new Date();
    a.tunnel_state = "down";
    return a;
  }

  async listAgents(
    tenantId: string,
    opts?: { state?: AgentState }
  ): Promise<Agent[]> {
    const out: Agent[] = [];
    for (const a of this.agents.values()) {
      if (a.tenant_id !== tenantId || a.deleted_at) continue;
      if (opts?.state && a.state !== opts.state) continue;
      out.push(a);
    }
    out.sort((x, y) => x.created_at.getTime() - y.created_at.getTime());
    return out;
  }

  async setAutoApprove(
    tenantId: string,
    enabled: boolean,
    actor: string
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    t.auto_approve_agents = enabled;
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async setSuspended(
    tenantId: string,
    suspended: boolean,
    actor: string,
    cause?: SuspendCause
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    t.suspended = suspended;
    // Fail safe: any suspend with no explicit cause is treated as security
    // (force-close), never silently downgraded to a billing-style drain.
    t.suspended_cause = suspended ? cause ?? "security" : null;
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async setSubstrateBinding(
    tenantId: string,
    binding: { enabled: boolean; expected_substrate_fingerprint?: string | null },
    actor: string
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    t.strict_substrate_binding = binding.enabled;
    if (binding.expected_substrate_fingerprint !== undefined) {
      t.expected_substrate_fingerprint = binding.expected_substrate_fingerprint;
    }
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async setQuotas(
    tenantId: string,
    quotas: {
      max_tunnels?: number;
      max_concurrent_streams?: number;
      max_stream_open_per_sec?: number;
    },
    actor: string
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    if (quotas.max_tunnels !== undefined) {
      if (quotas.max_tunnels < 1) throw new Error("max_tunnels_invalid");
      t.max_tunnels = quotas.max_tunnels;
    }
    if (quotas.max_concurrent_streams !== undefined) {
      if (quotas.max_concurrent_streams < 1)
        throw new Error("max_concurrent_streams_invalid");
      t.max_concurrent_streams = quotas.max_concurrent_streams;
    }
    if (quotas.max_stream_open_per_sec !== undefined) {
      if (quotas.max_stream_open_per_sec < 1)
        throw new Error("max_stream_open_per_sec_invalid");
      t.max_stream_open_per_sec = quotas.max_stream_open_per_sec;
    }
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async setWorkloadEvidence(
    tenantId: string,
    input: {
      strategy?: WorkloadEvidenceStrategy;
      oidc_issuer_url?: string | null;
      oidc_jwks_uri?: string | null;
      oidc_audience?: string;
      oidc_allowed_algs?: string[];
      oidc_ca_bundle_pem?: string | null;
      oidc_enabled?: boolean;
      oidc_last_discovery_ok_at?: Date | null;
      oidc_last_discovery_error?: string | null;
      workload_evidence_config?: Record<string, unknown>;
    },
    actor: string
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    if (input.strategy !== undefined) {
      const allowed: WorkloadEvidenceStrategy[] = [
        "none",
        "kubernetes_oidc",
        // "ecs_task_identity" — not yet implemented in Gateway; accepting
        // it here would let a tenant arm a strategy that hard-rejects
        // every stream. Re-add when gateway/internal/evidence has a real
        // ECS verifier (L3-POC-ECS).
      ];
      if (!allowed.includes(input.strategy)) {
        throw new Error(`workload_evidence_strategy_invalid: ${input.strategy}`);
      }
      t.workload_evidence_strategy = input.strategy;
    }
    if (input.oidc_issuer_url !== undefined) {
      t.oidc_issuer_url = input.oidc_issuer_url;
    }
    if (input.oidc_jwks_uri !== undefined) {
      t.oidc_jwks_uri = input.oidc_jwks_uri;
    }
    if (input.oidc_audience !== undefined) {
      t.oidc_audience = input.oidc_audience || "abluva-connect";
    }
    if (input.oidc_allowed_algs !== undefined) {
      t.oidc_allowed_algs =
        input.oidc_allowed_algs.length > 0
          ? input.oidc_allowed_algs
          : ["RS256"];
    }
    if (input.oidc_ca_bundle_pem !== undefined) {
      t.oidc_ca_bundle_pem = input.oidc_ca_bundle_pem;
    }
    if (input.oidc_enabled !== undefined) {
      t.oidc_enabled = input.oidc_enabled;
    }
    if (input.oidc_last_discovery_ok_at !== undefined) {
      t.oidc_last_discovery_ok_at = input.oidc_last_discovery_ok_at;
    }
    if (input.oidc_last_discovery_error !== undefined) {
      t.oidc_last_discovery_error = input.oidc_last_discovery_error;
    }
    if (input.workload_evidence_config !== undefined) {
      t.workload_evidence_config = input.workload_evidence_config;
    }
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async degradeStaleAgents(staleAfterMs: number): Promise<number> {
    if (staleAfterMs <= 0) return 0;
    const cutoff = new Date(Date.now() - staleAfterMs);
    let n = 0;
    for (const a of this.agents.values()) {
      if (!isAgentStale(a, cutoff)) continue;
      await this.transitionAgent(a.id, "Degraded", "heartbeat-watchdog");
      n++;
    }
    return n;
  }

  async revokeCertFingerprint(
    tenantId: string,
    fingerprint: string,
    actor: string,
    cause: RevokeCause = "security"
  ): Promise<TenantConnect> {
    const t = await this.ensureTenant(tenantId, actor);
    const { fingerprints, causes } = addRevokedFingerprint(
      t.revoked_cert_fingerprints,
      t.revoked_cert_causes,
      fingerprint,
      cause
    );
    t.revoked_cert_fingerprints = fingerprints;
    t.revoked_cert_causes = causes;
    t.updated_at = new Date();
    t.updated_by = actor;
    return t;
  }

  async createRegistration(input: {
    tenant_id: string;
    display_name: string;
    connectivity_type: "SERVICE" | "RESOURCE";
    destination_kind: string;
    host?: string;
    port?: number;
    actor: string;
  }): Promise<Registration> {
    const t = await this.ensureTenant(input.tenant_id, input.actor);
    if (t.suspended) throw new Error("tenant_suspended");
    const allowedKinds = new Set([
      "PLATFORM_SERVICE",
      "PLATFORM_RESOURCE",
      "CUSTOMER_SERVICE",
      "CUSTOMER_RESOURCE",
    ]);
    if (!allowedKinds.has(input.destination_kind)) {
      throw new Error(`destination_kind_invalid: ${input.destination_kind}`);
    }
    if (
      (input.destination_kind === "PLATFORM_SERVICE" ||
        input.destination_kind === "PLATFORM_RESOURCE" ||
        input.destination_kind === "CUSTOMER_SERVICE" ||
        input.destination_kind === "CUSTOMER_RESOURCE") &&
      (!input.host || !input.port)
    ) {
      throw new Error("host_port_required_for_destination");
    }
    for (const r of this.registrations.values()) {
      if (
        r.tenant_id === input.tenant_id &&
        r.display_name === input.display_name &&
        !r.deleted_at
      ) {
        throw new Error("registration_display_name_conflict");
      }
    }
    const now = new Date();
    const id = newId();
    const reg: Registration = {
      id,
      tenant_id: input.tenant_id,
      generation: 1,
      connectivity_type: input.connectivity_type,
      destination_kind: input.destination_kind,
      display_name: input.display_name,
      host: input.host ?? null,
      port: input.port ?? null,
      state: "Requested",
      observed: {},
      created_at: now,
      created_by: input.actor,
      updated_at: now,
      updated_by: input.actor,
      deleted_at: null,
    };
    this.registrations.set(id, reg);
    await this.advanceRegistrationToActive(id, input.actor);
    return this.registrations.get(id)!;
  }

  /**
   * Shared success path for create (from Requested) and retry (from
   * Validating, after Failed→Validating). Kept tiny and identical in
   * SequelizeStore so the two stores cannot drift on provisioning steps.
   */
  private async advanceRegistrationToActive(
    registrationId: string,
    actor: string
  ): Promise<Registration> {
    const r = this.registrations.get(registrationId);
    if (!r) throw new Error("registration_not_found");
    if (r.state === "Requested") {
      await this.transitionRegistration(registrationId, "Validating", actor);
    }
    if (this.registrations.get(registrationId)!.state !== "Validating") {
      throw new Error(
        `registration_not_advanceable: state is ${this.registrations.get(registrationId)!.state}`
      );
    }
    await this.transitionRegistration(registrationId, "Provisioning", actor);
    await this.transitionRegistration(registrationId, "Active", actor);
    return this.registrations.get(registrationId)!;
  }

  async retryRegistration(
    registrationId: string,
    actor: string
  ): Promise<Registration> {
    const r = this.registrations.get(registrationId);
    if (!r || r.deleted_at) throw new Error("registration_not_found");
    if (r.state !== "Failed") {
      throw new Error(
        `registration_not_retryable: state is ${r.state}, must be Failed`
      );
    }
    const tenant = this.tenants.get(r.tenant_id);
    if (tenant?.suspended) throw new Error("tenant_suspended");
    if (!r.host || !r.port) {
      throw new Error("host_port_required_for_destination");
    }
    // §D.5: a retry is a new desired-state attempt of the same config.
    r.generation += 1;
    await this.transitionRegistration(registrationId, "Validating", actor);
    return this.advanceRegistrationToActive(registrationId, actor);
  }

  async getRegistration(
    registrationId: string
  ): Promise<Registration | undefined> {
    const r = this.registrations.get(registrationId);
    if (!r || r.deleted_at) return undefined;
    return r;
  }

  async listRegistrations(tenantId: string): Promise<Registration[]> {
    const out: Registration[] = [];
    for (const r of this.registrations.values()) {
      if (r.tenant_id !== tenantId || r.deleted_at) continue;
      out.push(r);
    }
    out.sort((x, y) => x.created_at.getTime() - y.created_at.getTime());
    return out;
  }

  async deleteRegistration(
    registrationId: string,
    actor: string
  ): Promise<Registration> {
    const r = this.registrations.get(registrationId);
    if (!r || r.deleted_at) throw new Error("registration_not_found");
    if (r.state === "Deleted") return r;
    if (r.state === "Updating") {
      await this.transitionRegistration(registrationId, "Active", actor);
    }
    if (r.state === "Failed") {
      await this.transitionRegistration(registrationId, "Deleted", actor);
      return this.registrations.get(registrationId)!;
    }
    if (r.state === "Active") {
      await this.transitionRegistration(registrationId, "Deleting", actor);
      await this.transitionRegistration(registrationId, "Deleted", actor);
      return this.registrations.get(registrationId)!;
    }
    if (r.state === "Deleting") {
      await this.transitionRegistration(registrationId, "Deleted", actor);
      return this.registrations.get(registrationId)!;
    }
    throw new Error(`registration_not_deletable: ${r.state}`);
  }

  async updateRegistration(
    registrationId: string,
    patch: { display_name?: string; host?: string; port?: number },
    actor: string
  ): Promise<Registration> {
    const r = this.registrations.get(registrationId);
    if (!r || r.deleted_at) throw new Error("registration_not_found");
    if (r.state !== "Active") {
      throw new Error(`registration_not_updatable: state is ${r.state}, must be Active`);
    }

    // L2 §G.5: snapshot the last-known-good fields before touching anything,
    // so any failure below can restore them exactly rather than leaving a
    // half-applied row.
    const priorGood = {
      display_name: r.display_name,
      host: r.host,
      port: r.port,
    };

    const nextHost = patch.host !== undefined ? patch.host : r.host;
    const nextPort = patch.port !== undefined ? patch.port : r.port;
    if (!nextHost || !nextPort) {
      // Nothing mutated yet -- reject before ever entering Updating, same
      // validation createRegistration applies (§G.2 "specific reason").
      throw new Error("host_port_required_for_destination");
    }
    if (patch.display_name !== undefined && patch.display_name !== r.display_name) {
      for (const other of this.registrations.values()) {
        if (
          other.id !== registrationId &&
          other.tenant_id === r.tenant_id &&
          other.display_name === patch.display_name &&
          !other.deleted_at
        ) {
          throw new Error("registration_display_name_conflict");
        }
      }
    }

    await this.transitionRegistration(registrationId, "Updating", actor);
    try {
      if (patch.display_name !== undefined) r.display_name = patch.display_name;
      r.host = nextHost;
      r.port = nextPort;
      r.updated_at = new Date();
      r.updated_by = actor;
      await this.transitionRegistration(registrationId, "Active", actor);
      return this.registrations.get(registrationId)!;
    } catch (e) {
      // §G.5: restore prior last-known-good config; never silently treat a
      // failed change as if it had succeeded, and never leave the row
      // pointed at a half-applied destination.
      r.display_name = priorGood.display_name;
      r.host = priorGood.host;
      r.port = priorGood.port;
      r.updated_at = new Date();
      r.updated_by = actor;
      await this.transitionRegistration(registrationId, "Active", actor);
      throw e;
    }
  }

  async reportObserved(
    registrationId: string,
    agentId: string,
    observed: {
      condition: string;
      reachable?: "true" | "false" | "unknown";
      observed_generation: number;
    },
    actor: string
  ): Promise<Registration> {
    const r = this.registrations.get(registrationId);
    if (!r || r.deleted_at) throw new Error("registration_not_found");
    const a = this.agents.get(agentId);
    if (!a || a.tenant_id !== r.tenant_id) throw new Error("agent_not_found");
    r.observed[`agent:${agentId}`] = {
      observed_generation: observed.observed_generation,
      condition: observed.condition,
      reachable: observed.reachable,
      reported_at: new Date().toISOString(),
    };
    r.updated_at = new Date();
    r.updated_by = actor;
    return r;
  }

  async transitionRegistration(
    id: string,
    to: RegistrationState,
    actor: string
  ): Promise<Registration> {
    const r = this.registrations.get(id);
    if (!r) throw new Error("registration_not_found");
    assertTransition("registration", r.state, to, REG_TRANSITIONS);
    r.state = to;
    r.updated_at = new Date();
    r.updated_by = actor;
    if (to === "Deleted") r.deleted_at = new Date();
    if (to === "Updating") r.generation += 1;
    return r;
  }

  async authzContext(query: {
    tenant_id: string;
    registration_id?: string;
    cert_fingerprint?: string;
    agent_id?: string;
  }): Promise<AuthzContext> {
    const t = this.tenants.get(query.tenant_id);
    const suspended = t?.suspended ?? false;
    const suspendCause = t?.suspended_cause ?? undefined;
    const revoked = !!(
      query.cert_fingerprint &&
      t?.revoked_cert_fingerprints.includes(query.cert_fingerprint)
    );
    const revokeCause = revoked
      ? t?.revoked_cert_causes[query.cert_fingerprint!] ?? "security"
      : undefined;

    let agent_approved = false;
    let agent_state: string | undefined;
    let agent_id: string | undefined;

    if (query.agent_id) {
      const a = this.agents.get(query.agent_id);
      agent_id = a?.id;
      agent_state = a?.state;
      agent_approved = a?.state === "Connected" || a?.state === "Degraded";
    } else if (query.cert_fingerprint) {
      // L3-PKI-01a: uses the shared matchAgentByFp helper that also backs
      // findAgentByCertFingerprint and reportTunnel -- one code path for
      // the prior-FP overlap decision so it can't diverge.
      const a = this.matchAgentByFp(query.cert_fingerprint, {
        excludeRetired: true,
        tenantScope: query.tenant_id,
      });
      if (a) {
        agent_id = a.id;
        agent_state = a.state;
        agent_approved = a.state === "Connected" || a.state === "Degraded";
      }
    }

    let registration: AuthzContext["registration"] = null;
    const eligible_agents: Agent[] = [];
    if (query.registration_id) {
      let r = this.registrations.get(query.registration_id);
      // Convention-driven fallback: if the ID doesn't match a UUID-keyed
      // registration, try resolving it as a display_name slug within this
      // tenant. This is the path the Gateway's inbound handler takes when
      // the SNI hostname is <display_name_slug>.<tenant_id>.connect.fabric
      // instead of <registration_uuid>.<tenant_id>.connect.fabric — same
      // authorization, just a different lookup key.
      if (!r || r.tenant_id !== query.tenant_id || r.deleted_at) {
        const slug = slugifyDisplayName(query.registration_id);
        for (const candidate of this.registrations.values()) {
          if (
            candidate.tenant_id === query.tenant_id &&
            !candidate.deleted_at &&
            slugifyDisplayName(candidate.display_name) === slug
          ) {
            r = candidate;
            break;
          }
        }
      }
      if (r && r.tenant_id === query.tenant_id && !r.deleted_at) {
        registration = {
          ID: r.id,
          TenantID: r.tenant_id,
          State: r.state,
          ConnectivityType: r.connectivity_type,
          DestinationKind: r.destination_kind,
          Host: r.host ?? "",
          Port: r.port ?? 0,
          Generation: r.generation,
        };
        if (r.state === "Active") {
          const revokedSet = new Set(t?.revoked_cert_fingerprints ?? []);
          const candidates: Agent[] = [];
          for (const a of this.agents.values()) {
            if (
              a.tenant_id === query.tenant_id &&
              (a.state === "Connected" || a.state === "Degraded")
            ) {
              candidates.push(a);
            }
          }
          eligible_agents.push(
            ...filterEligibleAgents(candidates, r, revokedSet, PROBE_GRACE_MS)
          );
        }
      }
    }

    const quotas = {
      max_tunnels: t?.max_tunnels ?? 50,
      max_concurrent_streams: t?.max_concurrent_streams ?? 2000,
      max_stream_open_per_sec: t?.max_stream_open_per_sec ?? 100,
    };
    const quota_ok =
      quotas.max_tunnels > 0 &&
      quotas.max_concurrent_streams > 0 &&
      quotas.max_stream_open_per_sec > 0;

    return {
      registration,
      eligible_agents: eligible_agents.map((a) => ({
        ID: a.id,
        TenantID: a.tenant_id,
        State: a.state,
        CertFingerprint: a.cert_fingerprint_sha256 ?? undefined,
      })),
      tenant_suspended: suspended,
      tenant_suspend_cause: suspendCause ?? undefined,
      cert_revoked: revoked,
      cert_revoke_cause: revokeCause,
      quotas,
      quota_ok,
      quota_reason: quota_ok ? undefined : "quota_limits_invalid",
      agent_approved,
      agent_state,
      agent_id,
      evidence_trust: evidenceTrustFromTenant(t),
    };
  }

  async reportTunnel(input: {
    tenant_id: string;
    agent_id?: string;
    cert_fingerprint?: string;
    event: "up" | "down" | "heartbeat";
    actor: string;
  }): Promise<Agent> {
    let agent: Agent | undefined;
    if (input.agent_id) agent = this.agents.get(input.agent_id);
    else if (input.cert_fingerprint) {
      // Same prior-FP-aware match as authzContext and findAgentByCertFingerprint.
      agent = this.matchAgentByFp(input.cert_fingerprint, {
        excludeRetired: true,
        tenantScope: input.tenant_id,
      });
    }
    if (!agent) throw new Error("agent_not_found");
    if (agent.tenant_id !== input.tenant_id) {
      throw new Error("agent_tenant_mismatch");
    }

    const now = new Date();
    agent.last_heartbeat_at = now;
    agent.updated_at = now;
    agent.updated_by = input.actor;

    if (input.event === "heartbeat") {
      agent.tunnel_state = agent.tunnel_state ?? "up";
      if (agent.state === "Degraded") {
        await this.transitionAgent(agent.id, "Connected", input.actor);
        return this.agents.get(agent.id)!;
      }
      return agent;
    }

    if (input.event === "up") {
      if (agent.state === "PendingApproval") {
        agent.tunnel_state = "up_pending_approval";
        return agent;
      }
      agent.tunnel_state = "up";
      if (agent.state === "Connecting") {
        await this.transitionAgent(agent.id, "Connected", input.actor);
      } else if (agent.state === "Disconnected") {
        await this.transitionAgent(agent.id, "Connected", input.actor);
      } else if (agent.state === "Degraded") {
        await this.transitionAgent(agent.id, "Connected", input.actor);
      } else if (agent.state !== "Connected") {
        throw new Error(`agent_tunnel_up_invalid_state: ${agent.state}`);
      }
      return this.agents.get(agent.id)!;
    }

    agent.tunnel_state = "down";
    if (
      agent.state === "Connected" ||
      agent.state === "Degraded" ||
      agent.state === "Connecting"
    ) {
      await this.transitionAgent(agent.id, "Disconnected", input.actor);
    } else if (agent.state === "Retired") {
      // L2 §A.3: Retired is terminal. A security force-close of a
      // Retired agent's still-live tunnel (ReconcileSecurity) legitimately
      // fires a "down" event on its way out -- this is not an error, just
      // the tunnel finishing what the force-close already started. Throwing
      // here only produced noisy tunnel_event_failed retries in the
      // Gateway for a tunnel that was already correctly torn down.
      return agent;
    } else if (
      agent.state !== "PendingApproval" &&
      agent.state !== "Disconnected"
    ) {
      throw new Error(`agent_tunnel_down_invalid_state: ${agent.state}`);
    }
    return this.agents.get(agent.id)!;
  }
}
