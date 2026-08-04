import { z } from "zod";

/** Non-secret config only. DB credentials come from Access API. */
export const FabricConfigSchema = z.object({
  accessUrl: z.string().min(1),
  platformTenantId: z.string().uuid().or(z.literal("00000000-0000-0000-0000-000000000001")),
  platformEnvironmentId: z.string().uuid().or(z.literal("00000000-0000-0000-0000-000000000002")),
  vaultPrefix: z.string().default("ablv-fabric"),
  pgSchema: z.string().default("public"),
  tablePrefix: z.string().default("ablv_"),
  tenantsTable: z.string().default("ablv_tenants"),
  tenantsIdColumn: z.string().default("tenant_id"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  listenPort: z.coerce.number().default(8080),
  // Sequelize's own default (max: 5) is sized for a dev laptop, not a
  // service whose hottest read path (authz-context, hit once per
  // StreamOpen/tunnel-accept across every Gateway instance) needs headroom
  // for concurrent bursts. Configurable rather than just raised in code so
  // it can be tuned per-deployment without a redeploy.
  dbPoolMax: z.coerce.number().default(20),
  dbPoolMin: z.coerce.number().default(2),
  dbPoolIdleMs: z.coerce.number().default(10_000),
  dbPoolAcquireMs: z.coerce.number().default(30_000),
});

export type FabricConfig = z.infer<typeof FabricConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FabricConfig {
  return FabricConfigSchema.parse({
    accessUrl: env.ABLV_ACCESS_URL ?? "http://127.0.0.1:3000/v1/access",
    platformTenantId:
      env.ABLV_PLATFORM_TENANT_ID ?? "00000000-0000-0000-0000-000000000001",
    platformEnvironmentId:
      env.ABLV_PLATFORM_ENVIRONMENT_ID ?? "00000000-0000-0000-0000-000000000002",
    vaultPrefix: env.FABRIC_VAULT_PREFIX ?? "ablv-fabric",
    pgSchema: env.FABRIC_PG_SCHEMA ?? "control",
    tablePrefix: env.FABRIC_TABLE_PREFIX ?? "ablv_",
    tenantsTable: env.FABRIC_TENANTS_TABLE ?? "ablv_tenants",
    tenantsIdColumn: env.FABRIC_TENANTS_ID_COLUMN ?? "tenant_id",
    logLevel: env.FABRIC_LOG_LEVEL ?? "info",
    listenPort: env.FABRIC_CONTROL_PLANE_PORT ?? "8080",
    dbPoolMax: env.FABRIC_DB_POOL_MAX ?? "20",
    dbPoolMin: env.FABRIC_DB_POOL_MIN ?? "2",
    dbPoolIdleMs: env.FABRIC_DB_POOL_IDLE_MS ?? "10000",
    dbPoolAcquireMs: env.FABRIC_DB_POOL_ACQUIRE_MS ?? "30000",
  });
}
