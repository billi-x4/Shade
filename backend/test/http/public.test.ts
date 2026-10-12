import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiErrorBody,
  type AppConfig,
  COPY,
  type GrantCreated,
  type GrantView,
  type PublicInvoice,
} from "../../src/contract/index.ts";
import {
  type Harness,
  call,
  createHarness,
  createMerchant,
  json,
  merchantKey,
  putShieldedTx,
  randomTxid,
  syncChain,
} from "../support/harness.ts";
import {
  APP_CONFIG_KEYS,
  PUBLIC_INVOICE_KEYS,
  RECEIPT_KEYS,
  keysOf,
  sorted,
} from "../support/shapes.ts";

describe("/api/config and /api/public", () => {
  let h: Harness;
  let merchantId: string;
  let token: string;

  beforeAll(async () => {
    h = await createHarness();
    merchantId = (await createMerchant(h, { name: "Pay Shop" })).merchantId;
    token = (await merchantKey(h, merchantId)).token;
  });
  afterAll(() => h.close());

  const invoice = (
    body: Record<string, unknown> = { amount_zec: "0.01", memo: "pay me", tag: "payroll" },
  ) => h.services.invoices.create(merchantId, "testnet", body as { amount_zec: string });

  it("GET /api/config → AppConfig", async () => {
    const res = await call(h, "GET", "/api/config");
    expect(res.status).toBe(200);
    const config = await json<AppConfig>(res);
    expect(keysOf(config)).toEqual(sorted(APP_CONFIG_KEYS));
    expect(config).toEqual({
      networks: ["testnet"],
      default_network: "testnet",
      min_confirmations: { testnet: 1, mainnet: 10 },
      auth: { email_password: true, email_verification_required: false, password_min_length: 12 },
      features: { hosted_detection: true },
      explorer_tx_url: h.config.explorerTxUrl,
    });
  });

  describe("pay page", () => {
    it("GET /api/public/invoices/:id → minimal PublicInvoice", async () => {
      const inv = await invoice();
      const res = await call(h, "GET", `/api/public/invoices/${inv.id}`);
      expect(res.status).toBe(200);
      const body = await json<PublicInvoice>(res);
      expect(keysOf(body)).toEqual(sorted(PUBLIC_INVOICE_KEYS));
      const text = JSON.stringify(body);
      for (const forbidden of [inv.memo_hash, inv.chain_memo.slice(-15), "payroll", merchantId]) {
        expect(text).not.toContain(forbidden);
      }
      expect(body).toMatchObject({
        status: "open",
        progress: "awaiting",
        merchant_name: "Pay Shop",
      });
    });

    it("404s jar charges and unknown ids", async () => {
      const jar = await h.services.jars.create(merchantId, "testnet", { cap_zec: "1", label: "a" });
      const plan = h.services.jars.prepareCharge(merchantId, "testnet", jar.id, {
        amount_zec: "0.1",
      });
      const charge = await h.db.tx((sql) => h.services.jars.charge(sql, plan));
      for (const id of [charge.invoice_id, "inv_unknown", "%3Cscript%3E"]) {
        const res = await call(h, "GET", `/api/public/invoices/${id}`);
        expect(res.status).toBe(404);
        expect((await json<ApiErrorBody>(res)).error).toBe("NOT_FOUND");
      }
    });

    it("POST /api/public/invoices/:id/txid records a claim (never TXID_IN_USE)", async () => {
      const first = await invoice({ amount_zec: "0.02" });
      const second = await invoice({ amount_zec: "0.021" });
      const txid = randomTxid();
      putShieldedTx(h.chain.testnet, txid, { height: 1001 });
      syncChain(h, "testnet", 1001);
      for (const target of [first, second]) {
        const res = await call(h, "POST", `/api/public/invoices/${target.id}/txid`, {
          body: { txid },
          ip: "192.0.2.10",
        });
        expect(res.status).toBe(200);
        const body = await json<PublicInvoice>(res);
        expect(keysOf(body)).toEqual(sorted(PUBLIC_INVOICE_KEYS));
        expect(body).toMatchObject({ status: "paid_unverified", progress: "reported" });
        expect(JSON.stringify(body)).not.toContain(txid);
      }
      const bad = await call(h, "POST", `/api/public/invoices/${first.id}/txid`, {
        body: { txid: "zz" },
        ip: "192.0.2.11",
      });
      expect(bad.status).toBe(400);
      expect((await json<ApiErrorBody>(bad)).error).toBe("BAD_TXID");
      const missing = await call(h, "POST", `/api/public/invoices/${first.id}/txid`, {
        body: {},
        ip: "192.0.2.11",
      });
      expect((await json<ApiErrorBody>(missing)).error).toBe("INVALID_REQUEST");
    });

    it("maps chain answers to 404 / 422 / 503", async () => {
      const inv = await invoice({ amount_zec: "0.03" });
      const post = (txid: string, ip: string) =>
        call(h, "POST", `/api/public/invoices/${inv.id}/txid`, { body: { txid }, ip });
      const unknown = await post(randomTxid(), "192.0.2.20");
      expect(unknown.status).toBe(404);
      expect(await json<ApiErrorBody>(unknown)).toMatchObject({ error: "TX_NOT_FOUND" });
      const transparent = randomTxid();
      putShieldedTx(
        h.chain.testnet,
        transparent,
        { height: 1001 },
        { transparentInputs: 1, transparentOutputs: 1 },
      );
      const shaped = await post(transparent, "192.0.2.21");
      expect(shaped.status).toBe(422);
      expect((await json<ApiErrorBody>(shaped)).error).toBe("TX_NOT_SHIELDED");
      h.chain.testnet.failNext();
      const down = await post(randomTxid(), "192.0.2.22");
      expect(down.status).toBe(503);
      expect(down.headers.get("retry-after")).toBe("30");
      expect((await json<ApiErrorBody>(down)).retry_after).toBe(30);
    });

    it("rate-limits claims per IP and per invoice", async () => {
      const inv = await invoice({ amount_zec: "0.04" });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await call(h, "POST", `/api/public/invoices/${inv.id}/txid`, {
          body: { txid: randomTxid() },
          ip: `192.0.2.${100 + i}`,
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 404)).toBe(true);
      expect(statuses[5]).toBe(429);

      const ipStatuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const target = await invoice({ amount_zec: `0.05${i}` });
        const res = await call(h, "POST", `/api/public/invoices/${target.id}/txid`, {
          body: { txid: randomTxid() },
          ip: "192.0.2.200",
        });
        ipStatuses.push(res.status);
      }
      expect(ipStatuses[10]).toBe(429);
    });
  });

  describe("grant view and export", () => {
    const grant = async (scope = "payroll") => {
      const res = await call(h, "POST", "/v1/grants", { token, body: { scope, days: 1 } });
      return json<GrantCreated>(res);
    };

    it("POST /api/public/grants/view → GrantView (token only in the body)", async () => {
      const inv = await invoice({ amount_zec: "0.06", memo: "salary", tag: "payroll" });
      await h.db`
        update invoices set status = 'paid', verification = 'ivk_scan', txid = ${randomTxid()},
          paid_at = ${h.clock()} where id = ${inv.id}`;
      const g = await grant();
      const res = await call(h, "POST", "/api/public/grants/view", {
        body: { token: g.token },
        ip: "192.0.2.30",
      });
      expect(res.status).toBe(200);
      const view = await json<Extract<GrantView, { state: "active" }>>(res);
      expect(view.state).toBe("active");
      expect(keysOf(view)).toEqual(
        sorted(["state", "scope", "network", "merchant_name", "expires_at", "message", "receipts"]),
      );
      expect(view.receipts.map((r) => r.id)).toEqual([inv.id]);
      expect(keysOf(view.receipts[0])).toEqual(sorted(RECEIPT_KEYS));
      const unknown = await call(h, "POST", "/api/public/grants/view", {
        body: { token: `gv_${"x".repeat(43)}` },
        ip: "192.0.2.30",
      });
      expect(unknown.status).toBe(404);
    });

    it("POST /api/public/grants/export → CSV attachment; 410 once revoked or expired", async () => {
      const g = await grant("all");
      const res = await call(h, "POST", "/api/public/grants/export", {
        body: { token: g.token },
        ip: "192.0.2.31",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="shade-receipts-${g.id}.csv"`,
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.text()).split("\r\n")[0]).toBe(
        "paid_at,invoice_id,kind,amount_zec,memo,tag,txid,verification",
      );

      await call(h, "POST", `/v1/grants/${g.id}/revoke`, { token });
      const revoked = await call(h, "POST", "/api/public/grants/export", {
        body: { token: g.token },
        ip: "192.0.2.31",
      });
      expect(revoked.status).toBe(410);
      expect(await json<ApiErrorBody>(revoked)).toMatchObject({
        error: "GRANT_REVOKED",
        message: COPY.grantNote,
      });
      const view = await call(h, "POST", "/api/public/grants/view", {
        body: { token: g.token },
        ip: "192.0.2.31",
      });
      expect(await json<GrantView>(view)).toEqual({
        state: "revoked",
        scope: "all",
        message: COPY.grantNote,
      });

      const short = await json<GrantCreated>(
        await call(h, "POST", "/v1/grants", { token, body: { scope: "all", expires_in_sec: 600 } }),
      );
      h.clock.advance(601_000);
      const expired = await call(h, "POST", "/api/public/grants/export", {
        body: { token: short.token },
        ip: "192.0.2.32",
      });
      expect(expired.status).toBe(410);
      expect((await json<ApiErrorBody>(expired)).error).toBe("GRANT_EXPIRED");
    });

    it("rate-limits grant lookups per IP (30/60 s)", async () => {
      const windowStart = Math.floor(h.clock().getTime() / 60_000) * 60_000;
      await h.db`
        insert into rate_limits (bucket, window_start, count)
        values ('pub:grant:ip:192.0.2.99', ${new Date(windowStart)}, 30)`;
      const res = await call(h, "POST", "/api/public/grants/view", {
        body: { token: "gv_x" },
        ip: "192.0.2.99",
      });
      expect(res.status).toBe(429);
    });
  });
});
