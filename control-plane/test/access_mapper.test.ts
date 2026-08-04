import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapDatabaseResponse,
  mapSecretGetResponse,
} from "../src/access/client";

describe("Access API R1/R2 mappers", () => {
  it("maps keys#database (R1) including VERIFY_FULL → ssl", () => {
    const creds = mapDatabaseResponse({
      status: "success",
      statusCode: 200,
      message: "OK",
      data: {
        resourceId: "b591a299-8636-4574-85e5-a272c50e1600",
        resourceName: "Secrets Database",
        resourceType: "keys#database",
        resourceFlavor: "oci#postgres",
        credential: {
          type: "PASSWORD",
          username: "abluva",
          password: "REDACTED",
        },
        connection: {
          host: "172.16.1.85",
          port: 5432,
          database: "tenant_retail",
        },
        tls: { mode: "VERIFY_FULL" },
        properties: {
          refreshable: true,
          expiresAt: null,
          resourceVersion: "1784652639060",
        },
      },
    });
    assert.equal(creds.host, "172.16.1.85");
    assert.equal(creds.port, 5432);
    assert.equal(creds.database, "tenant_retail");
    assert.equal(creds.username, "abluva");
    assert.equal(creds.password, "REDACTED");
    assert.deepEqual(creds.ssl, { rejectUnauthorized: true });
    assert.equal(creds.tlsMode, "VERIFY_FULL");
  });

  it("maps secrets get (R2) to data.value", () => {
    const value = mapSecretGetResponse({
      status: "success",
      statusCode: 200,
      message: "OK",
      data: {
        action: "get",
        secretName: "service-test-key",
        status: "success",
        value: "initial-test-value-123",
      },
    });
    assert.equal(value, "initial-test-value-123");
  });

  it("rejects non-success database envelope", () => {
    assert.throws(
      () =>
        mapDatabaseResponse({
          status: "error",
          statusCode: 403,
          message: "denied",
          data: {},
        }),
      /keys#database/
    );
  });
});
