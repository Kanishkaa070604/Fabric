import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  buildPackEnv,
  stageAndActivate,
  leaseBody,
  leaseUrl,
  req,
  type PackEnv,
} from "./helpers/packHarness";

/**
 * Conditional ciphertext delivery (bandwidth): the CP omits the large pack
 * ciphertext when the caller already holds the resolved version
 * (known_pack_version_id matches). First fetch — and any version change — still
 * ships it. The signed lease always covers ciphertext_sha256, so integrity is
 * unaffected either way.
 */
describe("Secure Pack — conditional ciphertext delivery", () => {
  let env: PackEnv;

  before(async () => {
    env = await buildPackEnv();
    await stageAndActivate(env);
  });
  after(async () => {
    await env.close();
  });

  it("first lease (no known version) includes the ciphertext", async () => {
    const r = await req(env.port, "POST", leaseUrl(env), { body: leaseBody(env) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(typeof r.json.ciphertext_b64, "string");
    assert.ok((r.json.ciphertext_b64 as string).length > 0, "first fetch must ship ciphertext");
  });

  it("lease with matching known_pack_version_id OMITS the ciphertext", async () => {
    // First, learn the resolved version id.
    const first = await req(env.port, "POST", leaseUrl(env), { body: leaseBody(env) });
    const versionId = (first.json.lease as Record<string, unknown>).pack_version_id as string;
    assert.ok(versionId);

    // Second request declares we already hold that version.
    const second = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, { known_pack_version_id: versionId }),
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.ciphertext_b64, undefined, "ciphertext must be omitted when version is unchanged");
    // The lease + signature are still present and name the same version.
    assert.equal((second.json.lease as Record<string, unknown>).pack_version_id, versionId);
    assert.ok((second.json.signature as Record<string, unknown>).signature_b64);
  });

  it("lease with a STALE known_pack_version_id still includes the ciphertext", async () => {
    const r = await req(env.port, "POST", leaseUrl(env), {
      body: leaseBody(env, { known_pack_version_id: "00000000-0000-4000-8000-000000000000" }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(typeof r.json.ciphertext_b64, "string");
    assert.ok((r.json.ciphertext_b64 as string).length > 0, "version mismatch must re-ship ciphertext");
  });
});
