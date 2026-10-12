import type { PGlite } from "@electric-sql/pglite";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";

const WRITE_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const NO_TRANSACTIONS =
  "Kysely transactions are disabled on the shared PGlite engine: interleaved BEGIN/COMMIT would capture unrelated queries";

class PgliteConnection implements DatabaseConnection {
  readonly #pglite: PGlite;

  constructor(pglite: PGlite) {
    this.#pglite = pglite;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.#pglite.query<R>(compiled.sql, [...compiled.parameters]);
    if (result.command && WRITE_COMMANDS.has(result.command)) {
      return {
        rows: result.rows,
        numAffectedRows: BigInt(result.rowCount ?? result.affectedRows ?? 0),
      };
    }
    return { rows: result.rows };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    const unsupported = () =>
      Promise.reject(new Error("Streaming queries are not supported on PGlite"));
    return {
      next: unsupported,
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

/**
 * Each query takes PGlite's own lock, so no extra queueing is needed. Transactions throw: Better
 * Auth is configured with `transaction: false` on PGlite (development and tests only).
 */
class PgliteDriver implements Driver {
  readonly #pglite: PGlite;

  constructor(pglite: PGlite) {
    this.#pglite = pglite;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PgliteConnection(this.#pglite);
  }

  async beginTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }

  async commitTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }

  async releaseConnection(): Promise<void> {}

  // The engine belongs to the app's Db; closing it is Db.close()'s job.
  async destroy(): Promise<void> {}
}

/** Kysely over the process's single PGlite instance (never a second engine on the same data). */
export function createPgliteKysely(pglite: PGlite): Kysely<unknown> {
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PgliteDriver(pglite),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createIntrospector: (db) => new PostgresIntrospector(db),
  };
  return new Kysely<unknown>({ dialect });
}
