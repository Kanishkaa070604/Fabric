/**
 * Secure Pack producer — public surface.
 *
 * Integration entry point for the control plane. Import from here rather than
 * reaching into individual modules, so internal file layout can change without
 * breaking callers.
 *
 * Typical wiring in a route:
 *
 *   import { PackProducer, InMemoryPackKeyProtector, LocalKeyPackLeaseSigner } from "./packs";
 *
 *   const producer = new PackProducer({
 *     keyProtector: new InMemoryPackKeyProtector(),   // swap for unified-access impl
 *     leaseSigner: new LocalKeyPackLeaseSigner(),      // swap for KMS/unified-access impl
 *   });
 *   const enc = await producer.encryptVersion(plaintext, aadFields);
 *   const out = await producer.issueLease(content, binding, terms, enc);
 *   // out.{ciphertext,nonce,sealedDek,lease,leaseSignature,leaseSignedBytes}
 */

// Canonical wire encoders + their field types (the contract with Go).
export {
  encodePackAADV1,
  encodePackLeaseRequestSigningV1,
  encodePackLeaseSigningV1,
  type PackAADFields,
  type PackLeaseRequestFields,
  type PackLeaseFields,
} from "./protocol";

// Low-level crypto (usually accessed via PackProducer, exported for advanced use).
export {
  sodiumReady,
  sealDek,
  encryptPack,
  DEK_BYTES,
  XNONCE_BYTES,
  type Sodium,
  type EncryptedPack,
} from "./seal";

export { signLease } from "./leaseSign";

// Swappable seams + dev implementations.
export {
  isProductionEnv,
  type PackKeyProtector,
  type PackLeaseSigner,
  type DevImplOptions,
  type LocalKeyPackLeaseSignerOptions,
  InMemoryPackKeyProtector,
  LocalKeyPackLeaseSigner,
} from "./seams";

// Assembled producer facade — the recommended entry point.
export {
  PackProducer,
  type PackProducerDeps,
  type PackContentMeta,
  type LeaseBinding,
  type LeaseTerms,
  type ProducedPack,
} from "./producer";

// Lease-request verifier (composes the shared leaf primitives; DR-7).
export {
  verifyPackLeaseRequest,
  type VerifyLeaseRequestInput,
} from "./leaseRequest";

// Persistence seam + dev impl.
export {
  type PackRepository,
  type PackVersionRecord,
  type PackVersionState,
  type StageVersionInput,
  InMemoryPackRepository,
} from "./repository";

// Orchestration service + entitlement seam.
export {
  PackService,
  type PackServiceDeps,
  type PackLeaseResult,
  type PackLeaseErrorCode,
  type LeaseRequestInput,
  type PackLeasePolicy,
  type PackEntitlementProvider,
  AllowAllEntitlementProvider,
  DEFAULT_LEASE_POLICY,
  agentVersionSatisfies,
} from "./service";

// HTTP adapter — wired into the server via ServerOpts.packs.
export {
  handlePackRoutes,
  isPackLeaseRoute,
  isPackWriterRoute,
  type PackRoutesContext,
  type PackLogger,
} from "./routes";

// Subsystem assembly helpers.
export {
  buildPackContext,
  buildDevPackContext,
  buildProdPackContext,
  type BuildPackContextDeps,
} from "./wiring";

// Production backends.
export { definePackModels, type PackModels } from "./models";
export { SequelizePackRepository } from "./sequelizeRepository";
export {
  AccessApiPackKeyProtector,
  AccessApiPackLeaseSigner,
  type AccessPackDeps,
  type AccessPackLeaseSignerDeps,
} from "./accessProtector";
