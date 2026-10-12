import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export type Row = Record<string, unknown>;

/** Parameterized SQL. The tagged-template form turns each interpolation into `$n`. */
export interface Sql {
  <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Sql {
  readonly kind: "postgres" | "pglite";
  /**
   * Runs `fn` in one transaction on one connection and retries once on deadlock (40P01) or
   * serialization failure (40001). Inside `fn` use only the handle it receives.
   */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly pool: pg.Pool | null;
  readonly pglite: PGlite | null;
}

const OID_INT8 = 20;
const OID_INT8_ARRAY = 1016;
const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);

/** int8 → number, refusing values a JS number cannot hold exactly. */
export function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("int8 value is outside the safe integer range");
  }
  return value;
}

function mapNested(value: unknown, parse: (text: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => mapNested(item, parse));
  return typeof value === "string" ? parse(value) : value;
}

type TextParser = (text: string) => unknown;
const builtinParser = pg.types.getTypeParser as (
  oid: number,
  format?: "text" | "binary",
) => TextParser;
const parseInt8Array = (text: string): unknown =>
  mapNested(builtinParser(OID_INT8_ARRAY, "text")(text), parseInt8);

/** Driver contract on both engines: int8 → number, numeric → string, timestamptz → Date. */
const PG_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (format !== "binary" && oid === OID_INT8) return parseInt8;
    if (format !== "binary" && oid === OID_INT8_ARRAY) return parseInt8Array;
    return builtinParser(oid, format);
  }) as pg.CustomTypesConfig["getTypeParser"],
};

/** PGlite already maps numeric → string and timestamptz → Date; arrays reuse element parsers. */
const PGLITE_PARSERS = { [OID_INT8]: parseInt8 };

type Runner = (text: string, params: unknown[]) => Promise<Row[]>;

function compileTemplate(strings: TemplateStringsArray, count: number): string {
  let text = strings[0] ?? "";
  for (let i = 0; i < count; i += 1) text += `$${i + 1}${strings[i + 1] ?? ""}`;
  return text;
}

function makeSql(run: Runner): Sql {
  const tagged = <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> =>
    run(compileTemplate(strings, values.length), values) as Promise<T[]>;
  return Object.assign(tagged, {
    query: <T = Row>(text: string, params: unknown[] = []): Promise<T[]> =>
      run(text, params) as Promise<T[]>,
  });
}

function sqlState(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** True for SQLSTATE 23505, optionally only for the named constraint or unique index. */
export function isUniqueViolation(err: unknown, constraintOrIndex?: string): boolean {
  if (sqlState(err) !== "23505") return false;
  if (constraintOrIndex === undefined) return true;
  return (err as { constraint?: unknown }).constraint === constraintOrIndex;
}

async function retryOnce<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    const state = sqlState(err);
    if (state === undefined || !RETRYABLE_SQLSTATES.has(state)) throw err;
    return attempt();
  }
}

interface TxScope {
  active: boolean;
}

/**
 * Guards the root handle while a transaction callback runs: on PGlite the root handle would wait
 * forever for the transaction's lock, and on Postgres it would silently run outside the
 * transaction. Either way it is a bug, so it fails loudly.
 */
function createTxGuard() {
  const scope = new AsyncLocalStorage<TxScope>();
  return {
    assertOutside(): void {
      if (scope.getStore()?.active) {
        throw new Error("The root Db was used inside db.tx(); use the transaction handle instead");
      }
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const store: TxScope = { active: true };
      try {
        return await scope.run(store, fn);
      } finally {
        store.active = false;
      }
    },
  };
}

function closableRunner(run: Runner): { run: Runner; close(): void } {
  let closed = false;
  return {
    run: (text, params) => {
      if (closed) {
        return Promise.reject(new Error("Transaction handle used after the transaction ended"));
      }
      return run(text, params);
    },
    close: () => {
      closed = true;
    },
  };
}

function buildDb(parts: {
  kind: Db["kind"];
  run: Runner;
  transaction: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
  pool: pg.Pool | null;
  pglite: PGlite | null;
}): Db {
  const guard = createTxGuard();
  const root = makeSql((text, params) => {
    guard.assertOutside();
    return parts.run(text, params);
  });
  const tx = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
    guard.assertOutside();
    return retryOnce(() => guard.run(() => parts.transaction(fn)));
  };
  return Object.assign(root, {
    kind: parts.kind,
    tx,
    close: parts.close,
    pool: parts.pool,
    pglite: parts.pglite,
  });
}

/** Pool settings for Shade: small pool, bounded waits, and the shared type parsers. */
export function postgresPoolConfig(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    types: PG_TYPES,
  };
}

/** Wraps a pg Pool created with {@link postgresPoolConfig}; `close()` ends the pool. */
export function wrapPool(pool: pg.Pool, logger?: Logger): Db {
  // An idle client dying (e.g. a server restart) must not crash the process; the pool drops it.
  pool.on("error", (err) => logger?.error({ err }, "postgres idle client error"));

  const transaction = async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
    } catch (err) {
      client.release(true);
      throw err;
    }
    const handle = closableRunner(async (text, params) => (await client.query(text, params)).rows);
    let healthy = true;
    try {
      const result = await fn(makeSql(handle.run));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is unusable (e.g. it dropped mid-transaction): destroy it below.
        healthy = false;
      }
      throw err;
    } finally {
      handle.close();
      client.release(!healthy);
    }
  };

  return buildDb({
    kind: "postgres",
    run: async (text, params) => (await pool.query(text, params)).rows,
    transaction,
    close: () => pool.end(),
    pool,
    pglite: null,
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One PGlite engine may own a data directory. A `<dir>.lock` file holding the owner's pid stops a
 * second process (or a second instance in this one) from opening it; stale locks are reclaimed.
 */
function lockDataDir(dir: string): () => void {
  const lockPath = `${dir}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone; nothing to release.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (owner === process.pid) {
      throw new Error(`PGlite data directory ${dir} is already open in this process`);
    }
    if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) {
      throw new Error(
        `PGlite data directory ${dir} is in use by process ${owner}; stop it or delete ${lockPath}`,
      );
    }
    unlinkSync(lockPath);
  }
  throw new Error(`Could not lock PGlite data directory ${dir}`);
}

/** Wraps an open PGlite instance; `onClose` runs once the engine has closed. */
function wrapPglite(instance: PGlite, onClose: () => void): Db {
  const transaction = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
    instance.transaction(async (t) => {
      const handle = closableRunner(
        async (text, params) => (await t.query<Row>(text, params)).rows,
      );
      try {
        return await fn(makeSql(handle.run));
      } finally {
        handle.close();
      }
    });

  return buildDb({
    kind: "pglite",
    run: async (text, params) => (await instance.query<Row>(text, params)).rows,
    transaction,
    close: async () => {
      try {
        if (!instance.closed) await instance.close();
      } finally {
        onClose();
      }
    },
    pool: null,
    pglite: instance,
  });
}

/** Opens PGlite: persisted under `dir`, or in memory when `dir` is null. */
export async function openPglite(
  dir: string | null,
  options: { loadDataDir?: Blob } = {},
): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const release = dir ? lockDataDir(dir) : () => {};
  try {
    const instance = new PGlite({
      ...(dir ? { dataDir: dir } : {}),
      ...(options.loadDataDir ? { loadDataDir: options.loadDataDir } : {}),
      parsers: PGLITE_PARSERS,
    });
    await instance.waitReady;
    return wrapPglite(instance, release);
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Postgres (pg Pool) when `databaseUrl` is set; otherwise one PGlite engine, persisted under
 * `pgliteDir` or in memory. Production always requires Postgres.
 */
export async function createDb(
  config: Pick<Config, "databaseUrl" | "pgliteDir" | "env">,
  opts: { logger?: Logger } = {},
): Promise<Db> {
  if (config.databaseUrl) {
    return wrapPool(new pg.Pool(postgresPoolConfig(config.databaseUrl)), opts.logger);
  }
  if (config.env === "production") throw new Error("DATABASE_URL is required in production");
  return openPglite(config.pgliteDir);
}
