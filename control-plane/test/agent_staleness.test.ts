import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAgentStale } from "../src/store/types";

// Locks down the exact boundary semantics that memory.ts's degradeStaleAgents
// and sequelize.ts's degradeStaleAgents SQL WHERE clause must both match --
// see isAgentStale's doc comment in src/store/types.ts for why this can't be
// enforced by shared code alone (SQL can't call the JS function) and must be
// enforced by keeping this test's expectations true of both call sites.
describe("isAgentStale boundary semantics", () => {
  const cutoff = new Date("2026-01-01T00:00:00.000Z");

  it("is stale at exactly the cutoff instant, not just strictly before it", () => {
    const agent = {
      state: "Connected",
      deleted_at: null,
      last_heartbeat_at: new Date(cutoff.getTime()),
      updated_at: new Date(cutoff.getTime()),
    };
    assert.equal(isAgentStale(agent, cutoff), true);
  });

  it("is not stale one millisecond after the cutoff", () => {
    const agent = {
      state: "Connected",
      deleted_at: null,
      last_heartbeat_at: new Date(cutoff.getTime() + 1),
      updated_at: new Date(cutoff.getTime() + 1),
    };
    assert.equal(isAgentStale(agent, cutoff), false);
  });

  it("is stale one millisecond before the cutoff", () => {
    const agent = {
      state: "Connected",
      deleted_at: null,
      last_heartbeat_at: new Date(cutoff.getTime() - 1),
      updated_at: new Date(cutoff.getTime() - 1),
    };
    assert.equal(isAgentStale(agent, cutoff), true);
  });

  it("falls back to updated_at when last_heartbeat_at is null", () => {
    const stale = {
      state: "Connected",
      deleted_at: null,
      last_heartbeat_at: null,
      updated_at: new Date(cutoff.getTime() - 1),
    };
    const fresh = {
      state: "Connected",
      deleted_at: null,
      last_heartbeat_at: null,
      updated_at: new Date(cutoff.getTime() + 1),
    };
    assert.equal(isAgentStale(stale, cutoff), true);
    assert.equal(isAgentStale(fresh, cutoff), false);
  });

  it("never flags a non-Connected agent, however old its heartbeat", () => {
    for (const state of ["PendingApproval", "Degraded", "Disconnected", "Retired"]) {
      const agent = {
        state,
        deleted_at: null,
        last_heartbeat_at: new Date(0),
        updated_at: new Date(0),
      };
      assert.equal(isAgentStale(agent, cutoff), false, `state=${state}`);
    }
  });

  it("never flags a deleted agent, however old its heartbeat", () => {
    const agent = {
      state: "Connected",
      deleted_at: new Date(0),
      last_heartbeat_at: new Date(0),
      updated_at: new Date(0),
    };
    assert.equal(isAgentStale(agent, cutoff), false);
  });
});
