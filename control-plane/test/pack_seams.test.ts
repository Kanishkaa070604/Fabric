import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import {
  InMemoryPackKeyProtector,
  LocalKeyPackLeaseSigner,
} from "../src/packs/seams";
import { encodePackLeaseSigningV1 } from "../src/packs/protocol";
import { CRYPTO_FIXTURE } from "./pack_crypto_fixture";

describe("Secure Pack producer seams — dev implementations", () => {
  it("InMemoryPackKeyProtector round-trips a DEK by pack_version_id", async () => {
    const p = new InMemoryPackKeyProtector();
    const dek = Buffer.alloc(32, 0x11);
    await p.putDek("11111111-1111-4111-8111-111111111111", dek);
    const got = await p.getDek("11111111-1111-4111-8111-111111111111");
    assert.equal(got.toString("hex"), dek.toString("hex"));
  });

  it("InMemoryPackKeyProtector rejects a wrong-length DEK", async () => {
    const p = new InMemoryPackKeyProtector();
    await assert.rejects(() => p.putDek("v", Buffer.alloc(16)), /32 bytes/);
  });

  it("InMemoryPackKeyProtector throws on unknown pack_version_id", async () => {
    const p = new InMemoryPackKeyProtector();
    await assert.rejects(() => p.getDek("missing"), /no DEK stored/);
  });

  it("dev impls refuse to construct in a production-like env (injected)", () => {
    const prodEnv = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    assert.throws(() => new InMemoryPackKeyProtector({ env: prodEnv }), /development-only/);
    assert.throws(() => new LocalKeyPackLeaseSigner({ env: prodEnv }), /development-only/);
  });

  it("dev impls honor allowInProduction escape hatch", () => {
    const prodEnv = { FABRIC_ENV: "production" } as NodeJS.ProcessEnv;
    assert.doesNotThrow(
      () => new InMemoryPackKeyProtector({ env: prodEnv, allowInProduction: true }),
    );
    assert.doesNotThrow(
      () => new LocalKeyPackLeaseSigner({ env: prodEnv, allowInProduction: true }),
    );
  });

  it("LocalKeyPackLeaseSigner signs a lease that verifies against its public key", async () => {
    const signer = new LocalKeyPackLeaseSigner({ pkcs8Pem: CRYPTO_FIXTURE.es256PrivateKeyPem });
    const { signature, signedBytes } = await signer.signLease(CRYPTO_FIXTURE.leaseFields);

    // signedBytes must equal the canonical encoding (no re-encoding drift).
    assert.equal(
      signedBytes.toString("hex"),
      encodePackLeaseSigningV1(CRYPTO_FIXTURE.leaseFields).toString("hex"),
    );

    const spki = await signer.publicKeySpkiDer();
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    const v = createVerify("SHA256");
    v.update(signedBytes);
    v.end();
    assert.equal(v.verify({ key: pub, dsaEncoding: "der" }, signature), true);
  });

  it("LocalKeyPackLeaseSigner generates an ephemeral key when none is provided", async () => {
    const signer = new LocalKeyPackLeaseSigner();
    const spki = await signer.publicKeySpkiDer();
    assert.ok(spki.length > 0, "should expose an SPKI public key");
    const { signature, signedBytes } = await signer.signLease(CRYPTO_FIXTURE.leaseFields);
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    const v = createVerify("SHA256");
    v.update(signedBytes);
    v.end();
    assert.equal(v.verify({ key: pub, dsaEncoding: "der" }, signature), true);
  });
});
