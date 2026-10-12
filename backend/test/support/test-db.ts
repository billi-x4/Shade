import { type Db, openPglite } from "../../src/platform/db.ts";
import { MigrationError, runMigrations } from "../../src/platform/migrate.ts";

let migratedImage: Promise<Blob> | null = null;

async function buildMigratedImage(): Promise<Blob> {
  const db = await openPglite(null);
  try {
    await runMigrations(db);
    if (!db.pglite) throw new MigrationError("expected a PGlite database");
    return await db.pglite.dumpDataDir("none");
  } finally {
    await db.close();
  }
}

/**
 * A fresh in-memory PGlite database with every migration applied. The migrated data directory is
 * built once per process and cloned for each call, so tests can create many databases cheaply.
 */
export async function createTestDb(): Promise<Db> {
  migratedImage ??= buildMigratedImage().catch((err: unknown) => {
    migratedImage = null;
    throw err;
  });
  return openPglite(null, { loadDataDir: await migratedImage });
}
