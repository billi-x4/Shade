import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import type { Config } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { type Db, createDb } from "./db.ts";
import type { Logger } from "./logger.ts";

/** `backend/migrations`: plain SQL, applied in filename order, recorded by bare filename. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Arbitrary constant shared by every Shade migration runner. */
const ADVISORY_LOCK_KEY = "4733829156074211";

/** Same table and bare-filename keys as the legacy runner, so 0001–0004 are never re-applied. */
const CREATE_LEDGER_SQL =
  "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())";

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

interface MigrationTx {
  exec(sql: string): Promise<void>;
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

/** One connection for the whole run, so a session advisory lock covers every file. */
interface MigrationConnection {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: MigrationTx) => Promise<T>): Promise<T>;
  release(): void;
}

/** SHA-256 over the file with line endings normalized, so a CRLF checkout is not a "change". */
export function migrationChecksum(sql: string): string {
  return sha256Hex(sql.replace(/\r\n/g, "\n"));
}

async function migrationNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = await migrationNames(dir);
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8");
      return { name, sql, checksum: migrationChecksum(sql) };
    }),
  );
}

async function postgresConnection(pool: pg.Pool): Promise<MigrationConnection> {
  const client = await pool.connect();
  let healthy = true;
  // A query with no parameter list uses the simple protocol, which runs multi-statement files.
  const tx: MigrationTx = {
    exec: async (sql) => {
      await client.query(sql);
    },
    query: async <T>(text: string, params: unknown[] = []) =>
      (await client.query(text, params)).rows as T[],
  };
  return {
    query: tx.query,
    async transaction(fn) {
      try {
        await client.query("BEGIN");
      } catch (err) {
        healthy = false;
        throw err;
      }
      try {
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          healthy = false;
        }
        throw err;
      }
    },
    release: () => client.release(!healthy),
  };
}

function pgliteConnection(instance: PGlite): MigrationConnection {
  return {
    query: async <T>(text: string, params: unknown[] = []) =>
      (await instance.query<T>(text, params)).rows,
    transaction: (fn) =>
      instance.transaction((t) =>
        fn({
          exec: async (sql) => {
            await t.exec(sql);
          },
          query: async <T>(text: string, params: unknown[] = []) =>
            (await t.query<T>(text, params)).rows,
        }),
      ),
    release: () => {},
  };
}

function connectionFor(db: Db): Promise<MigrationConnection> {
  if (db.pool) return postgresConnection(db.pool);
  if (db.pglite) return Promise.resolve(pgliteConnection(db.pglite));
  throw new MigrationError("Db has neither a Postgres pool nor a PGlite instance");
}

/**
 * Earlier checksums of applied files whose later edit changed comments only; a ledger row holding
 * one adopts the current file. The 0001 header was Grok template text, rewritten before the first
 * v1 deployment; a database the v1 runner opened before that recorded the old checksum.
 */
const SUPERSEDED_CHECKSUMS: Readonly<Record<string, readonly string[]>> = {
  "0001_auth.sql": ["f953cacc448c0c81ae4fe63e66b0e59569e840782ad279fdee201dff529363e9"],
};

async function prepareLedger(
  tx: MigrationTx,
  files: MigrationFile[],
  logger: Logger | undefined,
): Promise<void> {
  await tx.exec(CREATE_LEDGER_SQL);
  const columns = await tx.query<{ present: boolean }>(
    "select exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = '_migrations' and column_name = 'checksum') as present",
  );
  if (!columns[0]?.present) await tx.exec("alter table _migrations add column checksum text");

  const byName = new Map(files.map((file) => [file.name, file]));
  const applied = await tx.query<{ name: string; checksum: string | null }>(
    "select name, checksum from _migrations order by name",
  );
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) {
      unknown.push(row.name);
    } else if (row.checksum === null) {
      // Rows written by the legacy runner have no checksum: trust the current file on first sight.
      await tx.query("update _migrations set checksum = $1 where name = $2 and checksum is null", [
        file.checksum,
        row.name,
      ]);
    } else if (SUPERSEDED_CHECKSUMS[row.name]?.includes(row.checksum)) {
      await tx.query("update _migrations set checksum = $1 where name = $2", [
        file.checksum,
        row.name,
      ]);
    } else if (row.checksum !== file.checksum) {
      changed.push(row.name);
    }
  }
  if (changed.length > 0) {
    throw new MigrationError(
      `Applied migrations were modified: ${changed.join(", ")}. Applied files are immutable; add a new migration instead.`,
    );
  }
  if (unknown.length > 0) {
    logger?.warn(
      { migrations: unknown },
      "database has applied migrations this build does not ship",
    );
  }
}

/**
 * Applies pending `*.sql` files in filename order, each in its own transaction together with its
 * `_migrations` row. Refuses to run when an applied file's checksum changed.
 *
 * Locking (Postgres): `sessionLock: true` holds `pg_advisory_lock` for the whole run and must only
 * be used on a direct connection (DATABASE_URL_UNPOOLED); a transaction-mode pooler would pin the
 * lock to a random server connection. Otherwise every file transaction takes
 * `pg_advisory_xact_lock` first and re-checks `_migrations`. PGlite is single-process: no lock.
 */
export async function runMigrations(
  db: Db,
  opts: { dir?: string; logger?: Logger; sessionLock?: boolean } = {},
): Promise<{ applied: string[] }> {
  const files = await readMigrationFiles(opts.dir ?? MIGRATIONS_DIR);
  const lock = db.kind === "pglite" ? "none" : opts.sessionLock ? "session" : "transaction";
  const lockSql = `select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
  const conn = await connectionFor(db);
  try {
    if (lock === "session") await conn.query(`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    try {
      await conn.transaction(async (tx) => {
        if (lock === "transaction") await tx.query(lockSql);
        await prepareLedger(tx, files, opts.logger);
      });

      const applied: string[] = [];
      for (const file of files) {
        const didApply = await conn.transaction(async (tx) => {
          if (lock === "transaction") await tx.query(lockSql);
          const existing = await tx.query<{ checksum: string | null }>(
            "select checksum from _migrations where name = $1",
            [file.name],
          );
          if (existing.length > 0) {
            // Another runner applied it while we waited for the lock.
            if (existing[0]?.checksum !== file.checksum) {
              throw new MigrationError(
                `Migration ${file.name} was applied with different contents`,
              );
            }
            return false;
          }
          await tx.exec(file.sql);
          await tx.query("insert into _migrations (name, checksum) values ($1, $2)", [
            file.name,
            file.checksum,
          ]);
          return true;
        });
        if (didApply) {
          applied.push(file.name);
          opts.logger?.info({ migration: file.name }, "migration applied");
        }
      }
      return { applied };
    } finally {
      if (lock === "session") await conn.query(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  } finally {
    conn.release();
  }
}

/**
 * The `db:migrate` entry point: opens its own connection — DATABASE_URL_UNPOOLED with a session
 * lock when configured, else DATABASE_URL with per-file transaction locks, else the development
 * PGlite directory (refused while another process holds it) — applies pending migrations and
 * closes the connection. A server running on PGlite migrates its own Db with runMigrations instead.
 */
export async function migrateDatabase(
  config: Pick<Config, "databaseUrl" | "databaseUrlUnpooled" | "pgliteDir" | "env">,
  logger?: Logger,
): Promise<{ applied: string[] }> {
  const databaseUrl = config.databaseUrlUnpooled ?? config.databaseUrl;
  const db = await createDb(
    { databaseUrl, pgliteDir: config.pgliteDir, env: config.env },
    { logger },
  );
  try {
    return await runMigrations(db, { logger, sessionLock: config.databaseUrlUnpooled !== null });
  } finally {
    await db.close();
  }
}

/** Filenames in `dir` not yet recorded in `_migrations` (all of them on an empty database). */
export async function pendingMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const names = await migrationNames(dir);
  const ledger = await db.query<{ present: boolean }>(
    "select to_regclass('_migrations') is not null as present",
  );
  if (!ledger[0]?.present) return names;
  const applied = new Set(
    (await db.query<{ name: string }>("select name from _migrations")).map((row) => row.name),
  );
  return names.filter((name) => !applied.has(name));
}
