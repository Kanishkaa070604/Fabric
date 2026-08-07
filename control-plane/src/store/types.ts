import { createHash, randomBytes, randomUUID } from "crypto";

export type AgentState =
  | "NotInstalled"
  | "Installing"
  | "Bootstrapping"
  | "PendingApproval"
  | "Connecting"
  | "Connected"
  | "Degraded"
  | "Disconnected"
  | "Retired";

export type RegistrationState =
  | "Requested"
  | "Validating"
  | "Provisioning"
  | "Active"
  | "Updating"
  | "Deleting"
  | "Deleted"
  | "Failed";

export const AGENT_TRANSITIONS: Record<AgentState, AgentState[]> = {
  NotInstalled: ["Installing"],
  Installing: ["Bootstrapping"],
  Bootstrapping: ["PendingApproval", "NotInstalled"],
  PendingApproval: ["Connecting", "Retired"],
  Connecting: ["Connected", "Disconnected", "Retired"],
  Connected: ["Degraded", "Disconnected", "Retired"],
  Degraded: ["Connected", "Disconnected", "Retired"],
  Disconnected: ["Connected", "Retired"],
  Retired: [],
};

/**
 * Registration state machine (L2 §A.2). Notable exits:
 * - `Failed → Validating` is the retry path (`FabricStore.retryRegistration` /
 *   `POST /v1/registrations/:id/retry`) — re-runs provisioning without
 *   delete+recreate.
 * - `Failed → Deleted` is the abandon path (`deleteRegistration`).
 * - `Updating → Failed` is legal in the table for a future apply-failure
 *   mode; today's `updateRegistration` follows §G.5 and restores to
 *   `Active` instead (never leaves a half-applied Failed row from update).
 */
export const REG_TRANSITIONS: Record<RegistrationState, RegistrationState[]> = {
  Requested: ["Validating"],
  Validating: ["Provisioning", "Failed"],
  Provisioning: ["Active", "Failed"],
  Active: ["Updating", "Deleting"],
  Updating: ["Active", "Failed"],
  Deleting: ["Deleted"],
  Deleted: [],
  Failed: ["Validating", "Deleted"],
};

/** L2 §G.3: distinguishes billing/policy suspension (drain) from an active security incident (force-close). */
export type SuspendCause = "billing" | "security";

/** L2 §D.3: distinguishes routine decommission (drain) from a security-triggered revocation (force-close). */
export type RevokeCause = "decommission" | "security";

/**
 * Cap on `TenantConnect.revoked_cert_fingerprints` (and its parallel
 * `revoked_cert_causes` map). Every certificate rotation/revocation ever
 * issued for a tenant used to be appended here forever with no pruning --
 * both the JSONB row (unbounded growth on a row that's re-read/rewritten
 * on every revoke) and the O(n) `.includes()` linear scan on the hot
 * authz-context read path (every StreamOpen) degrade as a tenant ages and
 * rotates certs over months/years. Bounding it to the most recent N
 * fingerprints keeps both bounded; dropping the oldest is safe because an
 * expired certificate can never pass Ghostunnel's mTLS handshake to reach
 * this check in the first place, so retaining revocation history past a
 * cert's own lifetime has no security value.
 */
export const MAX_REVOKED_CERT_FINGERPRINTS = 500;

/**
 * Default overlap window (seconds) for cert rotation -- how long the prior
 * fingerprint stays accepted after a new leaf is bound. Single source of
 * truth so the three places that default this (MemoryStore.rotateAgentCert,
 * SequelizeStore.rotateAgentCert, certlife.requestRotatedCert) can't drift.
 * 5 minutes is generous enough for an Agent to reconnect on the new leaf
 * via the force-reconnect hook (certlife.Config.Reconnect), while keeping
 * the revocation/deny surface bounded.
 */
export const DEFAULT_CERT_OVERLAP_SECONDS = 300;

/**
 * Default overlap window (seconds) for Agent API token mint -- how long the
 * prior bearer stays accepted after a new one is issued. Longer than
 * DEFAULT_CERT_OVERLAP_SECONDS because N DaemonSet instances may pull at
 * different times within a refresh interval (1h); giving them a full hour
 * of overlap avoids the "stomp the prior slot" problem documented in
 * G-CRED-1 / D1 reuse.
 */
export const DEFAULT_TOKEN_OVERLAP_SECONDS = 3600;

/** Appends `fingerprint`/`cause` and prunes to MAX_REVOKED_CERT_FINGERPRINTS,
 * dropping the oldest entries (and their cause) first. Shared by every
 * FabricStore implementation's revokeCertFingerprint so the retention policy
 * can't drift between them. */
export function addRevokedFingerprint(
  fingerprints: string[],
  causes: Record<string, RevokeCause>,
  fingerprint: string,
  cause: RevokeCause
): { fingerprints: string[]; causes: Record<string, RevokeCause> } {
  const deduped = fingerprints.filter((f) => f !== fingerprint);
  deduped.push(fingerprint);
  const dropped = deduped.slice(
    0,
    Math.max(0, deduped.length - MAX_REVOKED_CERT_FINGERPRINTS)
  );
  const kept = deduped.slice(-MAX_REVOKED_CERT_FINGERPRINTS);
  const nextCauses: Record<string, RevokeCause> = { ...causes, [fingerprint]: cause };
  for (const f of dropped) delete nextCauses[f];
  return { fingerprints: kept, causes: nextCauses };
}

/**
 * Single source of truth for "is this agent stale enough to degrade" (the
 * heartbeat watchdog rule). `MemoryStore.degradeStaleAgents` calls this
 * directly. `SequelizeStore.degradeStaleAgents` can't call it from inside a
 * SQL `WHERE` clause, but its `Op.or` predicate MUST stay logically
 * identical to this function -- there is no automated cross-check that
 * catches drift for a decision expressed in two hand-written places (SQL
 * vs JS), so treat any edit to either side as requiring the other to be
 * re-checked against this doc comment by eye. See
 * `test/agent_staleness.test.ts` for the exact boundary this locks down
 * (this pass found and fixed a real, if extremely low-probability,
 * divergence at the cutoff instant itself: memory.ts used to degrade at
 * `heartbeat <= cutoff`, sequelize.ts's `Op.lt` only at `heartbeat <
 * cutoff` -- both now use "at or before cutoff", matching this function).
 */
export function isAgentStale(
  agent: {
    state: string;
    deleted_at: Date | null;
    last_heartbeat_at: Date | null;
    updated_at: Date;
  },
  cutoff: Date
): boolean {
  if (agent.deleted_at || agent.state !== "Connected") return false;
  const reference = agent.last_heartbeat_at ?? agent.updated_at;
  return reference.getTime() <= cutoff.getTime();
}

export type WorkloadEvidenceStrategy =
  | "none"
  | "kubernetes_oidc"
  | "ecs_task_identity";

export type TenantConnect = {
  tenant_id: string;
  auto_approve_agents: boolean;
  max_tunnels: number;
  max_concurrent_streams: number;
  max_stream_open_per_sec: number;
  suspended: boolean;
  /** Missing/null while `suspended=false`; defaults to "security" if ever ambiguous (fail safe). */
  suspended_cause: SuspendCause | null;
  revoked_cert_fingerprints: string[];
  /** Cause per fingerprint in `revoked_cert_fingerprints`. Absent entries default to "security" (fail safe). */
  revoked_cert_causes: Record<string, RevokeCause>;
  /** Spec §10.1 Phase 1 optional substrate binding. */
  strict_substrate_binding: boolean;
  expected_substrate_fingerprint: string | null;
  /** L3-EVID-01 — primary evidence strategy for this tenant. */
  workload_evidence_strategy: WorkloadEvidenceStrategy;
  /** Strategy-specific extras (ECS later); kubernetes_oidc uses oidc_* columns. */
  workload_evidence_config: Record<string, unknown>;
  oidc_enabled: boolean;
  oidc_issuer_url: string | null;
  oidc_jwks_uri: string | null;
  oidc_audience: string;
  oidc_allowed_algs: string[];
  oidc_ca_bundle_pem: string | null;
  oidc_last_discovery_ok_at: Date | null;
  oidc_last_discovery_error: string | null;
  bootstrap_token_hash: Buffer | null;
  bootstrap_expires_at: Date | null;
  /** L3-CTL-01a: scoped Agent API bearer (enroll / list regs / observed / rotate). */
  agent_api_token_hash: Buffer | null;
  agent_api_token_expires_at: Date | null;
  /** G-CRED-1: previous bearer hash during pull/rotate overlap. */
  prior_agent_api_token_hash: Buffer | null;
  prior_agent_api_token_valid_until: Date | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
};

export type Agent = {
  id: string;
  tenant_id: string;
  state: AgentState;
  substrate: string;
  /** Spec §10.1 optional strict substrate binding: cluster UID / cloud account presented at enroll. */
  substrate_fingerprint: string | null;
  cert_fingerprint_sha256: string | null;
  /** Leaf NotAfter when issued/rotated (L3-PKI-01a); used by expiry scan later. */
  cert_not_after: Date | null;
  /** Prior leaf during rotate overlap window (L3-PKI-01a). */
  prior_cert_fingerprint_sha256: string | null;
  prior_cert_valid_until: Date | null;
  enrollment_approved_at: Date | null;
  enrollment_approved_by: string | null;
  last_heartbeat_at: Date | null;
  tunnel_state: string | null;
  deleted_at: Date | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
};

export type Registration = {
  id: string;
  tenant_id: string;
  generation: number;
  connectivity_type: "SERVICE" | "RESOURCE";
  destination_kind: string;
  display_name: string;
  host: string | null;
  port: number | null;
  state: RegistrationState;
  observed: Record<
    string,
    {
      observed_generation: number;
      condition: string;
      reachable?: "true" | "false" | "unknown";
      reported_at: string;
    }
  >;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  deleted_at: Date | null;
};

export type AuthzContext = {
  registration: {
    ID: string;
    TenantID: string;
    State: string;
    ConnectivityType: string;
    DestinationKind: string;
    Host: string;
    Port: number;
    Generation: number;
  } | null;
  eligible_agents: {
    ID: string;
    TenantID: string;
    State: string;
    CertFingerprint?: string;
  }[];
  tenant_suspended: boolean;
  /** Only meaningful when tenant_suspended=true. Drives force-close vs drain (L2 §G.3). */
  tenant_suspend_cause?: SuspendCause;
  cert_revoked: boolean;
  /** Only meaningful when cert_revoked=true. Drives force-close vs drain (L2 §D.3). */
  cert_revoke_cause?: RevokeCause;
  /** Limits for Gateway enforcement (L3-GW-02). Live usage is counted on Gateway. */
  quotas: {
    max_tunnels: number;
    max_concurrent_streams: number;
    max_stream_open_per_sec: number;
  };
  /** True when limits are configured (>0). Live exhaustion is decided by Gateway. */
  quota_ok: boolean;
  quota_reason?: string;
  agent_approved: boolean;
  agent_state?: string;
  agent_id?: string;
  /**
   * L3-EVID-01: trust material for Gateway evidence attribution.
   * Gateway verifies when strategy≠none and (for k8s) oidc_enabled.
   */
  evidence_trust: EvidenceTrust;
};

/** Wire shape Gateway consumes from authz-context (and GET workload-evidence). */
export type EvidenceTrust = {
  strategy: WorkloadEvidenceStrategy;
  oidc_enabled: boolean;
  issuer_url: string | null;
  jwks_uri: string | null;
  audience: string;
  allowed_algs: string[];
  ca_bundle_pem: string | null;
  config: Record<string, unknown>;
};

export function evidenceTrustFromTenant(t: TenantConnect | undefined): EvidenceTrust {
  if (!t) {
    return {
      strategy: "none",
      oidc_enabled: false,
      issuer_url: null,
      jwks_uri: null,
      audience: "abluva-connect",
      allowed_algs: ["RS256"],
      ca_bundle_pem: null,
      config: {},
    };
  }
  return {
    strategy: t.workload_evidence_strategy,
    oidc_enabled: t.oidc_enabled,
    issuer_url: t.oidc_issuer_url,
    jwks_uri: t.oidc_jwks_uri,
    audience: t.oidc_audience || "abluva-connect",
    allowed_algs:
      t.oidc_allowed_algs?.length > 0 ? t.oidc_allowed_algs : ["RS256"],
    ca_bundle_pem: t.oidc_ca_bundle_pem,
    config: t.workload_evidence_config ?? {},
  };
}

export function assertTransition<S extends string>(
  kind: string,
  from: S,
  to: S,
  table: Record<S, S[]>
) {
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`${kind}_illegal_transition: ${from} -> ${to}`);
  }
}

export function hashBootstrapToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Same hash as bootstrap — Agent API tokens are distinct credentials, same storage shape. */
export const hashAgentApiToken = hashBootstrapToken;

export function newId(): string {
  return randomUUID();
}

export function cryptoRandom(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Async store used by HTTP APIs (MemoryStore or SequelizeStore). */
export interface FabricStore {
  ensureTenant(tenantId: string, actor: string): Promise<TenantConnect>;
  /** Read-only; does not create. */
  getTenant(tenantId: string): Promise<TenantConnect | undefined>;
  /** Internal-only (not exposed over HTTP): drives the DNS reconciler's tenant fan-out. */
  listAllTenantIds(): Promise<string[]>;
  issueBootstrapToken(
    tenantId: string,
    actor: string,
    ttlMinutes?: number
  ): Promise<string>;
  /** Clears outstanding bootstrap token so it can no longer enroll. */
  revokeBootstrapToken(
    tenantId: string,
    actor: string
  ): Promise<TenantConnect>;
  /**
   * L3-CTL-01a / G-CRED-1: issue scoped Agent API bearer.
   * Default TTL 365 days; pass ttlMinutes=0 for no expiry until revoke.
   * overlap_seconds>0 keeps the previous hash accepted until then (multi-Agent pull).
   */
  issueAgentApiToken(
    tenantId: string,
    actor: string,
    ttlMinutes?: number,
    opts?: { overlap_seconds?: number }
  ): Promise<string>;
  revokeAgentApiToken(
    tenantId: string,
    actor: string
  ): Promise<TenantConnect>;
  /** Returns tenant_id when raw token is valid (current or prior-in-overlap). */
  resolveAgentApiToken(raw: string): Promise<string | undefined>;
  enrollAgent(input: {
    tenant_id: string;
    bootstrap_token: string;
    substrate: string;
    substrate_fingerprint?: string;
    cert_fingerprint_sha256?: string;
    cert_not_after?: Date | null;
    actor: string;
  }): Promise<Agent>;
  /**
   * L3-PKI-01a: rebind leaf fingerprint keeping agent_id.
   * overlap_seconds>0 keeps prior FP accepted until then; 0 revokes prior immediately.
   */
  rotateAgentCert(input: {
    agent_id: string;
    cert_fingerprint_sha256: string;
    cert_not_after?: Date | null;
    actor: string;
    overlap_seconds?: number;
  }): Promise<{ agent: Agent; previous_fingerprint: string | null }>;
  getAgent(agentId: string): Promise<Agent | undefined>;
  listAgents(
    tenantId: string,
    opts?: { state?: AgentState }
  ): Promise<Agent[]>;
  approveAgent(agentId: string, actor: string): Promise<Agent>;
  retireAgent(agentId: string, actor: string): Promise<Agent>;
  findAgentByCertFingerprint(
    certFingerprint: string
  ): Promise<Agent | undefined>;
  // Unlike findAgentByCertFingerprint, this does NOT exclude Retired/deleted
  // agents. Gateway's ReconcileSecurity (L2 §A.3) needs to find a Retired
  // agent BY its cert fingerprint specifically to force-close its tunnel --
  // the strict lookup above exists so a *new* tunnel dial from a retired
  // cert doesn't rebind at accept time, but that same exclusion would make
  // the Retired agent unfindable for force-close if reused here too.
  findAgentByCertFingerprintAny(
    certFingerprint: string
  ): Promise<Agent | undefined>;
  setAutoApprove(
    tenantId: string,
    enabled: boolean,
    actor: string
  ): Promise<TenantConnect>;
  /** `cause` is required when `suspended=true` (L2 §G.3); ignored when lifting suspension. */
  setSuspended(
    tenantId: string,
    suspended: boolean,
    actor: string,
    cause?: SuspendCause
  ): Promise<TenantConnect>;
  setSubstrateBinding(
    tenantId: string,
    binding: { enabled: boolean; expected_substrate_fingerprint?: string | null },
    actor: string
  ): Promise<TenantConnect>;
  setQuotas(
    tenantId: string,
    quotas: {
      max_tunnels?: number;
      max_concurrent_streams?: number;
      max_stream_open_per_sec?: number;
    },
    actor: string
  ): Promise<TenantConnect>;
  /**
   * L3-EVID-01: set workload-evidence strategy + OIDC trust material.
   * Caller may pass discovery results (jwks_uri, oidc_enabled, errors).
   */
  setWorkloadEvidence(
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
  ): Promise<TenantConnect>;
  /** `cause` defaults to "security" (fail safe → immediate teardown) per L2 §D.3. */
  revokeCertFingerprint(
    tenantId: string,
    fingerprint: string,
    actor: string,
    cause?: RevokeCause
  ): Promise<TenantConnect>;
  /** Connected agents with stale last_heartbeat_at → Degraded. Returns count. */
  degradeStaleAgents(staleAfterMs: number): Promise<number>;
  createRegistration(input: {
    tenant_id: string;
    display_name: string;
    connectivity_type: "SERVICE" | "RESOURCE";
    destination_kind: string;
    host?: string;
    port?: number;
    actor: string;
  }): Promise<Registration>;
  getRegistration(registrationId: string): Promise<Registration | undefined>;
  listRegistrations(tenantId: string): Promise<Registration[]>;
  /** Active → Deleting → Deleted (stops StreamOpen for this registration). */
  deleteRegistration(
    registrationId: string,
    actor: string
  ): Promise<Registration>;
  /**
   * L2 §A.2 Updating / §G.5 / §F.3: change an existing Active registration's
   * customer-facing name and/or destination in place. Only valid from
   * Active (never Updating→Updating, never on Deleting/Deleted/Failed).
   * §G.2: the registration is non-routable for new streams for the
   * (brief, in-memory) duration of the transition; existing in-flight
   * streams are untouched (Gateway never re-reads Registration mid-stream).
   * §G.5: on any validation/apply failure the prior last-known-good fields
   * are restored and the Registration lands back on Active — never left
   * half-applied, and the failure reason is thrown, never swallowed.
   * §D.5: bumps `generation` like any other desired-state change.
   */
  updateRegistration(
    registrationId: string,
    patch: { display_name?: string; host?: string; port?: number },
    actor: string
  ): Promise<Registration>;
  /**
   * L3-REG-01: retry a Failed registration without delete+recreate.
   * Only legal from `Failed`; drives `Failed → Validating → Provisioning →
   * Active` (same success path as create). Rejects if the tenant is
   * suspended or the registration is missing/deleted/not-Failed. Bumps
   * `generation` so Agents and DNS treat it as a new desired-state attempt
   * (§D.5). Does not invent new ways for create/update to land on Failed —
   * those paths stay unchanged to avoid ops surprises.
   */
  retryRegistration(
    registrationId: string,
    actor: string
  ): Promise<Registration>;
  reportObserved(
    registrationId: string,
    agentId: string,
    observed: {
      condition: string;
      reachable?: "true" | "false" | "unknown";
      observed_generation: number;
    },
    actor: string
  ): Promise<Registration>;
  authzContext(query: {
    tenant_id: string;
    registration_id?: string;
    cert_fingerprint?: string;
    agent_id?: string;
  }): Promise<AuthzContext>;
  reportTunnel(input: {
    tenant_id: string;
    agent_id?: string;
    cert_fingerprint?: string;
    event: "up" | "down" | "heartbeat";
    actor: string;
  }): Promise<Agent>;
}

/** Safe JSON view of a tenant (never return raw bootstrap hash). */
export function publicTenant(t: TenantConnect) {
  const outstanding = !!(
    t.bootstrap_token_hash && t.bootstrap_token_hash.length > 0
  );
  return {
    tenant_id: t.tenant_id,
    auto_approve_agents: t.auto_approve_agents,
    max_tunnels: t.max_tunnels,
    max_concurrent_streams: t.max_concurrent_streams,
    max_stream_open_per_sec: t.max_stream_open_per_sec,
    suspended: t.suspended,
    suspended_cause: t.suspended_cause,
    revoked_cert_fingerprints: t.revoked_cert_fingerprints,
    revoked_cert_causes: t.revoked_cert_causes,
    strict_substrate_binding: t.strict_substrate_binding,
    expected_substrate_fingerprint: t.expected_substrate_fingerprint,
    workload_evidence_strategy: t.workload_evidence_strategy,
    oidc_enabled: t.oidc_enabled,
    oidc_issuer_url: t.oidc_issuer_url,
    oidc_jwks_uri: t.oidc_jwks_uri,
    oidc_audience: t.oidc_audience,
    oidc_last_discovery_ok_at: t.oidc_last_discovery_ok_at,
    oidc_last_discovery_error: t.oidc_last_discovery_error,
    bootstrap_token_outstanding: outstanding,
    bootstrap_expires_at: t.bootstrap_expires_at,
    agent_api_token_outstanding: !!(
      t.agent_api_token_hash && t.agent_api_token_hash.length > 0
    ),
    agent_api_token_expires_at: t.agent_api_token_expires_at,
    created_at: t.created_at,
    created_by: t.created_by,
    updated_at: t.updated_at,
    updated_by: t.updated_by,
  };
}

/** Safe JSON for GET/PUT workload-evidence (no secrets beyond CA bundle PEM). */
export function publicWorkloadEvidence(t: TenantConnect) {
  return {
    tenant_id: t.tenant_id,
    strategy: t.workload_evidence_strategy,
    config: t.workload_evidence_config,
    oidc_enabled: t.oidc_enabled,
    oidc_issuer_url: t.oidc_issuer_url,
    oidc_jwks_uri: t.oidc_jwks_uri,
    oidc_audience: t.oidc_audience,
    oidc_allowed_algs: t.oidc_allowed_algs,
    oidc_ca_bundle_pem: t.oidc_ca_bundle_pem,
    oidc_last_discovery_ok_at: t.oidc_last_discovery_ok_at,
    oidc_last_discovery_error: t.oidc_last_discovery_error,
    evidence_trust: evidenceTrustFromTenant(t),
  };
}

/** True for the two destination kinds Spec A3/B4 route Platform-originated dials at (G-A3-1). */
export function isInboundDestination(destinationKind: string): boolean {
  return (
    destinationKind === "CUSTOMER_SERVICE" ||
    destinationKind === "CUSTOMER_RESOURCE"
  );
}

/**
 * G-A3-1 per-registration inbound DNS name. Single source of truth for the
 * naming scheme so `publicRegistration` (API response) and the DNS
 * reconciler (`../dns/reconciler.ts`, prod automation for this name) can
 * never drift from one another.
 */
export function inboundHostname(
  registrationId: string,
  tenantId: string,
  domainSuffix = "connect.fabric"
): string {
  return `${registrationId}.${tenantId}.${domainSuffix}`;
}

/**
 * Convention-driven friendly inbound hostname using the registration's
 * display_name (sanitized to DNS-label format) instead of its UUID.
 * This is the hostname SaaS services construct at runtime:
 *   `<service-name>.<tenant-id>.connect.fabric`
 * without needing per-tenant config or API lookups — they know the service
 * name (it's in their own code) and the tenant_id (from the request's
 * x-ablv-tenant-id header).
 *
 * Both the UUID-based and name-based hostnames resolve to the same target
 * (the DNS reconciler emits both). The UUID-based path is canonical (stable
 * even if display_name is later renamed); the name-based path is what makes
 * Fabric transparent to multi-tenant SaaS services.
 */
export function inboundHostnameByName(
  displayName: string,
  tenantId: string,
  domainSuffix = "connect.fabric"
): string {
  return `${slugifyDisplayName(displayName)}.${tenantId}.${domainSuffix}`;
}

/**
 * Sanitize a registration display_name to a valid DNS label (RFC 1123):
 * lowercase, replace non-alphanumeric with hyphens, collapse runs, trim
 * leading/trailing hyphens, max 63 chars.
 */
export function slugifyDisplayName(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length > 63) slug = slug.slice(0, 63).replace(/-$/, "");
  return slug || "unnamed";
}

/** Registration JSON + G-A3-1 inbound DNS names for CUSTOMER_* destinations. */
export function publicRegistration(
  r: Registration,
  domainSuffix = "connect.fabric"
) {
  const isInbound = isInboundDestination(r.destination_kind);
  return {
    ...r,
    inbound_hostname: isInbound
      ? inboundHostname(r.id, r.tenant_id, domainSuffix)
      : null,
    // Convention-driven friendly hostname (what SaaS services construct
    // at runtime from display_name + tenant_id, no lookup needed).
    inbound_hostname_friendly: isInbound
      ? inboundHostnameByName(r.display_name, r.tenant_id, domainSuffix)
      : null,
  };
}

/**
 * Shared eligible-agent filter + sort for authzContext. Both MemoryStore
 * and SequelizeStore fetch their own candidate agents (in-memory loop vs
 * SQL WHERE), then pass the result list through this one function so the
 * eligibility logic — revoked-fingerprint exclusion, tunnel-ready gate,
 * probe-grace window, reachable-state scoring, and preference sort —
 * can never diverge between the two stores. The original prior-FP P0 bug
 * was exactly this class of drift; this extraction prevents it for the
 * eligibility path too.
 *
 * Callers pass in:
 * - `candidates`: agents in state Connected|Degraded for this tenant
 *   (pre-filtered by the caller's own storage query; this function does
 *   NOT re-check state/tenant/deleted — that's the caller's job so the
 *   storage-specific WHERE clause stays efficient).
 * - `registration`: the Active registration being authorized (provides
 *   `observed`, `generation`, `updated_at` for probe-grace logic).
 * - `revokedFingerprints`: the tenant's revoked set (from TenantConnect).
 * - `probeGraceMs`: how long a new registration without a matching-gen
 *   probe is still eligible (FABRIC_PROBE_GRACE env; caller passes their
 *   own parsed constant).
 *
 * Returns the sorted eligible-agent list (empty = DESTINATION_UNAVAILABLE
 * to the Gateway). Pure function, no I/O.
 */
export function filterEligibleAgents(
  candidates: Agent[],
  registration: Registration,
  revokedFingerprints: Set<string>,
  probeGraceMs: number
): Agent[] {
  const eligible: Agent[] = [];
  for (const a of candidates) {
    // Revoked cert: exclude even if Connected.
    if (a.cert_fingerprint_sha256 && revokedFingerprints.has(a.cert_fingerprint_sha256)) {
      continue;
    }
    // Spec §5.2 / L2 §G.1: Tunnel Ready.
    if (a.tunnel_state !== "up" && a.tunnel_state !== "up_pending_approval") {
      continue;
    }
    // Probe observation check for this registration's current generation.
    const obs = registration.observed[`agent:${a.id}`];
    const hasCurrentObs =
      !!obs &&
      typeof obs.observed_generation === "number" &&
      obs.observed_generation === registration.generation;
    if (!hasCurrentObs) {
      // L2 §G.1 probe-grace: brand-new registration / just-bumped
      // generation with no matching observation yet is eligible as
      // "unknown" for a bounded window — otherwise every new CUSTOMER_*
      // registration fails its first StreamOpen(s) by construction.
      if (Date.now() - registration.updated_at.getTime() <= probeGraceMs) {
        eligible.push(a);
      }
      continue;
    }
    // Reported unreachable: exclude.
    const reachable = obs.reachable as string | boolean | undefined;
    if (reachable === "false" || reachable === false) continue;
    // Accept reachable=true or unknown (probe-grace / inconclusive).
    if (reachable !== "true" && reachable !== true && reachable !== "unknown") {
      continue;
    }
    eligible.push(a);
  }
  // Prefer reachable=true, then unknown (includes missing-but-in-grace).
  eligible.sort((x, y) => {
    const rx = registration.observed[`agent:${x.id}`]?.reachable;
    const ry = registration.observed[`agent:${y.id}`]?.reachable;
    const score = (v?: string) =>
      v === "true" ? 0 : v === "unknown" || v === undefined ? 1 : 2;
    return score(rx) - score(ry);
  });
  return eligible;
}
