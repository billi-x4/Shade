/**
 * Standalone background worker: hosted detection, promotion, webhook outbox and sweeper.
 *
 *   npm run worker -w @shade/backend          (or `node src/bin/worker.ts` in the Docker image)
 *
 * Outside Docker, set NODE_ENV=production in the environment for `npm run worker`: the Docker
 * image sets it, but neither the npm script nor backend/.env.example does, and without it the
 * worker runs in development mode (a missing secret or seal key is generated into backend/.data/
 * instead of refusing to start).
 *
 * Shares Postgres with the API (DATABASE_URL). Local development on PGlite runs the same loops
 * inside the dev server instead (SHADE_WORKER=inline, the development default). Needs
 * VIEWING_KEY_SEAL_PRIVATE_KEYS to open uploaded viewing keys; only this process gets it (docker
 * compose: backend/.env.worker). It serves no auth routes, so it creates no Better Auth instance.
 * SIGINT/SIGTERM stop it gracefully.
 * Exit status: 0 after a clean stop, 1 when it cannot start, 2 on invalid configuration.
 */
import type { Network } from "../contract/index.ts";
import { type Config, ConfigError, loadConfig } from "../platform/config.ts";
import { type Db, createDb } from "../platform/db.ts";
import { type Logger, createLogger } from "../platform/logger.ts";
import { createMailer } from "../platform/mailer.ts";
import { pendingMigrations } from "../platform/migrate.ts";
import { type Services, createServices } from "../services/index.ts";
import { type WorkerHandle, startWorker } from "../worker/index.ts";
import { type ChainClient, createLightwalletdClient } from "../zcash/lightwalletd.ts";
import { createLedgerScanner } from "../zcash/scanner.ts";

/** A stop that hangs (e.g. a stuck database call) must not keep the process alive forever. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

function nextSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
}

interface Running {
  db: Db;
  services: Services;
  worker: WorkerHandle;
}

async function start(config: Config, logger: Logger): Promise<Running | null> {
  const db = await createDb(config, { logger });
  const pending = await pendingMigrations(db);
  if (pending.length > 0) {
    logger.fatal({ pending }, "database migrations are pending; run npm run db:migrate first");
    await db.close();
    return null;
  }
  const chain: Record<Network, ChainClient> = {
    testnet: createLightwalletdClient({ urls: config.lightwalletd.testnet, network: "testnet" }),
    mainnet: createLightwalletdClient({ urls: config.lightwalletd.mainnet, network: "mainnet" }),
  };
  const scanner = createLedgerScanner({ urls: (network) => config.lightwalletd[network] });
  const mailer = createMailer(config, logger);
  const clock = (): Date => new Date();
  const services = createServices({ db, config, logger, chain, scanner, mailer, clock });
  const worker = startWorker({ db, config, logger, services, scanner, chain, clock });
  return { db, services, worker };
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
  if (!config.databaseUrl) {
    console.error(
      "The worker shares Postgres with the API: set DATABASE_URL. For local development on PGlite, run the dev server with SHADE_WORKER=inline (the development default) instead of a separate worker.",
    );
    return 2;
  }

  const logger = createLogger(config);
  let running: Running | null;
  try {
    running = await start(config, logger);
  } catch (err) {
    logger.fatal({ err }, "worker failed to start");
    return 1;
  }
  if (running === null) return 1;

  const signal = await nextSignal();
  logger.info({ signal }, "worker stopping");
  const forceExit = setTimeout(() => {
    logger.error("worker did not stop in time; exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  await running.worker.stop();
  // Webhook deliveries kicked after a settlement finish before the database closes.
  await running.services.idle();
  await running.db.close();
  clearTimeout(forceExit);
  return 0;
}

process.exitCode = await main();
