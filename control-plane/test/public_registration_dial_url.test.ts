import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUuid,
  publicRegistration,
  type Registration,
} from "../src/store/types";

function baseReg(over: Partial<Registration>): Registration {
  return {
    id: "6cad18cb-de47-41dd-96cd-576abd3454c9",
    tenant_id: "5d5fcf62-9efa-48d1-9132-e3becf4436e5",
    display_name: "agent-launcher",
    destination_kind: "CUSTOMER_SERVICE",
    connectivity_type: "SERVICE",
    state: "Active",
    host: "agent-svc",
    port: 5004,
    generation: 1,
    observed: {},
    created_at: new Date(),
    created_by: "test",
    updated_at: new Date(),
    updated_by: "test",
    deleted_at: null,
    ...over,
  };
}

describe("publicRegistration platform dial URLs", () => {
  it("returns https://host:8444 for CUSTOMER_*", () => {
    const pub = publicRegistration(baseReg({}), "connect.abluva.com", 8444);
    assert.equal(
      pub.inbound_hostname,
      "6cad18cb-de47-41dd-96cd-576abd3454c9.5d5fcf62-9efa-48d1-9132-e3becf4436e5.connect.abluva.com"
    );
    assert.equal(
      pub.inbound_hostname_friendly,
      "agent-launcher.5d5fcf62-9efa-48d1-9132-e3becf4436e5.connect.abluva.com"
    );
    assert.equal(pub.inbound_listen_port, 8444);
    assert.equal(
      pub.platform_dial_url,
      "https://6cad18cb-de47-41dd-96cd-576abd3454c9.5d5fcf62-9efa-48d1-9132-e3becf4436e5.connect.abluva.com:8444"
    );
    assert.equal(
      pub.platform_dial_url_friendly,
      "https://agent-launcher.5d5fcf62-9efa-48d1-9132-e3becf4436e5.connect.abluva.com:8444"
    );
  });

  it("isUuid accepts registration ids and rejects slugs", () => {
    assert.equal(isUuid("6cad18cb-de47-41dd-96cd-576abd3454c9"), true);
    assert.equal(isUuid("agent-launcher"), false);
  });

  it("returns null dial URLs for PLATFORM_*", () => {
    const pub = publicRegistration(
      baseReg({ destination_kind: "PLATFORM_SERVICE", display_name: "discovery" }),
      "connect.abluva.com"
    );
    assert.equal(pub.inbound_hostname, null);
    assert.equal(pub.platform_dial_url, null);
    assert.equal(pub.platform_dial_url_friendly, null);
    assert.equal(pub.inbound_listen_port, null);
    assert.equal(pub.agent_listen_port, null);
  });

  it("exposes agent_listen_port from observed listen_port", () => {
    const pub = publicRegistration(
      baseReg({
        destination_kind: "PLATFORM_SERVICE",
        display_name: "control-server",
        observed: {
          "agent:aaaa": {
            condition: "Listener",
            reachable: "true",
            observed_generation: 1,
            listen_port: 9444,
            reported_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      "connect.abluva.com"
    );
    assert.equal(pub.agent_listen_port, 9444);
  });

  it("picks the latest agent_listen_port when multiple Agents report", () => {
    const pub = publicRegistration(
      baseReg({
        destination_kind: "PLATFORM_SERVICE",
        observed: {
          "agent:older": {
            condition: "Listener",
            reachable: "true",
            observed_generation: 1,
            listen_port: 9443,
            reported_at: "2026-01-01T00:00:00.000Z",
          },
          "agent:newer": {
            condition: "Listener",
            reachable: "true",
            observed_generation: 1,
            listen_port: 9445,
            reported_at: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
      "connect.abluva.com"
    );
    assert.equal(pub.agent_listen_port, 9445);
  });
});
