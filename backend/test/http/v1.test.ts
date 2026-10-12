import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiErrorBody,
  COPY,
  type GrantCreated,
  type Invoice,
  type Jar,
  type JarChargeResult,
  type Page,
  type Tag,
  type WebhookEndpointCreated,
} from "../../src/contract/index.ts";
import {
  type Harness,
  call,
  createHarness,
  createMerchant,
  createUser,
  deskSession,
  json,
  merchantKey,
  putShieldedTx,
  randomTxid,
  syncChain,
  webhookReceiver,
} from "../support/harness.ts";
import {
  GRANT_CREATED_KEYS,
  GRANT_KEYS,
  INVOICE_KEYS,
  JAR_CHARGE_RESULT_KEYS,
  JAR_KEYS,
  TAG_KEYS,
  TAG_RESOLUTION_KEYS,
  WEBHOOK_ENDPOINT_CREATED_KEYS,
  keysOf,
  sorted,
} from "../support/shapes.ts";

describe("/v1 public API", () => {
  let h: Harness;
  let merchantId: string;
  let token: string;
  let mainnetToken: string;

  beforeAll(async () => {
    h = await createHarness({ SHADE_NETWORKS: "testnet,mainnet" });
    const merchant = await createMerchant(h, { networks: ["testnet", "mainnet"] });
    merchantId = merchant.merchantId;
    token = (await merchantKey(h, merchantId, "testnet")).token;
    mainnetToken = (await merchantKey(h, merchantId, "mainnet")).token;
  });
  afterAll(() => h.close());

  const createInvoice = async (
    body: Record<string, unknown> = { amount_zec: "0.01", memo: "demo" },
  ) => {
    const res = await call(h, "POST", "/v1/invoices", { token, body });
    expect(res.status).toBe(201);
    return json<Invoice>(res);
  };

  describe("authentication", () => {
    it("401s missing, malformed, unknown and revoked keys with request_id", async () => {
      const missing = await call(h, "GET", "/v1/invoices");
      expect(missing.status).toBe(401);
      const body = await json<ApiErrorBody>(missing);
      expect(body).toMatchObject({ error: "UNAUTHORIZED", message: "Missing or invalid API key." });
      expect(body.request_id).toBe(missing.headers.get("x-request-id"));
      for (const bad of ["nope", `sk_test_${"A".repeat(43)}`, "gv_abc"]) {
        expect((await call(h, "GET", "/v1/invoices", { token: bad })).status).toBe(401);
      }
      const key = await merchantKey(h, merchantId);
      await h.services.keys.revoke(merchantId, key.id);
      expect((await call(h, "GET", "/v1/invoices", { token: key.token })).status).toBe(401);
    });

    it("ignores desk cookies", async () => {
      const session = await deskSession(h);
      const res = await call(h, "GET", "/v1/invoices", { cookie: session.cookie });
      expect(res.status).toBe(401);
    });

    it("403s keys whose network is not enabled", async () => {
      const testnetOnly = await createHarness();
      try {
        const merchant = await createMerchant(testnetOnly);
        const key = await merchantKey(testnetOnly, merchant.merchantId);
        await testnetOnly.db`update api_keys set network = 'mainnet' where id = ${key.id}`;
        const res = await call(testnetOnly, "GET", "/v1/invoices", { token: key.token });
        expect(res.status).toBe(403);
        expect((await json<ApiErrorBody>(res)).error).toBe("NETWORK_DISABLED");
      } finally {
        await testnetOnly.close();
      }
    });

    it("rate-limits per key (600/60 s) with retry-after", async () => {
      const key = await merchantKey(h, merchantId);
      const windowStart = Math.floor(h.clock().getTime() / 60_000) * 60_000;
      await h.db`
        insert into rate_limits (bucket, window_start, count)
        values (${`v1:key:${key.id}`}, ${new Date(windowStart)}, 600)`;
      const res = await call(h, "GET", "/v1/invoices", { token: key.token });
      expect(res.status).toBe(429);
      const body = await json<ApiErrorBody>(res);
      expect(body.error).toBe("RATE_LIMITED");
      expect(body.retry_after).toBeGreaterThan(0);
      expect(res.headers.get("retry-after")).toBe(String(body.retry_after));
    });

    it("rate-limits failed authentications per IP (60/60 s); valid keys are unaffected", async () => {
      const windowStart = Math.floor(h.clock().getTime() / 60_000) * 60_000;
      const failures = async () =>
        (
          await h.db<{ bucket: string; count: number }>`
            select bucket, count from rate_limits
            where bucket like 'v1:auth:ip:%' and window_start = ${new Date(windowStart)}`
        )[0];
      const before = (await failures())?.count ?? 0;
      expect((await call(h, "GET", "/v1/invoices", { token: "nope" })).status).toBe(401);
      const counted = await failures();
      expect(counted?.count).toBe(before + 1);
      // A valid key does not count as a failure.
      expect((await call(h, "GET", "/v1/invoices", { token })).status).toBe(200);
      expect((await failures())?.count).toBe(before + 1);
      await h.db`
        update rate_limits set count = 60
        where bucket = ${counted!.bucket} and window_start = ${new Date(windowStart)}`;
      const limited = await call(h, "GET", "/v1/invoices", { token: "nope" });
      expect(limited.status).toBe(429);
      expect((await json<ApiErrorBody>(limited)).error).toBe("RATE_LIMITED");
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect((await call(h, "GET", "/v1/invoices", { token })).status).toBe(200);
      await h.db`delete from rate_limits where bucket = ${counted!.bucket}`;
    });
  });

  describe("invoices", () => {
    it("POST /v1/invoices → 201 Invoice (PRD §9 fields)", async () => {
      const invoice = await createInvoice({
        amount_zec: "0.01",
        memo: "order_1042",
        expires_in_sec: 3600,
      });
      expect(keysOf(invoice)).toEqual(sorted(INVOICE_KEYS));
      expect(invoice).toMatchObject({
        status: "open",
        network: "testnet",
        amount_zec: "0.01",
        memo: "order_1042",
        pay_url: `${h.config.appOrigin}/pay/${invoice.id}`,
        // The chain tip at creation: scanners (scan-local) start from it.
        created_height: (await h.chain.testnet.getTip()).height,
      });
      expect(invoice.zip321).toMatch(/^zcash:utest1[0-9a-z]+\?amount=0\.01&memo=[A-Za-z0-9_-]+$/);
      expect(invoice.address).toMatch(/^utest1/);
    });

    it("validates with zod (400 INVALID_REQUEST issues) and domain codes", async () => {
      const typed = await call(h, "POST", "/v1/invoices", { token, body: { amount_zec: 0.01 } });
      expect(typed.status).toBe(400);
      const body = await json<ApiErrorBody>(typed);
      expect(body.error).toBe("INVALID_REQUEST");
      expect(body.issues?.[0]?.path).toBe("amount_zec");
      expect(JSON.stringify(body)).not.toContain("0.01");
      const cases: [Record<string, unknown>, string][] = [
        [{ amount_zec: "abc" }, "BAD_AMOUNT"],
        [{ amount_zec: "1", memo: "a\u0000b" }, "BAD_MEMO"],
        [{ amount_zec: "1", tag: "Not OK" }, "BAD_TAG"],
        [{ amount_zec: "1", tag: "all" }, "BAD_TAG"],
        [{ amount_zec: "1", tag: "All" }, "BAD_TAG"],
        [{ amount_zec: "1", expires_in_sec: 10 }, "BAD_EXPIRY"],
      ];
      for (const [input, code] of cases) {
        const res = await call(h, "POST", "/v1/invoices", { token, body: input });
        expect(res.status).toBe(400);
        expect((await json<ApiErrorBody>(res)).error).toBe(code);
      }
      const bare = await createUser(h);
      const bareKey = await merchantKey(h, bare.merchantId);
      const noAddress = await call(h, "POST", "/v1/invoices", {
        token: bareKey.token,
        body: { amount_zec: "1" },
      });
      expect(noAddress.status).toBe(409);
      expect(await json<ApiErrorBody>(noAddress)).toMatchObject({
        error: "NO_ADDRESS",
        message: COPY.noAddress,
      });
    });

    it("replays an Idempotency-Key and refuses it for a different body", async () => {
      const headers = { "idempotency-key": `create-${randomTxid()}` };
      const body = { amount_zec: "0.02", memo: "idem" };
      const first = await call(h, "POST", "/v1/invoices", { token, body, headers });
      expect(first.status).toBe(201);
      expect(first.headers.get("idempotent-replayed")).toBeNull();
      const replay = await call(h, "POST", "/v1/invoices", { token, body, headers });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect((await json<Invoice>(replay)).id).toBe((await json<Invoice>(first)).id);
      const mismatch = await call(h, "POST", "/v1/invoices", {
        token,
        body: { ...body, memo: "other" },
        headers,
      });
      expect(mismatch.status).toBe(422);
      expect((await json<ApiErrorBody>(mismatch)).error).toBe("IDEMPOTENCY_MISMATCH");

      const validationKey = { "idempotency-key": `bad-${randomTxid()}` };
      expect(
        (
          await call(h, "POST", "/v1/invoices", {
            token,
            body: { amount_zec: "x" },
            headers: validationKey,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(h, "POST", "/v1/invoices", {
            token,
            body: { amount_zec: "1" },
            headers: validationKey,
          })
        ).status,
      ).toBe(201);
      const badKey = await call(h, "POST", "/v1/invoices", {
        token,
        body,
        headers: { "idempotency-key": "has space" },
      });
      expect(badKey.status).toBe(400);
    });

    it("GET /v1/invoices lists non-jar invoices of the key's network with filters", async () => {
      const open = await createInvoice({ amount_zec: "0.03" });
      const cancelled = await createInvoice({ amount_zec: "0.031" });
      await call(h, "POST", `/v1/invoices/${cancelled.id}/cancel`, { token });
      const mainnet = await call(h, "POST", "/v1/invoices", {
        token: mainnetToken,
        body: { amount_zec: "1" },
      });
      const mainnetInvoice = await json<Invoice>(mainnet);

      const all = await json<Page<Invoice>>(
        await call(h, "GET", "/v1/invoices?limit=100", { token }),
      );
      expect(keysOf(all)).toEqual(["items", "next_cursor"]);
      const ids = all.items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([open.id, cancelled.id]));
      expect(ids).not.toContain(mainnetInvoice.id);
      const filtered = await json<Page<Invoice>>(
        await call(h, "GET", "/v1/invoices?status=open,paid_unverified,expired&limit=100", {
          token,
        }),
      );
      expect(
        filtered.items.every((i) => ["open", "paid_unverified", "expired"].includes(i.status)),
      ).toBe(true);
      expect(filtered.items.map((i) => i.id)).not.toContain(cancelled.id);
      const page = await json<Page<Invoice>>(
        await call(h, "GET", "/v1/invoices?limit=1", { token }),
      );
      expect(page.items).toHaveLength(1);
      const next = await json<Page<Invoice>>(
        await call(h, "GET", `/v1/invoices?limit=1&cursor=${page.next_cursor ?? ""}`, { token }),
      );
      expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
      // expires_after keeps only invoices expiring later (scanners skip old expired ones).
      const later = await json<Page<Invoice>>(
        await call(
          h,
          "GET",
          `/v1/invoices?limit=100&expires_after=${encodeURIComponent(open.expires_at)}`,
          { token },
        ),
      );
      expect(later.items.map((i) => i.id)).not.toContain(open.id);
      const earlier = new Date(Date.parse(open.expires_at) - 1000).toISOString();
      const kept = await json<Page<Invoice>>(
        await call(h, "GET", `/v1/invoices?limit=100&expires_after=${earlier}`, { token }),
      );
      expect(kept.items.map((i) => i.id)).toContain(open.id);
      for (const query of [
        "status=bogus",
        "limit=0",
        "limit=101",
        "cursor=***",
        "expires_after=yesterday",
        "expires_after=2026-13-45T99:00:00Z",
      ]) {
        const res = await call(h, "GET", `/v1/invoices?${query}`, { token });
        expect(res.status).toBe(400);
        expect((await json<ApiErrorBody>(res)).error).toBe("INVALID_REQUEST");
      }
    });

    it("GET /v1/invoices/:id is scoped to the merchant and the key's network", async () => {
      const invoice = await createInvoice();
      expect((await call(h, "GET", `/v1/invoices/${invoice.id}`, { token })).status).toBe(200);
      expect(
        (await call(h, "GET", `/v1/invoices/${invoice.id}`, { token: mainnetToken })).status,
      ).toBe(404);
      const stranger = await createMerchant(h);
      const strangerKey = await merchantKey(h, stranger.merchantId);
      const res = await call(h, "GET", `/v1/invoices/${invoice.id}`, { token: strangerKey.token });
      expect(res.status).toBe(404);
      expect((await json<ApiErrorBody>(res)).error).toBe("NOT_FOUND");
      expect((await call(h, "GET", "/v1/invoices/not%20an%20id", { token })).status).toBe(404);
    });

    it("POST /v1/invoices/:id/cancel works bodiless, without a content type", async () => {
      const invoice = await createInvoice();
      const res = await h.app.request(`/v1/invoices/${invoice.id}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect((await json<Invoice>(res)).status).toBe("cancelled");
      const again = await call(h, "POST", `/v1/invoices/${invoice.id}/cancel`, { token });
      expect(again.status).toBe(409);
      expect((await json<ApiErrorBody>(again)).error).toBe("NOT_OPEN");
    });

    it("POST /v1/invoices/:id/detections verifies on chain and settles", async () => {
      const invoice = await createInvoice({ amount_zec: "0.04", memo: "device" });
      const txid = randomTxid();
      putShieldedTx(h.chain.testnet, txid, { height: 1001 });
      syncChain(h, "testnet", 1001);
      const body = { txid, amount_zec: "0.04", memo_hash: invoice.memo_hash, pool: "ironwood" };
      const res = await call(h, "POST", `/v1/invoices/${invoice.id}/detections`, { token, body });
      expect(res.status).toBe(200);
      const paid = await json<Invoice>(res);
      expect(paid).toMatchObject({ status: "paid", verification: "ivk_scan", txid });
      expect(paid.detection).toMatchObject({ state: "settled", source: "merchant_device" });

      // One memo group of a transaction settles one invoice: a legacy invoice sharing the memo
      // hash cannot claim the same payment.
      const legacy = await createInvoice({ amount_zec: "0.04", memo: "device" });
      await h.db`
        update invoices set memo_ref = null, memo_hash = ${invoice.memo_hash} where id = ${legacy.id}`;
      const reuse = await call(h, "POST", `/v1/invoices/${legacy.id}/detections`, { token, body });
      expect(reuse.status).toBe(409);
      expect((await json<ApiErrorBody>(reuse)).error).toBe("TXID_IN_USE");
      const other = await createInvoice({ amount_zec: "0.04", memo: "device" });
      const mismatch = await call(h, "POST", `/v1/invoices/${other.id}/detections`, {
        token,
        body: { ...body, txid: randomTxid() },
      });
      expect(mismatch.status).toBe(422);
      expect((await json<ApiErrorBody>(mismatch)).error).toBe("MEMO_MISMATCH");
      const worker = await call(h, "POST", `/v1/invoices/${other.id}/detections`, {
        token,
        body: { ...body, source: "shade_worker" },
      });
      expect(worker.status).toBe(400);
      h.chain.testnet.failNext();
      const down = await call(h, "POST", `/v1/invoices/${other.id}/detections`, {
        token,
        body: { ...body, txid: randomTxid(), memo_hash: other.memo_hash },
      });
      expect(down.status).toBe(503);
      expect(down.headers.get("retry-after")).toBe("30");
      expect(await json<ApiErrorBody>(down)).toMatchObject({
        error: "CHAIN_UNAVAILABLE",
        retry_after: 30,
      });
    });
  });

  describe("jars", () => {
    const createJar = async (cap: string, headers: Record<string, string> = {}) => {
      const res = await call(h, "POST", "/v1/jars", {
        token,
        body: { cap_zec: cap, label: "research-agent" },
        headers,
      });
      expect(res.status).toBe(201);
      return json<Jar>(res);
    };
    const agentFor = async (jarId: string) =>
      (await h.services.keys.issue(merchantId, { kind: "agent", label: "agent", jar_id: jarId }))
        .token;

    it("POST /v1/jars → 201 Jar, idempotent", async () => {
      const headers = { "idempotency-key": `jar-${randomTxid()}` };
      const jar = await createJar("0.05", headers);
      expect(keysOf(jar)).toEqual(sorted(JAR_KEYS));
      expect(jar).toMatchObject({
        cap_zec: "0.05",
        spent_zec: "0",
        remaining_zec: "0.05",
        note: COPY.killNote,
      });
      expect((await createJar("0.05", headers)).id).toBe(jar.id);
      const bad = await call(h, "POST", "/v1/jars", { token, body: { cap_zec: "1", label: "" } });
      expect((await json<ApiErrorBody>(bad)).error).toBe("BAD_LABEL");
    });

    it("lets an agent key charge until 402 JAR_EMPTY, then 409 JAR_CLOSED after kill", async () => {
      const jar = await createJar("0.006");
      const agent = await agentFor(jar.id);
      const lines: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
          token: agent,
          body: { amount_zec: "0.002", memo: "api:search" },
        });
        expect(res.status).toBe(201);
        const charge = await json<JarChargeResult>(res);
        expect(keysOf(charge)).toEqual(sorted(JAR_CHARGE_RESULT_KEYS));
        lines.push(charge.remaining_zec);
      }
      expect(lines).toEqual(["0.004", "0.002", "0"]);
      const empty = await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
        token: agent,
        body: { amount_zec: "0.002", memo: "api:search" },
      });
      expect(empty.status).toBe(402);
      const emptyBody = await json<ApiErrorBody>(empty);
      expect(emptyBody).toMatchObject({
        error: "JAR_EMPTY",
        message: COPY.jarEmpty,
        remaining_zec: "0",
      });
      expect(emptyBody.request_id).toBeTruthy();

      const killed = await call(h, "POST", `/v1/jars/${jar.id}/kill`, { token });
      expect(killed.status).toBe(200);
      expect((await json<Jar>(killed)).status).toBe("killed");
      const closed = await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
        token: agent,
        body: { amount_zec: "0.001" },
      });
      expect(closed.status).toBe(409);
      expect(await json<ApiErrorBody>(closed)).toMatchObject({
        error: "JAR_CLOSED",
        message: COPY.jarClosed,
        remaining_zec: "0",
      });
    });

    it("never double-debits a replayed charge, and replays a stored 402", async () => {
      const jar = await createJar("0.003");
      const agent = await agentFor(jar.id);
      const headers = { "idempotency-key": `charge-${randomTxid()}` };
      const body = { amount_zec: "0.002" };
      const first = await json<JarChargeResult>(
        await call(h, "POST", `/v1/jars/${jar.id}/charge`, { token: agent, body, headers }),
      );
      const replay = await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
        token: agent,
        body,
        headers,
      });
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect((await json<JarChargeResult>(replay)).invoice_id).toBe(first.invoice_id);
      const emptyKey = { "idempotency-key": `empty-${randomTxid()}` };
      const empty = await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
        token: agent,
        body,
        headers: emptyKey,
      });
      expect(empty.status).toBe(402);
      const emptyReplay = await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
        token: agent,
        body,
        headers: emptyKey,
      });
      expect(emptyReplay.status).toBe(402);
      expect(emptyReplay.headers.get("idempotent-replayed")).toBe("true");
      const [state] = await h.db<{
        spent_zec: string;
      }>`select spent_zec from jars where id = ${jar.id}`;
      expect(state?.spent_zec).toBe("0.00200000");
    });

    it("GET /v1/jars/:id: the merchant and the jar's own agent read its budget", async () => {
      const jar = await createJar("0.01");
      const agent = await agentFor(jar.id);
      await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
        token: agent,
        body: { amount_zec: "0.004" },
      });
      for (const key of [token, agent]) {
        const res = await call(h, "GET", `/v1/jars/${jar.id}`, { token: key });
        expect(res.status).toBe(200);
        const read = await json<Jar>(res);
        expect(keysOf(read)).toEqual(sorted(JAR_KEYS));
        expect(read).toMatchObject({
          id: jar.id,
          spent_zec: "0.004",
          remaining_zec: "0.006",
          charge_count: 1,
        });
      }
      expect((await call(h, "GET", `/v1/jars/${jar.id}`, { token: mainnetToken })).status).toBe(
        404,
      );
      expect((await call(h, "GET", "/v1/jars/jar_unknown", { token })).status).toBe(404);
    });

    it("restricts agent keys to charging their own jar and reading its budget", async () => {
      const jar = await createJar("1");
      const otherJar = await createJar("1");
      const agent = await agentFor(jar.id);
      const forbidden = [
        ["GET", "/v1/invoices"],
        ["POST", "/v1/invoices"],
        ["POST", `/v1/jars/${jar.id}/kill`],
        ["POST", `/v1/jars/${otherJar.id}/charge`],
        ["GET", `/v1/jars/${otherJar.id}`],
        ["GET", "/v1/webhooks"],
        ["POST", "/v1/grants"],
      ] as const;
      for (const [method, path] of forbidden) {
        const body = method === "GET" ? undefined : { amount_zec: "0.1" };
        const res = await call(h, method, path, { token: agent, body });
        expect(res.status).toBe(403);
        expect((await json<ApiErrorBody>(res)).error).toBe("FORBIDDEN");
      }
    });

    it("cancels a jar charge through /v1 with a refund while the jar is open", async () => {
      const jar = await createJar("0.01");
      const charge = await json<JarChargeResult>(
        await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
          token,
          body: { amount_zec: "0.004" },
        }),
      );
      const fetched = await json<Invoice>(
        await call(h, "GET", `/v1/invoices/${charge.invoice_id}`, { token }),
      );
      expect(fetched).toMatchObject({
        status: "authorized",
        verification: "jar_ledger",
        pay_url: null,
        address: null,
        zip321: null,
      });
      const res = await call(h, "POST", `/v1/invoices/${charge.invoice_id}/cancel`, { token });
      expect(res.status).toBe(200);
      expect((await json<Invoice>(res)).status).toBe("cancelled");
      const [state] = await h.db<{
        spent_zec: string;
      }>`select spent_zec from jars where id = ${jar.id}`;
      expect(state?.spent_zec).toBe("0.00000000");
      const second = await json<JarChargeResult>(
        await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
          token,
          body: { amount_zec: "0.004" },
        }),
      );
      await call(h, "POST", `/v1/jars/${jar.id}/kill`, { token });
      const closed = await call(h, "POST", `/v1/invoices/${second.invoice_id}/cancel`, { token });
      expect(closed.status).toBe(409);
      expect((await json<ApiErrorBody>(closed)).error).toBe("JAR_CLOSED");
    });

    it("404s jars of another network or merchant", async () => {
      const jar = await createJar("1");
      expect(
        (await call(h, "POST", `/v1/jars/${jar.id}/kill`, { token: mainnetToken })).status,
      ).toBe(404);
      const charge = await call(h, "POST", `/v1/jars/${jar.id}/charge`, {
        token: mainnetToken,
        body: { amount_zec: "0.1" },
      });
      expect(charge.status).toBe(404);
    });
  });

  describe("grants, webhooks, tags", () => {
    it("POST /v1/grants → 201 GrantCreated; revoke → 200 Grant", async () => {
      const res = await call(h, "POST", "/v1/grants", {
        token,
        body: { scope: "payroll", days: 7 },
      });
      expect(res.status).toBe(201);
      const grant = await json<GrantCreated>(res);
      expect(keysOf(grant)).toEqual(sorted(GRANT_CREATED_KEYS));
      expect(grant.view_url).toBe(`${h.config.appOrigin}/view#${grant.token}`);
      const short = await json<GrantCreated>(
        await call(h, "POST", "/v1/grants", { token, body: { scope: "all", expires_in_sec: 600 } }),
      );
      expect(Date.parse(short.expires_at) - Date.parse(short.created_at)).toBe(600_000);
      const revoked = await call(h, "POST", `/v1/grants/${grant.id}/revoke`, { token });
      expect(revoked.status).toBe(200);
      const body = await json<Record<string, unknown>>(revoked);
      expect(keysOf(body)).toEqual(sorted(GRANT_KEYS));
      expect(body.state).toBe("revoked");
      const bad = await call(h, "POST", "/v1/grants", {
        token,
        body: { scope: "payroll", days: 91 },
      });
      expect((await json<ApiErrorBody>(bad)).error).toBe("BAD_DURATION");
      const scope = await call(h, "POST", "/v1/grants", { token, body: { scope: "a b" } });
      expect((await json<ApiErrorBody>(scope)).error).toBe("BAD_SCOPE");
      expect(
        (await call(h, "POST", `/v1/grants/${grant.id}/revoke`, { token: mainnetToken })).status,
      ).toBe(404);
    });

    it("POST /v1/webhooks → 201 with the secret once", async () => {
      const receiver = await webhookReceiver();
      try {
        const res = await call(h, "POST", "/v1/webhooks", { token, body: { url: receiver.url } });
        expect(res.status).toBe(201);
        const endpoint = await json<WebhookEndpointCreated>(res);
        expect(keysOf(endpoint)).toEqual(sorted(WEBHOOK_ENDPOINT_CREATED_KEYS));
        expect(endpoint.secret).toMatch(/^whsec_/);
        const bad = await call(h, "POST", "/v1/webhooks", {
          token,
          body: { url: "ftp://example.com" },
        });
        expect(bad.status).toBe(400);
        expect((await json<ApiErrorBody>(bad)).error).toBe("BAD_URL");
      } finally {
        await receiver.close();
      }
    });

    it("GET /v1/webhooks lists the key's network; DELETE removes one (204, then 404)", async () => {
      const receiver = await webhookReceiver();
      try {
        const created = await json<WebhookEndpointCreated>(
          await call(h, "POST", "/v1/webhooks", { token, body: { url: receiver.url } }),
        );
        const listed = await json<Array<{ id: string; network: string }>>(
          await call(h, "GET", "/v1/webhooks", { token }),
        );
        expect(listed.map((e) => e.id)).toContain(created.id);
        expect(listed.every((e) => e.network === "testnet")).toBe(true);
        expect(JSON.stringify(listed)).not.toContain(created.secret);
        const mainnetList = await json<Array<{ id: string }>>(
          await call(h, "GET", "/v1/webhooks", { token: mainnetToken }),
        );
        expect(mainnetList.map((e) => e.id)).not.toContain(created.id);

        const otherNetwork = await call(h, "DELETE", `/v1/webhooks/${created.id}`, {
          token: mainnetToken,
        });
        expect(otherNetwork.status).toBe(404);
        const deleted = await call(h, "DELETE", `/v1/webhooks/${created.id}`, { token });
        expect(deleted.status).toBe(204);
        expect(await deleted.text()).toBe("");
        const again = await call(h, "DELETE", `/v1/webhooks/${created.id}`, { token });
        expect(again.status).toBe(404);
        const after = await json<Array<{ id: string }>>(
          await call(h, "GET", "/v1/webhooks", { token }),
        );
        expect(after.map((e) => e.id)).not.toContain(created.id);
      } finally {
        await receiver.close();
      }
    });

    it("POST /v1/tags → 201 Tag; GET /v1/tags/:name resolves without a key", async () => {
      const res = await call(h, "POST", "/v1/tags", { token, body: { name: "asharib" } });
      expect(res.status).toBe(201);
      const tag = await json<Tag>(res);
      expect(keysOf(tag)).toEqual(sorted(TAG_KEYS));
      expect(tag.display).toBe("asharib.shade");
      const resolved = await call(h, "GET", "/v1/tags/asharib");
      expect(resolved.status).toBe(200);
      const body = await json<Record<string, unknown>>(resolved);
      expect(keysOf(body)).toEqual(sorted(TAG_RESOLUTION_KEYS));
      expect(body).toEqual({ name: "asharib", network: "testnet", address: tag.address });
      expect((await call(h, "GET", "/v1/tags/asharib.shade")).status).toBe(200);
      expect((await call(h, "GET", "/v1/tags/nobody")).status).toBe(404);
      const taken = await call(h, "POST", "/v1/tags", {
        token: mainnetToken,
        body: { name: "asharib" },
      });
      expect(taken.status).toBe(409);
      expect((await json<ApiErrorBody>(taken)).error).toBe("TAG_TAKEN");
      const reserved = await call(h, "POST", "/v1/tags", { token, body: { name: "admin" } });
      expect((await json<ApiErrorBody>(reserved)).error).toBe("BAD_TAG");
    });
  });

  describe("CORS", () => {
    it("answers preflights for any origin without credentials", async () => {
      const res = await h.app.request("/v1/invoices", {
        method: "OPTIONS",
        headers: {
          origin: "https://shop.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type, idempotency-key",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      const allowed = (res.headers.get("access-control-allow-headers") ?? "").split(",");
      expect(allowed).toEqual(
        expect.arrayContaining(["authorization", "content-type", "idempotency-key", "accept"]),
      );
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
    });

    it("exposes x-request-id and retry-after on /v1 responses, errors included", async () => {
      const res = await call(h, "GET", "/v1/invoices", { origin: "https://shop.example" });
      expect(res.status).toBe(401);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const exposed = (res.headers.get("access-control-expose-headers") ?? "").split(",");
      expect(exposed).toEqual(expect.arrayContaining(["x-request-id", "retry-after"]));
    });
  });
});
