import { Op, type Sequelize, type Transaction } from "sequelize";
import type { FabricModels } from "../db/models";
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
  addRevokedFingerprint,
  DEFAULT_CERT_OVERLAP_SECONDS,
  filterEligibleAgents,
  evidenceTrustFromTenant,
  slugifyDisplayName,
  type WorkloadEvidenceStrategy,
} from "./types";

// L2 §G.1 probe-grace (see memory.ts for full rationale).
const PROBE_GRACE_MS = parseDurationMs(process.env.FABRIC_PROBE_GRACE, 15_000);

function asTenant(row: Record<string, unknown>): TenantConnect {
  const fps = row.revoked_cert_fingerprints;
  const causes = row.revoked_cert_causes;
  return {
    tenant_id: String(row.tenant_id),
    auto_approve_agents: Boolean(row.auto_approve_agents),
    max_tunnels: Number(row.max_tunnels),
    max_concurrent_streams: Number(row.max_concurrent_streams),
    max_stream_open_per_sec: Number(row.max_stream_open_per_sec),
    suspended: Boolean(row.suspended),
    suspended_cause: (row.suspended_cause as SuspendCause | null) ?? null,
    revoked_cert_fingerprints: Array.isArray(fps)
      ? fps.map(String)
      : [],
    revoked_cert_causes:
      causes && typeof causes === "object"
        ? (causes as Record<string, RevokeCause>)
        : {},
    strict_substrate_binding: Boolean(row.strict_substrate_binding),
    expected_substrate_fingerprint:
      (row.expected_substrate_fingerprint as string | null) ?? null,
    workload_evidence_strategy: (row.workload_evidence_strategy as
      | "none"
      | "kubernetes_oidc"
      | "ecs_task_identity") || "none",
    workload_evidence_config:
      row.workload_evidence_config &&
      typeof row.workload_evidence_config === "object"
        ? (row.workload_evidence_config as Record<string, unknown>)
        : {},
    oidc_enabled: Boolean(row.oidc_enabled),
    oidc_issuer_url: (row.oidc_issuer_url as string | null) ?? null,
    oidc_jwks_uri: (row.oidc_jwks_uri as string | null) ?? null,
    oidc_audience: String(row.oidc_audience || "abluva-connect"),
    oidc_allowed_algs: Array.isArray(row.oidc_allowed_algs)
      ? (row.oidc_allowed_algs as string[]).map(String)
      : ["RS256"],
    oidc_ca_bundle_pem: (row.oidc_ca_bundle_pem as string | null) ?? null,
    oidc_last_discovery_ok_at:
      (row.oidc_last_discovery_ok_at as Date | null) ?? null,
    oidc_last_discovery_error:
      (row.oidc_last_discovery_error as string | null) ?? null,
    bootstrap_token_hash: (row.bootstrap_token_hash as Buffer | null) ?? null,
    bootstrap_expires_at: (row.bootstrap_expires_at as Date | null) ?? null,
    agent_api_token_hash: (row.agent_api_token_hash as Buffer | null) ?? null,
    agent_api_token_expires_at:
      (row.agent_api_token_expires_at as Date | null) ?? null,
    prior_agent_api_token_hash:
      (row.prior_agent_api_token_hash as Buffer | null) ?? null,
    prior_agent_api_token_valid_until:
      (row.prior_agent_api_token_valid_until as Date | null) ?? null,
    created_at: row.created_at as Date,
    created_by: String(row.created_by),
    updated_at: row.updated_at as Date,
    updated_by: String(row.updated_by),
  };
}

function asAgent(row: Record<string, unknown>): Agent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    state: row.state as AgentState,
    substrate: String(row.substrate),
    substrate_fingerprint: row.substrate_fingerprint
      ? String(row.substrate_fingerprint)
      : null,
    cert_fingerprint_sha256: row.cert_fingerprint_sha256
      ? String(row.cert_fingerprint_sha256)
      : null,
    cert_not_after: (row.cert_not_after as Date | null) ?? null,
    prior_cert_fingerprint_sha256: row.prior_cert_fingerprint_sha256
      ? String(row.prior_cert_fingerprint_sha256)
      : null,
    prior_cert_valid_until: (row.prior_cert_valid_until as Date | null) ?? null,
    enrollment_approved_at: (row.enrollment_approved_at as Date | null) ?? null,
    enrollment_approved_by: row.enrollment_approved_by
      ? String(row.enrollment_approved_by)
      : null,
    last_heartbeat_at: (row.last_heartbeat_at as Date | null) ?? null,
    tunnel_state: row.tunnel_state ? String(row.tunnel_state) : null,
    deleted_at: (row.deleted_at as Date | null) ?? null,
    created_at: row.created_at as Date,
    created_by: String(row.created_by),
    updated_at: row.updated_at as Date,
    updated_by: String(row.updated_by),
  };
}

function asRegistration(row: Record<string, unknown>): Registration {
  let observed: Registration["observed"] = {};
  const raw = row.observed;
  if (typeof raw === "string") {
    try {
      observed = JSON.parse(raw) as Registration["observed"];
    } catch {
      observed = {};
    }
  } else if (raw && typeof raw === "object") {
    observed = raw as Registration["observed"];
  }
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    generation: Number(row.generation),
    connectivity_type: row.connectivity_type as "SERVICE" | "RESOURCE",
    destination_kind: String(row.destination_kind),
    display_name: String(row.display_name),
    host: row.host ? String(row.host) : null,
    port: row.port != null ? Number(row.port) : null,
    state: row.state as RegistrationState,
    observed,
    created_at: row.created_at as Date,
    created_by: String(row.created_by),
    updated_at: row.updated_at as Date,
    updated_by: String(row.updated_by),
    deleted_at: (row.deleted_at as Date | null) ?? null,
  };
}

function agentReportedUnreachable(
  obs?: { reachable?: string | boolean }
): boolean {
  return obs?.reachable === "false" || obs?.reachable === false;
}

/**
 * Single-source Sequelize `where` clause for fingerprint matching with
 * prior-FP overlap -- mirrors memory.ts's `matchAgentByFp` helper. Used
 * by findAgentByCertFingerprint, authzContext's cert_fingerprint branch,
 * and reportTunnel's cert_fingerprint fallback. Before this existed, all
 * three had their own hand-copied `Op.or` block, which is exactly the
 * kind of drift that caused the original prior-FP P0 bug (authzContext's
 * copy silently missed the prior-FP branch that findAgentByCertFingerprint
 * already had). One function now, so an overlap-semantics change can't
 * update two of the three call sites and miss the third.
 *
 * Options:
 * - excludeRetired (default true): normal authorization path; a Retired
 *   agent's cert must not rebind at accept time.
 * - tenantId: when set, scopes the match to this tenant (reportTunnel and
 *   authzContext both know the tenant already).
 */
function matchAgentByFpWhere(
  certFingerprint: string,
  opts?: { excludeRetired?: boolean; tenantId?: string }
): Record<string, unknown> {
  const now = new Date();
  const where: Record<string, unknown> = {
    deleted_at: null,
    [Op.or]: [
      { cert_fingerprint_sha256: certFingerprint },
      {
        prior_cert_fingerprint_sha256: certFingerprint,
        prior_cert_valid_until: { [Op.gte]: now },
      },
    ],
  };
  // deleted_at is always set together with state="Retired" (see
  // retireAgent in both stores), so deleted_at:null alone already
  // excludes Retired agents in practice -- this extra state check exists
  // to make that intent explicit and future-proof against a hypothetical
  // path that sets one without the other.
  if (opts?.excludeRetired !== false) {
    where.state = { [Op.ne]: "Retired" };
  }
  if (opts?.tenantId) {
    where.tenant_id = opts.tenantId;
  }
  return where;
}

/**
 * Postgres-backed store. Requires ablv_tenants row to exist (or FABRIC_ENSURE_SAAS_TENANT=1
 * for local compose, which inserts a stub tenant).
 */

function bootstrapTtlMinutes(): number {
  const raw = (process.env.FABRIC_BOOTSTRAP_TTL || "").trim();
  if (!raw) return 7 * 24 * 60;
  const ms = parseDurationMs(raw, 7 * 24 * 60 * 60_000);
  return Math.max(1, Math.round(ms / 60_000));
}
export class SequelizeStore implements FabricStore {
  constructor(
    private readonly sequelize: Sequelize,
    private readonly models: FabricModels,
    private readonly opts: {
      tenantsTable: string;
      tenantsIdColumn: string;
      /** Local/dev only: insert stub into ablv_tenants when missing */
      ensureSaasTenant: boolean;
    }
  ) {}

  private async ensureSaasTenantRow(
    tenantId: string,
    t: Transaction
  ): Promise<void> {
    if (!this.opts.ensureSaasTenant) return;
    const table = this.opts.tenantsTable;
    const col = this.opts.tenantsIdColumn;
    await this.sequelize.query(
      `INSERT INTO ${table} (${col}) VALUES (:id) ON CONFLICT (${col}) DO NOTHING`,
      { replacements: { id: tenantId }, transaction: t }
    );
  }

  async ensureTenant(tenantId: string, actor: string): Promise<TenantConnect> {
    return this.sequelize.transaction(async (t) => {
      await this.ensureSaasTenantRow(tenantId, t);
      const existing = await this.models.TenantConnect.findByPk(tenantId, {
        transaction: t,
      });
      if (existing) return asTenant(existing.get({ plain: true }) as Record<string, unknown>);
      const now = new Date();
      const created = await this.models.TenantConnect.create(
        {
          tenant_id: tenantId,
          auto_approve_agents: true,
          max_tunnels: 50,
          max_concurrent_streams: 2000,
          max_stream_open_per_sec: 100,
          suspended: false,
          suspended_cause: null,
          strict_substrate_binding: false,
          expected_substrate_fingerprint: null,
          workload_evidence_strategy: "none",
          workload_evidence_config: {},
          oidc_enabled: false,
          oidc_audience: "abluva-connect",
          oidc_allowed_algs: ["RS256"],
          revoked_cert_fingerprints: [],
          revoked_cert_causes: {},
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
        },
        { transaction: t }
      );
      return asTenant(created.get({ plain: true }) as Record<string, unknown>);
    });
  }

  async getTenant(tenantId: string): Promise<TenantConnect | undefined> {
    const row = await this.models.TenantConnect.findByPk(tenantId);
    if (!row) return undefined;
    return asTenant(row.get({ plain: true }) as Record<string, unknown>);
  }

  async listAllTenantIds(): Promise<string[]> {
    const rows = await this.models.TenantConnect.findAll({
      attributes: ["tenant_id"],
    });
    return rows.map((r) => String(r.get("tenant_id")));
  }

  async issueBootstrapToken(
    tenantId: string,
    actor: string,
    ttlMinutes = bootstrapTtlMinutes()
  ): Promise<string> {
    await this.ensureTenant(tenantId, actor);
    const raw = cryptoRandom(24);
    const expires = new Date(Date.now() + ttlMinutes * 60_000);
    await this.models.TenantConnect.update(
      {
        bootstrap_token_hash: hashBootstrapToken(raw),
        bootstrap_expires_at: expires,
        updated_at: new Date(),
        updated_by: actor,
      },
      { where: { tenant_id: tenantId } }
    );
    return raw;
  }

  async revokeBootstrapToken(
    tenantId: string,
    actor: string
  ): Promise<TenantConnect> {
    await this.ensureTenant(tenantId, actor);
    await this.models.TenantConnect.update(
      {
        bootstrap_token_hash: null,
        bootstrap_expires_at: null,
        updated_at: new Date(),
        updated_by: actor,
      },
      { where: { tenant_id: tenantId } }
    );
    return (await this.getTenant(tenantId))!;
  }

  async issueAgentApiToken(
    tenantId: string,
    actor: string,
    ttlMinutes = 365 * 24 * 60,
    opts?: { overlap_seconds?: number }
  ): Promise<string> {
    await this.ensureTenant(tenantId, actor);
    const overlap = Math.max(0, opts?.overlap_seconds ?? 0);
    const existing = await this.getTenant(tenantId);
    const raw = cryptoRandom(32);
    const expires =
      ttlMinutes <= 0 ? null : new Date(Date.now() + ttlMinutes * 60_000);
    const patch: Record<string, unknown> = {
      agent_api_token_hash: hashAgentApiToken(raw),
      agent_api_token_expires_at: expires,
      updated_at: new Date(),
      updated_by: actor,
    };
    if (overlap > 0 && existing?.agent_api_token_hash) {
      patch.prior_agent_api_token_hash = existing.agent_api_token_hash;
      patch.prior_agent_api_token_valid_until = new Date(
        Date.now() + overlap * 1000
      );
    } else {
      patch.prior_agent_api_token_hash = null;
      patch.prior_agent_api_token_valid_until = null;
    }
    await this.models.TenantConnect.update(patch, {
      where: { tenant_id: tenantId },
    });
    return raw;
  }

  async revokeAgentApiToken(
    tenantId: string,
    actor: string
  ): Promise<TenantConnect> {
    await this.ensureTenant(tenantId, actor);
    await this.models.TenantConnect.update(
      {
        agent_api_token_hash: null,
        agent_api_token_expires_at: null,
        prior_agent_api_token_hash: null,
        prior_agent_api_token_valid_until: null,
        updated_at: new Date(),
        updated_by: actor,
      },
      { where: { tenant_id: tenantId } }
    );
    return (await this.getTenant(tenantId))!;
  }

  async resolveAgentApiToken(raw: string): Promise<string | undefined> {
    if (!raw) return undefined;
    const hash = hashAgentApiToken(raw);
    const now = new Date();
    const current = await this.models.TenantConnect.findOne({
      where: { agent_api_token_hash: hash },
    });
    if (current) {
      const t = asTenant(current.get({ plain: true }) as Record<string, unknown>);
      if (
        t.agent_api_token_expires_at &&
        t.agent_api_token_expires_at.getTime() < now.getTime()
      ) {
        await this.models.TenantConnect.update(
          {
            agent_api_token_hash: null,
            agent_api_token_expires_at: null,
            updated_at: now,
            updated_by: "agent_api_token_expiry",
          },
          { where: { tenant_id: t.tenant_id } }
        );
        return undefined;
      }
      return t.tenant_id;
    }
    const prior = await this.models.TenantConnect.findOne({
      where: { prior_agent_api_token_hash: hash },
    });
    if (!prior) return undefined;
    const t = asTenant(prior.get({ plain: true }) as Record<string, unknown>);
    if (
      !t.prior_agent_api_token_valid_until ||
      t.prior_agent_api_token_valid_until.getTime() < now.getTime()
    ) {
      return undefined;
    }
    return t.tenant_id;
  }

  private async consumeBootstrapToken(
    raw: string,
    expectedTenant: string,
    t: Transaction
  ): Promise<void> {
    const hash = hashBootstrapToken(raw);
    const row = await this.models.TenantConnect.findByPk(expectedTenant, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) throw new Error("bootstrap_token_invalid");
    const plain = row.get({ plain: true }) as Record<string, unknown>;
    const stored = plain.bootstrap_token_hash as Buffer | Uint8Array | null;
    if (!stored) throw new Error("bootstrap_token_invalid");
    const storedBuf = Buffer.from(stored);
    if (storedBuf.length !== hash.length || !storedBuf.equals(hash)) {
      throw new Error("bootstrap_token_invalid");
    }
    const exp = plain.bootstrap_expires_at as Date | null;
    if (!exp || new Date(exp).getTime() < Date.now()) {
      await row.update(
        { bootstrap_token_hash: null, bootstrap_expires_at: null },
        { transaction: t }
      );
      throw new Error("bootstrap_token_expired");
    }
    // L3-AGT-02 Phase A: multi-redeem until expiry — do not null the hash here.
    // Early kill remains revokeBootstrapToken.
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
    return this.sequelize.transaction(async (t) => {
      await this.ensureSaasTenantRow(input.tenant_id, t);
      await this.consumeBootstrapToken(
        input.bootstrap_token,
        input.tenant_id,
        t
      );
      let tenant = await this.models.TenantConnect.findByPk(input.tenant_id, {
        transaction: t,
      });
      if (!tenant) {
        throw new Error("tenant_not_found");
      }
      const tc = asTenant(tenant.get({ plain: true }) as Record<string, unknown>);
      if (tc.suspended) throw new Error("tenant_suspended");
      // Spec §10.1 Phase 1 optional strict substrate binding: reject enrollment
      // from a substrate the tenant did not declare at onboarding.
      if (tc.strict_substrate_binding) {
        if (
          !input.substrate_fingerprint ||
          input.substrate_fingerprint !== tc.expected_substrate_fingerprint
        ) {
          throw new Error("substrate_binding_mismatch");
        }
      }

      if (input.cert_fingerprint_sha256) {
        const conflict = await this.models.Agent.findOne({
          where: {
            tenant_id: input.tenant_id,
            cert_fingerprint_sha256: input.cert_fingerprint_sha256,
            deleted_at: null,
            state: { [Op.ne]: "Retired" },
          },
          transaction: t,
        });
        if (conflict) throw new Error("agent_cert_fingerprint_conflict");
      }

      const now = new Date();
      const id = newId();
      let state: AgentState = "PendingApproval";
      let approvedAt: Date | null = null;
      let approvedBy: string | null = null;
      if (tc.auto_approve_agents) {
        state = "Connecting";
        approvedAt = now;
        approvedBy = "auto_approve_agents";
      }
      const created = await this.models.Agent.create(
        {
          id,
          tenant_id: input.tenant_id,
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
        },
        { transaction: t }
      );
      return asAgent(created.get({ plain: true }) as Record<string, unknown>);
    });
  }

  async rotateAgentCert(input: {
    agent_id: string;
    cert_fingerprint_sha256: string;
    cert_not_after?: Date | null;
    actor: string;
    overlap_seconds?: number;
  }): Promise<{ agent: Agent; previous_fingerprint: string | null }> {
    const overlap = input.overlap_seconds ?? DEFAULT_CERT_OVERLAP_SECONDS;
    const { prev, tenantId } = await this.sequelize.transaction(async (t) => {
      const row = await this.models.Agent.findByPk(input.agent_id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row) throw new Error("agent_not_found");
      const a = asAgent(row.get({ plain: true }) as Record<string, unknown>);
      if (a.deleted_at || a.state === "Retired") throw new Error("agent_not_found");
      const prevFp = a.cert_fingerprint_sha256;
      if (prevFp === input.cert_fingerprint_sha256) {
        throw new Error("cert_fingerprint_unchanged");
      }
      const conflict = await this.models.Agent.findOne({
        where: {
          tenant_id: a.tenant_id,
          cert_fingerprint_sha256: input.cert_fingerprint_sha256,
          deleted_at: null,
          state: { [Op.ne]: "Retired" },
          id: { [Op.ne]: a.id },
        },
        transaction: t,
      });
      if (conflict) throw new Error("agent_cert_fingerprint_conflict");
      const priorUntil =
        prevFp && overlap > 0 ? new Date(Date.now() + overlap * 1000) : null;
      await row.update(
        {
          prior_cert_fingerprint_sha256: overlap > 0 ? prevFp : null,
          prior_cert_valid_until: priorUntil,
          cert_fingerprint_sha256: input.cert_fingerprint_sha256,
          cert_not_after: input.cert_not_after ?? null,
          updated_at: new Date(),
          updated_by: input.actor,
        },
        { transaction: t }
      );
      return { prev: prevFp, tenantId: a.tenant_id };
    });
    if (prev && overlap <= 0) {
      await this.revokeCertFingerprint(
        tenantId,
        prev,
        input.actor,
        "decommission"
      );
    }
    return {
      agent: (await this.getAgent(input.agent_id))!,
      previous_fingerprint: prev,
    };
  }

  async getAgent(agentId: string): Promise<Agent | undefined> {
    const row = await this.models.Agent.findByPk(agentId);
    if (!row) return undefined;
    return asAgent(row.get({ plain: true }) as Record<string, unknown>);
  }

  async listAgents(
    tenantId: string,
    opts?: { state?: AgentState }
  ): Promise<Agent[]> {
    const where: Record<string, unknown> = {
      tenant_id: tenantId,
      deleted_at: null,
    };
    if (opts?.state) where.state = opts.state;
    const rows = await this.models.Agent.findAll({
      where,
      order: [["created_at", "ASC"]],
    });
    return rows.map((r) =>
      asAgent(r.get({ plain: true }) as Record<string, unknown>)
    );
  }

  private async transitionAgentTx(
    agentId: string,
    to: AgentState,
    actor: string,
    t: Transaction
  ): Promise<Agent> {
    const row = await this.models.Agent.findByPk(agentId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) throw new Error("agent_not_found");
    const a = asAgent(row.get({ plain: true }) as Record<string, unknown>);
    assertTransition("agent", a.state, to, AGENT_TRANSITIONS);
    const patch: Record<string, unknown> = {
      state: to,
      updated_at: new Date(),
      updated_by: actor,
    };
    if (to === "PendingApproval") {
      patch.enrollment_approved_at = null;
      patch.enrollment_approved_by = null;
    }
    await row.update(patch, { transaction: t });
    return asAgent(row.get({ plain: true }) as Record<string, unknown>);
  }

  async approveAgent(agentId: string, actor: string): Promise<Agent> {
    return this.sequelize.transaction(async (t) => {
      const row = await this.models.Agent.findByPk(agentId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row) throw new Error("agent_not_found");
      const a = asAgent(row.get({ plain: true }) as Record<string, unknown>);
      if (a.deleted_at) throw new Error("agent_deleted");
      if (a.state !== "PendingApproval") {
        throw new Error(`agent_approve_invalid_state: ${a.state}`);
      }
      await row.update(
        {
          enrollment_approved_at: new Date(),
          enrollment_approved_by: actor,
        },
        { transaction: t }
      );
      await this.transitionAgentTx(agentId, "Connecting", actor, t);
      const again = await this.models.Agent.findByPk(agentId, { transaction: t });
      const cur = asAgent(again!.get({ plain: true }) as Record<string, unknown>);
      if (
        cur.tunnel_state === "up" ||
        cur.tunnel_state === "up_pending_approval"
      ) {
        await again!.update({ tunnel_state: "up" }, { transaction: t });
        return this.transitionAgentTx(agentId, "Connected", actor, t);
      }
      return asAgent(again!.get({ plain: true }) as Record<string, unknown>);
    });
  }

  async findAgentByCertFingerprint(
    certFingerprint: string
  ): Promise<Agent | undefined> {
    const row = await this.models.Agent.findOne({
      where: matchAgentByFpWhere(certFingerprint, { excludeRetired: true }),
    });
    if (!row) return undefined;
    return asAgent(row.get({ plain: true }) as Record<string, unknown>);
  }

  async findAgentByCertFingerprintAny(
    certFingerprint: string
  ): Promise<Agent | undefined> {
    const row = await this.models.Agent.findOne({
      where: {
        [Op.or]: [
          { cert_fingerprint_sha256: certFingerprint },
          { prior_cert_fingerprint_sha256: certFingerprint },
        ],
      },
      order: [["updated_at", "DESC"]],
    });
    if (!row) return undefined;
    return asAgent(row.get({ plain: true }) as Record<string, unknown>);
  }

  async retireAgent(agentId: string, actor: string): Promise<Agent> {
    return this.sequelize.transaction(async (t) => {
      const row = await this.models.Agent.findByPk(agentId, { transaction: t });
      if (!row) throw new Error("agent_not_found");
      const a = asAgent(row.get({ plain: true }) as Record<string, unknown>);
      if (a.state === "Retired") return a;
      await this.transitionAgentTx(agentId, "Retired", actor, t);
      await row.update(
        { deleted_at: new Date(), tunnel_state: "down" },
        { transaction: t }
      );
      const again = await this.models.Agent.findByPk(agentId, { transaction: t });
      return asAgent(again!.get({ plain: true }) as Record<string, unknown>);
    });
  }

  async setAutoApprove(
    tenantId: string,
    enabled: boolean,
    actor: string
  ): Promise<TenantConnect> {
    await this.ensureTenant(tenantId, actor);
    await this.models.TenantConnect.update(
      {
        auto_approve_agents: enabled,
        updated_at: new Date(),
        updated_by: actor,
      },
      { where: { tenant_id: tenantId } }
    );
    return (await this.ensureTenant(tenantId, actor))!;
  }

  async setSuspended(
    tenantId: string,
    suspended: boolean,
    actor: string,
    cause?: SuspendCause
  ): Promise<TenantConnect> {
    await this.ensureTenant(tenantId, actor);
    await this.models.TenantConnect.update(
      {
        suspended,
        // Fail safe: any suspend with no explicit cause is treated as security
        // (force-close), never silently downgraded to a billing-style drain.
        suspended_cause: suspended ? cause ?? "security" : null,
        updated_at: new Date(),
        updated_by: actor,
      },
      { where: { tenant_id: tenantId } }
    );
    return this.ensureTenant(tenantId, actor);
  }

  async setSubstrateBinding(
    tenantId: string,
    binding: { enabled: boolean; expected_substrate_fingerprint?: string | null },
    actor: string
  ): Promise<TenantConnect> {
    await this.ensureTenant(tenantId, actor);
    const patch: Record<string, unknown> = {
      strict_substrate_binding: binding.enabled,
      updated_at: new Date(),
      updated_by: actor,
    };
    if (binding.expected_substrate_fingerprint !== undefined) {
      patch.expected_substrate_fingerprint = binding.expected_substrate_fingerprint;
    }
    await this.models.TenantConnect.update(patch, {
      where: { tenant_id: tenantId },
    });
    return this.ensureTenant(tenantId, actor);
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
    await this.ensureTenant(tenantId, actor);
    const patch: Record<string, unknown> = {
      updated_at: new Date(),
      updated_by: actor,
    };
    if (quotas.max_tunnels !== undefined) {
      if (quotas.max_tunnels < 1) throw new Error("max_tunnels_invalid");
      patch.max_tunnels = quotas.max_tunnels;
    }
    if (quotas.max_concurrent_streams !== undefined) {
      if (quotas.max_concurrent_streams < 1)
        throw new Error("max_concurrent_streams_invalid");
      patch.max_concurrent_streams = quotas.max_concurrent_streams;
    }
    if (quotas.max_stream_open_per_sec !== undefined) {
      if (quotas.max_stream_open_per_sec < 1)
        throw new Error("max_stream_open_per_sec_invalid");
      patch.max_stream_open_per_sec = quotas.max_stream_open_per_sec;
    }
    await this.models.TenantConnect.update(patch, {
      where: { tenant_id: tenantId },
    });
    return this.ensureTenant(tenantId, actor);
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
    await this.ensureTenant(tenantId, actor);
    const patch: Record<string, unknown> = {
      updated_at: new Date(),
      updated_by: actor,
    };
    if (input.strategy !== undefined) {
      const allowed: WorkloadEvidenceStrategy[] = [
        "none",
        "kubernetes_oidc",
        // "ecs_task_identity" — not implemented in Gateway yet (L3-POC-ECS).
      ];
      if (!allowed.includes(input.strategy)) {
        throw new Error(`workload_evidence_strategy_invalid: ${input.strategy}`);
      }
      patch.workload_evidence_strategy = input.strategy;
    }
    if (input.oidc_issuer_url !== undefined) {
      patch.oidc_issuer_url = input.oidc_issuer_url;
    }
    if (input.oidc_jwks_uri !== undefined) {
      patch.oidc_jwks_uri = input.oidc_jwks_uri;
    }
    if (input.oidc_audience !== undefined) {
      patch.oidc_audience = input.oidc_audience || "abluva-connect";
    }
    if (input.oidc_allowed_algs !== undefined) {
      patch.oidc_allowed_algs =
        input.oidc_allowed_algs.length > 0
          ? input.oidc_allowed_algs
          : ["RS256"];
    }
    if (input.oidc_ca_bundle_pem !== undefined) {
      patch.oidc_ca_bundle_pem = input.oidc_ca_bundle_pem;
    }
    if (input.oidc_enabled !== undefined) {
      patch.oidc_enabled = input.oidc_enabled;
    }
    if (input.oidc_last_discovery_ok_at !== undefined) {
      patch.oidc_last_discovery_ok_at = input.oidc_last_discovery_ok_at;
    }
    if (input.oidc_last_discovery_error !== undefined) {
      patch.oidc_last_discovery_error = input.oidc_last_discovery_error;
    }
    if (input.workload_evidence_config !== undefined) {
      patch.workload_evidence_config = input.workload_evidence_config;
    }
    await this.models.TenantConnect.update(patch, {
      where: { tenant_id: tenantId },
    });
    return this.ensureTenant(tenantId, actor);
  }

  // Must stay logically identical to types.ts's isAgentStale (SQL can't
  // call that JS function directly -- see its doc comment). Uses Op.lte,
  // not Op.lt: isAgentStale degrades at "reference <= cutoff", so this
  // must match at the exact cutoff instant too, not just approximately.
  async degradeStaleAgents(staleAfterMs: number): Promise<number> {
    if (staleAfterMs <= 0) return 0;
    const cutoff = new Date(Date.now() - staleAfterMs);
    const rows = await this.models.Agent.findAll({
      where: {
        state: "Connected",
        deleted_at: null,
        [Op.or]: [
          { last_heartbeat_at: { [Op.lte]: cutoff } },
          {
            last_heartbeat_at: null,
            updated_at: { [Op.lte]: cutoff },
          },
        ],
      },
    });
    let n = 0;
    for (const row of rows) {
      const id = String(row.get("id"));
      try {
        await this.sequelize.transaction(async (t) => {
          await this.transitionAgentTx(id, "Degraded", "heartbeat-watchdog", t);
        });
        n++;
      } catch {
        // concurrent transition — skip
      }
    }
    return n;
  }

  async revokeCertFingerprint(
    tenantId: string,
    fingerprint: string,
    actor: string,
    cause: RevokeCause = "security"
  ): Promise<TenantConnect> {
    return this.sequelize.transaction(async (t) => {
      await this.ensureSaasTenantRow(tenantId, t);
      const row = await this.models.TenantConnect.findByPk(tenantId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row) {
        await this.ensureTenant(tenantId, actor);
      }
      const cur = await this.models.TenantConnect.findByPk(tenantId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      const tc = asTenant(cur!.get({ plain: true }) as Record<string, unknown>);
      const { fingerprints: fps, causes } = addRevokedFingerprint(
        tc.revoked_cert_fingerprints,
        tc.revoked_cert_causes,
        fingerprint,
        cause
      );
      await cur!.update(
        {
          revoked_cert_fingerprints: fps,
          revoked_cert_causes: causes,
          updated_at: new Date(),
          updated_by: actor,
        },
        { transaction: t }
      );
      return asTenant({
        ...(cur!.get({ plain: true }) as Record<string, unknown>),
        revoked_cert_fingerprints: fps,
        revoked_cert_causes: causes,
      });
    });
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
    return this.sequelize.transaction(async (t) => {
      const tenant = await this.ensureTenant(input.tenant_id, input.actor);
      if (tenant.suspended) throw new Error("tenant_suspended");
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
      const conflict = await this.models.Registration.findOne({
        where: {
          tenant_id: input.tenant_id,
          display_name: input.display_name,
          deleted_at: null,
        },
        transaction: t,
      });
      if (conflict) throw new Error("registration_display_name_conflict");

      const now = new Date();
      const id = newId();
      await this.models.Registration.create(
        {
          id,
          tenant_id: input.tenant_id,
          generation: 1,
          connectivity_type: input.connectivity_type,
          destination_kind: input.destination_kind,
          display_name: input.display_name,
          host: input.host ?? null,
          port: input.port ?? null,
          tls_mode: "in-band",
          workload_evidence_attribution_level: "standard",
          intended_consumers: [],
          state: "Requested",
          observed: {},
          deleted_at: null,
          created_at: now,
          created_by: input.actor,
          updated_at: now,
          updated_by: input.actor,
        },
        { transaction: t }
      );
      await this.advanceRegistrationToActiveTx(id, input.actor, t);
      const row = await this.models.Registration.findByPk(id, { transaction: t });
      return asRegistration(row!.get({ plain: true }) as Record<string, unknown>);
    });
  }

  /** See MemoryStore.advanceRegistrationToActive — keep steps identical. */
  private async advanceRegistrationToActiveTx(
    registrationId: string,
    actor: string,
    t: Transaction
  ): Promise<Registration> {
    const row = await this.models.Registration.findByPk(registrationId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) throw new Error("registration_not_found");
    let r = asRegistration(row.get({ plain: true }) as Record<string, unknown>);
    if (r.state === "Requested") {
      r = await this.transitionRegistrationTx(registrationId, "Validating", actor, t);
    }
    if (r.state !== "Validating") {
      throw new Error(`registration_not_advanceable: state is ${r.state}`);
    }
    await this.transitionRegistrationTx(registrationId, "Provisioning", actor, t);
    return this.transitionRegistrationTx(registrationId, "Active", actor, t);
  }

  async retryRegistration(
    registrationId: string,
    actor: string
  ): Promise<Registration> {
    return this.sequelize.transaction(async (t) => {
      const row = await this.models.Registration.findByPk(registrationId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row || row.get("deleted_at")) throw new Error("registration_not_found");
      const r = asRegistration(row.get({ plain: true }) as Record<string, unknown>);
      if (r.state !== "Failed") {
        throw new Error(
          `registration_not_retryable: state is ${r.state}, must be Failed`
        );
      }
      const tenant = await this.models.TenantConnect.findByPk(r.tenant_id, {
        transaction: t,
      });
      if (tenant?.get("suspended")) throw new Error("tenant_suspended");
      if (!r.host || !r.port) {
        throw new Error("host_port_required_for_destination");
      }
      // §D.5: bump before leaving Failed so observers see a new attempt.
      await row.update(
        { generation: r.generation + 1, updated_at: new Date(), updated_by: actor },
        { transaction: t }
      );
      await this.transitionRegistrationTx(registrationId, "Validating", actor, t);
      return this.advanceRegistrationToActiveTx(registrationId, actor, t);
    });
  }

  async getRegistration(
    registrationId: string
  ): Promise<Registration | undefined> {
    const row = await this.models.Registration.findByPk(registrationId);
    if (!row || row.get("deleted_at")) return undefined;
    return asRegistration(row.get({ plain: true }) as Record<string, unknown>);
  }

  async listRegistrations(tenantId: string): Promise<Registration[]> {
    const rows = await this.models.Registration.findAll({
      where: { tenant_id: tenantId, deleted_at: null },
      order: [["created_at", "ASC"]],
    });
    return rows.map((r) =>
      asRegistration(r.get({ plain: true }) as Record<string, unknown>)
    );
  }

  async deleteRegistration(
    registrationId: string,
    actor: string
  ): Promise<Registration> {
    return this.sequelize.transaction(async (t) => {
      const row = await this.models.Registration.findByPk(registrationId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row || row.get("deleted_at")) throw new Error("registration_not_found");
      let r = asRegistration(row.get({ plain: true }) as Record<string, unknown>);
      if (r.state === "Deleted") return r;
      if (r.state === "Updating") {
        r = await this.transitionRegistrationTx(registrationId, "Active", actor, t);
      }
      if (r.state === "Failed") {
        return this.transitionRegistrationTx(registrationId, "Deleted", actor, t);
      }
      if (r.state === "Active") {
        await this.transitionRegistrationTx(registrationId, "Deleting", actor, t);
        return this.transitionRegistrationTx(registrationId, "Deleted", actor, t);
      }
      if (r.state === "Deleting") {
        return this.transitionRegistrationTx(registrationId, "Deleted", actor, t);
      }
      throw new Error(`registration_not_deletable: ${r.state}`);
    });
  }

  async updateRegistration(
    registrationId: string,
    patch: { display_name?: string; host?: string; port?: number },
    actor: string
  ): Promise<Registration> {
    // L2 §G.5: the whole Active -> Updating -> Active(new) cycle runs inside
    // one DB transaction. If anything below throws, Postgres rolls the
    // entire transaction back and the row is exactly as it was before this
    // call started (still Active, still the old host/port/display_name) --
    // a stronger form of "never left half-applied" than a manual restore,
    // since no concurrent reader can observe a partially-applied row even
    // transiently. §G.2's "Updating is non-routable" still holds for the
    // (here, effectively zero-width) window between commit points.
    return this.sequelize.transaction(async (t) => {
      const row = await this.models.Registration.findByPk(registrationId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row || row.get("deleted_at")) throw new Error("registration_not_found");
      const r = asRegistration(row.get({ plain: true }) as Record<string, unknown>);
      if (r.state !== "Active") {
        throw new Error(`registration_not_updatable: state is ${r.state}, must be Active`);
      }

      const nextHost = patch.host !== undefined ? patch.host : r.host;
      const nextPort = patch.port !== undefined ? patch.port : r.port;
      if (!nextHost || !nextPort) {
        throw new Error("host_port_required_for_destination");
      }
      if (patch.display_name !== undefined && patch.display_name !== r.display_name) {
        const conflict = await this.models.Registration.findOne({
          where: {
            tenant_id: r.tenant_id,
            display_name: patch.display_name,
            deleted_at: null,
            id: { [Op.ne]: registrationId },
          },
          transaction: t,
        });
        if (conflict) throw new Error("registration_display_name_conflict");
      }

      await this.transitionRegistrationTx(registrationId, "Updating", actor, t);
      await row.update(
        {
          display_name: patch.display_name ?? r.display_name,
          host: nextHost,
          port: nextPort,
          updated_at: new Date(),
          updated_by: actor,
        },
        { transaction: t }
      );
      return this.transitionRegistrationTx(registrationId, "Active", actor, t);
    });
  }

  private async transitionRegistrationTx(
    id: string,
    to: RegistrationState,
    actor: string,
    t: Transaction
  ): Promise<Registration> {
    const row = await this.models.Registration.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) throw new Error("registration_not_found");
    const r = asRegistration(row.get({ plain: true }) as Record<string, unknown>);
    assertTransition("registration", r.state, to, REG_TRANSITIONS);
    const patch: Record<string, unknown> = {
      state: to,
      updated_at: new Date(),
      updated_by: actor,
    };
    if (to === "Deleted") patch.deleted_at = new Date();
    if (to === "Updating") patch.generation = r.generation + 1;
    await row.update(patch, { transaction: t });
    return asRegistration(row.get({ plain: true }) as Record<string, unknown>);
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
    return this.sequelize.transaction(async (t) => {
      const reg = await this.models.Registration.findByPk(registrationId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!reg || reg.get("deleted_at")) throw new Error("registration_not_found");
      const agent = await this.models.Agent.findByPk(agentId, { transaction: t });
      if (!agent || agent.get("tenant_id") !== reg.get("tenant_id")) {
        throw new Error("agent_not_found");
      }
      const r = asRegistration(reg.get({ plain: true }) as Record<string, unknown>);
      // New object required: Sequelize skips JSONB updates when the reference is unchanged.
      const nextObserved = {
        ...r.observed,
        [`agent:${agentId}`]: {
          observed_generation: observed.observed_generation,
          condition: observed.condition,
          reachable: observed.reachable,
          reported_at: new Date().toISOString(),
        },
      };
      await reg.update(
        {
          observed: nextObserved,
          updated_at: new Date(),
          updated_by: actor,
        },
        { transaction: t }
      );
      return asRegistration({
        ...(reg.get({ plain: true }) as Record<string, unknown>),
        observed: nextObserved,
      });
    });
  }

  async authzContext(query: {
    tenant_id: string;
    registration_id?: string;
    cert_fingerprint?: string;
    agent_id?: string;
  }): Promise<AuthzContext> {
    const tenantRow = await this.models.TenantConnect.findByPk(query.tenant_id);
    const t = tenantRow
      ? asTenant(tenantRow.get({ plain: true }) as Record<string, unknown>)
      : undefined;
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
      const a = await this.getAgent(query.agent_id);
      agent_id = a?.id;
      agent_state = a?.state;
      agent_approved = a?.state === "Connected" || a?.state === "Degraded";
    } else if (query.cert_fingerprint) {
      // Same shared where-clause as findAgentByCertFingerprint and
      // reportTunnel -- see matchAgentByFpWhere's doc comment. Matches
      // memory.ts's authzContext (excludeRetired: true) exactly.
      const a = await this.models.Agent.findOne({
        where: matchAgentByFpWhere(query.cert_fingerprint, {
          excludeRetired: true,
          tenantId: query.tenant_id,
        }),
      });
      if (a) {
        const agent = asAgent(a.get({ plain: true }) as Record<string, unknown>);
        agent_id = agent.id;
        agent_state = agent.state;
        agent_approved =
          agent.state === "Connected" || agent.state === "Degraded";
      }
    }

    let registration: AuthzContext["registration"] = null;
    const eligible_agents: Agent[] = [];
    if (query.registration_id) {
      // Try UUID first (canonical path).
      let regRow = await this.models.Registration.findByPk(
        query.registration_id
      );
      // Convention-driven fallback: resolve display_name slug within tenant
      // (same logic as memory.ts's authzContext — see that function's
      // comment for the full rationale about SaaS service discovery).
      if (!regRow) {
        const slug = slugifyDisplayName(query.registration_id);
        const candidates = await this.models.Registration.findAll({
          where: { tenant_id: query.tenant_id, deleted_at: null },
        });
        for (const c of candidates) {
          if (slugifyDisplayName(c.get("display_name") as string) === slug) {
            regRow = c;
            break;
          }
        }
      }
      if (regRow) {
        const r = asRegistration(
          regRow.get({ plain: true }) as Record<string, unknown>
        );
        if (r.tenant_id === query.tenant_id && !r.deleted_at) {
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
            const agents = await this.models.Agent.findAll({
              where: {
                tenant_id: query.tenant_id,
                state: { [Op.in]: ["Connected", "Degraded"] },
                deleted_at: null,
              },
            });
            const candidates = agents.map((row) =>
              asAgent(row.get({ plain: true }) as Record<string, unknown>)
            );
            const revokedSet = new Set(t?.revoked_cert_fingerprints ?? []);
            eligible_agents.push(
              ...filterEligibleAgents(candidates, r, revokedSet, PROBE_GRACE_MS)
            );
          }
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
    return this.sequelize.transaction(async (t) => {
      let row = input.agent_id
        ? await this.models.Agent.findByPk(input.agent_id, {
            transaction: t,
            lock: t.LOCK.UPDATE,
          })
        : null;
      if (!row && input.cert_fingerprint) {
        // Same shared where-clause as findAgentByCertFingerprint and
        // authzContext -- see matchAgentByFpWhere's doc comment.
        row = await this.models.Agent.findOne({
          where: matchAgentByFpWhere(input.cert_fingerprint, {
            excludeRetired: true,
            tenantId: input.tenant_id,
          }),
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
      }
      if (!row) throw new Error("agent_not_found");
      let agent = asAgent(row.get({ plain: true }) as Record<string, unknown>);
      if (agent.tenant_id !== input.tenant_id) {
        throw new Error("agent_tenant_mismatch");
      }

      const now = new Date();
      await row.update(
        {
          last_heartbeat_at: now,
          updated_at: now,
          updated_by: input.actor,
        },
        { transaction: t }
      );

      if (input.event === "heartbeat") {
        await row.update(
          { tunnel_state: agent.tunnel_state ?? "up" },
          { transaction: t }
        );
        if (agent.state === "Degraded") {
          return this.transitionAgentTx(agent.id, "Connected", input.actor, t);
        }
        return asAgent(row.get({ plain: true }) as Record<string, unknown>);
      }

      if (input.event === "up") {
        if (agent.state === "PendingApproval") {
          await row.update(
            { tunnel_state: "up_pending_approval" },
            { transaction: t }
          );
          return asAgent(row.get({ plain: true }) as Record<string, unknown>);
        }
        await row.update({ tunnel_state: "up" }, { transaction: t });
        if (agent.state === "Connecting") {
          return this.transitionAgentTx(agent.id, "Connected", input.actor, t);
        }
        if (agent.state === "Disconnected") {
          return this.transitionAgentTx(agent.id, "Connected", input.actor, t);
        }
        if (agent.state === "Degraded") {
          return this.transitionAgentTx(agent.id, "Connected", input.actor, t);
        }
        if (agent.state === "Connected") {
          return asAgent(row.get({ plain: true }) as Record<string, unknown>);
        }
        throw new Error(`agent_tunnel_up_invalid_state: ${agent.state}`);
      }

      await row.update({ tunnel_state: "down" }, { transaction: t });
      agent = asAgent(row.get({ plain: true }) as Record<string, unknown>);
      if (
        agent.state === "Connected" ||
        agent.state === "Degraded" ||
        agent.state === "Connecting"
      ) {
        return this.transitionAgentTx(agent.id, "Disconnected", input.actor, t);
      }
      if (
        agent.state === "PendingApproval" ||
        agent.state === "Disconnected"
      ) {
        return agent;
      }
      if (agent.state === "Retired") {
        // L2 §A.3: Retired is terminal. A security force-close of a
        // Retired agent's still-live tunnel (ReconcileSecurity) legitimately
        // fires a "down" event on its way out -- see memory.ts's matching
        // branch for the full rationale. Not an error.
        return agent;
      }
      throw new Error(`agent_tunnel_down_invalid_state: ${agent.state}`);
    });
  }
}
