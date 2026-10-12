import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/http/server";
import { MemoryStore } from "../src/store/memory";

// An observation is recorded per Agent (`observed["agent:<id>"]`) and feeds the
// Gateway's choice of which Agent to dial for a CUSTOMER_* registration. So
// "who reported this" is an authorization decision, not metadata: if Agent A
// can file reachability under Agent B's key, A can steer traffic away from a
// healthy B or toward an unreachable one. A same-tenant check cannot catch
// that, because the sibling genuinely is in the tenant -- identity has to come
// from the credential.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

async function post(
  port: number,
  path: string,
  body: unknown,
  token?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-ABLV-Actor": "test",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

describe("observed reachability is attributed to the authenticated Agent", () => {
  const store = new MemoryStore();
  const writer = "writer-secret";
  let server: http.Server;
  let port = 0;
  const tenant = "44444444-4444-4444-4444-444444444444";
  const otherTenant = "55555555-5555-5555-5555-555555555555";
  let agentA = "";
  let agentB = "";
  let outsider = "";
  let registrationId = "";
  let tokenA = "";
  let tokenOutsider = "";

  async function enroll(t: string): Promise<string> {
    const boot = await store.issueBootstrapToken(t, "test");
    const a = await store.enrollAgent({
      tenant_id: t,
      bootstrap_token: boot,
      substrate: "kubernetes",
      actor: "test",
    });
    return a.id;
  }

  before(async () => {
    await store.ensureTenant(tenant, "test");
    await store.ensureTenant(otherTenant, "test");
    agentA = await enroll(tenant);
    agentB = await enroll(tenant);
    outsider = await enroll(otherTenant);
    tokenA = await store.issueAgentApiToken(agentA, "test");
    tokenOutsider = await store.issueAgentApiToken(outsider, "test");

    const reg = await store.createRegistration({
      tenant_id: tenant,
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      display_name: "probe-target",
      host: "db.internal",
      port: 5432,
      actor: "test",
    });
    registrationId = reg.id;

    server = createServer(store, { authToken: writer });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("attributes an Agent's report to itself", async () => {
    const res = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      { condition: "Probe", reachable: "true", observed_generation: 1 },
      tokenA
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const reg = await store.getRegistration(registrationId);
    assert.ok(reg?.observed[`agent:${agentA}`], "expected report under agent A");
  });

  it("ignores a body agent_id that names a sibling Agent", async () => {
    const before = await store.getRegistration(registrationId);
    assert.equal(
      before?.observed[`agent:${agentB}`],
      undefined,
      "precondition: no report for B yet"
    );

    const res = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      {
        agent_id: agentB, // the spoof attempt
        condition: "Probe",
        reachable: "false",
        observed_generation: 1,
      },
      tokenA
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const reg = await store.getRegistration(registrationId);
    // The claim must land under A (who actually called), never under B.
    assert.equal(
      reg?.observed[`agent:${agentB}`],
      undefined,
      "sibling key must not be written by another Agent"
    );
    assert.equal(reg?.observed[`agent:${agentA}`]?.reachable, "false");
  });

  it("rejects an Agent reporting on another tenant's registration", async () => {
    const res = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      { condition: "Probe", reachable: "true", observed_generation: 1 },
      tokenOutsider
    );
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.error, "tenant_mismatch");
  });

  it("writer tooling must name the Agent it reports for", async () => {
    // Writer has no Agent identity of its own, so there is nothing to derive.
    const missing = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      { condition: "Probe", reachable: "true", observed_generation: 1 },
      writer
    );
    assert.equal(missing.status, 400, JSON.stringify(missing.json));
    assert.equal(missing.json.error, "agent_id_required_for_writer");

    const ok = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      {
        agent_id: agentB,
        condition: "Probe",
        reachable: "true",
        observed_generation: 1,
      },
      writer
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const reg = await store.getRegistration(registrationId);
    assert.equal(reg?.observed[`agent:${agentB}`]?.reachable, "true");
  });

  it("stores listen_port and preserves it across Probe without listen_port", async () => {
    const withPort = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      {
        condition: "Listener",
        reachable: "true",
        observed_generation: 1,
        listen_port: 9444,
      },
      tokenA
    );
    assert.equal(withPort.status, 200, JSON.stringify(withPort.json));
    assert.equal(withPort.json.agent_listen_port, 9444);

    const probeOnly = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      { condition: "Probe", reachable: "true", observed_generation: 1 },
      tokenA
    );
    assert.equal(probeOnly.status, 200, JSON.stringify(probeOnly.json));
    assert.equal(probeOnly.json.agent_listen_port, 9444);

    const reg = await store.getRegistration(registrationId);
    assert.equal(reg?.observed[`agent:${agentA}`]?.listen_port, 9444);
  });

  it("rejects out-of-range listen_port", async () => {
    const res = await post(
      port,
      `/v1/registrations/${registrationId}/observed`,
      {
        condition: "Listener",
        reachable: "true",
        observed_generation: 1,
        listen_port: 70000,
      },
      tokenA
    );
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.error, "invalid_listen_port");
  });
});
