/**
 * Applies pending SQL migrations (backend/migrations) and exits.
 *
 *   npm run db:migrate                 (DATABASE_URL_UNPOOLED, else DATABASE_URL, else dev PGlite)
 *
 * Run it as a release step before starting new servers or workers. Safe to run concurrently: a
 * Postgres advisory lock serialises runners. After the SQL files it repairs receive addresses
 * stored before v1 (services/stored-addresses.ts: SQL cannot re-encode them), which is idempotent.
 * Exit status: 0 when the database is up to date, 1 when a migration or the repair fails, 2 on
 * invalid configuration.
 */
import { type Config, ConfigError, loadConfig } from "../platform/config.ts";
import { createDb } from "../platform/db.ts";
import { type Logger, createLogger } from "../platform/logger.ts";
import { migrateDatabase } from "../platform/migrate.ts";
import { repairStoredAddresses } from "../services/stored-addresses.ts";

/** Same database as migrateDatabase: the direct connection when configured. */
async function repairAddresses(config: Config, logger: Logger): Promise<number> {
  const db = await createDb(
    {
      databaseUrl: config.databaseUrlUnpooled ?? config.databaseUrl,
      pgliteDir: config.pgliteDir,
      env: config.env,
    },
    { logger },
  );
  try {
    const repaired = await repairStoredAddresses(db, logger);
    return repaired.merchantsRewritten + repaired.merchantsCleared + repaired.jarsRewritten;
  } finally {
    await db.close();
  }
}

async function main(): Promise<number> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const logger = createLogger(config);
  try {
    const { applied } = await migrateDatabase(config, logger);
    console.log(
      applied.length === 0
        ? "Database is up to date."
        : `Applied ${applied.length} migration(s): ${applied.join(", ")}`,
    );
  } catch (err) {
    console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  try {
    const repaired = await repairAddresses(config, logger);
    if (repaired > 0) console.log(`Repaired ${repaired} stored receive address(es).`);
    return 0;
  } catch (err) {
    console.error(`Address repair failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main();
