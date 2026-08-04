import { Sequelize } from "sequelize";
import type { DatabaseCredentials } from "../access/client";
import type { FabricConfig } from "../config";

/** Build Sequelize from Access API credentials (never from env secrets in prod). */
export function sequelizeFromAccess(
  creds: DatabaseCredentials,
  cfg: FabricConfig
): Sequelize {
  return new Sequelize(creds.database, creds.username, creds.password, {
    host: creds.host,
    port: creds.port,
    dialect: "postgres",
    logging: false,
    schema: cfg.pgSchema,
    pool: {
      max: cfg.dbPoolMax,
      min: cfg.dbPoolMin,
      idle: cfg.dbPoolIdleMs,
      acquire: cfg.dbPoolAcquireMs,
    },
    dialectOptions:
      creds.ssl === false
        ? {}
        : {
            ssl: {
              require: true,
              rejectUnauthorized: creds.ssl.rejectUnauthorized,
            },
          },
  });
}

/**
 * Local/dev override: FABRIC_DATABASE_URL=postgres://user:pass@host:5432/db
 * Used by docker-compose smoke so Access API is not required on a laptop.
 */
export function sequelizeFromDatabaseUrl(
  url: string,
  cfg: FabricConfig
): Sequelize {
  return new Sequelize(url, {
    dialect: "postgres",
    logging: false,
    schema: cfg.pgSchema,
    pool: {
      max: cfg.dbPoolMax,
      min: cfg.dbPoolMin,
      idle: cfg.dbPoolIdleMs,
      acquire: cfg.dbPoolAcquireMs,
    },
  });
}

export async function authenticateDb(sequelize: Sequelize): Promise<void> {
  await sequelize.authenticate();
}
