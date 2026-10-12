/**
 * The Shade API server (Hono on @hono/node-server).
 *
 *   npm run dev -w @shade/backend      (development: PGlite + inline worker by default)
 *   npm start -w @shade/backend        (production: Postgres; run `npm run db:migrate` first)
 *
 * Outside Docker, set NODE_ENV=production in the environment for `npm start`: the Docker image
 * sets it, but neither the npm script nor backend/.env.example does, and without it the server
 * boots in development mode (no email verification, cookies without Secure, inline worker,
 * generated secrets in backend/.data/).
 *
 * On PGlite the server migrates its own database (and repairs pre-v1 receive addresses, as
 * `db:migrate` does) before listening. On Postgres it refuses to start while migrations are
 * pending. SHADE_WORKER=inline runs the worker loops in this process.
 * SIGINT/SIGTERM stop the worker, close the server and the database, then exit.
 * Exit status: 0 after a clean stop, 1 when it cannot start, 2 on invalid configuration.
 */
import { serve } from "@hono/node-server";
import type { Network } from "../contract/index.ts";
import { createAuth } from "../platform/auth.ts";
import { type Config, ConfigError, loadConfig } from "../platform/config.ts";
import { type Db, createDb } from "../platform/db.ts";
import { type Logger, createLogger } from "../platform/logger.ts";
import { createMailer } from "../platform/mailer.ts";
import { pendingMigrations, runMigrations } from "../platform/migrate.ts";
import { createApp } from "../http/app.ts";
import { createBackground } from "../services/background.ts";
import { createServices } from "../services/index.ts";
import { repairStoredAddresses } from "../services/stored-addresses.ts";
import { type WorkerHandle, startWorker } from "../worker/index.ts";
import { type ChainClient, createLightwalletdClient } from "../zcash/lightwalletd.ts";
import { createLedgerScanner } from "../zcash/scanner.ts";

/** A stop that hangs (a stuck request or database call) must not keep the process alive. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

function nextSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
}

/**
 * Everything between opening the database and listening. Null when migrations are pending (the
 * reason is printed); any other failure throws.
 */
async function start(config: Config, logger: Logger, db: Db) {
  if (db.kind === "pglite") {
    await runMigrations(db, { logger });
    await repairStoredAddresses(db, logger);
  } else {
    const pending = await pendingMigrations(db);
    if (pending.length > 0) {
      console.error(
        `The database has ${pending.length} pending migration(s): ${pending.join(", ")}.\nRun "npm run db:migrate" (against the same DATABASE_URL) and start the server again.`,
      );
      return null;
    }
  }

  // Clients are lazy: a network that is not enabled never opens a connection.
  const chain: Record<Network, ChainClient> = {
    testnet: createLightwalletdClient({ urls: config.lightwalletd.testnet, network: "testnet" }),
    mainnet: createLightwalletdClient({ urls: config.lightwalletd.mainnet, network: "mainnet" }),
  };
  const scanner = createLedgerScanner({ urls: (network) => config.lightwalletd[network] });
  const mailer = createMailer(config, logger);
  const clock = (): Date => new Date();
  const services = createServices({ db, config, logger, chain, scanner, mailer, clock });
  // Auth mail and Better Auth's deferred work run after the response; shutdown drains them.
  const authBackground = createBackground(logger.child({ component: "auth" }));
  const auth = createAuth({
    config,
    db,
    mailer,
    logger,
    background: authBackground,
    onUserCreated: async (user) => {
      await services.merchants.ensure(user);
    },
  });
  const app = createApp({ config, logger, db, auth, services });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return { server, services, authBackground, scanner, chain, clock };
}

async function run(config: Config, logger: Logger): Promise<number> {
  const db = await createDb(config, { logger });
  let started: Awaited<ReturnType<typeof start>>;
  try {
    started = await start(config, logger, db);
  } catch (err) {
    // An idle pool client would keep the process alive for the pool's idle timeout (~30 s) after
    // a failed start. A close error must not hide the startup error.
    await db.close().catch(() => {});
    throw err;
  }
  if (started === null) {
    await db.close();
    return 1;
  }
  const { server, services, authBackground, scanner, chain, clock } = started;
  logger.info(
    { host: config.host, port: config.port, networks: config.networks },
    "server listening",
  );
  const worker: WorkerHandle | null =
    config.worker === "inline"
      ? startWorker({ db, config, logger, services, scanner, chain, clock })
      : null;

  const signal = await nextSignal();
  logger.info({ signal }, "server stopping");
  const forceExit = setTimeout(() => {
    logger.error("server did not stop in time; exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  await worker?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Webhook kicks, notification and auth emails, and Better Auth's rate-limit pruning (which
  // uses the database) finish before the database closes.
  await Promise.all([services.idle(), authBackground.idle()]);
  await db.close();
  clearTimeout(forceExit);
  return 0;
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
    return await run(config, logger);
  } catch (err) {
    logger.fatal({ err }, "server failed to start");
    return 1;
  }
}

process.exitCode = await main();
