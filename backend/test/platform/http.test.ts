import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApiErrorBody } from "../../src/contract/index.ts";
import { type Config, loadConfig } from "../../src/platform/config.ts";
import type { Db } from "../../src/platform/db.ts";
import { AppError } from "../../src/platform/errors.ts";
import {
  type AppEnv,
  type Principal,
  apiKeyAuth,
  edgeGuard,
  errorHandler,
  jsonBody,
  noStore,
  notFoundHandler,
  rateLimit,
  requestContext,
  requireFreshSession,
  requireSameOrigin,
} from "../../src/platform/http.ts";
import { createLogger } from "../../src/platform/logger.ts";
import { createTestDb } from "../support/test-db.ts";

const logger = createLogger({ logLevel: "silent", env: "test" });

function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env });
}

function baseApp(config: Config = testConfig()): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext({ logger, config }));
  app.use("*", noStore());
  app.onError(errorHandler());
  app.notFound(notFoundHandler());
  return app;
}

async function errorOf(res: Response): Promise<ApiErrorBody> {
  return (await res.json()) as ApiErrorBody;
}

describe("requestContext", () => {
  const app = baseApp();
  app.get("/ctx", (c) =>
    c.json({
      requestId: c.get("requestId"),
      clientIp: c.get("clientIp"),
      forwardedToAuth: c.req.header("x-shade-client-ip") ?? null,
    }),
  );

  it("echoes a well-formed X-Request-Id and generates one otherwise", async () => {
    const good = await app.request("/ctx", { headers: { "x-request-id": "abc.DEF_1:2-3" } });
    expect(good.headers.get("x-request-id")).toBe("abc.DEF_1:2-3");
    expect(((await good.json()) as { requestId: string }).requestId).toBe("abc.DEF_1:2-3");

    for (const bad of ["has space", "x".repeat(65), "semi;colon", "émoji"]) {
      const res = await app.request("/ctx", { headers: { "x-request-id": bad } });
      const id = res.headers.get("x-request-id") ?? "";
      expect(id).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
      expect(((await res.json()) as { requestId: string }).requestId).toBe(id);
    }
  });

  it("uses the socket address and strips any inbound x-shade-client-ip", async () => {
    const res = await app.request(
      "/ctx",
      { headers: { "x-shade-client-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7" } },
      { incoming: { socket: { remoteAddress: "::ffff:198.51.100.7" } } },
    );
    expect(await res.json()).toMatchObject({
      clientIp: "198.51.100.7",
      forwardedToAuth: "198.51.100.7",
    });

    const anonymous = await app.request("/ctx", { headers: { "x-shade-client-ip": "6.6.6.6" } });
    expect(await anonymous.json()).toMatchObject({ clientIp: null, forwardedToAuth: null });
  });

  it("trusts the configured proxy header only behind a matching edge secret", async () => {
    const proxied = baseApp(testConfig({ TRUST_PROXY: "x-forwarded-for" }));
    proxied.get("/ctx", (c) =>
      c.json({ clientIp: c.get("clientIp"), auth: c.req.header("x-shade-client-ip") }),
    );
    const res = await proxied.request("/ctx", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(await res.json()).toEqual({ clientIp: "203.0.113.5", auth: "203.0.113.5" });
    const garbage = await proxied.request("/ctx", { headers: { "x-forwarded-for": "not-an-ip" } });
    expect(await garbage.json()).toEqual({ clientIp: null });
    // With a socket, a missing or unparseable trusted header falls back to it (a shared bucket).
    const peer = { incoming: { socket: { remoteAddress: "10.0.0.9" } } };
    for (const headers of [{ "x-forwarded-for": "not-an-ip" }, {}]) {
      const fallback = await proxied.request("/ctx", { headers }, peer);
      expect(await fallback.json()).toEqual({ clientIp: "10.0.0.9", auth: "10.0.0.9" });
    }

    const edged = baseApp(
      testConfig({ TRUST_PROXY: "x-real-ip", EDGE_SHARED_SECRET: "edge-secret-0123456789" }),
    );
    edged.get("/ctx", (c) => c.json({ clientIp: c.get("clientIp") }));
    const socket = { incoming: { socket: { remoteAddress: "10.1.1.1" } } };
    const spoofed = await edged.request(
      "/ctx",
      { headers: { "x-real-ip": "203.0.113.9" } },
      socket,
    );
    expect(await spoofed.json()).toEqual({ clientIp: "10.1.1.1" });
    const viaEdge = await edged.request(
      "/ctx",
      { headers: { "x-real-ip": "2001:db8::7", "x-shade-edge": "edge-secret-0123456789" } },
      socket,
    );
    expect(await viaEdge.json()).toEqual({ clientIp: "2001:db8::7" });
  });

  it("behind Vercel → Railway: the Vercel header via the edge, Railway's X-Real-IP otherwise", async () => {
    const SECRET = "edge-secret-0123456789";
    const app = baseApp(
      testConfig({
        TRUST_PROXY: "x-vercel-forwarded-for",
        TRUST_PROXY_DIRECT: "x-real-ip",
        EDGE_SHARED_SECRET: SECRET,
      }),
    );
    app.get("/ctx", (c) =>
      c.json({ clientIp: c.get("clientIp"), auth: c.req.header("x-shade-client-ip") }),
    );
    // Railway's edge overwrote these with Vercel's egress address and its own hop.
    const railway = { "x-real-ip": "76.76.21.21", "x-forwarded-for": "76.76.21.21, 100.64.0.2" };
    const socket = { incoming: { socket: { remoteAddress: "100.64.0.2" } } };
    const ip = async (headers: Record<string, string>) =>
      (await (await app.request("/ctx", { headers }, socket)).json()) as {
        clientIp: string | null;
        auth?: string;
      };

    expect(
      await ip({ ...railway, "x-shade-edge": SECRET, "x-vercel-forwarded-for": "198.51.100.20" }),
    ).toEqual({ clientIp: "198.51.100.20", auth: "198.51.100.20" });
    // The Vercel header did not arrive: Railway's header beats one shared "unknown" bucket.
    expect(await ip({ ...railway, "x-shade-edge": SECRET })).toMatchObject({
      clientIp: "76.76.21.21",
    });
    // A single-address header a hop appended to fails closed instead of trusting its first entry.
    expect(
      await ip({
        ...railway,
        "x-shade-edge": SECRET,
        "x-vercel-forwarded-for": "198.51.100.99, 198.51.100.20",
      }),
    ).toMatchObject({ clientIp: "76.76.21.21" });
    // A direct caller cannot pick its bucket with the Vercel header: Railway's X-Real-IP wins.
    expect(
      await ip({ "x-real-ip": "203.0.113.50", "x-vercel-forwarded-for": "198.51.100.99" }),
    ).toMatchObject({ clientIp: "203.0.113.50" });
    expect(await ip({ "x-shade-edge": "wrong-secret-0123456789" })).toMatchObject({
      clientIp: "100.64.0.2",
    });
  });
});

describe("requestContext boot warnings", () => {
  function captured() {
    const lines: string[] = [];
    const log = createLogger(
      { logLevel: "warn", env: "production" },
      { write: (line: string) => void lines.push(line) },
    );
    return { log, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  }

  it("logs the production proxy warnings once, when the app is built", async () => {
    const { log, records } = captured();
    const config: Config = { ...testConfig(), env: "production" };
    const app = new Hono<AppEnv>();
    app.use("*", requestContext({ logger: log, config }));
    app.get("/x", (c) => c.json({ ok: true }));
    expect(records()).toEqual([
      expect.objectContaining({
        level: "warn",
        component: "http",
        msg: expect.stringMatching(/^TRUST_PROXY=none: /),
      }),
    ]);
    await app.request("/x");
    expect(records().filter((r) => r.level === "warn")).toHaveLength(1);
  });

  it("stays quiet behind an edge-authenticated proxy", () => {
    const { log, records } = captured();
    const config: Config = {
      ...testConfig({
        TRUST_PROXY: "x-forwarded-for",
        EDGE_SHARED_SECRET: "edge-secret-0123456789",
      }),
      env: "production",
    };
    requestContext({ logger: log, config });
    expect(records()).toEqual([]);
  });
});

describe("behind @hono/node-server", () => {
  it("reads the socket address and replaces x-shade-client-ip before handlers run", async () => {
    const app = baseApp();
    app.post("/echo", async (c) => {
      const raw = c.req.raw.clone();
      return c.json({
        clientIp: c.get("clientIp"),
        header: c.req.header("x-shade-client-ip"),
        cloned: raw.headers.get("x-shade-client-ip"),
        body: await raw.text(),
      });
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: "POST",
        headers: { "x-shade-client-ip": "6.6.6.6", "content-type": "application/json" },
        body: '{"a":1}',
      });
      expect(res.headers.get("x-request-id")).toMatch(/^req_/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        clientIp: "127.0.0.1",
        header: "127.0.0.1",
        cloned: "127.0.0.1",
        body: '{"a":1}',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("errorHandler, notFound and noStore", () => {
  const app = baseApp();
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/app-error", () => {
    throw new AppError(402, "JAR_EMPTY", "Jar empty. The agent cannot spend.", {
      remaining_zec: "0.001",
    });
  });
  app.get("/limited", () => {
    throw new AppError(429, "RATE_LIMITED", "Too many requests.", { retry_after: 12.2 });
  });
  app.get("/zod", (c) => {
    z.object({ amount_zec: z.string(), network: z.enum(["testnet", "mainnet"]) }).parse({
      amount_zec: 42,
      network: "secret-value-123",
    });
    return c.json({});
  });
  app.get("/crash", () => {
    throw new Error("connection string postgres://user:hunter2@db leaked");
  });
  app.post("/limit", bodyLimit({ maxSize: 4 }), (c) => c.json({}));

  it("sets no-store and x-request-id on success and on errors", async () => {
    for (const path of ["/ok", "/app-error", "/missing", "/crash"]) {
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    }
  });

  it("renders AppError with its status, code, extra fields and request id", async () => {
    const res = await app.request("/app-error", { headers: { "x-request-id": "r1" } });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: "JAR_EMPTY",
      message: "Jar empty. The agent cannot spend.",
      remaining_zec: "0.001",
      request_id: "r1",
    });
    const limited = await app.request("/limited");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("13");
  });

  it("maps zod failures to INVALID_REQUEST issues without echoing values", async () => {
    const res = await app.request("/zod");
    expect(res.status).toBe(400);
    const body = await errorOf(res);
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.issues?.map((issue) => issue.path)).toEqual(["amount_zec", "network"]);
    expect(JSON.stringify(body)).not.toContain("secret-value-123");
    expect(JSON.stringify(body)).not.toContain("42");
  });

  it("hides unknown errors behind INTERNAL", async () => {
    const res = await app.request("/crash", { headers: { "x-request-id": "r2" } });
    expect(res.status).toBe(500);
    const body = await errorOf(res);
    expect(body).toMatchObject({ error: "INTERNAL", request_id: "r2" });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("maps Hono HTTP exceptions and unknown routes", async () => {
    const big = await app.request("/limit", {
      method: "POST",
      body: "123456789",
      headers: { "content-type": "application/json" },
    });
    expect(big.status).toBe(413);
    expect((await errorOf(big)).error).toBe("PAYLOAD_TOO_LARGE");
    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).error).toBe("NOT_FOUND");
  });
});

describe("jsonBody", () => {
  const app = baseApp();
  const schema = z.object({ amount_zec: z.string().default("0"), memo: z.string().optional() });
  app.post("/body", async (c) => {
    const body = await jsonBody(c, schema);
    return c.json({ body, raw: c.get("rawBody") });
  });

  const post = (body: RequestInit["body"], headers: Record<string, string> = {}) =>
    app.request("/body", { method: "POST", body, headers, duplex: "half" } as RequestInit);

  it("parses JSON and keeps the raw text", async () => {
    const res = await post('{"amount_zec":"0.5"}', {
      "content-type": "application/json; charset=utf-8",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { amount_zec: "0.5" }, raw: '{"amount_zec":"0.5"}' });
  });

  it("accepts an empty body with or without a content type", async () => {
    expect(await (await post(null)).json()).toEqual({ body: { amount_zec: "0" }, raw: "" });
    expect((await post("", { "content-type": "text/plain" })).status).toBe(200);
  });

  it("requires application/json for non-empty bodies", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonp"]) {
      const res = await post('{"amount_zec":"1"}', { "content-type": type });
      expect(res.status).toBe(415);
      expect((await errorOf(res)).error).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    expect((await post('{"amount_zec":"1"}')).status).toBe(415);
  });

  it("caps bodies at 16 KB, declared or streamed", async () => {
    const atLimit = JSON.stringify({ memo: "m".repeat(16 * 1024 - 11) });
    expect(Buffer.byteLength(atLimit)).toBe(16 * 1024);
    expect((await post(atLimit, { "content-type": "application/json" })).status).toBe(200);

    const over = JSON.stringify({ memo: "m".repeat(16 * 1024) });
    const declared = await post(over, { "content-type": "application/json" });
    expect(declared.status).toBe(413);
    expect((await errorOf(declared)).error).toBe("PAYLOAD_TOO_LARGE");

    const chunk = new TextEncoder().encode("x".repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 8) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const streamed = await post(stream, { "content-type": "application/json" });
    expect(streamed.status).toBe(413);
  });

  it("rejects malformed JSON, bad UTF-8 and schema violations with 400", async () => {
    const malformed = await post("{nope", { "content-type": "application/json" });
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await errorOf(malformed))).not.toContain("nope");
    const badUtf8 = await post(new Uint8Array([0x7b, 0xff, 0x7d]), {
      "content-type": "application/json",
    });
    expect(badUtf8.status).toBe(400);
    const invalid = await post('{"amount_zec":5}', { "content-type": "application/json" });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).issues).toEqual([
      { path: "amount_zec", message: expect.any(String) },
    ]);
  });
});

describe("requireSameOrigin", () => {
  const config = testConfig({ APP_ORIGIN: "http://localhost:5173" });
  const app = baseApp(config);
  app.use("/api/*", requireSameOrigin(config));
  app.all("/api/thing", (c) => c.json({ ok: true }));

  const call = (method: string, headers: Record<string, string>) =>
    app.request("/api/thing", { method, headers });

  it("accepts the app origin, its loopback twin, and same-origin fetch metadata", async () => {
    expect((await call("POST", { origin: "http://localhost:5173" })).status).toBe(200);
    expect((await call("DELETE", { origin: "http://127.0.0.1:5173" })).status).toBe(200);
    expect((await call("PUT", { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("rejects foreign or missing origins on unsafe methods", async () => {
    const rejected: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "http://localhost:5174" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      {},
      { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of rejected) {
      const res = await call("POST", headers);
      expect(res.status).toBe(403);
      expect((await errorOf(res)).error).toBe("FORBIDDEN_ORIGIN");
    }
  });

  it("lets safe methods through", async () => {
    expect((await call("GET", { origin: "https://evil.example" })).status).toBe(200);
    expect((await call("HEAD", {})).status).toBe(200);
  });

  it("never trusts the dev twin in production", () => {
    const prod = loadConfig({
      NODE_ENV: "production",
      APP_ORIGIN: "http://localhost:5173",
      DATABASE_URL: "postgres://localhost/shade",
      BETTER_AUTH_SECRET: "s".repeat(40),
      SHADE_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
    });
    expect(prod.devOrigins).toEqual([]);
  });
});

describe("edgeGuard", () => {
  it("requires the shared edge header when configured", async () => {
    const config = testConfig({ EDGE_SHARED_SECRET: "edge-secret-0123456789" });
    const app = baseApp(config);
    app.use("/api/*", edgeGuard(config));
    app.get("/api/x", (c) => c.json({ ok: true }));
    expect((await app.request("/api/x")).status).toBe(403);
    expect((await app.request("/api/x", { headers: { "x-shade-edge": "wrong" } })).status).toBe(
      403,
    );
    expect(
      (await app.request("/api/x", { headers: { "x-shade-edge": "edge-secret-0123456789" } }))
        .status,
    ).toBe(200);

    const open = baseApp();
    open.use("/api/*", edgeGuard(testConfig()));
    open.get("/api/x", (c) => c.json({ ok: true }));
    expect((await open.request("/api/x")).status).toBe(200);
  });
});

describe("rateLimit", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it("throttles per key and skips when the key is null", async () => {
    const now = () => new Date("2026-10-02T12:00:10Z");
    const app = baseApp();
    app.use(
      "/limited/:who",
      rateLimit(db, {
        name: "test:who",
        limit: 2,
        windowSec: 60,
        key: (c) => (c.req.param("who") === "anon" ? null : (c.req.param("who") ?? null)),
        now,
      }),
    );
    app.get("/limited/:who", (c) => c.json({ ok: true }));

    expect((await app.request("/limited/alice")).status).toBe(200);
    expect((await app.request("/limited/alice")).status).toBe(200);
    const third = await app.request("/limited/alice");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("50");
    expect(await errorOf(third)).toMatchObject({ error: "RATE_LIMITED", retry_after: 50 });
    expect((await app.request("/limited/bob")).status).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await app.request("/limited/anon")).status).toBe(200);
    const [row] = await db<{
      count: number;
    }>`select count from rate_limits where bucket = ${"test:who:alice"}`;
    expect(row?.count).toBe(3);
  });
});

describe("apiKeyAuth", () => {
  const merchant: Principal = {
    kind: "merchant",
    keyId: "key_1",
    merchantId: "m_1",
    network: "testnet",
    jarId: null,
  };
  const live: Principal = { ...merchant, keyId: "key_2", network: "mainnet" };
  const seen: string[] = [];
  const config = testConfig();
  const app = baseApp(config);
  app.use(
    "/v1/*",
    apiKeyAuth(async (token) => {
      seen.push(token);
      if (token === "sk_test_valid0123456789") return merchant;
      if (token === "sk_live_valid0123456789") return live;
      return null;
    }, config),
  );
  app.get("/v1/me", (c) => c.json(c.get("principal") ?? null));

  it("resolves a well-formed bearer token to its principal", async () => {
    const res = await app.request("/v1/me", {
      headers: { authorization: "Bearer sk_test_valid0123456789" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(merchant);
    const lower = await app.request("/v1/me", {
      headers: { authorization: "bearer sk_test_valid0123456789" },
    });
    expect(lower.status).toBe(200);
  });

  it("rejects missing, malformed and unknown keys without consulting the store for garbage", async () => {
    seen.length = 0;
    for (const authorization of [
      undefined,
      "sk_test_valid0123456789",
      "Basic dXNlcjpwYXNz",
      "Bearer pk_test_abc",
      "Bearer sk_test_",
      "Bearer sk_test_abc def",
      `Bearer sk_test_${"a".repeat(300)}`,
    ]) {
      const res = await app.request("/v1/me", { headers: authorization ? { authorization } : {} });
      expect(res.status).toBe(401);
      expect((await errorOf(res)).error).toBe("UNAUTHORIZED");
    }
    expect(seen).toEqual([]);
    const unknown = await app.request("/v1/me", {
      headers: { authorization: "Bearer ag_unknown123" },
    });
    expect(unknown.status).toBe(401);
    expect(seen).toEqual(["ag_unknown123"]);
  });

  it("ignores session cookies", async () => {
    const res = await app.request("/v1/me", { headers: { cookie: "shade.session_token=abc" } });
    expect(res.status).toBe(401);
  });

  it("refuses keys for networks this server does not enable", async () => {
    const res = await app.request("/v1/me", {
      headers: { authorization: "Bearer sk_live_valid0123456789" },
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).error).toBe("NETWORK_DISABLED");
  });
});

describe("requireFreshSession", () => {
  const now = () => new Date("2026-10-02T12:00:00Z");
  const app = baseApp();
  app.use("/desk/*", async (c, next) => {
    const age = Number(c.req.query("age"));
    if (Number.isFinite(age))
      c.set("session", { id: "s1", createdAt: new Date(now().getTime() - age * 1000) });
    await next();
  });
  app.post("/desk/fresh", requireFreshSession(900, now), (c) => c.json({ ok: true }));

  it("allows sessions up to 15 minutes old", async () => {
    expect((await app.request("/desk/fresh?age=0", { method: "POST" })).status).toBe(200);
    expect((await app.request("/desk/fresh?age=900", { method: "POST" })).status).toBe(200);
  });

  it("asks older sessions to sign in again", async () => {
    const res = await app.request("/desk/fresh?age=901", { method: "POST" });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).error).toBe("SESSION_NOT_FRESH");
    expect((await app.request("/desk/fresh", { method: "POST" })).status).toBe(401);
  });
});
