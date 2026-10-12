import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shade, ShadeConnectionError, ShadeError, VERSION } from "../src/index.ts";
import type { ShadeOptions } from "../src/index.ts";
import {
  wireChargeResult,
  wireEndpointCreated,
  wireGrant,
  wireGrantCreated,
  wireInvoice,
  wireJar,
  wireJarChargeInvoice,
  wireTag,
  wireTagResolution,
} from "./fixtures.ts";
import { camelizeDeep, errorOf, fakeFetch, json, settle } from "./helpers.ts";
import type { Reply } from "./helpers.ts";

const API_KEY = "sk_test_9fJx2LkQ7rT1uV4wY6zA";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function client(replies: Reply[], opts: Partial<ShadeOptions> = {}) {
  const fake = fakeFetch(replies);
  const shade = new Shade({ apiKey: API_KEY, fetch: fake.fetch, ...opts });
  return { shade, calls: fake.calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Shade options", () => {
  it.each([undefined, "", "sk_test_ with space", "sk_test_\n"])("rejects apiKey %j", (apiKey) => {
    expect(() => new Shade({ apiKey: apiKey as string })).toThrow(TypeError);
  });

  it.each([
    "",
    "shade-zcash.vercel.app",
    "ftp://shade-zcash.vercel.app",
    "https://shade-zcash.vercel.app/?x=1",
  ])("rejects baseUrl %j", (baseUrl) => {
    expect(() => new Shade({ apiKey: API_KEY, baseUrl })).toThrow(TypeError);
  });

  it.each([{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { maxRetries: -1 }, { maxRetries: Number.NaN }])(
    "rejects %j",
    (opts) => {
      expect(() => new Shade({ apiKey: API_KEY, ...opts })).toThrow(TypeError);
    },
  );

  it("defaults to https://shade-zcash.vercel.app and strips trailing slashes from baseUrl", async () => {
    const a = client([json(200, wireInvoice)]);
    await a.shade.invoices.get("inv_1");
    expect(a.calls[0]!.url).toBe("https://shade-zcash.vercel.app/v1/invoices/inv_1");

    const b = client([json(200, wireInvoice)], { baseUrl: "http://localhost:5173//" });
    await b.shade.invoices.get("inv_1");
    expect(b.calls[0]!.url).toBe("http://localhost:5173/v1/invoices/inv_1");
  });

  it("uses globalThis.fetch when no fetch is given", async () => {
    const fake = fakeFetch([json(200, wireInvoice)]);
    vi.stubGlobal("fetch", fake.fetch);
    await new Shade({ apiKey: API_KEY }).invoices.get("inv_1");
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps the API key out of inspect output and errors", async () => {
    const { shade } = client([json(401, { error: "UNAUTHORIZED", message: "Invalid API key." })]);
    expect(inspect(shade, { depth: 10, showHidden: true })).not.toContain(API_KEY);
    const err = await shade.invoices.get("inv_1").catch((e: unknown) => e);
    expect(inspect(err, { depth: 10 })).not.toContain(API_KEY);
  });

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("request building", () => {
  it("invoices.create sends auth, JSON, an idempotency key and the SDK user agent", async () => {
    const { shade, calls } = client([json(201, wireInvoice)]);
    await shade.invoices.create({
      amountZec: "0.01",
      memo: "order_1042",
      expiresInSec: 600,
      tag: "payroll",
    });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://shade-zcash.vercel.app/v1/invoices");
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.accept).toBe("application/json");
    expect(call.headers["user-agent"]).toBe(`shade-sdk/${VERSION}`);
    expect(call.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(call.body).toBe(
      '{"amount_zec":"0.01","memo":"order_1042","expires_in_sec":600,"tag":"payroll"}',
    );
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits optional fields that were not given", async () => {
    const { shade, calls } = client([json(201, wireInvoice)]);
    await shade.invoices.create({ amountZec: "0.01" });
    expect(calls[0]!.body).toBe('{"amount_zec":"0.01"}');
  });

  it("uses a new idempotency key for each logical call", async () => {
    const { shade, calls } = client([json(201, wireChargeResult), json(201, wireChargeResult)]);
    await shade.jars.charge("jar_1", { amountZec: "0.002" });
    await shade.jars.charge("jar_1", { amountZec: "0.002" });
    const [a, b] = calls.map((c) => c.headers["idempotency-key"]);
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  it("sends bodiless POSTs without a body, content type or idempotency key", async () => {
    const { shade, calls } = client([
      json(200, wireJar),
      json(200, wireGrant),
      json(200, wireInvoice),
    ]);
    await shade.jars.kill("jar_1");
    await shade.grants.revoke("grt_1");
    await shade.invoices.cancel("inv_1");
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.body).toBeUndefined();
      expect(call.headers["content-type"]).toBeUndefined();
      expect(call.headers["idempotency-key"]).toBeUndefined();
    }
  });

  it("only creates and charges carry an idempotency key", async () => {
    const { shade, calls } = client([
      json(201, wireJar),
      json(201, wireGrantCreated),
      json(201, wireEndpointCreated),
      json(201, wireTag),
      json(200, wireInvoice),
    ]);
    await shade.jars.create({ capZec: "0.006", label: "research-agent" });
    await shade.grants.create({ scope: "all" });
    await shade.webhooks.create({ url: "https://vendor.example/hooks/shade" });
    await shade.tags.create({ name: "asharib" });
    await shade.invoices.reportDetection("inv_1", {
      txid: "a".repeat(64),
      amountZec: "0.01",
      memoHash: wireInvoice.memo_hash,
      pool: "ironwood",
    });
    expect(calls.map((c) => c.headers["idempotency-key"] !== undefined)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("encodes path segments and rejects empty ids before any request", async () => {
    const { shade, calls } = client([json(200, wireInvoice)]);
    await shade.invoices.get("inv/../x?y");
    expect(calls[0]!.url).toBe("https://shade-zcash.vercel.app/v1/invoices/inv%2F..%2Fx%3Fy");
    await expect(shade.invoices.cancel("")).rejects.toThrow(TypeError);
    await expect(shade.jars.charge("", { amountZec: "0.002" })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(1);
  });

  it("invoices.list sends status, cursor and limit as query parameters", async () => {
    const { shade, calls } = client([
      json(200, { items: [], next_cursor: null }),
      json(200, { items: [], next_cursor: null }),
      json(200, { items: [], next_cursor: null }),
    ]);
    await shade.invoices.list({ status: ["open", "paid_unverified"], cursor: "c_1", limit: 50 });
    await shade.invoices.list({ status: "expired" });
    await shade.invoices.list();
    expect(calls.map((c) => c.url)).toEqual([
      "https://shade-zcash.vercel.app/v1/invoices?status=open%2Cpaid_unverified&cursor=c_1&limit=50",
      "https://shade-zcash.vercel.app/v1/invoices?status=expired",
      "https://shade-zcash.vercel.app/v1/invoices",
    ]);
  });

  it("tags.resolve is public: no API key is sent, and a .shade suffix is accepted", async () => {
    const { shade, calls } = client([json(200, wireTagResolution)]);
    await shade.tags.resolve("asharib.shade");
    expect(calls[0]!.url).toBe("https://shade-zcash.vercel.app/v1/tags/asharib");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("grants.create sends days or expires_in_sec, never both", async () => {
    const { shade, calls } = client([json(201, wireGrantCreated), json(201, wireGrantCreated)]);
    await shade.grants.create({ scope: "payroll", days: 7 });
    await shade.grants.create({ scope: "payroll", expiresInSec: 600 });
    expect(calls.map((c) => c.body)).toEqual([
      '{"scope":"payroll","days":7}',
      '{"scope":"payroll","expires_in_sec":600}',
    ]);
    const both = { scope: "payroll", days: 7, expiresInSec: 600 } as unknown as { scope: string };
    await expect(shade.grants.create(both)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(2);
  });

  it("does not set User-Agent in browsers (it would break the CORS preflight)", async () => {
    vi.stubGlobal("document", {});
    const { shade, calls } = client([json(200, wireInvoice)]);
    await shade.invoices.get("inv_1");
    expect(calls[0]!.headers["user-agent"]).toBeUndefined();
  });
});

describe("response mapping", () => {
  const detection = {
    txid: "a".repeat(64),
    amountZec: "0.01",
    memoHash: wireInvoice.memo_hash,
    pool: "ironwood",
  } as const;
  const cases = [
    {
      name: "invoices.create",
      call: (s: Shade) => s.invoices.create({ amountZec: "0.01", memo: "order_1042" }),
      method: "POST",
      path: "/v1/invoices",
      body: { amount_zec: "0.01", memo: "order_1042" },
      status: 201,
      wire: wireInvoice,
    },
    {
      name: "invoices.get (jar charge)",
      call: (s: Shade) => s.invoices.get("inv_charge_1"),
      method: "GET",
      path: "/v1/invoices/inv_charge_1",
      body: undefined,
      status: 200,
      wire: wireJarChargeInvoice,
    },
    {
      name: "invoices.list",
      call: (s: Shade) => s.invoices.list({ limit: 1 }),
      method: "GET",
      path: "/v1/invoices?limit=1",
      body: undefined,
      status: 200,
      wire: { items: [wireInvoice], next_cursor: "c_2" },
    },
    {
      name: "invoices.cancel",
      call: (s: Shade) => s.invoices.cancel("inv_1"),
      method: "POST",
      path: "/v1/invoices/inv_1/cancel",
      body: undefined,
      status: 200,
      wire: { ...wireInvoice, status: "cancelled", detection: null },
    },
    {
      name: "invoices.reportDetection",
      call: (s: Shade) =>
        s.invoices.reportDetection("inv_1", { ...detection, source: "external_scanner" }),
      method: "POST",
      path: "/v1/invoices/inv_1/detections",
      body: {
        txid: detection.txid,
        amount_zec: "0.01",
        memo_hash: detection.memoHash,
        pool: "ironwood",
        source: "external_scanner",
      },
      status: 200,
      wire: { ...wireInvoice, status: "paid", verification: "ivk_scan", txid: detection.txid },
    },
    {
      name: "jars.create",
      call: (s: Shade) => s.jars.create({ capZec: "0.006", label: "research-agent" }),
      method: "POST",
      path: "/v1/jars",
      body: { cap_zec: "0.006", label: "research-agent" },
      status: 201,
      wire: wireJar,
    },
    {
      name: "jars.charge",
      call: (s: Shade) => s.jars.charge("jar_1", { amountZec: "0.002", memo: "api:search" }),
      method: "POST",
      path: "/v1/jars/jar_1/charge",
      body: { amount_zec: "0.002", memo: "api:search" },
      status: 201,
      wire: wireChargeResult,
    },
    {
      name: "jars.kill",
      call: (s: Shade) => s.jars.kill("jar_1"),
      method: "POST",
      path: "/v1/jars/jar_1/kill",
      body: undefined,
      status: 200,
      wire: { ...wireJar, status: "killed", killed_at: "2026-10-02T12:30:00.000Z" },
    },
    {
      name: "grants.create",
      call: (s: Shade) => s.grants.create({ scope: "payroll", days: 7 }),
      method: "POST",
      path: "/v1/grants",
      body: { scope: "payroll", days: 7 },
      status: 201,
      wire: wireGrantCreated,
    },
    {
      name: "grants.revoke",
      call: (s: Shade) => s.grants.revoke("grt_1"),
      method: "POST",
      path: "/v1/grants/grt_1/revoke",
      body: undefined,
      status: 200,
      wire: wireGrant,
    },
    {
      name: "webhooks.create",
      call: (s: Shade) => s.webhooks.create({ url: "https://vendor.example/hooks/shade" }),
      method: "POST",
      path: "/v1/webhooks",
      body: { url: "https://vendor.example/hooks/shade" },
      status: 201,
      wire: wireEndpointCreated,
    },
    {
      name: "tags.create",
      call: (s: Shade) => s.tags.create({ name: "asharib" }),
      method: "POST",
      path: "/v1/tags",
      body: { name: "asharib" },
      status: 201,
      wire: wireTag,
    },
    {
      name: "tags.resolve",
      call: (s: Shade) => s.tags.resolve("asharib"),
      method: "GET",
      path: "/v1/tags/asharib",
      body: undefined,
      status: 200,
      wire: wireTagResolution,
    },
  ];

  it.each(cases)(
    "$name maps every wire field to camelCase",
    async ({ call, method, path, body, status, wire }) => {
      const { shade, calls } = client([json(status, wire)]);
      const result = await call(shade);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(method);
      expect(calls[0]!.url).toBe(`https://shade-zcash.vercel.app${path}`);
      expect(calls[0]!.body === undefined ? undefined : JSON.parse(calls[0]!.body)).toEqual(body);
      expect(result).toStrictEqual(camelizeDeep(wire));
    },
  );

  it("exposes the PRD §9 field names", async () => {
    const { shade } = client([
      json(201, wireInvoice),
      json(201, wireChargeResult),
      json(201, wireGrantCreated),
    ]);
    const inv = await shade.invoices.create({ amountZec: "0.01", memo: "demo" });
    expect(inv).toMatchObject({
      id: "inv_1",
      payUrl: wireInvoice.pay_url,
      zip321: wireInvoice.zip321,
      address: wireInvoice.address,
      expiresAt: wireInvoice.expires_at,
      chainMemo: wireInvoice.chain_memo,
      createdHeight: wireInvoice.created_height,
    });
    expect(inv.detection?.requiredConfirmations).toBe(3);
    const charge = await shade.jars.charge("jar_1", { amountZec: "0.002" });
    expect(charge.remainingZec).toBe("0.004");
    const grant = await shade.grants.create({ scope: "payroll", expiresInSec: 600 });
    expect(grant.viewUrl).toBe(wireGrantCreated.view_url);
    expect(grant.token).toBe(wireGrantCreated.token);
  });
});

describe("errors", () => {
  it("402 JAR_EMPTY becomes ShadeError with remainingZec, without a retry", async () => {
    const { shade, calls } = client([
      json(
        402,
        {
          error: "JAR_EMPTY",
          message: "Jar empty. The agent cannot spend.",
          remaining_zec: "0",
          request_id: "req_1",
        },
        { "x-request-id": "req_1" },
      ),
    ]);
    const err = await shade.jars.charge("jar_1", { amountZec: "0.002" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShadeError);
    expect(err).toMatchObject({
      name: "ShadeError",
      status: 402,
      code: "JAR_EMPTY",
      message: "Jar empty. The agent cannot spend.",
      remainingZec: "0",
      requestId: "req_1",
    });
    expect(calls).toHaveLength(1);
  });

  it("409 JAR_CLOSED carries remainingZec", async () => {
    const { shade } = client([
      json(409, {
        error: "JAR_CLOSED",
        message: "Jar closed. The agent cannot spend.",
        remaining_zec: "0.004",
      }),
    ]);
    await expect(shade.jars.charge("jar_1", { amountZec: "0.002" })).rejects.toMatchObject({
      status: 409,
      code: "JAR_CLOSED",
      remainingZec: "0.004",
    });
  });

  it("400 INVALID_REQUEST carries issues; request id falls back to the header", async () => {
    const issues = [{ path: "amount_zec", message: "Required" }];
    const { shade } = client([
      json(
        400,
        { error: "INVALID_REQUEST", message: "Invalid request.", issues },
        { "x-request-id": "req_h" },
      ),
    ]);
    await expect(shade.invoices.create({ amountZec: "" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      issues,
      requestId: "req_h",
    });
  });

  it("429 RATE_LIMITED takes retryAfter from the body, else from the Retry-After header", async () => {
    const { shade } = client([
      json(
        429,
        { error: "RATE_LIMITED", message: "Slow down.", retry_after: 12 },
        { "retry-after": "30" },
      ),
      json(429, { error: "RATE_LIMITED", message: "Slow down." }, { "retry-after": "7" }),
    ]);
    await expect(shade.invoices.get("inv_1")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: 12,
    });
    await expect(shade.invoices.get("inv_1")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: 7,
    });
  });

  it("passes unknown server codes through", async () => {
    const { shade } = client([json(409, { error: "SOMETHING_NEW", message: "New rule." })]);
    await expect(shade.tags.create({ name: "x" })).rejects.toMatchObject({ code: "SOMETHING_NEW" });
  });

  it("a non-Shade error body becomes UNEXPECTED_RESPONSE with the HTTP status", async () => {
    const { shade } = client(
      [
        new Response("<html>Bad gateway</html>", {
          status: 502,
          headers: { "x-request-id": "edge_1" },
        }),
      ],
      { maxRetries: 0 },
    );
    await expect(shade.invoices.get("inv_1")).rejects.toMatchObject({
      status: 502,
      code: "UNEXPECTED_RESPONSE",
      requestId: "edge_1",
    });
  });

  it("a 2xx without a JSON body becomes UNEXPECTED_RESPONSE", async () => {
    const { shade } = client([new Response("ok", { status: 200 })]);
    await expect(shade.invoices.get("inv_1")).rejects.toMatchObject({
      status: 200,
      code: "UNEXPECTED_RESPONSE",
    });
  });
});

describe("retries", () => {
  it.each([
    { name: "a 503", first: json(503, { error: "INTERNAL", message: "Unavailable." }) as Reply },
    { name: "a network error", first: new TypeError("fetch failed") as Reply },
    { name: "a timeout", first: "hang" as Reply },
  ])("jars.charge retries $name once with the same idempotency key and body", async ({ first }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { shade, calls } = client([first, json(201, wireChargeResult)]);
    const result = settle(shade.jars.charge("jar_1", { amountZec: "0.002", memo: "api:search" }));
    await vi.runAllTimersAsync();
    const outcome = await result;
    expect(outcome).toStrictEqual({ ok: true, value: camelizeDeep(wireChargeResult) });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["idempotency-key"]).toBe(calls[0]!.headers["idempotency-key"]);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("invoices.create and jars.create retry 5xx with the same key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { shade, calls } = client([
      json(500, { error: "INTERNAL", message: "Oops." }),
      json(201, wireInvoice),
      json(502, { error: "INTERNAL", message: "Oops." }),
      json(201, wireJar),
    ]);
    const inv = settle(shade.invoices.create({ amountZec: "0.01" }));
    await vi.runAllTimersAsync();
    expect((await inv).ok).toBe(true);
    const jar = settle(shade.jars.create({ capZec: "0.006", label: "research-agent" }));
    await vi.runAllTimersAsync();
    expect((await jar).ok).toBe(true);
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fail = () => json(503, { error: "CHAIN_UNAVAILABLE", message: "Chain unavailable." });
    for (const [maxRetries, attempts] of [
      [0, 1],
      [1, 2],
      [3, 4],
    ] as const) {
      const { shade, calls } = client([fail(), fail(), fail(), fail()], { maxRetries });
      const result = settle(shade.jars.charge("jar_1", { amountZec: "0.002" }));
      await vi.runAllTimersAsync();
      expect(errorOf(await result)).toMatchObject({ status: 503, code: "CHAIN_UNAVAILABLE" });
      expect(calls).toHaveLength(attempts);
    }
  });

  it("never retries a 4xx, even for idempotent calls", async () => {
    const { shade, calls } = client([
      json(422, { error: "IDEMPOTENCY_MISMATCH", message: "Key reused." }),
      json(409, { error: "IDEMPOTENCY_IN_PROGRESS", message: "In progress." }),
      json(404, { error: "NOT_FOUND", message: "Not found." }),
    ]);
    await expect(shade.invoices.create({ amountZec: "0.01" })).rejects.toMatchObject({
      status: 422,
    });
    await expect(shade.jars.charge("jar_1", { amountZec: "0.002" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(shade.invoices.get("inv_1")).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(3);
  });

  const unsafe = [
    { name: "invoices.cancel", call: (s: Shade) => s.invoices.cancel("inv_1") },
    {
      name: "invoices.reportDetection",
      call: (s: Shade) =>
        s.invoices.reportDetection("inv_1", {
          txid: "a".repeat(64),
          amountZec: "0.01",
          memoHash: "sha256:x",
          pool: "sapling",
        }),
    },
    { name: "jars.kill", call: (s: Shade) => s.jars.kill("jar_1") },
    { name: "grants.create", call: (s: Shade) => s.grants.create({ scope: "all" }) },
    { name: "grants.revoke", call: (s: Shade) => s.grants.revoke("grt_1") },
    {
      name: "webhooks.create",
      call: (s: Shade) => s.webhooks.create({ url: "https://vendor.example/h" }),
    },
    { name: "tags.create", call: (s: Shade) => s.tags.create({ name: "asharib" }) },
  ];

  it.each(unsafe)("$name is never retried (5xx or network error)", async ({ call }) => {
    const a = client([json(503, { error: "INTERNAL", message: "Unavailable." })]);
    await expect(call(a.shade)).rejects.toMatchObject({ status: 503 });
    expect(a.calls).toHaveLength(1);
    const b = client([new TypeError("fetch failed")]);
    await expect(call(b.shade)).rejects.toBeInstanceOf(ShadeConnectionError);
    expect(b.calls).toHaveLength(1);
  });

  it("reads are retried on 5xx and network errors", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { shade, calls } = client([
      json(502, { error: "INTERNAL", message: "Bad gateway." }),
      json(200, wireInvoice),
      new TypeError("fetch failed"),
      json(200, wireTagResolution),
    ]);
    const inv = settle(shade.invoices.get("inv_1"));
    await vi.runAllTimersAsync();
    expect((await inv).ok).toBe(true);
    const tag = settle(shade.tags.resolve("asharib"));
    await vi.runAllTimersAsync();
    expect((await tag).ok).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it("waits for a short Retry-After before retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { shade, calls } = client([
      json(503, { error: "CHAIN_UNAVAILABLE", message: "Chain unavailable.", retry_after: 2 }),
      json(201, wireChargeResult),
    ]);
    const result = settle(shade.jars.charge("jar_1", { amountZec: "0.002" }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not retry when Retry-After is longer than the SDK will wait", async () => {
    const { shade, calls } = client([
      json(
        503,
        { error: "CHAIN_UNAVAILABLE", message: "Chain unavailable." },
        { "retry-after": "60" },
      ),
    ]);
    await expect(shade.jars.charge("jar_1", { amountZec: "0.002" })).rejects.toMatchObject({
      status: 503,
      retryAfter: 60,
    });
    expect(calls).toHaveLength(1);
  });

  it("a network failure surfaces as ShadeConnectionError NETWORK_ERROR with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const { shade } = client([cause], { maxRetries: 0 });
    const err = await shade.invoices.get("inv_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShadeConnectionError);
    expect(err).toBeInstanceOf(ShadeError);
    expect(err).toMatchObject({
      name: "ShadeConnectionError",
      status: 0,
      code: "NETWORK_ERROR",
      requestId: null,
    });
    expect((err as Error).cause).toBe(cause);
  });
});

describe("timeouts", () => {
  it("aborts the request after timeoutMs and throws TIMEOUT", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { shade, calls } = client(["hang"], { timeoutMs: 2_500, maxRetries: 0 });
    const result = settle(shade.invoices.get("inv_1"));
    await vi.advanceTimersByTimeAsync(2_499);
    expect(calls[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = errorOf(await result);
    expect(calls[0]!.signal!.aborted).toBe(true);
    expect(err).toBeInstanceOf(ShadeConnectionError);
    expect(err).toMatchObject({ status: 0, code: "TIMEOUT" });
  });

  it("each attempt gets its own deadline and no timer outlives the call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { shade, calls } = client(["hang", "hang"], { timeoutMs: 1_000 });
    const result = settle(shade.jars.charge("jar_1", { amountZec: "0.002" }));
    await vi.runAllTimersAsync();
    expect(errorOf(await result)).toMatchObject({ code: "TIMEOUT" });
    expect(calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a successful response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { shade } = client([json(200, wireInvoice)]);
    await shade.invoices.get("inv_1");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("budget reads, endpoint management and per-call options", () => {
  it("jars.get reads one jar", async () => {
    const { shade, calls } = client([json(200, wireJar)]);
    const jar = await shade.jars.get("jar_1");
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "https://shade-zcash.vercel.app/v1/jars/jar_1",
    });
    expect(jar).toEqual(camelizeDeep(wireJar));
  });

  it("webhooks.list maps endpoints without secrets; webhooks.delete accepts 204", async () => {
    const { secret: _secret, ...endpoint } = wireEndpointCreated;
    const { shade, calls } = client([json(200, [endpoint]), new Response(null, { status: 204 })]);
    expect(await shade.webhooks.list()).toEqual([camelizeDeep(endpoint)]);
    await expect(shade.webhooks.delete("whe_1")).resolves.toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://shade-zcash.vercel.app/v1/webhooks",
      "DELETE https://shade-zcash.vercel.app/v1/webhooks/whe_1",
    ]);
  });

  it("sends the caller's idempotency key, and the same one on retries", async () => {
    const { shade, calls } = client([
      json(503, { error: "INTERNAL", message: "x" }),
      json(201, wireChargeResult),
    ]);
    await shade.jars.charge("jar_1", { amountZec: "0.002" }, { idempotencyKey: "search-req-42" });
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual([
      "search-req-42",
      "search-req-42",
    ]);
    await expect(
      shade.jars.charge("jar_1", { amountZec: "0.002" }, { idempotencyKey: "has space" }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(2);
  });

  it("invoices.list sends expires_after from a Date or a string", async () => {
    const { shade, calls } = client([
      json(200, { items: [], next_cursor: null }),
      json(200, { items: [], next_cursor: null }),
    ]);
    await shade.invoices.list({
      status: "expired",
      expiresAfter: new Date("2026-10-06T10:00:00Z"),
    });
    await shade.invoices.list({ expiresAfter: "2026-10-06T11:00:00Z" });
    expect(calls.map((c) => new URL(c.url).searchParams.get("expires_after"))).toEqual([
      "2026-10-06T10:00:00.000Z",
      "2026-10-06T11:00:00Z",
    ]);
  });

  it("an aborted signal ends the call with ABORTED, also during a retry wait", async () => {
    const controller = new AbortController();
    controller.abort();
    const { shade, calls } = client([json(200, wireInvoice)]);
    expect(
      errorOf(await settle(shade.invoices.get("inv_1", { signal: controller.signal }))),
    ).toMatchObject({
      code: "ABORTED",
      status: 0,
    });
    expect(calls).toHaveLength(0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const late = new AbortController();
    const retrying = client([
      json(503, { error: "INTERNAL", message: "x" }),
      json(200, wireInvoice),
    ]);
    const result = settle(retrying.shade.invoices.get("inv_1", { signal: late.signal }));
    await vi.advanceTimersByTimeAsync(10);
    late.abort();
    const err = errorOf(await result);
    expect(err).toBeInstanceOf(ShadeConnectionError);
    expect(err).toMatchObject({ code: "ABORTED" });
    expect(retrying.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborting an in-flight request ends it with ABORTED, not TIMEOUT", async () => {
    const controller = new AbortController();
    const { shade, calls } = client(["hang"], { maxRetries: 3 });
    const result = settle(
      shade.jars.charge("jar_1", { amountZec: "0.002" }, { signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(errorOf(await result)).toMatchObject({ code: "ABORTED" });
    expect(calls).toHaveLength(1);
  });
});
