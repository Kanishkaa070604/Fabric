import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createServer } from "../src/http/server";
import { MemoryStore } from "../src/store/memory";

// The Gateway used to authenticate to the control plane with the writer bearer,
// which gave every Gateway replica unscoped authority over every tenant. It
// needs exactly three endpoints. These tests pin both halves of that: the three
// it must reach, and the fact that it cannot reach anything else -- so a future
// route added to the Gateway's HTTP store fails loudly here rather than
// quietly widening the data plane's authority.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

describe("Gateway service principal is scoped to the endpoints it calls", () => {
  const store = new MemoryStore();
  const writer = "writer-secret";
  const gatewayToken = "gateway-secret";
  let server: http.Server;
  let port = 0;
  const tenant = "66666666-6666-6666-6666-666666666666";
  let agentId = "";
  const certFp = "gwtest-fp-0001";

  async function call(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown }
  ) {
    const headers: Record<string, string> = { "X-ABLV-Actor": "test" };
    if (opts?.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  before(async () => {
    await store.ensureTenant(tenant, "test");
    const boot = await store.issueBootstrapToken(tenant, "test");
    const agent = await store.enrollAgent({
      tenant_id: tenant,
      bootstrap_token: boot,
      substrate: "kubernetes",
      cert_fingerprint_sha256: certFp,
      actor: "test",
    });
    agentId = agent.id;
    server = createServer(store, { authToken: writer, gatewayToken });
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe("the three endpoints the Gateway actually calls", () => {
    it("GET /v1/internal/authz-context", async () => {
      const res = await call(
        "GET",
        `/v1/internal/authz-context?tenant_id=${tenant}&cert_fingerprint=${certFp}`,
        { token: gatewayToken }
      );
      assert.equal(res.status, 200, JSON.stringify(res.json));
    });

    it("GET /v1/internal/agent-by-cert", async () => {
      const res = await call(
        "GET",
        `/v1/internal/agent-by-cert?cert_fingerprint=${certFp}`,
        { token: gatewayToken }
      );
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.agent_id, agentId);
    });

    it("POST /v1/agents/tunnel-event", async () => {
      const res = await call("POST", "/v1/agents/tunnel-event", {
        token: gatewayToken,
        body: { tenant_id: tenant, cert_fingerprint: certFp, event: "up" },
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
    });
  });

  describe("everything else is refused", () => {
    const forbidden: Array<[string, string, unknown?]> = [
      ["POST", `/v1/tenants/${tenant}/suspend`, { suspended: true, cause: "security" }],
      ["POST", `/v1/tenants/${tenant}/bootstrap-token`, {}],
      ["POST", `/v1/tenants/${tenant}/agent-api-token/revoke`, {}],
      ["POST", `/v1/tenants/${tenant}/quotas`, { max_tunnels: 1 }],
      ["GET", `/v1/tenants/${tenant}`],
      ["GET", `/v1/tenants/${tenant}/registrations`],
      ["POST", "/v1/tenants/ensure", { tenant_id: tenant }],
    ];

    for (const [method, path, body] of forbidden) {
      it(`${method} ${path}`, async () => {
        const res = await call(method, path, { token: gatewayToken, body });
        assert.equal(
          res.status,
          403,
          `expected 403 for ${method} ${path}, got ${res.status} ${JSON.stringify(res.json)}`
        );
        assert.equal(res.json.error, "gateway_token_insufficient");
      });
    }

    it("cannot approve an Agent", async () => {
      const res = await call("POST", `/v1/agents/${agentId}/approve`, {
        token: gatewayToken,
        body: {},
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.error, "gateway_token_insufficient");
    });

    it("cannot revoke an Agent's API credential", async () => {
      const res = await call("POST", `/v1/agents/${agentId}/api-token/revoke`, {
        token: gatewayToken,
        body: {},
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.error, "gateway_token_insufficient");
    });
  });

  it("writer keeps full access to the internal endpoints", async () => {
    const res = await call(
      "GET",
      `/v1/internal/agent-by-cert?cert_fingerprint=${certFp}`,
      { token: writer }
    );
    assert.equal(res.status, 200);
  });

  it("with no gatewayToken configured, the Gateway bearer is just an unknown bearer", async () => {
    // This is the pre-fix production shape: Gateway had no credential the CP
    // recognised, so every call 401'd. Asserted so the failure mode is
    // documented rather than rediscovered.
    const bare = createServer(store, { authToken: writer });
    const p = await listen(bare);
    try {
      const res = await fetch(
        `http://127.0.0.1:${p}/v1/internal/agent-by-cert?cert_fingerprint=${certFp}`,
        { headers: { Authorization: `Bearer ${gatewayToken}` } }
      );
      assert.equal(res.status, 401);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });
});
