import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

describe("MemoryStore agent lifecycle", () => {
  it("enroll → PendingApproval → approve → Connecting → tunnel up → Connected", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, false, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "abc",
      actor: "agent",
    });
    assert.equal(agent.state, "PendingApproval");

    const approved = await s.approveAgent(agent.id, "tenant-admin");
    assert.equal(approved.state, "Connecting");
    assert.equal(approved.enrollment_approved_by, "tenant-admin");

    const up = await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    assert.equal(up.state, "Connected");
    assert.equal(up.tunnel_state, "up");
  });

  it("L2 §A.3: findAgentByCertFingerprint excludes a Retired agent, but the *Any variant still finds it", async () => {
    // Regression: Gateway's ReconcileSecurity needs to find a Retired agent BY
    // its cert fingerprint to force-close its still-live tunnel. The plain
    // lookup intentionally excludes Retired/deleted agents (so a *new* tunnel
    // dial from a retired cert doesn't rebind at accept time) -- using that
    // same lookup for the force-close check silently made it dead code, since
    // a Retired agent could never be resolved by it in the first place.
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, false, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "fp-retire-me",
      actor: "agent",
    });
    await s.approveAgent(agent.id, "tenant-admin");

    const before = await s.findAgentByCertFingerprint("fp-retire-me");
    assert.equal(before?.id, agent.id, "sanity: findable before retire");

    await s.retireAgent(agent.id, "tenant-admin");

    const afterPlain = await s.findAgentByCertFingerprint("fp-retire-me");
    assert.equal(afterPlain, undefined, "plain lookup must exclude Retired agents");

    const afterAny = await s.findAgentByCertFingerprintAny("fp-retire-me");
    assert.equal(afterAny?.id, agent.id, "*Any lookup must still find the Retired agent");
    assert.equal(afterAny?.state, "Retired");
  });

  it("G-BOOT-1: tunnel up while PendingApproval does not grant data plane", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, false, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "def",
      actor: "agent",
    });
    const up = await s.reportTunnel({
      tenant_id: TENANT,
      cert_fingerprint: "def",
      event: "up",
      actor: "gateway",
    });
    assert.equal(up.state, "PendingApproval");
    assert.equal(up.tunnel_state, "up_pending_approval");

    const ctx = await s.authzContext({
      tenant_id: TENANT,
      cert_fingerprint: "def",
    });
    assert.equal(ctx.agent_approved, false);
    assert.equal(ctx.agent_state, "PendingApproval");

    const approved = await s.approveAgent(agent.id, "tenant-admin");
    assert.equal(approved.state, "Connected");
  });

  it("auto_approve (default) lands in Connecting until tunnel up", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    // Default auto_approve_agents=true — no setAutoApprove needed.
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "ghi",
      actor: "agent",
    });
    assert.equal(agent.state, "Connecting");
    assert.equal(agent.enrollment_approved_by, "auto_approve_agents");
    const up = await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    assert.equal(up.state, "Connected");
  });

  it("tunnel down / reconnect goes directly Disconnected → Connected (no Reconnecting intermediate)", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, true, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "jkl",
      actor: "agent",
    });
    await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    const down = await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "down",
      actor: "gateway",
    });
    assert.equal(down.state, "Disconnected");
    const up = await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    assert.equal(up.state, "Connected");
  });

  it("L2 §A.3: reportTunnel 'down' on a Retired agent is a no-op, not an error", async () => {
    // Regression: Gateway's ReconcileSecurity force-closes a Retired
    // agent's still-live tunnel, which fires a "down" tunnel-event on its
    // way out (ServeConn's deferred cleanup). That must not throw --
    // the tunnel is already correctly torn down, there's nothing invalid
    // about it, and throwing here only produced noisy tunnel_event_failed
    // retries in the Gateway for a tunnel that was never actually stuck.
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, false, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "retired-down-test",
      actor: "agent",
    });
    await s.approveAgent(agent.id, "tenant-admin");
    await s.retireAgent(agent.id, "tenant-admin");

    const result = await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "down",
      actor: "gateway",
    });
    assert.equal(result.state, "Retired");
  });

  it("rejects illegal agent transitions", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, false, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      actor: "agent",
    });
    await assert.rejects(
      () => s.transitionAgent(agent.id, "Connected", "x"),
      /illegal_transition/
    );
  });

  it("excludes unreachable agents from eligible list", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, true, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "mno",
      actor: "agent",
    });
    await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "cust-svc",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "10.0.0.5",
      port: 8080,
      actor: "test",
    });
    assert.equal(reg.state, "Active");
    await s.reportObserved(
      reg.id,
      agent.id,
      { condition: "Probe", reachable: "false", observed_generation: 1 },
      "agent"
    );
    const ctx = await s.authzContext({
      tenant_id: TENANT,
      registration_id: reg.id,
    });
    assert.equal(ctx.eligible_agents.length, 0);
  });

  it("excludes revoked-cert agents from eligible list", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, true, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "revoked-fp",
      actor: "agent",
    });
    await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "cust-rev",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "10.0.0.5",
      port: 8080,
      actor: "test",
    });
    await s.revokeCertFingerprint(TENANT, "revoked-fp", "test");
    const ctx = await s.authzContext({
      tenant_id: TENANT,
      registration_id: reg.id,
    });
    assert.equal(ctx.eligible_agents.length, 0);
  });

  it("L2 §G.1 probe-grace: a brand-new registration with no probe yet is still eligible (unknown)", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, true, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "noprobe",
      actor: "agent",
    });
    await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "cust-noprobe",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "10.0.0.5",
      port: 8080,
      actor: "test",
    });
    // Freshly Active, no observed report has landed yet -- must not be
    // permanently excluded (that would fail every new registration's first
    // StreamOpen(s) by construction, before the Agent's watch loop ever gets
    // a chance to probe it).
    const ctx = await s.authzContext({
      tenant_id: TENANT,
      registration_id: reg.id,
    });
    assert.equal(ctx.eligible_agents.length, 1);
    assert.equal(ctx.eligible_agents[0].ID, agent.id);
  });

  it("excludes an agent with no matching-generation probe once the probe-grace window elapses", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, true, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "noprobe-stale",
      actor: "agent",
    });
    await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "cust-noprobe-stale",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "10.0.0.5",
      port: 8080,
      actor: "test",
    });
    // Simulate the grace window having elapsed with still no probe landed
    // (an agent that never probes at all must not be eligible forever).
    s.registrations.get(reg.id)!.updated_at = new Date(Date.now() - 60_000);
    const ctx = await s.authzContext({
      tenant_id: TENANT,
      registration_id: reg.id,
    });
    assert.equal(ctx.eligible_agents.length, 0);
  });

  it("prefers reachable=true agent when multiple Connected", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, true, "test");
    const tok1 = await s.issueBootstrapToken(TENANT, "test");
    const a1 = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok1,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "fp-a1",
      actor: "agent",
    });
    const tok2 = await s.issueBootstrapToken(TENANT, "test");
    const a2 = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok2,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "fp-a2",
      actor: "agent",
    });
    for (const id of [a1.id, a2.id]) {
      await s.reportTunnel({
        tenant_id: TENANT,
        agent_id: id,
        event: "up",
        actor: "gateway",
      });
    }
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "cust-multi",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "10.0.0.5",
      port: 8080,
      actor: "test",
    });
    await s.reportObserved(
      reg.id,
      a1.id,
      { condition: "Probe", reachable: "false", observed_generation: 1 },
      "agent"
    );
    await s.reportObserved(
      reg.id,
      a2.id,
      { condition: "Probe", reachable: "true", observed_generation: 1 },
      "agent"
    );
    const ctx = await s.authzContext({
      tenant_id: TENANT,
      registration_id: reg.id,
    });
    assert.equal(ctx.eligible_agents.length, 1);
    assert.equal(ctx.eligible_agents[0].ID, a2.id);
  });

  it("degrades Connected agents with stale heartbeats and recovers on heartbeat", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await s.setAutoApprove(TENANT, true, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "hb-fp",
      actor: "agent",
    });
    await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "up",
      actor: "gateway",
    });
    assert.equal((await s.getAgent(agent.id))!.state, "Connected");
    const a = (await s.getAgent(agent.id))!;
    a.last_heartbeat_at = new Date(Date.now() - 120_000);
    const n = await s.degradeStaleAgents(60_000);
    assert.equal(n, 1);
    assert.equal((await s.getAgent(agent.id))!.state, "Degraded");
    await s.reportTunnel({
      tenant_id: TENANT,
      agent_id: agent.id,
      event: "heartbeat",
      actor: "gateway",
    });
    assert.equal((await s.getAgent(agent.id))!.state, "Connected");
  });

  it("setQuotas updates tenant limits", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    const t = await s.setQuotas(
      TENANT,
      { max_tunnels: 2, max_concurrent_streams: 3, max_stream_open_per_sec: 4 },
      "test"
    );
    assert.equal(t.max_tunnels, 2);
    assert.equal(t.max_concurrent_streams, 3);
    assert.equal(t.max_stream_open_per_sec, 4);
    const ctx = await s.authzContext({ tenant_id: TENANT });
    assert.equal(ctx.quotas.max_tunnels, 2);
  });

  it("requires host/port for platform destinations", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    await assert.rejects(
      () =>
        s.createRegistration({
          tenant_id: TENANT,
          display_name: "plat",
          connectivity_type: "SERVICE",
          destination_kind: "PLATFORM_SERVICE",
          actor: "test",
        }),
      /host_port_required/
    );
  });

  it("bootstrap token is multi-redeem until expiry (L3-AGT-02)", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    const tok = await s.issueBootstrapToken(TENANT, "test");
    const a1 = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "fp-instance-1",
      actor: "agent",
    });
    const a2 = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      cert_fingerprint_sha256: "fp-instance-2",
      actor: "agent",
    });
    assert.notEqual(a1.id, a2.id);
    const t = await s.getTenant(TENANT);
    assert.ok(t?.bootstrap_token_hash, "hash must remain until expiry/revoke");
  });

  it("lists agents/registrations and deletes registration", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    await s.setAutoApprove(TENANT, false, "ops");
    const tok = await s.issueBootstrapToken(TENANT, "ops");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok,
      substrate: "kubernetes",
      actor: "agent",
    });
    const listed = await s.listAgents(TENANT, { state: "PendingApproval" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, agent.id);
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "plat-echo",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    assert.equal((await s.listRegistrations(TENANT)).length, 1);
    assert.equal((await s.getRegistration(reg.id))?.state, "Active");
    const deleted = await s.deleteRegistration(reg.id, "ops");
    assert.equal(deleted.state, "Deleted");
    assert.equal(await s.getRegistration(reg.id), undefined);
    assert.equal((await s.listRegistrations(TENANT)).length, 0);
  });

  it("updates a registration's destination and name in place (L2 §A.2/§G.5/§F.3)", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "plat-echo",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    assert.equal(reg.generation, 1);

    const updated = await s.updateRegistration(
      reg.id,
      { display_name: "plat-echo-v2", host: "127.0.0.2", port: 10 },
      "ops"
    );
    assert.equal(updated.state, "Active");
    assert.equal(updated.display_name, "plat-echo-v2");
    assert.equal(updated.host, "127.0.0.2");
    assert.equal(updated.port, 10);
    // §D.5: an applied change bumps generation like any other desired-state change.
    assert.equal(updated.generation, 2);
  });

  it("rejects updating a registration to a missing host/port and leaves it Active with the prior config (§G.5)", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "plat-echo",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    await assert.rejects(
      () => s.updateRegistration(reg.id, { host: "" }, "ops"),
      /host_port_required_for_destination/
    );
    const after = await s.getRegistration(reg.id);
    assert.equal(after?.state, "Active");
    assert.equal(after?.host, "127.0.0.1");
    assert.equal(after?.port, 9);
    // Rejected before ever entering Updating, so generation is untouched.
    assert.equal(after?.generation, 1);
  });

  it("rejects updating a registration that isn't Active", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "plat-echo",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    await s.deleteRegistration(reg.id, "ops");
    await assert.rejects(
      () => s.updateRegistration(reg.id, { host: "10.0.0.1" }, "ops"),
      /registration_not_found/
    );
  });

  it("retries a Failed registration back to Active without delete+recreate (L3-REG-01)", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "plat-echo",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    // Reach Failed via the legal Updating → Failed edge (create/update do
    // not invent new failure modes; this is the state-machine path retry
    // must accept). transitionRegistration is the store's own transition
    // helper — same machinery delete/create use.
    await s.transitionRegistration(reg.id, "Updating", "ops");
    await s.transitionRegistration(reg.id, "Failed", "ops");
    assert.equal((await s.getRegistration(reg.id))?.state, "Failed");
    const genBefore = (await s.getRegistration(reg.id))!.generation;

    const retried = await s.retryRegistration(reg.id, "ops");
    assert.equal(retried.state, "Active");
    assert.equal(retried.host, "127.0.0.1");
    assert.equal(retried.port, 9);
    assert.ok(retried.generation > genBefore, "retry bumps generation (§D.5)");
  });

  it("rejects retry unless the registration is Failed", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "plat-echo",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    await assert.rejects(
      () => s.retryRegistration(reg.id, "ops"),
      /registration_not_retryable/
    );
  });

  it("rejects retry when the tenant is suspended", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const reg = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "plat-echo",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    await s.transitionRegistration(reg.id, "Updating", "ops");
    await s.transitionRegistration(reg.id, "Failed", "ops");
    await s.setSuspended(TENANT, true, "ops", "security");
    await assert.rejects(
      () => s.retryRegistration(reg.id, "ops"),
      /tenant_suspended/
    );
  });

  it("rejects renaming a registration to a name already used by another (§F.3)", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    await s.createRegistration({
      tenant_id: TENANT,
      display_name: "taken-name",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 9,
      actor: "ops",
    });
    const reg2 = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "other-name",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "127.0.0.1",
      port: 10,
      actor: "ops",
    });
    await assert.rejects(
      () => s.updateRegistration(reg2.id, { display_name: "taken-name" }, "ops"),
      /registration_display_name_conflict/
    );
  });

  it("revokes bootstrap token before enroll", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const tok = await s.issueBootstrapToken(TENANT, "ops");
    const t = await s.revokeBootstrapToken(TENANT, "ops");
    assert.equal(t.bootstrap_token_hash, null);
    await assert.rejects(
      () =>
        s.enrollAgent({
          tenant_id: TENANT,
          bootstrap_token: tok,
          substrate: "kubernetes",
          actor: "agent",
        }),
      /bootstrap_token_invalid/
    );
  });

  it("L2 §G.3: suspend cause defaults to security (fail safe) and clears on lift", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    const t1 = await s.setSuspended(TENANT, true, "ops");
    assert.equal(t1.suspended, true);
    assert.equal(t1.suspended_cause, "security");

    const t2 = await s.setSuspended(TENANT, true, "ops", "billing");
    assert.equal(t2.suspended_cause, "billing");

    const t3 = await s.setSuspended(TENANT, false, "ops");
    assert.equal(t3.suspended, false);
    assert.equal(t3.suspended_cause, null);
  });

  it("L2 §D.3: revoke cause defaults to security and is tracked per fingerprint", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    await s.revokeCertFingerprint(TENANT, "fp-security", "ops");
    await s.revokeCertFingerprint(TENANT, "fp-decommission", "ops", "decommission");

    const secCtx = await s.authzContext({
      tenant_id: TENANT,
      cert_fingerprint: "fp-security",
    });
    assert.equal(secCtx.cert_revoked, true);
    assert.equal(secCtx.cert_revoke_cause, "security");

    const decomCtx = await s.authzContext({
      tenant_id: TENANT,
      cert_fingerprint: "fp-decommission",
    });
    assert.equal(decomCtx.cert_revoked, true);
    assert.equal(decomCtx.cert_revoke_cause, "decommission");
  });

  it("Spec §10.1: strict substrate binding rejects enrollment from a mismatched substrate", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "ops");
    await s.setSubstrateBinding(
      TENANT,
      { enabled: true, expected_substrate_fingerprint: "cluster-uid-123" },
      "ops"
    );

    const tok1 = await s.issueBootstrapToken(TENANT, "ops");
    await assert.rejects(
      () =>
        s.enrollAgent({
          tenant_id: TENANT,
          bootstrap_token: tok1,
          substrate: "kubernetes",
          substrate_fingerprint: "cluster-uid-WRONG",
          actor: "agent",
        }),
      /substrate_binding_mismatch/
    );

    const tok2 = await s.issueBootstrapToken(TENANT, "ops");
    const agent = await s.enrollAgent({
      tenant_id: TENANT,
      bootstrap_token: tok2,
      substrate: "kubernetes",
      substrate_fingerprint: "cluster-uid-123",
      actor: "agent",
    });
    assert.equal(agent.substrate_fingerprint, "cluster-uid-123");
  });
});
