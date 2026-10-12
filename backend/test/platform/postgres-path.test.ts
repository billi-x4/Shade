import { readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../../src/platform/auth.ts";
import { loadConfig } from "../../src/platform/config.ts";
import { newId } from "../../src/platform/crypto.ts";
import { type Db, isUniqueViolation, wrapPool } from "../../src/platform/db.ts";
import { type AppEnv, errorHandler, requestContext, sessionAuth } from "../../src/platform/http.ts";
import { createLogger } from "../../src/platform/logger.ts";
import type { MailMessage } from "../../src/platform/mailer.ts";
import { MIGRATIONS_DIR, pendingMigrations, runMigrations } from "../../src/platform/migrate.ts";
import { consumeRateLimit } from "../../src/platform/rate-limit.ts";
import { pgliteWirePool } from "./support/pglite-wire.ts";

const SHIPPED = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

// The production driver path (node-postgres Pool, its type parsers and pooled transactions), driven
// over the wire protocol into PGlite. Concurrency needs a real server: see platform.pg.test.ts.
let engine: PGlite;
let db: Db;

beforeAll(async () => {
  engine = new PGlite();
  await engine.waitReady;
  db = wrapPool(pgliteWirePool(engine));
}, 60_000);

afterAll(async () => {
  await db.close();
  await engine.close();
});

describe("pg driver contract", () => {
  it("maps int8 → number, int8[] → number[], numeric → string, timestamptz → Date", async () => {
    expect(db.kind).toBe("postgres");
    const at = new Date("2026-10-02T12:34:56.789Z");
    const [row] = await db`
      select ${41}::int8 + 1 as n, array[1, 2]::int8[] as arr, ${"0.01"}::numeric(20, 8) as amount,
             ${at}::timestamptz as at, count(*) as total, ${JSON.stringify({ a: 1 })}::jsonb as meta`;
    expect(row).toEqual({ n: 42, arr: [1, 2], amount: "0.01000000", at, total: 1, meta: { a: 1 } });
  });

  it("refuses unsafe int8 values and keeps the connection usable", async () => {
    await expect(db`select ${"9007199254740993"}::int8 as big`).rejects.toThrow(RangeError);
    expect(await db`select 1 as ok`).toEqual([{ ok: 1 }]);
  });

  it("commits and rolls back on a checked-out client", async () => {
    await db.query("create table pg_items (id text primary key)");
    await db.tx(async (sql) => {
      await sql`insert into pg_items values (${"a"})`;
    });
    await expect(
      db.tx(async (sql) => {
        await sql`insert into pg_items values (${"b"})`;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db`select id from pg_items`).toEqual([{ id: "a" }]);
    await expect(db.tx(async () => db`select 1`)).rejects.toThrow(/root Db/);

    const violation = await db`insert into pg_items values (${"a"})`.catch((e: unknown) => e);
    expect(isUniqueViolation(violation, "pg_items_pkey")).toBe(true);
  });
});

describe("migrations over pg", () => {
  it("applies with per-file transaction locks, then no-ops under a session lock", async () => {
    const { applied } = await runMigrations(db);
    expect(applied.at(0)).toBe("0001_auth.sql");
    expect(applied).toEqual(SHIPPED);
    expect(await runMigrations(db, { sessionLock: true })).toEqual({ applied: [] });
    expect(await pendingMigrations(db)).toEqual([]);
    const ok = await consumeRateLimit(db, "pg:test", 1, 60, new Date("2026-10-02T12:00:00Z"));
    expect(ok).toEqual({ ok: true, retryAfterSec: 0 });
  }, 60_000);

  it("runs Better Auth with transactions on the shared pool", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_ORIGIN: "http://localhost:5173",
    });
    const logger = createLogger({ logLevel: "silent", env: "test" });
    const mail: MailMessage[] = [];
    const auth = createAuth({
      config,
      db,
      logger,
      mailer: { send: async (msg) => void mail.push(msg) },
      onUserCreated: async (user) => {
        await db`insert into merchants (id, user_id, network) values (${newId("m")}, ${user.id}, ${"testnet"})
          on conflict (user_id) do nothing`;
      },
    });
    const app = new Hono<AppEnv>();
    app.use("*", requestContext({ logger, config }));
    app.onError(errorHandler());
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
    app.get("/api/desk/me", sessionAuth(auth, { requireVerifiedEmail: false }), (c) =>
      c.json(c.get("user")),
    );

    const headers = { origin: "http://localhost:5173", "content-type": "application/json" };
    const body = JSON.stringify({
      email: "pg@example.com",
      password: "correct horse battery staple",
      name: "Pg",
    });
    expect(
      (await app.request("/api/auth/sign-up/email", { method: "POST", headers, body })).status,
    ).toBe(200);
    const signIn = await app.request("/api/auth/sign-in/email", { method: "POST", headers, body });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const me = await app.request("/api/desk/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ email: "pg@example.com", emailVerified: false });
    expect(await db`select count(*) as n from merchants`).toEqual([{ n: 1 }]);
    expect(mail).toHaveLength(1);
  }, 60_000);
});
