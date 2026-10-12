import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Db,
  createDb,
  isUniqueViolation,
  openPglite,
  parseInt8,
} from "../../src/platform/db.ts";

let db: Db;

beforeAll(async () => {
  db = await openPglite(null);
  await db.query(`
    create table items (
      id text primary key,
      n int8,
      amount numeric(20, 8),
      at timestamptz,
      flag boolean,
      tags int8[],
      meta jsonb
    )`);
  await db.query("create unique index items_n_unique on items (n)");
});

afterAll(async () => {
  await db.close();
});

describe("query forms", () => {
  it("turns template interpolations into $n parameters", async () => {
    const id = "it_1'; drop table items; --";
    await db`insert into items (id, n, amount) values (${id}, ${41}, ${"1.5"})`;
    const rows = await db<{
      id: string;
      n: number;
    }>`select id, n from items where id = ${id} and n = ${41}`;
    expect(rows).toEqual([{ id, n: 41 }]);
  });

  it("runs text with explicit parameters", async () => {
    const rows = await db.query<{ sum: number }>("select $1::int8 + $2::int8 as sum", [2, 3]);
    expect(rows).toEqual([{ sum: 5 }]);
    expect(await db.query("select 1 as one")).toEqual([{ one: 1 }]);
  });
});

describe("type parsing", () => {
  it("maps int8 → number, numeric → string, timestamptz → Date, int8[] → number[]", async () => {
    const at = new Date("2026-10-02T12:34:56.789Z");
    await db`insert into items (id, n, amount, at, flag, tags, meta)
      values (${"types"}, ${9_007_199_254_740_991}, ${"0.01"}, ${at}, ${true}, ${[1, 2]}, ${JSON.stringify({ a: 1 })})`;
    const [row] =
      await db`select n, amount, at, flag, tags, meta, count(*) over () as total from items where id = ${"types"}`;
    expect(row).toEqual({
      n: 9_007_199_254_740_991,
      amount: "0.01000000",
      at,
      flag: true,
      tags: [1, 2],
      meta: { a: 1 },
      total: 1,
    });
  });

  it("refuses int8 values a number cannot hold exactly", async () => {
    await expect(db`select ${"9007199254740993"}::int8 as big`).rejects.toThrow(RangeError);
    expect(() => parseInt8("9007199254740992")).toThrow(RangeError);
    expect(parseInt8("-42")).toBe(-42);
    // The engine stays usable afterwards.
    expect(await db`select 1::int8 as one`).toEqual([{ one: 1 }]);
  });
});

describe("transactions", () => {
  it("commits on success and returns the callback result", async () => {
    const result = await db.tx(async (sql) => {
      await sql`insert into items (id) values (${"tx_commit"})`;
      return (
        await sql<{ n: number }>`select count(*) as n from items where id = ${"tx_commit"}`
      )[0]?.n;
    });
    expect(result).toBe(1);
    expect(await db`select id from items where id = ${"tx_commit"}`).toHaveLength(1);
  });

  it("rolls back when the callback throws", async () => {
    await expect(
      db.tx(async (sql) => {
        await sql`insert into items (id) values (${"tx_rollback"})`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db`select id from items where id = ${"tx_rollback"}`).toEqual([]);
  });

  it("refuses the root handle inside a transaction instead of deadlocking", async () => {
    await expect(db.tx(async () => db`select 1`)).rejects.toThrow(/root Db was used inside db\.tx/);
    await expect(db.tx(async () => db.tx(async () => 1))).rejects.toThrow(/root Db/);
    expect(await db`select 1 as ok`).toEqual([{ ok: 1 }]);
  });

  it("refuses a transaction handle used after its transaction ended", async () => {
    const leaked = await db.tx(async (sql) => sql);
    await expect(leaked`select 1`).rejects.toThrow(/after the transaction ended/);
  });

  it("retries once on serialization failure or deadlock", async () => {
    let attempts = 0;
    const result = await db.tx(async (sql) => {
      attempts += 1;
      await sql`insert into items (id) values (${`retry_${attempts}`})`;
      if (attempts === 1) throw Object.assign(new Error("could not serialize"), { code: "40001" });
      return "done";
    });
    expect(result).toBe("done");
    expect(attempts).toBe(2);
    expect(await db`select id from items where id like 'retry_%' order by id`).toEqual([
      { id: "retry_2" },
    ]);

    let deadlocks = 0;
    await expect(
      db.tx(async () => {
        deadlocks += 1;
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }),
    ).rejects.toThrow("deadlock detected");
    expect(deadlocks).toBe(2);

    let other = 0;
    await expect(
      db.tx(async () => {
        other += 1;
        throw Object.assign(new Error("unique"), { code: "23505" });
      }),
    ).rejects.toThrow("unique");
    expect(other).toBe(1);
  });
});

describe("isUniqueViolation", () => {
  it("matches SQLSTATE 23505 and the violated constraint or index", async () => {
    await db`insert into items (id, n) values (${"u1"}, ${777})`;
    const indexError = await db`insert into items (id, n) values (${"u2"}, ${777})`.catch(
      (e: unknown) => e,
    );
    expect(isUniqueViolation(indexError)).toBe(true);
    expect(isUniqueViolation(indexError, "items_n_unique")).toBe(true);
    expect(isUniqueViolation(indexError, "items_pkey")).toBe(false);
    const pkError = await db`insert into items (id) values (${"u1"})`.catch((e: unknown) => e);
    expect(isUniqueViolation(pkError, "items_pkey")).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("PGlite data directory", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "shade-pglite-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists data, holds an exclusive lock, and reclaims stale locks", async () => {
    const dataDir = join(dir, "pglite");
    const first = await openPglite(dataDir);
    await first.query("create table kept (v text)");
    await first`insert into kept values (${"hello"})`;
    await expect(openPglite(dataDir)).rejects.toThrow(/already open in this process/);
    await first.close();

    writeFileSync(`${dataDir}.lock`, "999999999");
    const second = await createDb({ databaseUrl: null, pgliteDir: dataDir, env: "development" });
    expect(second.kind).toBe("pglite");
    expect(await second`select v from kept`).toEqual([{ v: "hello" }]);
    await second.close();
  }, 60_000);
});

describe("createDb", () => {
  it("never falls back to PGlite in production", async () => {
    await expect(
      createDb({ databaseUrl: null, pgliteDir: null, env: "production" }),
    ).rejects.toThrow(/DATABASE_URL is required/);
  });
});
