import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  AccessApiPackKeyProtector,
  AccessApiPackLeaseSigner,
} from "../src/packs";
import type { AccessClient, AccessHeaders } from "../src/access/client";
import { CRYPTO_FIXTURE } from "./pack_crypto_fixture";

/** Minimal in-memory AccessClient double implementing the get/put secret surface. */
class FakeAccessClient implements AccessClient {
  readonly secrets = new Map<string, string>();
  createCalls = 0;
  updateCalls = 0;

  async getDatabaseCredentials(): Promise<never> {
    throw new Error("not used");
  }
  async getSecret(_h: AccessHeaders, name: string): Promise<string> {
    const v = this.secrets.get(name);
    if (v === undefined) throw new Error(`no secret ${name}`);
    return v;
  }
  async createSecret(_h: AccessHeaders, name: string, value: string): Promise<void> {
    this.createCalls++;
    if (this.secrets.has(name)) throw new Error("exists"); // emulate create-or-fail stores
    this.secrets.set(name, value);
  }
  async updateSecret(_h: AccessHeaders, name: string, value: string): Promise<void> {
    this.updateCalls++;
    this.secrets.set(name, value);
  }
}

const headers: AccessHeaders = { tenantId: "t", environmentId: "e" };

describe("AccessApiPackKeyProtector", () => {
  it("stores and retrieves a DEK by pack_version_id (base64 in the store)", async () => {
    const access = new FakeAccessClient();
    const p = new AccessApiPackKeyProtector({ access, headers });
    const dek = Buffer.from(CRYPTO_FIXTURE.dekHex, "hex");
    await p.putDek("v1", dek);
    // Stored under the prefixed name, base64-encoded.
    const stored = access.secrets.get("fabric-pack-dek/v1");
    assert.equal(stored, dek.toString("base64"));
    const got = await p.getDek("v1");
    assert.equal(got.toString("hex"), CRYPTO_FIXTURE.dekHex);
  });

  it("putDek is idempotent: falls back to update when create conflicts", async () => {
    const access = new FakeAccessClient();
    const p = new AccessApiPackKeyProtector({ access, headers });
    const dek = Buffer.from(CRYPTO_FIXTURE.dekHex, "hex");
    await p.putDek("v1", dek);
    await p.putDek("v1", dek); // second call: create throws "exists" → update
    assert.equal(access.createCalls, 2);
    assert.equal(access.updateCalls, 1);
    assert.equal((await p.getDek("v1")).toString("hex"), CRYPTO_FIXTURE.dekHex);
  });

  it("rejects a wrong-length stored DEK", async () => {
    const access = new FakeAccessClient();
    access.secrets.set("fabric-pack-dek/bad", Buffer.alloc(16).toString("base64"));
    const p = new AccessApiPackKeyProtector({ access, headers });
    await assert.rejects(() => p.getDek("bad"), /expected 32/);
  });
});

describe("AccessApiPackLeaseSigner", () => {
  it("fetches the signing key once, caches it, and signs verifiably", async () => {
    const access = new FakeAccessClient();
    access.secrets.set("fabric-pack-lease-signing-key", CRYPTO_FIXTURE.es256PrivateKeyPem);
    const signer = new AccessApiPackLeaseSigner({ access, headers });

    const spki1 = await signer.publicKeySpkiDer();
    const { signature, signedBytes } = await signer.signLease(CRYPTO_FIXTURE.leaseFields);
    const spki2 = await signer.publicKeySpkiDer();
    assert.deepEqual(spki1, spki2);

    const { createPublicKey, createVerify } = await import("node:crypto");
    const pub = createPublicKey({ key: spki1, format: "der", type: "spki" });
    const v = createVerify("SHA256");
    v.update(signedBytes);
    v.end();
    assert.equal(v.verify({ key: pub, dsaEncoding: "der" }, signature), true);
  });

  it("retries the key fetch after a failure (does not cache the rejection)", async () => {
    const access = new FakeAccessClient();
    const signer = new AccessApiPackLeaseSigner({ access, headers });
    await assert.rejects(() => signer.publicKeySpkiDer(), /no secret/);
    // Now provision the key; a subsequent call must succeed.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    access.secrets.set(
      "fabric-pack-lease-signing-key",
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const spki = await signer.publicKeySpkiDer();
    assert.ok(spki.length > 0);
  });
});
