import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openPglite } from "../../src/platform/db.ts";
import type { Logger } from "../../src/platform/logger.ts";
import {
  MIGRATIONS_DIR,
  MigrationError,
  migrateDatabase,
  migrationChecksum,
  pendingMigrations,
  runMigrations,
} from "../../src/platform/migrate.ts";
import { createTestDb } from "../support/test-db.ts";

const SHIPPED = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function fakeLogger() {
  const warn = vi.fn();
  const info = vi.fn();
  return { logger: { warn, info } as unknown as Logger, warn, info };
}

let dir: string;
let db: Db;
let blankImage: Blob;

// initdb is the slow part of a fresh PGlite; clone one blank data directory per test instead.
beforeAll(async () => {
  const blank = await openPglite(null);
  blankImage = await blank.pglite!.dumpDataDir("none");
  await blank.close();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "shade-migrations-"));
  db = await openPglite(null, { loadDataDir: blankImage });
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeMigration(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql);
}

describe("runMigrations on the shipped migrations", () => {
  it("applies every file in order, records checksums, and is idempotent", async () => {
    expect(SHIPPED[0]).toBe("0001_auth.sql");
    expect(SHIPPED).toContain("0006_better_auth.sql");
    expect(await pendingMigrations(db)).toEqual(SHIPPED);

    const { logger, info } = fakeLogger();
    expect(await runMigrations(db, { logger })).toEqual({ applied: SHIPPED });
    expect(info).toHaveBeenCalledTimes(SHIPPED.length);

    const ledger = await db<{
      name: string;
      checksum: string;
    }>`select name, checksum from _migrations order by name`;
    expect(ledger.map((row) => row.name)).toEqual(SHIPPED);
    for (const row of ledger) {
      expect(row.checksum).toBe(
        migrationChecksum(readFileSync(join(MIGRATIONS_DIR, row.name), "utf8")),
      );
    }
    const tables = await db<{ name: string }>`
      select table_name as name from information_schema.tables where table_schema = 'public'`;
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["user", "rateLimit", "merchants", "idempotency_keys", "rate_limits"]),
    );

    expect(await runMigrations(db)).toEqual({ applied: [] });
    expect(await pendingMigrations(db)).toEqual([]);
  }, 60_000);

  it("upgrades a legacy ledger (bare names, no checksum column) without re-running old files", async () => {
    await db.query(
      "create table _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const legacy = SHIPPED.slice(0, 4);
    for (const name of legacy) {
      await db.pglite!.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
      await db`insert into _migrations (name) values (${name})`;
    }
    // Re-running 0004 would recreate the global txid index that 0005 drops.
    expect(await runMigrations(db)).toEqual({ applied: SHIPPED.slice(4) });
    const ledger = await db<{
      name: string;
      checksum: string | null;
    }>`select name, checksum from _migrations order by name`;
    expect(
      ledger.every((row) => typeof row.checksum === "string" && row.checksum.length === 64),
    ).toBe(true);
    const legacyIndex = await db`select 1 from pg_indexes where indexname = 'invoices_txid_unique'`;
    expect(legacyIndex).toEqual([]);
  }, 60_000);
});

describe("runMigrations safety", () => {
  it("refuses to run when an applied file changed, but ignores line-ending changes", async () => {
    writeMigration("0001_a.sql", "create table a (id int);\n");
    writeMigration("0002_b.sql", "create table b (id int);\n");
    await runMigrations(db, { dir });

    writeMigration("0001_a.sql", "create table a (id int);\r\n");
    writeMigration("0003_c.sql", "create table c (id int);");
    expect(await runMigrations(db, { dir })).toEqual({ applied: ["0003_c.sql"] });

    writeMigration("0002_b.sql", "create table b (id bigint);\n");
    writeMigration("0004_d.sql", "create table d (id int);");
    await expect(runMigrations(db, { dir })).rejects.toThrow(MigrationError);
    await expect(runMigrations(db, { dir })).rejects.toThrow(/0002_b\.sql/);
    expect(await pendingMigrations(db, dir)).toEqual(["0004_d.sql"]);
  });

  it("adopts the shipped 0001 over its checksum from before the comment-only header edit", async () => {
    await runMigrations(db);
    const current = migrationChecksum(readFileSync(join(MIGRATIONS_DIR, "0001_auth.sql"), "utf8"));
    const before = "f953cacc448c0c81ae4fe63e66b0e59569e840782ad279fdee201dff529363e9";
    await db`update _migrations set checksum = ${before} where name = '0001_auth.sql'`;
    expect(await runMigrations(db)).toEqual({ applied: [] });
    const [row] = await db<{ checksum: string }>`
      select checksum from _migrations where name = '0001_auth.sql'`;
    expect(row?.checksum).toBe(current);

    // Any other recorded checksum is still a modified file.
    await db`update _migrations set checksum = ${"0".repeat(64)} where name = '0001_auth.sql'`;
    await expect(runMigrations(db)).rejects.toThrow(/0001_auth\.sql/);
  });

  it("applies each file atomically with its ledger row", async () => {
    writeMigration("0001_ok.sql", "create table ok (id int);");
    writeMigration("0002_bad.sql", "create table half (id int);\nselect * from missing_table;");
    writeMigration("0003_later.sql", "create table later (id int);");
    await expect(runMigrations(db, { dir })).rejects.toThrow(/missing_table/);
    expect(await pendingMigrations(db, dir)).toEqual(["0002_bad.sql", "0003_later.sql"]);
    expect(await db`select to_regclass('half') as t`).toEqual([{ t: null }]);
    expect(await db`select to_regclass('ok') is not null as t`).toEqual([{ t: true }]);
  });

  it("warns about applied migrations this build does not ship", async () => {
    writeMigration("0001_a.sql", "create table a (id int);");
    await runMigrations(db, { dir });
    await db`insert into _migrations (name, checksum) values (${"0099_future.sql"}, ${"x"})`;
    const { logger, warn } = fakeLogger();
    expect(await runMigrations(db, { dir, logger })).toEqual({ applied: [] });
    expect(warn).toHaveBeenCalledWith({ migrations: ["0099_future.sql"] }, expect.any(String));
  });

  it("only picks up .sql files", async () => {
    writeMigration("0001_a.sql", "create table a (id int);");
    writeMigration("README.md", "not a migration");
    expect(await runMigrations(db, { dir })).toEqual({ applied: ["0001_a.sql"] });
  });
});

describe("migrateDatabase", () => {
  it("migrates the development PGlite directory once and refuses it while it is open", async () => {
    const config = {
      databaseUrl: null,
      databaseUrlUnpooled: null,
      pgliteDir: join(dir, "pglite"),
      env: "development" as const,
    };
    expect(await migrateDatabase(config)).toEqual({ applied: SHIPPED });
    expect(await migrateDatabase(config)).toEqual({ applied: [] });
    const server = await openPglite(config.pgliteDir);
    try {
      await expect(migrateDatabase(config)).rejects.toThrow(/already open/);
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe("createTestDb", () => {
  it("returns independent, fully migrated in-memory databases", async () => {
    const [a, b] = await Promise.all([createTestDb(), createTestDb()]);
    try {
      expect(a.kind).toBe("pglite");
      expect(await pendingMigrations(a)).toEqual([]);
      await a`insert into "user" (id, name, email, "emailVerified") values (${"u1"}, ${"A"}, ${"a@example.com"}, ${false})`;
      expect(await a`select id from "user"`).toEqual([{ id: "u1" }]);
      expect(await b`select id from "user"`).toEqual([]);
      const [{ n }] = (await b<{ n: number }>`select count(*) as n from _migrations`) as [
        { n: number },
      ];
      expect(n).toBe(SHIPPED.length);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 60_000);
});
