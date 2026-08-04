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

describe("L3-CTL-01a scoped Agent API token", () => {
  const store = new MemoryStore();
  const writer = "writer-secret";
  const dual = "break-glass";
  let server: http.Server;
  let port: number;
  const tenant = "11111111-1111-1111-1111-111111111111";

  before(async () => {
    server = createServer(store, {
      authToken: writer,
      dualControlToken: dual,
    });
    port = await listen(server);
    await req(port, "POST", "/v1/tenants/ensure", {
      token: writer,
      body: { tenant_id: tenant },
    });
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("issues token; Agent can list regs; cannot suspend", async () => {
    const issued = await req(port, "POST", `/v1/tenants/${tenant}/agent-api-token`, {
      token: writer,
      body: {},
    });
    assert.equal(issued.status, 200);
    const agentTok = String(issued.json.agent_api_token || "");
    assert.ok(agentTok.length > 20);

    const list = await req(port, "GET", `/v1/tenants/${tenant}/registrations`, {
      token: agentTok,
    });
    assert.equal(list.status, 200);

    const suspend = await req(port, "POST", `/v1/tenants/${tenant}/suspend`, {
      token: agentTok,
      body: { suspended: true, cause: "security" },
      breakGlass: dual,
    });
    assert.equal(suspend.status, 403);
    assert.equal(suspend.json.error, "agent_token_insufficient");
  });

  it("revoke blocks further Agent API use", async () => {
    const issued = await req(port, "POST", `/v1/tenants/${tenant}/agent-api-token`, {
      token: writer,
      body: { ttl_minutes: 60 },
    });
    const agentTok = String(issued.json.agent_api_token || "");
    await req(port, "POST", `/v1/tenants/${tenant}/agent-api-token/revoke`, {
      token: writer,
      body: {},
    });
    const list = await req(port, "GET", `/v1/tenants/${tenant}/registrations`, {
      token: agentTok,
    });
    assert.equal(list.status, 401);
  });
});
