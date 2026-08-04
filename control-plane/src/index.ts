import { loadConfig } from "./config";
import { log } from "./logging";
import { HttpAccessClient } from "./access/client";
import {
  sequelizeFromAccess,
  sequelizeFromDatabaseUrl,
  authenticateDb,
} from "./db/connect";
import { defineFabricModels } from "./db/models";
import { ensureMeshSchema } from "./db/ensureSchema";
import { MemoryStore } from "./store/memory";
import { SequelizeStore } from "./store/sequelize";
import type { FabricStore } from "./store/types";
import { createServer } from "./http/server";
import { startHeartbeatWatchdog } from "./heartbeat";
import { loadGatewayPushConfig } from "./gatewayPush";
import { loadDnsReconcilerConfig, startDnsReconciler } from "./dns/reconciler";
import { loadAgentCA } from "./pki/issueLeaf";
import { startCertExpiryScanJob } from "./jobs/certExpiryScan";

async function main() {
  const cfg = loadConfig();
  const storeMode = (process.env.FABRIC_STORE || "memory").toLowerCase();
  const useMemory = storeMode === "memory";
  const authToken = process.env.FABRIC_CONTROL_PLANE_TOKEN || "";
  const dualControlToken = process.env.FABRIC_DUAL_CONTROL_TOKEN || "";

  log.info("control_plane_starting", {
    layer: "main",
    access_url: cfg.accessUrl,
    vault_prefix: cfg.vaultPrefix,
    tenants_table: cfg.tenantsTable,
    listen_port: cfg.listenPort,
    store_mode: useMemory ? "memory" : "postgres",
    auth_enabled: !!authToken,
    dual_control_enabled: !!dualControlToken,
  });

  let store: FabricStore;

  if (useMemory) {
    store = new MemoryStore();
    log.info("store_ready", { layer: "store", backend: "memory" });
  } else {
    const databaseUrl = process.env.FABRIC_DATABASE_URL || "";
    const sequelize = databaseUrl
      ? sequelizeFromDatabaseUrl(databaseUrl, cfg)
      : sequelizeFromAccess(
          await new HttpAccessClient(cfg.accessUrl).getDatabaseCredentials({
            tenantId: cfg.platformTenantId,
            environmentId: cfg.platformEnvironmentId,
          }),
          cfg
        );

    await authenticateDb(sequelize);
    await ensureMeshSchema(sequelize);
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
  const server = createServer(store, {
    authToken: authToken || undefined,
    dualControlToken: dualControlToken || undefined,
    inboundDomainSuffix: process.env.FABRIC_GATEWAY_INBOUND_DOMAIN || "connect.fabric",
    gatewayPush,
    agentCA,
  });
  log.info("agent_ca_config", {
    layer: "control-plane.enroll",
    csr_signing_enabled: !!agentCA,
  });
  log.info("gateway_push_config", {
    layer: "main",
    enabled: gatewayPush.urls.length > 0,
    targets: gatewayPush.urls.length,
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
