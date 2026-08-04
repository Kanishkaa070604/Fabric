import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadGatewayPushConfig, resolveTargets } from "../src/gatewayPush";

describe("loadGatewayPushConfig", () => {
  it("parses static urls and dns names as separate comma-separated lists", () => {
    const cfg = loadGatewayPushConfig({
      FABRIC_GATEWAY_PUSH_URLS: "http://10.0.0.1:8443, http://10.0.0.2:8443",
      FABRIC_GATEWAY_PUSH_DNS_NAMES: "gateway-headless.mesh.svc.cluster.local",
      FABRIC_GATEWAY_PUSH_DNS_PORT: "9443",
      FABRIC_GATEWAY_PUSH_DNS_SCHEME: "https",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(cfg.urls, [
      "http://10.0.0.1:8443",
      "http://10.0.0.2:8443",
    ]);
    assert.deepEqual(cfg.dnsNames, ["gateway-headless.mesh.svc.cluster.local"]);
    assert.equal(cfg.dnsPort, 9443);
    assert.equal(cfg.dnsScheme, "https");
  });

  it("defaults to no dns names, http scheme, and revoke port 9090 when unset", () => {
    const cfg = loadGatewayPushConfig({} as NodeJS.ProcessEnv);
    assert.deepEqual(cfg.urls, []);
    assert.deepEqual(cfg.dnsNames, []);
    assert.equal(cfg.dnsScheme, "http");
    assert.equal(cfg.dnsPort, 9090);
  });
});

describe("resolveTargets", () => {
  it("combines static urls with freshly resolved dns names, deduped", async () => {
    const cfg = loadGatewayPushConfig({
      FABRIC_GATEWAY_PUSH_URLS: "http://static.example:8443",
      FABRIC_GATEWAY_PUSH_DNS_NAMES: "localhost",
      FABRIC_GATEWAY_PUSH_DNS_PORT: "8443",
    } as NodeJS.ProcessEnv);
    const targets = await resolveTargets(cfg);
    // localhost resolves locally (no network needed) to a loopback address
    // that this test doesn't hardcode the exact form of (v4 vs v6), it just
    // asserts the static url survived and at least one dns-derived target
    // was added -- the actual "stays current across a rolling restart"
    // property this exists for can't be exercised without a real fleet.
    assert.ok(targets.includes("http://static.example:8443"));
    assert.ok(targets.some((t) => t.includes(":8443") && t !== "http://static.example:8443"));
  });

  it("a failing dns name is skipped, not thrown, and other targets are unaffected", async () => {
    const cfg = loadGatewayPushConfig({
      FABRIC_GATEWAY_PUSH_URLS: "http://static.example:8443",
      FABRIC_GATEWAY_PUSH_DNS_NAMES: "this-name-does-not-resolve.invalid",
    } as NodeJS.ProcessEnv);
    const targets = await resolveTargets(cfg);
    assert.deepEqual(targets, ["http://static.example:8443"]);
  });

  it("with neither urls nor dns names, resolves to no targets", async () => {
    const cfg = loadGatewayPushConfig({} as NodeJS.ProcessEnv);
    const targets = await resolveTargets(cfg);
    assert.deepEqual(targets, []);
  });
});
