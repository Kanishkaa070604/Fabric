/**
 * Pack subsystem assembly — one place that constructs the pack routes context
 * from its seams, so both the real server (index.ts) and tests build it the
 * same way. Keeps index.ts free of pack internals.
 *
 * The dev assembly (buildDevPackContext) uses the in-memory/local dev impls and
 * refuses to run in production (the impls self-guard). A production assembly
 * would swap in the unified-access PackKeyProtector, the Sequelize
 * PackRepository, and the KMS/unified-access PackLeaseSigner — same shape, real
 * backends — and is a separate task.
 */

import type { Sequelize } from "sequelize";
import { PackProducer } from "./producer";
import {
  InMemoryPackKeyProtector,
  LocalKeyPackLeaseSigner,
  type PackKeyProtector,
  type PackLeaseSigner,
} from "./seams";
import { InMemoryPackRepository, type PackRepository } from "./repository";
import { SequelizePackRepository } from "./sequelizeRepository";
import { definePackModels } from "./models";
import {
  AccessApiPackKeyProtector,
  AccessApiPackLeaseSigner,
} from "./accessProtector";
import type { AccessClient, AccessHeaders } from "../access/client";
import type { FabricConfig } from "../config";
import {
  PackService,
  AllowAllEntitlementProvider,
  type PackEntitlementProvider,
  type PackLeasePolicy,
} from "./service";
import type { PackRoutesContext, PackLogger } from "./routes";
import type { FabricStore } from "../store/types";

export type BuildPackContextDeps = {
  store: FabricStore;
  caCertPem: string;
  log: PackLogger;
  keyProtector: PackKeyProtector;
  leaseSigner: PackLeaseSigner;
  repository: PackRepository;
  entitlement?: PackEntitlementProvider;
  policy?: PackLeasePolicy;
  maxSkewSeconds?: number;
  maxUploadBytes?: number;
};

/**
 * Assemble a PackRoutesContext from fully-constructed seams. Backend-agnostic:
 * pass dev impls for local, real impls for production. This is the function the
 * server wiring calls; it owns the PackProducer + PackService assembly so no
 * caller has to know the internal graph.
 */
export function buildPackContext(deps: BuildPackContextDeps): PackRoutesContext {
  const producer = new PackProducer({
    keyProtector: deps.keyProtector,
    leaseSigner: deps.leaseSigner,
  });
  const service = new PackService({
    store: deps.store,
    repository: deps.repository,
    producer,
    entitlement: deps.entitlement ?? new AllowAllEntitlementProvider(),
    caCertPem: deps.caCertPem,
    policy: deps.policy,
    maxSkewSeconds: deps.maxSkewSeconds,
  });
  return {
    service,
    repository: deps.repository,
    keyProtector: deps.keyProtector,
    log: deps.log,
    maxUploadBytes: deps.maxUploadBytes,
  };
}

/**
 * Convenience dev assembly: in-memory repository + protector, local ES256
 * signer. NOT for production — the underlying impls throw if they detect a
 * production-like env. Returns the context plus the signer's public key SPKI
 * (DER) so the operator can pin it on the consumer side during local testing.
 */
export async function buildDevPackContext(deps: {
  store: FabricStore;
  caCertPem: string;
  log: PackLogger;
  pkcs8Pem?: string;
}): Promise<{ context: PackRoutesContext; vendorPublicKeySpkiDer: Buffer }> {
  const keyProtector = new InMemoryPackKeyProtector();
  const leaseSigner = new LocalKeyPackLeaseSigner({ pkcs8Pem: deps.pkcs8Pem });
  const repository = new InMemoryPackRepository();
  const context = buildPackContext({
    store: deps.store,
    caCertPem: deps.caCertPem,
    log: deps.log,
    keyProtector,
    leaseSigner,
    repository,
  });
  const vendorPublicKeySpkiDer = await leaseSigner.publicKeySpkiDer();
  return { context, vendorPublicKeySpkiDer };
}

/**
 * Production assembly: Sequelize-backed repository + Access-API-backed key
 * protector and lease signer. Same PackRoutesContext shape as the dev path, so
 * the server/route layer is identical either way — only the backends differ.
 *
 * Returns the context plus the vendor public key (SPKI DER) so the operator can
 * pin it on the consumer side. The pack signing key must already exist in
 * unified-access under signingKeySecretName (provisioned out of band).
 */
export async function buildProdPackContext(deps: {
  sequelize: Sequelize;
  cfg: FabricConfig;
  access: AccessClient;
  accessHeaders: AccessHeaders;
  store: FabricStore;
  caCertPem: string;
  log: PackLogger;
  dekPrefix?: string;
  signingKeySecretName?: string;
  policy?: PackLeasePolicy;
  maxSkewSeconds?: number;
  maxUploadBytes?: number;
}): Promise<{ context: PackRoutesContext; vendorPublicKeySpkiDer: Buffer }> {
  const models = definePackModels(deps.sequelize, deps.cfg);
  const repository = new SequelizePackRepository(deps.sequelize, models);
  const keyProtector = new AccessApiPackKeyProtector({
    access: deps.access,
    headers: deps.accessHeaders,
    dekPrefix: deps.dekPrefix,
  });
  const leaseSigner = new AccessApiPackLeaseSigner({
    access: deps.access,
    headers: deps.accessHeaders,
    signingKeySecretName: deps.signingKeySecretName,
  });
  const context = buildPackContext({
    store: deps.store,
    caCertPem: deps.caCertPem,
    log: deps.log,
    keyProtector,
    leaseSigner,
    repository,
    policy: deps.policy,
    maxSkewSeconds: deps.maxSkewSeconds,
    maxUploadBytes: deps.maxUploadBytes,
  });
  // Fetch the vendor public key up front so a misprovisioned signing key fails
  // at startup, not on the first lease.
  const vendorPublicKeySpkiDer = await leaseSigner.publicKeySpkiDer();
  return { context, vendorPublicKeySpkiDer };
}
