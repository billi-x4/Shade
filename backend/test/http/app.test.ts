import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../src/contract/index.ts";
import {
  type Harness,
  PASSWORD,
  call,
  createHarness,
  createMerchant,
  json,
  merchantKey,
  nextIp,
} from "../support/harness.ts";

describe("app conventions", () => {
  let h: Harness;
  let token: string;

  beforeAll(async () => {
    h = await createHarness();
    const merchant = await createMerchant(h);
    token = (await merchantKey(h, merchant.merchantId)).token;
  });
  afterAll(() => h.close());

  it("GET /healthz answers without the database, with no-store, a request id and secure headers", async () => {
    const res = await h.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("GET /readyz checks the database, migrations and worker heartbeats", async () => {
    const ready = await h.app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ok: true,
      database: "ok",
      pending_migrations: [],
      workers: {},
    });

    await h.db`
      insert into worker_heartbeats (name, last_seen_at, info)
      values ('detector', ${new Date(h.clock().getTime() - 42_000)}, '{"ok":true}')`;
    const beat = await json<{ workers: Record<string, { age_sec: number }> }>(
      await h.app.request("/readyz"),
    );
    expect(beat.workers.detector?.age_sec).toBeGreaterThanOrEqual(41);

    const [last] = await h.db<{
      name: string;
    }>`select name from _migrations order by name desc limit 1`;
    await h.db`delete from _migrations where name = ${last?.name ?? ""}`;
    const pending = await h.app.request("/readyz");
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({ ok: false, pending_migrations: [last?.name] });
    await h.db`insert into _migrations (name) values (${last?.name ?? ""})`;
  });

  it("echoes a well-formed X-Request-Id and replaces anything else", async () => {
    const echoed = await h.app.request("/healthz", { headers: { "x-request-id": "edge-123:abc" } });
    expect(echoed.headers.get("x-request-id")).toBe("edge-123:abc");
    const replaced = await h.app.request("/healthz", {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(replaced.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("answers unknown routes with a JSON 404 that carries the request id", async () => {
    const res = await h.app.request("/nope");
    expect(res.status).toBe(404);
    const body = await json<ApiErrorBody>(res);
    expect(body).toMatchObject({ error: "NOT_FOUND" });
    expect(body.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("refuses non-JSON bodies (415), large bodies (413) and malformed JSON (400)", async () => {
    const text = await call(h, "POST", "/v1/invoices", {
      token,
      rawBody: "amount_zec=1",
      headers: { "content-type": "text/plain" },
    });
    expect(text.status).toBe(415);
    expect((await json<ApiErrorBody>(text)).error).toBe("UNSUPPORTED_MEDIA_TYPE");
    const big = await call(h, "POST", "/v1/invoices", {
      token,
      rawBody: JSON.stringify({ amount_zec: "1", memo: "x".repeat(17_000) }),
      headers: { "content-type": "application/json" },
    });
    expect(big.status).toBe(413);
    expect((await json<ApiErrorBody>(big)).error).toBe("PAYLOAD_TOO_LARGE");
    const broken = await call(h, "POST", "/v1/invoices", {
      token,
      rawBody: "{",
      headers: { "content-type": "application/json" },
    });
    expect(broken.status).toBe(400);
    expect((await json<ApiErrorBody>(broken)).error).toBe("INVALID_REQUEST");
    const desk = await call(h, "POST", "/api/public/grants/view", {
      rawBody: "token=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(desk.status).toBe(415);
  });

  it("caps Better Auth request bodies at 16 KB too (413 before sign-up reads them)", async () => {
    const email = `big-${Date.now()}@example.com`;
    const signUp = (name: string, headers: Record<string, string> = {}) =>
      call(h, "POST", "/api/auth/sign-up/email", {
        rawBody: JSON.stringify({ email, password: PASSWORD, name }),
        headers: { "content-type": "application/json", ...headers },
        ip: nextIp(),
      });
    // A streamed body (no Content-Length) and a declared one are both refused.
    const streamed = await signUp("x".repeat(17_000));
    expect(streamed.status).toBe(413);
    expect((await json<ApiErrorBody>(streamed)).error).toBe("PAYLOAD_TOO_LARGE");
    const declared = await signUp("x", { "content-length": String(20 * 1024 * 1024) });
    expect(declared.status).toBe(413);
    const [users] = await h.db<{ n: number }>`
      select count(*)::int as n from "user" where email = ${email}`;
    expect(users?.n).toBe(0);

    const ok = await signUp("Small Shop");
    expect(ok.status).toBe(200);
  });

  it("sends no CORS headers on /api", async () => {
    const preflight = await h.app.request("/api/config", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const get = await call(h, "GET", "/api/config", { origin: "https://evil.example" });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires the edge header on /api (not /v1) when EDGE_SHARED_SECRET is set", async () => {
    const edge = await createHarness({ EDGE_SHARED_SECRET: "edge-secret-0123456789" });
    try {
      expect((await call(edge, "GET", "/api/config")).status).toBe(403);
      const ok = await call(edge, "GET", "/api/config", {
        headers: { "x-shade-edge": "edge-secret-0123456789" },
      });
      expect(ok.status).toBe(200);
      expect((await call(edge, "GET", "/v1/tags/nobody")).status).toBe(404);
    } finally {
      await edge.close();
    }
  });

  it("maps unexpected failures to 500 INTERNAL without details", async () => {
    const broken = await createHarness();
    await broken.db.close();
    const res = await call(broken, "GET", "/api/public/invoices/inv_x");
    expect(res.status).toBe(500);
    const body = await json<ApiErrorBody>(res);
    expect(body).toMatchObject({ error: "INTERNAL" });
    expect(body.request_id).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/pglite|closed|select/i);
  });
});
