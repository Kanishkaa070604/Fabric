import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/http/server";
import { MemoryStore } from "../src/store/memory";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown; breakGlass?: string }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = opts?.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = {
    "X-ABLV-Actor": "test",
  };
  if (body) headers["Content-Type"] = "application/json";
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts?.breakGlass) headers["X-ABLV-Break-Glass"] = opts.breakGlass;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body,
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

// L3-CTL-01a: the Agent API bearer is per-Agent. The properties that matter
// are that the server can name the calling Agent (not just its tenant), and
// that one Agent's credential lifecycle is independent of its siblings'.
describe("L3-CTL-01a per-Agent API credential", () => {
  const store = new MemoryStore();
  const writer = "writer-secret";
  const dual = "break-glass";
  let server: http.Server;
  let port: number;
  const tenantA = "11111111-1111-1111-1111-111111111111";
  const tenantB = "22222222-2222-2222-2222-222222222222";
  let agentA1 = "";
  let agentA2 = "";
  let agentB1 = "";

  async function enroll(tenant: string): Promise<string> {
    const boot = await store.issueBootstrapToken(tenant, "test");
    const agent = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      actor: "test",
    });
    return agent.id;
  }

  before(async () => {
    server = createServer(store, {
      authToken: writer,
      dualControlToken: dual,
    });
    port = await listen(server);
    await store.ensureTenant(tenantA, "test");
    await store.ensureTenant(tenantB, "test");
    agentA1 = await enroll(tenantA);
    agentA2 = await enroll(tenantA);
    agentB1 = await enroll(tenantB);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("resolves a bearer to the exact Agent and its tenant", async () => {
    const tok = await store.issueAgentApiToken(agentA1, "test");
    const principal = await store.resolveAgentApiToken(tok);
    assert.deepEqual(principal, {
      agentId: agentA1,
      tenantId: tenantA,
      slot: "current",
    });
  });

  it("issues distinct credentials per Agent in the same tenant", async () => {
    const t1 = await store.issueAgentApiToken(agentA1, "test");
    const t2 = await store.issueAgentApiToken(agentA2, "test");
    assert.notEqual(t1, t2);
    assert.equal((await store.resolveAgentApiToken(t1))?.agentId, agentA1);
    assert.equal((await store.resolveAgentApiToken(t2))?.agentId, agentA2);
  });

  it("refusing to mint for a nonexistent Agent (tenant cannot be chosen by caller)", async () => {
    await assert.rejects(
      () => store.issueAgentApiToken("00000000-0000-0000-0000-000000000000", "test"),
      /agent_not_found/
    );
  });

  it("Agent bearer can list its tenant's registrations but cannot suspend", async () => {
    const tok = await store.issueAgentApiToken(agentA1, "test");
    const list = await req(port, "GET", `/v1/tenants/${tenantA}/registrations`, {
      token: tok,
    });
    assert.equal(list.status, 200);

    const suspend = await req(port, "POST", `/v1/tenants/${tenantA}/suspend`, {
      token: tok,
      body: { suspended: true, cause: "security" },
      breakGlass: dual,
    });
    assert.equal(suspend.status, 403);
    assert.equal(suspend.json.error, "agent_token_insufficient");
  });

  it("Agent bearer cannot read another tenant's registrations", async () => {
    const tok = await store.issueAgentApiToken(agentB1, "test");
    const list = await req(port, "GET", `/v1/tenants/${tenantA}/registrations`, {
      token: tok,
    });
    assert.equal(list.status, 403);
    assert.equal(list.json.error, "tenant_mismatch");
  });

  it("revoking one Agent leaves its sibling working", async () => {
    const tokA1 = await store.issueAgentApiToken(agentA1, "test");
    const tokA2 = await store.issueAgentApiToken(agentA2, "test");

    const revoked = await req(
      port,
      "POST",
      `/v1/agents/${agentA1}/api-token/revoke`,
      { token: writer, body: {} }
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));

    // This is the capability a tenant-wide bearer could not express.
    const deniedA1 = await req(
      port,
      "GET",
      `/v1/tenants/${tenantA}/registrations`,
      { token: tokA1 }
    );
    assert.equal(deniedA1.status, 401);

    const okA2 = await req(port, "GET", `/v1/tenants/${tenantA}/registrations`, {
      token: tokA2,
    });
    assert.equal(okA2.status, 200);
  });

  it("per-Agent revoke requires writer", async () => {
    const tok = await store.issueAgentApiToken(agentA2, "test");
    const res = await req(
      port,
      "POST",
      `/v1/agents/${agentA2}/api-token/revoke`,
      { token: tok, body: {} }
    );
    // An Agent bearer is not permitted on this route at all.
    assert.equal(res.status, 403);
  });

  it("tenant-wide revoke clears every Agent in that tenant only", async () => {
    const tokA1 = await store.issueAgentApiToken(agentA1, "test");
    const tokA2 = await store.issueAgentApiToken(agentA2, "test");
    const tokB1 = await store.issueAgentApiToken(agentB1, "test");

    const res = await req(
      port,
      "POST",
      `/v1/tenants/${tenantA}/agent-api-token/revoke`,
      { token: writer, body: {} }
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.agents_cleared, 2);

    for (const tok of [tokA1, tokA2]) {
      const denied = await req(
        port,
        "GET",
        `/v1/tenants/${tenantA}/registrations`,
        { token: tok }
      );
      assert.equal(denied.status, 401);
    }
    const stillOk = await req(
      port,
      "GET",
      `/v1/tenants/${tenantB}/registrations`,
      { token: tokB1 }
    );
    assert.equal(stillOk.status, 200);
  });

  it("prior slot stays valid through the overlap and reports which slot matched", async () => {
    const first = await store.issueAgentApiToken(agentB1, "test", undefined, {
      overlap_seconds: 60,
    });
    const second = await store.issueAgentApiToken(agentB1, "test", undefined, {
      overlap_seconds: 60,
    });
    assert.notEqual(first, second);
    assert.equal((await store.resolveAgentApiToken(second))?.slot, "current");
    // The old bearer keeps working during the overlap, so a refresh is not a
    // cliff for a request already in flight -- but it is reported as `prior`
    // so an Agent stuck on it is visible.
    assert.equal((await store.resolveAgentApiToken(first))?.slot, "prior");
  });

  it("issuing with no overlap invalidates the previous credential immediately", async () => {
    const first = await store.issueAgentApiToken(agentB1, "test");
    const second = await store.issueAgentApiToken(agentB1, "test");
    assert.equal(await store.resolveAgentApiToken(first), undefined);
    assert.equal((await store.resolveAgentApiToken(second))?.agentId, agentB1);
  });

  it("an expired credential does not resolve", async () => {
    // Fractional minutes so the TTL lapses within the test. Note ttlMinutes<=0
    // means "no expiry until revoke", not "already expired".
    const tok = await store.issueAgentApiToken(agentB1, "test", 0.0001);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(await store.resolveAgentApiToken(tok), undefined);
  });

  it("ttlMinutes<=0 means no expiry until revoked", async () => {
    const tok = await store.issueAgentApiToken(agentB1, "test", 0);
    const principal = await store.resolveAgentApiToken(tok);
    assert.equal(principal?.agentId, agentB1);
    await store.revokeAgentApiTokens(agentB1, "test");
    assert.equal(await store.resolveAgentApiToken(tok), undefined);
  });
});
