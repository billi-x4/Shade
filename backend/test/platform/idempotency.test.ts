import { type Context, Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApiErrorBody } from "../../src/contract/index.ts";
import { loadConfig } from "../../src/platform/config.ts";
import { newId, sha256Hex } from "../../src/platform/crypto.ts";
import type { Db } from "../../src/platform/db.ts";
import { AppError } from "../../src/platform/errors.ts";
import {
  type AppEnv,
  errorHandler,
  idempotency,
  jsonBody,
  noStore,
  notFoundHandler,
  requestContext,
} from "../../src/platform/http.ts";
import { createLogger } from "../../src/platform/logger.ts";
import { createTestDb } from "../support/test-db.ts";

const NOW = new Date("2026-10-02T12:00:00Z");

let db: Db;
let app: Hono<AppEnv>;
let calls = 0;
let crashNext = false;

const WidgetBody = z.object({
  name: z.string(),
  outcome: z.enum(["created", "jar_empty", "bad_amount", "server_error"]).default("created"),
});

beforeAll(async () => {
  db = await createTestDb();
  await db.query("create table widgets (id text primary key, name text not null)");
  await db`insert into "user" (id, name, email, "emailVerified") values (${"u1"}, ${"A"}, ${"a@example.com"}, ${true})`;
  await db`insert into merchants (id, user_id, network) values (${"m1"}, ${"u1"}, ${"testnet"})`;
  await db.query(
    `insert into api_keys (id, merchant_id, kind, prefix, key_hash, network)
     values ('key_1', 'm1', 'merchant', 'sk_test_', 'h1', 'testnet'),
            ('key_2', 'm1', 'merchant', 'sk_test_', 'h2', 'testnet')`,
  );

  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const logger = createLogger({ logLevel: "silent", env: "test" });
  const idem = idempotency(db, () => NOW);
  app = new Hono<AppEnv>();
  app.use("*", requestContext({ logger, config }));
  app.use("*", noStore());
  app.onError(errorHandler());
  app.notFound(notFoundHandler());
  app.use("/v1/*", async (c, next) => {
    c.set("principal", {
      kind: "merchant",
      keyId: c.req.header("x-test-key") ?? "key_1",
      merchantId: "m1",
      network: "testnet",
      jarId: null,
    });
    await next();
  });
  const handler = async (c: Context<AppEnv>) => {
    const body = await jsonBody(c, WidgetBody);
    return idem.run(c, async (sql) => {
      calls += 1;
      const id = newId("w");
      await sql`insert into widgets (id, name) values (${id}, ${body.name})`;
      if (crashNext) {
        crashNext = false;
        throw new Error("database exploded");
      }
      if (body.outcome === "jar_empty") {
        throw new AppError(402, "JAR_EMPTY", "Jar empty. The agent cannot spend.", {
          remaining_zec: "0",
        });
      }
      if (body.outcome === "bad_amount") throw new AppError(400, "BAD_AMOUNT", "Enter an amount.");
      if (body.outcome === "server_error") {
        return { status: 503, body: { error: "CHAIN_UNAVAILABLE", message: "Chain is down." } };
      }
      return { status: 201, body: { id, name: body.name } };
    });
  };
  app.post("/v1/widgets", handler);
  app.post("/v1/widgets/other", handler);
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  calls = 0;
  crashNext = false;
  await db.query("delete from idempotency_keys");
  await db.query("delete from widgets");
});

function post(body: unknown, headers: Record<string, string> = {}, path = "/v1/widgets") {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

async function storedRows() {
  return db<{ api_key_id: string; idem_key: string; response_status: number }>`
    select api_key_id, idem_key, response_status from idempotency_keys order by api_key_id`;
}

async function widgetCount(): Promise<number> {
  const [row] = await db<{ n: number }>`select count(*) as n from widgets`;
  return row?.n ?? 0;
}

describe("idempotency.run", () => {
  it("runs without storing anything when no Idempotency-Key is sent", async () => {
    expect((await post({ name: "a" })).status).toBe(201);
    expect((await post({ name: "a" })).status).toBe(201);
    expect(calls).toBe(2);
    expect(await storedRows()).toEqual([]);
  });

  it("replays the stored response for the same key and request", async () => {
    const first = await post({ name: "a" }, { "idempotency-key": "order-1042" });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const firstText = await first.text();

    const replay = await post({ name: "a" }, { "idempotency-key": "order-1042" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("content-type")).toMatch(/application\/json/);
    expect(await replay.text()).toBe(firstText);
    expect(calls).toBe(1);
    expect(await widgetCount()).toBe(1);
    expect(await storedRows()).toEqual([
      { api_key_id: "key_1", idem_key: "order-1042", response_status: 201 },
    ]);
  });

  it("answers 422 when a key is reused for a different body or path", async () => {
    await post({ name: "a" }, { "idempotency-key": "k" });
    const otherBody = await post({ name: "b" }, { "idempotency-key": "k" });
    expect(otherBody.status).toBe(422);
    expect(((await otherBody.json()) as ApiErrorBody).error).toBe("IDEMPOTENCY_MISMATCH");
    const otherPath = await post({ name: "a" }, { "idempotency-key": "k" }, "/v1/widgets/other");
    expect(otherPath.status).toBe(422);
    expect(calls).toBe(1);
  });

  it("scopes keys to the API key", async () => {
    await post({ name: "a" }, { "idempotency-key": "shared" });
    const other = await post({ name: "a" }, { "idempotency-key": "shared", "x-test-key": "key_2" });
    expect(other.status).toBe(201);
    expect(other.headers.get("idempotent-replayed")).toBeNull();
    expect(calls).toBe(2);
  });

  it("rejects malformed keys with 400 and stores nothing", async () => {
    for (const key of ["has space", "x".repeat(256), "tab\tkey", "été"]) {
      const res = await post({ name: "a" }, { "idempotency-key": key });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiErrorBody).error).toBe("INVALID_REQUEST");
    }
    expect((await post({ name: "a" }, { "idempotency-key": "~".repeat(255) })).status).toBe(201);
    expect(calls).toBe(1);
  });

  it("stores business 4xx outcomes without their side effects and replays them", async () => {
    const first = await post(
      { name: "a", outcome: "jar_empty" },
      { "idempotency-key": "charge-1", "x-request-id": "r1" },
    );
    expect(first.status).toBe(402);
    expect(await first.json()).toEqual({
      error: "JAR_EMPTY",
      message: "Jar empty. The agent cannot spend.",
      remaining_zec: "0",
      request_id: "r1",
    });
    expect(await widgetCount()).toBe(0);
    expect(await storedRows()).toEqual([
      { api_key_id: "key_1", idem_key: "charge-1", response_status: 402 },
    ]);

    const replay = await post(
      { name: "a", outcome: "jar_empty" },
      { "idempotency-key": "charge-1", "x-request-id": "r2" },
    );
    expect(replay.status).toBe(402);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toMatchObject({
      error: "JAR_EMPTY",
      remaining_zec: "0",
      request_id: "r2",
    });
    expect(calls).toBe(1);
  });

  it("never stores validation errors, crashes or 5xx outcomes", async () => {
    const bad = await post({ name: "a", outcome: "bad_amount" }, { "idempotency-key": "k1" });
    expect(bad.status).toBe(400);
    expect(await storedRows()).toEqual([]);

    crashNext = true;
    const crashed = await post({ name: "a" }, { "idempotency-key": "k2" });
    expect(crashed.status).toBe(500);
    expect(await storedRows()).toEqual([]);
    expect(await widgetCount()).toBe(0);
    const retried = await post({ name: "a" }, { "idempotency-key": "k2" });
    expect(retried.status).toBe(201);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();

    const down = await post({ name: "b", outcome: "server_error" }, { "idempotency-key": "k3" });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "CHAIN_UNAVAILABLE", message: "Chain is down." });
    expect((await storedRows()).map((row) => row.idem_key)).toEqual(["k2"]);
    expect(await widgetCount()).toBe(1);
  });

  it("treats rows older than 24 hours as absent", async () => {
    await db`insert into idempotency_keys (api_key_id, idem_key, request_hash, response_status, response_body, created_at)
      values (${"key_1"}, ${"old"}, ${"stale-hash"}, ${201}, ${"{}"}, ${new Date(NOW.getTime() - 25 * 3600 * 1000)})`;
    const res = await post({ name: "a" }, { "idempotency-key": "old" });
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    expect(calls).toBe(1);
  });

  it("reports an unfinished claim as in progress", async () => {
    const raw = JSON.stringify({ name: "a" });
    await db`insert into idempotency_keys (api_key_id, idem_key, request_hash, response_status, response_body, created_at)
      values (${"key_1"}, ${"pending"}, ${sha256Hex(`POST\n/v1/widgets\n${raw}`)}, ${0}, ${""}, ${NOW})`;
    const res = await post({ name: "a" }, { "idempotency-key": "pending" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(calls).toBe(0);
  });
});
