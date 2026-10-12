import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLIENT_IP_HEADER, createAuth } from "../../src/platform/auth.ts";
import { loadConfig } from "../../src/platform/config.ts";
import { type Db, createDb } from "../../src/platform/db.ts";
import {
  type AppEnv,
  errorHandler,
  idempotency,
  jsonBody,
  requestContext,
} from "../../src/platform/http.ts";
import { createLogger } from "../../src/platform/logger.ts";
import type { MailMessage } from "../../src/platform/mailer.ts";
import { MIGRATIONS_DIR, pendingMigrations, runMigrations } from "../../src/platform/migrate.ts";
import { consumeRateLimit } from "../../src/platform/rate-limit.ts";
import { createBackground } from "../../src/services/background.ts";

// Races that a single-session PGlite cannot exercise. Runs only when TEST_DATABASE_URL points at a
// disposable Postgres; each suite works inside its own schema and drops it afterwards.
const databaseUrl = process.env.TEST_DATABASE_URL;

function schemaUrl(schema: string): string {
  const url = new URL(databaseUrl ?? "");
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

async function openIn(schema: string): Promise<Db> {
  return createDb({ databaseUrl: schemaUrl(schema), pgliteDir: null, env: "test" });
}

describe.skipIf(!databaseUrl)("platform on a real Postgres server", () => {
  const schemas: string[] = [];
  let admin: Db;

  async function freshSchema(): Promise<string> {
    const schema = `shade_platform_${randomBytes(4).toString("hex")}`;
    await admin.query(`create schema ${schema}`);
    schemas.push(schema);
    return schema;
  }

  beforeAll(async () => {
    admin = await createDb({ databaseUrl: databaseUrl ?? null, pgliteDir: null, env: "test" });
  });

  afterAll(async () => {
    for (const schema of schemas) await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.close();
  });

  it("maps driver types like PGlite does", async () => {
    const at = new Date("2026-10-02T12:34:56.789Z");
    const [row] = await admin`
      select ${41}::int8 + 1 as n, array[1, 2]::int8[] as arr, ${"0.01"}::numeric(20, 8) as amount,
             ${at}::timestamptz as at, count(*) as total`;
    expect(row).toEqual({ n: 42, arr: [1, 2], amount: "0.01000000", at, total: 1 });
    await expect(admin`select ${"9007199254740993"}::int8 as big`).rejects.toThrow(RangeError);
  });

  it.each([false, true])(
    "serializes concurrent migration runners (sessionLock=%s)",
    async (sessionLock) => {
      const schema = await freshSchema();
      const runners = await Promise.all([openIn(schema), openIn(schema), openIn(schema)]);
      try {
        const results = await Promise.all(runners.map((db) => runMigrations(db, { sessionLock })));
        const applied = results.flatMap((result) => result.applied).sort();
        const shipped = readdirSync(MIGRATIONS_DIR)
          .filter((name) => name.endsWith(".sql"))
          .sort();
        // Every file applied exactly once across the three runners.
        expect(applied).toEqual(shipped);
        expect(await pendingMigrations(runners[0]!)).toEqual([]);
      } finally {
        await Promise.all(runners.map((db) => db.close()));
      }
    },
    120_000,
  );

  it("counts concurrent rate-limit hits exactly", async () => {
    const schema = await freshSchema();
    const db = await openIn(schema);
    try {
      await runMigrations(db);
      const now = new Date("2026-10-02T12:00:00Z");
      const results = await Promise.all(
        Array.from({ length: 40 }, () => consumeRateLimit(db, "race", 10, 60, now)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(10);
      const [row] = await db<{
        count: number;
      }>`select count from rate_limits where bucket = ${"race"}`;
      expect(row?.count).toBe(40);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("runs a duplicate Idempotency-Key in flight exactly once", async () => {
    const schema = await freshSchema();
    const db = await openIn(schema);
    try {
      await runMigrations(db);
      await db`insert into "user" (id, name, email, "emailVerified") values (${"u1"}, ${"A"}, ${"a@example.com"}, ${true})`;
      await db`insert into merchants (id, user_id, network) values (${"m1"}, ${"u1"}, ${"testnet"})`;
      await db`insert into api_keys (id, merchant_id, kind, prefix, key_hash, network)
        values (${"key_1"}, ${"m1"}, ${"merchant"}, ${"sk_test_"}, ${"h1"}, ${"testnet"})`;
      await db.query("create table charges (id serial primary key, name text not null)");

      let executions = 0;
      const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
      const logger = createLogger({ logLevel: "silent", env: "test" });
      const idem = idempotency(db);
      const app = new Hono<AppEnv>();
      app.use("*", requestContext({ logger, config }));
      app.onError(errorHandler());
      app.post("/v1/charges", async (c) => {
        c.set("principal", {
          kind: "merchant",
          keyId: "key_1",
          merchantId: "m1",
          network: "testnet",
          jarId: null,
        });
        const body = await jsonBody(c, z.object({ name: z.string() }));
        return idem.run(c, async (sql) => {
          executions += 1;
          await sql`insert into charges (name) values (${body.name})`;
          await sql`select pg_sleep(0.3)`;
          return { status: 201, body: { name: body.name } };
        });
      });

      const send = () =>
        app.request("/v1/charges", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "in-flight" },
          body: JSON.stringify({ name: "agent call" }),
        });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const replayed = [a, b].filter((res) => res.headers.get("idempotent-replayed") === "true");
      expect(replayed).toHaveLength(1);
      expect(executions).toBe(1);
      expect(await db`select name from charges`).toEqual([{ name: "agent call" }]);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("reclaims an account parked on an unconfirmed email (Better Auth sign-up transaction)", async () => {
    // On Postgres Better Auth runs sign-up in a real transaction and calls onExistingUserSignUp
    // inside it; the reclaim must still commit after that transaction is gone.
    const schema = await freshSchema();
    const db = await openIn(schema);
    const logger = createLogger({ logLevel: "silent", env: "test" });
    const background = createBackground(logger);
    try {
      await runMigrations(db);
      const config = loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
      });
      const mail: MailMessage[] = [];
      const auth = createAuth({
        config,
        db,
        logger,
        background,
        mailer: { send: async (msg) => void mail.push(msg) },
        onUserCreated: async () => {},
      });
      let ip = 0;
      const post = (path: string, body: unknown) =>
        auth.handler(
          new Request(`${config.appOrigin}/api/auth${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: config.appOrigin,
              [CLIENT_IP_HEADER]: `198.51.100.${++ip}`,
            },
            body: JSON.stringify(body),
          }),
        );
      const email = "victim@example.com";
      expect(
        (await post("/sign-up/email", { email, password: "attacker chosen password", name: "A" }))
          .status,
      ).toBe(200);
      expect(
        (await post("/sign-up/email", { email, password: "victim chosen password", name: "V" }))
          .status,
      ).toBe(200);
      await background.idle();

      expect(mail.map((m) => [m.to, m.subject])).toEqual([
        [email, "Confirm your email for Shade"],
        [email, "Finish setting up Shade"],
      ]);
      expect(
        (await post("/sign-in/email", { email, password: "attacker chosen password" })).status,
      ).toBe(401);
      const token = new URL(
        mail[1]!.text.split("\n").find((line) => line.includes("/reset-password?"))!,
      ).searchParams.get("token");
      expect(
        (await post("/reset-password", { token, newPassword: "victim chosen password" })).status,
      ).toBe(200);
      expect(
        (await post("/sign-in/email", { email, password: "victim chosen password" })).status,
      ).toBe(200);
    } finally {
      await background.idle();
      await db.close();
    }
  }, 120_000);
});
