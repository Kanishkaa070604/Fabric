import { loadConfig } from "./config";
import { log } from "./logging";
import { HttpAccessClient } from "./access/client";
import {
  sequelizeFromAccess,
  sequelizeFromDatabaseUrl,
  authenticateDb,
} from "./db/connect";
import { defineFabricModels } from "./db/models";
import { MemoryStore } from "./store/memory";
import { SequelizeStore } from "./store/sequelize";
import type { FabricStore } from "./store/types";
import { createServer } from "./http/server";
import { startHeartbeatWatchdog } from "./heartbeat";
import { loadGatewayPushConfig } from "./gatewayPush";
import { loadDnsReconcilerConfig, startDnsReconciler } from "./dns/reconciler";
import { loadAgentCA } from "./pki/issueLeaf";
import { startCertExpiryScanJob } from "./jobs/certExpiryScan";
import {
  buildDevPackContext,
  buildProdPackContext,
  type PackRoutesContext,
} from "./packs";

async function main() {
  const cfg = loadConfig();
  const storeMode = (process.env.FABRIC_STORE || "memory").toLowerCase();
  const useMemory = storeMode === "memory";
  const authToken = process.env.FABRIC_CONTROL_PLANE_TOKEN || "";
  const dualControlToken = process.env.FABRIC_DUAL_CONTROL_TOKEN || "";
  const gatewayToken = process.env.FABRIC_GATEWAY_CONTROL_TOKEN || "";

  log.info("control_plane_starting", {
    layer: "main",
    access_url: cfg.accessUrl,
    vault_prefix: cfg.vaultPrefix,
    tenants_table: cfg.tenantsTable,
    listen_port: cfg.listenPort,
    store_mode: useMemory ? "memory" : "postgres",
    auth_enabled: !!authToken,
    dual_control_enabled: !!dualControlToken,
    // Off means every Gateway->CP call 401s. Surfaced at startup because the
    // symptom otherwise shows up only as authz failures under load.
    gateway_principal_enabled: !!gatewayToken,
  });

  let store: FabricStore;
  // Captured for the pack subsystem's production backends (Sequelize repository
  // + Access-API key protector/signer). Only set in the postgres branch.
  let packSequelize: import("sequelize").Sequelize | undefined;
  let packAccess: HttpAccessClient | undefined;

  if (useMemory) {
    store = new MemoryStore();
    log.info("store_ready", { layer: "store", backend: "memory" });
  } else {
    const databaseUrl = process.env.FABRIC_DATABASE_URL || "";
    packAccess = new HttpAccessClient(cfg.accessUrl, cfg.accessDbResourceType);
    const sequelize = databaseUrl
      ? sequelizeFromDatabaseUrl(databaseUrl, cfg)
      : sequelizeFromAccess(
          await packAccess.getDatabaseCredentials({
            tenantId: cfg.platformTenantId,
            environmentId: cfg.platformEnvironmentId,
          }),
          cfg
        );
    packSequelize = sequelize;

    // Schema is owned solely by control-plane/migrations. There used to be an
    // idempotent ALTER-TABLE shim here as well; two places defining the same
    // columns is how they drift, so the migration is the only source now.
    await authenticateDb(sequelize);
    const models = defineFabricModels(sequelize, cfg);
    const ensureSaasTenant =
      (process.env.FABRIC_ENSURE_SAAS_TENANT || "").toLowerCase() === "1" ||
      (process.env.FABRIC_ENSURE_SAAS_TENANT || "").toLowerCase() === "true";

    store = new SequelizeStore(sequelize, models, {
      tenantsTable: cfg.tenantsTable,
      tenantsIdColumn: cfg.tenantsIdColumn,
      ensureSaasTenant,
    });

    log.info("store_ready", {
      layer: "store",
      backend: "postgres",
      via: databaseUrl ? "FABRIC_DATABASE_URL" : "access_api",
      ensure_saas_tenant: ensureSaasTenant,
    });
  }

  const gatewayPush = loadGatewayPushConfig();
  const agentCA = loadAgentCA();

  // Secure Pack routes are opt-in. FABRIC_PACKS_STORE selects the backend:
  //   "postgres" → Sequelize repository + Access-API key protector/signer (prod).
  //   "memory"/"dev" → in-memory repo + local signer (self-refuses in prod env).
  // Unset → pack routes disabled entirely (404). Either backend needs a
  // configured Agent CA, since the lease route verifies leaf PoP against it.
  const packLog = {
    info: (msg: string, fields?: Record<string, unknown>) => log.info(msg, fields ?? {}),
    warn: (msg: string, fields?: Record<string, unknown>) => log.warn(msg, fields ?? {}),
  };
  const packsStore = (process.env.FABRIC_PACKS_STORE || "").toLowerCase();
  let packs: PackRoutesContext | undefined;
  if (packsStore === "postgres") {
    if (!agentCA) {
      log.warn("packs_disabled_no_ca", { layer: "control-plane.packs", note: "no Agent CA; pack lease route needs it." });
    } else if (!packSequelize || !packAccess) {
      log.warn("packs_disabled_no_db", {
        layer: "control-plane.packs",
        note: "FABRIC_PACKS_STORE=postgres requires FABRIC_STORE=postgres (Sequelize + Access API).",
      });
    } else {
      const built = await buildProdPackContext({
        sequelize: packSequelize,
        cfg,
        access: packAccess,
        accessHeaders: { tenantId: cfg.platformTenantId, environmentId: cfg.platformEnvironmentId },
        store,
        caCertPem: agentCA.certPem,
        log: packLog,
      });
      packs = built.context;
      log.info("packs_enabled", {
        layer: "control-plane.packs",
        backend: "postgres+access-api",
        vendor_public_key_spki_der_hex: built.vendorPublicKeySpkiDer.toString("hex"),
      });
    }
  } else if (["memory", "dev", "1", "true"].includes(packsStore)) {
    if (!agentCA) {
      log.warn("packs_disabled_no_ca", { layer: "control-plane.packs", note: "no Agent CA; pack lease route needs it." });
    } else {
      const built = await buildDevPackContext({ store, caCertPem: agentCA.certPem, log: packLog });
      packs = built.context;
      log.warn("packs_dev_enabled", {
        layer: "control-plane.packs",
        note: "DEV pack routes active (in-memory key custody, local signer). NOT for production.",
        vendor_public_key_spki_der_hex: built.vendorPublicKeySpkiDer.toString("hex"),
      });
    }
  }

  const server = createServer(store, {
    authToken: authToken || undefined,
    dualControlToken: dualControlToken || undefined,
    gatewayToken: gatewayToken || undefined,
    inboundDomainSuffix: process.env.FABRIC_GATEWAY_INBOUND_DOMAIN || "connect.fabric",
    gatewayPush,
    agentCA,
    packs,
  });
  log.info("agent_ca_config", {
    layer: "control-plane.enroll",
    csr_signing_enabled: !!agentCA,
  });
  log.info("gateway_push_config", {
    layer: "main",
    // Either static URLs or DNS names enable push (dnsNames re-resolved per push).
    enabled:
      gatewayPush.urls.length > 0 || gatewayPush.dnsNames.length > 0,
    targets: gatewayPush.urls.length + gatewayPush.dnsNames.length,
    urls: gatewayPush.urls.length,
    dns_names: gatewayPush.dnsNames.length,
    dns_port: gatewayPush.dnsPort,
  });
  startHeartbeatWatchdog(store);
  startCertExpiryScanJob(store);
  const dnsCfg = loadDnsReconcilerConfig();
  startDnsReconciler(store, dnsCfg);
  server.listen(cfg.listenPort, () => {
    log.info("control_plane_listening", {
      layer: "main",
      port: cfg.listenPort,
      store: useMemory ? "memory" : "postgres",
      auth_enabled: !!authToken,
    });
  });
}

main().catch((err) => {
  log.error("control_plane_fatal", {
    layer: "main",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
