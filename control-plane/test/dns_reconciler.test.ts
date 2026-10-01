import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryStore } from "../src/store/memory";
import {
  computeDesiredRecords,
  resolveLeaderElection,
  startDnsReconciler,
} from "../src/dns/reconciler";
import { createTestLeaseLock } from "../src/dns/leaseLock";
import { WebhookDnsProvider } from "../src/dns/webhookProvider";
import { FileDnsProvider } from "../src/dns/fileProvider";

const TENANT = "00000000-0000-0000-0000-0000000000bb";

describe("G-A3-1 DNS reconciler", () => {
  it("computes one inbound record per Active CUSTOMER_* registration, none for PLATFORM_* or non-Active", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");

    const svc = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "customer-svc",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "svc.customer.internal",
      port: 443,
      actor: "test",
    });
    const res = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "customer-res",
      connectivity_type: "RESOURCE",
      destination_kind: "CUSTOMER_RESOURCE",
      host: "db.customer.internal",
      port: 5432,
      actor: "test",
    });
    // Not an inbound destination: Platform originates the dial directly (A1/B1), no G-A3-1 record.
    await s.createRegistration({
      tenant_id: TENANT,
      display_name: "platform-svc",
      connectivity_type: "SERVICE",
      destination_kind: "PLATFORM_SERVICE",
      host: "svc.platform.internal",
      port: 443,
      actor: "test",
    });

    const desired = await computeDesiredRecords(s, {
      domainSuffix: "connect.fabric",
      target: "gw-inbound.example.internal",
    });

    const names = desired.map((r) => r.name).sort();
    // Each Active CUSTOMER_* registration produces TWO records:
    // one by UUID (canonical, stable across renames) and one by
    // display_name slug (convention-driven, what SaaS services construct).
    assert.deepEqual(names, [
      `${res.id}.${TENANT}.connect.fabric`,
      `${svc.id}.${TENANT}.connect.fabric`,
      `customer-res.${TENANT}.connect.fabric`,
      `customer-svc.${TENANT}.connect.fabric`,
    ].sort());
    for (const r of desired) {
      assert.equal(r.target, "gw-inbound.example.internal");
    }
  });

  it("drops a record once its registration is deleted", async () => {
    const s = new MemoryStore();
    await s.ensureTenant(TENANT, "test");
    const svc = await s.createRegistration({
      tenant_id: TENANT,
      display_name: "customer-svc",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "svc.customer.internal",
      port: 443,
      actor: "test",
    });

    let desired = await computeDesiredRecords(s, {
      domainSuffix: "connect.fabric",
      target: "gw",
    });
    assert.equal(desired.length, 2); // UUID + display_name record

    await s.deleteRegistration(svc.id, "test");

    desired = await computeDesiredRecords(s, {
      domainSuffix: "connect.fabric",
      target: "gw",
    });
    assert.equal(desired.length, 0);
  });
});

describe("WebhookDnsProvider", () => {
  it("emits upsert only for new/changed records, and delete once a record drops out", async () => {
    const calls: { op: string; name: string; target?: string }[] = [];
    const provider = new WebhookDnsProvider(
      "http://example.invalid/dns",
      undefined,
      5000,
      async (body) => {
        calls.push(body);
      }
    );

    await provider.reconcile([
      { name: "a.example", target: "gw" },
      { name: "b.example", target: "gw" },
    ]);
    assert.deepEqual(calls, [
      { op: "upsert", name: "a.example", target: "gw" },
      { op: "upsert", name: "b.example", target: "gw" },
    ]);

    calls.length = 0;
    // Unchanged set: no calls at all (idempotent, no redundant API traffic).
    await provider.reconcile([
      { name: "a.example", target: "gw" },
      { name: "b.example", target: "gw" },
    ]);
    assert.deepEqual(calls, []);

    calls.length = 0;
    // "b" dropped, "a" retargeted: one upsert, one delete.
    await provider.reconcile([{ name: "a.example", target: "gw2" }]);
    assert.deepEqual(calls, [
      { op: "upsert", name: "a.example", target: "gw2" },
      { op: "delete", name: "b.example" },
    ]);
  });

  it("retries a failed upsert on the next tick instead of marking it applied", async () => {
    const calls: { op: string; name: string }[] = [];
    let fail = true;
    const provider = new WebhookDnsProvider(
      "http://example.invalid/dns",
      undefined,
      5000,
      async (body) => {
        calls.push({ op: body.op, name: body.name });
        if (fail) throw new Error("simulated failure");
      }
    );

    await provider.reconcile([{ name: "a.example", target: "gw" }]);
    fail = false;
    await provider.reconcile([{ name: "a.example", target: "gw" }]);

    assert.deepEqual(calls, [
      { op: "upsert", name: "a.example" },
      { op: "upsert", name: "a.example" },
    ]);
  });

  it("persists applied state across restarts so a record deleted while down still gets cleaned up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fabric-dns-webhook-"));
    const statePath = join(dir, "state.json");
    const calls: { op: string; name: string }[] = [];
    const postFn = async (body: { op: string; name: string }) => {
      calls.push({ op: body.op, name: body.name });
    };

    // "Process 1": applies two records, then the process exits (simulated
    // by simply constructing a fresh provider below instead of reusing
    // this instance -- WebhookDnsProvider itself never reloads mid-life).
    const p1 = new WebhookDnsProvider(
      "http://example.invalid/dns",
      undefined,
      5000,
      postFn,
      statePath
    );
    await p1.reconcile([
      { name: "a.example", target: "gw" },
      { name: "b.example", target: "gw" },
    ]);
    assert.deepEqual(calls, [
      { op: "upsert", name: "a.example" },
      { op: "upsert", name: "b.example" },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), {
      "a.example": "gw",
      "b.example": "gw",
    });

    // "b.example"'s registration is deleted while the process is down --
    // desired no longer includes it, and (before this fix) a fresh
    // in-memory `applied` map wouldn't have known to delete it either.
    calls.length = 0;
    const p2 = new WebhookDnsProvider(
      "http://example.invalid/dns",
      undefined,
      5000,
      postFn,
      statePath
    );
    await p2.reconcile([{ name: "a.example", target: "gw" }]);
    assert.deepEqual(calls, [{ op: "delete", name: "b.example" }]);
  });

  it("without a statePath, behaves exactly as before (in-memory only, no persistence)", async () => {
    const calls: { op: string; name: string }[] = [];
    const provider = new WebhookDnsProvider(
      "http://example.invalid/dns",
      undefined,
      5000,
      async (body) => {
        calls.push({ op: body.op, name: body.name });
      }
    );
    await provider.reconcile([{ name: "a.example", target: "gw" }]);
    assert.deepEqual(calls, [{ op: "upsert", name: "a.example" }]);
  });
});

describe("resolveLeaderElection production defaults (L3-DNS-02)", () => {
  it("defaults election ON when reconcile is enabled and in-cluster (production)", () => {
    assert.equal(resolveLeaderElection(true, undefined, true), true);
  });
  it("defaults election OFF when not in-cluster (local compose)", () => {
    assert.equal(resolveLeaderElection(true, undefined, false), false);
  });
  it("defaults election OFF when reconcile is disabled", () => {
    assert.equal(resolveLeaderElection(false, undefined, true), false);
  });
  it("explicit 0 wins even in-cluster (escape hatch)", () => {
    assert.equal(resolveLeaderElection(true, "0", true), false);
  });
  it("explicit 1 wins even when not in-cluster (will fail closed at start)", () => {
    assert.equal(resolveLeaderElection(true, "1", false), true);
  });
});

describe("startDnsReconciler instance auditability (L3-DNS-02)", () => {
  it("logs dns_reconciler_started at warn level with an instance_id, so a second live instance is auditable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-dns-startup-"));
    const s = new MemoryStore();
    await s.ensureTenant("00000000-0000-0000-0000-0000000000cc", "test");

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (line: string) => {
      lines.push(line);
    };
    let handle: ReturnType<typeof startDnsReconciler> = null;
    try {
      handle = startDnsReconciler(s, {
        enabled: true,
        provider: "file",
        domainSuffix: "connect.fabric",
        target: "gw",
        intervalMs: 60_000,
        filePath: join(dir, "records.json"),
      });
    } finally {
      console.log = originalLog;
    }
    assert.ok(handle, "reconciler should have started given enabled+target+file config");

    const started = lines
      .map((l) => JSON.parse(l))
      .find((l) => l.msg === "dns_reconciler_started");
    assert.ok(started, "expected a dns_reconciler_started log line");
    assert.equal(started.level, "warn");
    assert.ok(typeof started.instance_id === "string" && started.instance_id.length > 0);
    assert.match(started.note, /exactly ONE/);
    assert.equal(started.leader_election, false);

    handle!.stop();
  });

  it("with leader election, standby replicas skip reconcile writes until they hold the lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-dns-lease-"));
    const path = join(dir, "records.json");
    const s = new MemoryStore();
    await s.ensureTenant("00000000-0000-0000-0000-0000000000dd", "test");
    await s.createRegistration({
      tenant_id: "00000000-0000-0000-0000-0000000000dd",
      display_name: "cust",
      connectivity_type: "SERVICE",
      destination_kind: "CUSTOMER_SERVICE",
      host: "h",
      port: 1,
      actor: "test",
    });

    const lock = createTestLeaseLock({
      identity: "replica-a",
      shouldLead: () => false,
    });
    const handle = startDnsReconciler(s, {
      enabled: true,
      provider: "file",
      domainSuffix: "connect.fabric",
      target: "gw",
      intervalMs: 60_000,
      filePath: path,
      leaderElection: true,
      leaseLockForTest: lock,
    });
    assert.ok(handle);
    // Give the first tick a moment; standby must not write the file.
    await new Promise((r) => setTimeout(r, 50));
    assert.throws(() => readFileSync(path, "utf8"), /ENOENT/);

    lock.setLeading(true);
    // Force a tick by waiting for renew loop + manually we rely on interval;
    // call stop/restart is heavy — instead wait for the lease run loop to
    // flip leading, then invoke a second start is wrong. Expose nothing:
    // the first void tick() already ran as standby; setLeading and wait
    // for interval is 60s. Better: use a short intervalMs.
    handle!.stop();

    const lock2 = createTestLeaseLock({
      identity: "replica-a",
      shouldLead: () => true,
    });
    // Prime leading before start so the immediate void tick() sees leadership.
    lock2.setLeading(true);
    const handle2 = startDnsReconciler(s, {
      enabled: true,
      provider: "file",
      domainSuffix: "connect.fabric",
      target: "gw",
      intervalMs: 60_000,
      filePath: path,
      leaderElection: true,
      leaseLockForTest: lock2,
    });
    assert.ok(handle2);
    await new Promise((r) => setTimeout(r, 80));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.records.length, 2); // UUID + display_name per Active CUSTOMER_* reg
    handle2!.stop();
  });

  it("refuses to start with leaderElection when no test lock and not in-cluster (fail closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-dns-lease-fc-"));
    const handle = startDnsReconciler(new MemoryStore(), {
      enabled: true,
      provider: "file",
      domainSuffix: "connect.fabric",
      target: "gw",
      intervalMs: 60_000,
      filePath: join(dir, "records.json"),
      leaderElection: true,
      // no leaseLockForTest, and we're not in a real pod
    });
    assert.equal(handle, null);
  });
});

describe("FileDnsProvider multi-replica stamp guard (L3-DNS-02 mitigation)", () => {
  it("writes normally when nothing else has written a newer file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-dns-file-"));
    const path = join(dir, "records.json");
    const provider = new FileDnsProvider(path);
    await provider.reconcile([{ name: "a.example", target: "gw" }]);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed.records, [{ name: "a.example", target: "gw" }]);
  });

  it("skips the write if the on-disk file is stamped newer (simulating a faster concurrent replica)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-dns-file-"));
    const path = join(dir, "records.json");
    // Simulate another (faster) replica having already written fresher
    // state, stamped further in the future than this tick will use.
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      path,
      JSON.stringify({
        generated_at: future,
        records: [{ name: "fresher.example", target: "gw" }],
      })
    );

    const provider = new FileDnsProvider(path);
    await provider.reconcile([{ name: "staler.example", target: "gw" }]);

    // The file must still hold the "other replica's" fresher data, not
    // this (older-relative-to-it) tick's data.
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed.records, [{ name: "fresher.example", target: "gw" }]);
  });

  it("still writes over a corrupt or missing on-disk file rather than getting stuck", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-dns-file-"));
    const path = join(dir, "records.json");
    writeFileSync(path, "not valid json{{{");

    const provider = new FileDnsProvider(path);
    await provider.reconcile([{ name: "a.example", target: "gw" }]);

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed.records, [{ name: "a.example", target: "gw" }]);
  });
});
