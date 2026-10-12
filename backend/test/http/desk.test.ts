import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AddressSaved,
  ApiErrorBody,
  ApiKey,
  ApiKeyCreated,
  Grant,
  GrantCreated,
  Invoice,
  Jar,
  JarCharge,
  JarChargeResult,
  Me,
  Page,
  Tag,
  ViewingKeyStatus,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from "../../src/contract/index.ts";
import {
  type CallOptions,
  type Harness,
  call,
  createHarness,
  deskSession,
  json,
  putShieldedTx,
  randomTxid,
  syncChain,
  testAddress,
  testUfvk,
  webhookReceiver,
} from "../support/harness.ts";
import {
  API_KEY_CREATED_KEYS,
  API_KEY_KEYS,
  GRANT_CREATED_KEYS,
  GRANT_KEYS,
  INVOICE_KEYS,
  JAR_CHARGE_KEYS,
  JAR_KEYS,
  ME_KEYS,
  SCAN_KEYS,
  TAG_KEYS,
  VIEWING_KEY_STATUS_KEYS,
  WEBHOOK_DELIVERY_KEYS,
  WEBHOOK_ENDPOINT_CREATED_KEYS,
  WEBHOOK_ENDPOINT_KEYS,
  keysOf,
  sorted,
} from "../support/shapes.ts";

const STALE_MS = 16 * 60_000;

describe("/api/desk", () => {
  let h: Harness;
  let session: Awaited<ReturnType<typeof deskSession>>;

  /** A desk call for the shared session. */
  const desk = (method: string, path: string, opts: CallOptions = {}) =>
    call(h, method, `/api/desk${path}`, { cookie: session.cookie, ...opts });

  const errorOf = async (res: Response) => (await json<ApiErrorBody>(res)).error;

  beforeAll(async () => {
    h = await createHarness({ SHADE_NETWORKS: "testnet,mainnet" });
    session = await deskSession(h, { name: "Desk Shop", networks: ["testnet"] });
  });
  afterAll(() => h.close());

  describe("session and origin", () => {
    it("401s without a session and 403s unsafe requests from another origin", async () => {
      const anonymous = await call(h, "GET", "/api/desk/me");
      expect(anonymous.status).toBe(401);
      expect(await errorOf(anonymous)).toBe("UNAUTHORIZED");
      const foreign = await desk("POST", "/invoices", {
        body: { amount_zec: "1" },
        origin: "https://evil.example",
      });
      expect(foreign.status).toBe(403);
      expect(await errorOf(foreign)).toBe("FORBIDDEN_ORIGIN");
      const noOrigin = await desk("POST", "/invoices", { body: { amount_zec: "1" }, origin: null });
      expect(noOrigin.status).toBe(403);
      const sameSite = await desk("POST", "/invoices", {
        body: { amount_zec: "1" },
        origin: null,
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(sameSite.status).toBe(201);
      const loopbackTwin = await desk("GET", "/me", { origin: "http://127.0.0.1:5173" });
      expect(loopbackTwin.status).toBe(200);
      expect(loopbackTwin.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("requires a verified email when verification is on", async () => {
      const strict = await createHarness({ AUTH_REQUIRE_EMAIL_VERIFICATION: "true" });
      try {
        const signUp = await strict.auth.api.signUpEmail({
          body: {
            email: "strict@example.com",
            password: "correct horse battery staple",
            name: "S",
          },
        });
        await strict.db`update "user" set "emailVerified" = true where id = ${signUp.user.id}`;
        const signedIn = await call(strict, "POST", "/api/auth/sign-in/email", {
          body: { email: "strict@example.com", password: "correct horse battery staple" },
          ip: "192.0.2.80",
        });
        const cookie = signedIn.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
        expect((await call(strict, "GET", "/api/desk/me", { cookie })).status).toBe(200);
        await strict.db`update "user" set "emailVerified" = false where id = ${signUp.user.id}`;
        const res = await call(strict, "GET", "/api/desk/me", { cookie });
        expect(res.status).toBe(403);
        expect(await errorOf(res)).toBe("EMAIL_UNVERIFIED");
      } finally {
        await strict.close();
      }
    });

    it("creates a missing merchant lazily when the session is resolved", async () => {
      const lost = await deskSession(h);
      await h.db`delete from merchants where id = ${lost.merchantId}`;
      const res = await call(h, "GET", "/api/desk/me", { cookie: lost.cookie });
      expect(res.status).toBe(200);
      const me = await json<Me>(res);
      expect(me.merchant.id).not.toBe(lost.merchantId);
      expect(me.user.id).toBe(lost.userId);
    });

    it("rate-limits desk mutations per merchant", async () => {
      const busy = await deskSession(h);
      const windowStart = Math.floor(h.clock().getTime() / 60_000) * 60_000;
      await h.db`
        insert into rate_limits (bucket, window_start, count)
        values (${`desk:mut:${busy.merchantId}`}, ${new Date(windowStart)}, 120)`;
      const limited = await call(h, "PUT", "/api/desk/settings/profile", {
        cookie: busy.cookie,
        body: { display_name: "x" },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect((await call(h, "GET", "/api/desk/me", { cookie: busy.cookie })).status).toBe(200);
    });
  });

  describe("me and settings", () => {
    it("GET /me returns Me", async () => {
      const res = await desk("GET", "/me");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const me = await json<Me>(res);
      expect(keysOf(me)).toEqual(sorted(ME_KEYS));
      expect(me).toMatchObject({
        user: {
          id: session.userId,
          email: session.email,
          name: "Desk Shop",
          email_verified: false,
        },
        merchant: { id: session.merchantId, display_name: "Desk Shop", network: "testnet" },
        networks_enabled: ["testnet", "mainnet"],
        hosted_detection: true,
      });
    });

    it("PUT /settings/profile updates the display name", async () => {
      const res = await desk("PUT", "/settings/profile", { body: { display_name: "Renamed" } });
      expect(res.status).toBe(200);
      expect((await json<Me>(res)).merchant.display_name).toBe("Renamed");
      const tooLong = await desk("PUT", "/settings/profile", {
        body: { display_name: "x".repeat(49) },
      });
      expect(tooLong.status).toBe(400);
      const missing = await desk("PUT", "/settings/profile", { body: {} });
      expect((await json<ApiErrorBody>(missing)).issues?.[0]?.path).toBe("display_name");
    });

    it("PUT /settings/address saves a normalized address and needs a fresh session", async () => {
      const raw = testAddress("mainnet", { transparent: true });
      const res = await desk("PUT", "/settings/address", {
        body: { network: "mainnet", address: raw },
      });
      expect(res.status).toBe(200);
      const saved = await json<AddressSaved>(res);
      expect(keysOf(saved)).toEqual(["address", "me", "notice"]);
      expect(saved.notice).toMatch(/transparent/);
      expect(saved.me.merchant.receive_addresses.mainnet).toBe(saved.address);
      const bad = await desk("PUT", "/settings/address", {
        body: { network: "testnet", address: "t1nope" },
      });
      expect(bad.status).toBe(400);
      expect(await errorOf(bad)).toBe("BAD_ADDRESS");

      const stale = await deskSession(h);
      h.clock.advance(STALE_MS);
      try {
        const res2 = await call(h, "PUT", "/api/desk/settings/address", {
          cookie: stale.cookie,
          body: { network: "testnet", address: testAddress("testnet") },
        });
        expect(res2.status).toBe(403);
        expect(await errorOf(res2)).toBe("SESSION_NOT_FRESH");
      } finally {
        h.clock.advance(-STALE_MS);
      }
    });

    it("PUT /settings/network switches networks (fresh only for mainnet)", async () => {
      const other = await deskSession(h);
      h.clock.advance(STALE_MS);
      try {
        const toMainnet = await call(h, "PUT", "/api/desk/settings/network", {
          cookie: other.cookie,
          body: { network: "mainnet" },
        });
        expect(toMainnet.status).toBe(403);
        expect(await errorOf(toMainnet)).toBe("SESSION_NOT_FRESH");
        const toTestnet = await call(h, "PUT", "/api/desk/settings/network", {
          cookie: other.cookie,
          body: { network: "testnet" },
        });
        expect(toTestnet.status).toBe(200);
      } finally {
        h.clock.advance(-STALE_MS);
      }
      const res = await call(h, "PUT", "/api/desk/settings/network", {
        cookie: other.cookie,
        body: { network: "mainnet" },
      });
      expect((await json<Me>(res)).merchant.network).toBe("mainnet");
      const bogus = await call(h, "PUT", "/api/desk/settings/network", {
        cookie: other.cookie,
        body: { network: "regtest" },
      });
      expect(bogus.status).toBe(400);
    });
  });

  describe("invoices", () => {
    it("POST and GET /invoices with a single status filter and ?network", async () => {
      const created = await desk("POST", "/invoices", {
        body: { amount_zec: "0.01", memo: "desk", tag: "payroll" },
      });
      expect(created.status).toBe(201);
      const invoice = await json<Invoice>(created);
      expect(keysOf(invoice)).toEqual(sorted(INVOICE_KEYS));
      const list = await json<Page<Invoice>>(await desk("GET", "/invoices?status=open&limit=100"));
      expect(list.items.map((i) => i.id)).toContain(invoice.id);
      const paid = await json<Page<Invoice>>(await desk("GET", "/invoices?status=paid"));
      expect(paid.items.map((i) => i.id)).not.toContain(invoice.id);
      const mainnet = await json<Page<Invoice>>(await desk("GET", "/invoices?network=mainnet"));
      expect(mainnet.items.map((i) => i.id)).not.toContain(invoice.id);
      expect((await desk("GET", "/invoices?network=moon")).status).toBe(400);
    });

    it('refuses the reserved label "all" with 400 BAD_TAG', async () => {
      for (const tag of ["all", "ALL"]) {
        const res = await desk("POST", "/invoices", { body: { amount_zec: "0.01", tag } });
        expect(res.status).toBe(400);
        expect(await json<ApiErrorBody>(res)).toMatchObject({
          error: "BAD_TAG",
          message: '"all" is reserved. Pick another label.',
        });
      }
    });

    it("accepts and rejects payer claims; cancel refuses claims", async () => {
      const make = async (amount: string) =>
        json<Invoice>(await desk("POST", "/invoices", { body: { amount_zec: amount } }));
      const claim = async (invoice: Invoice, txid: string) => {
        const res = await call(h, "POST", `/api/public/invoices/${invoice.id}/txid`, {
          body: { txid },
          ip: `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
        });
        expect(res.status).toBe(200);
      };
      const first = await make("0.02");
      const txid = randomTxid();
      putShieldedTx(h.chain.testnet, txid, { height: 1001 });
      syncChain(h, "testnet", 1001);
      await claim(first, txid);
      const cancel = await desk("POST", `/invoices/${first.id}/cancel`);
      expect(cancel.status).toBe(409);
      expect(await errorOf(cancel)).toBe("NOT_OPEN");
      const accepted = await desk("POST", `/invoices/${first.id}/accept`);
      expect(accepted.status).toBe(200);
      expect(await json<Invoice>(accepted)).toMatchObject({
        status: "paid",
        verification: "merchant_accept",
        txid,
      });

      const second = await make("0.03");
      const pending = randomTxid();
      putShieldedTx(h.chain.testnet, pending, "mempool");
      await claim(second, pending);
      const notMined = await desk("POST", `/invoices/${second.id}/accept`);
      expect(notMined.status).toBe(409);
      expect(await errorOf(notMined)).toBe("TX_NOT_MINED");
      const rejected = await desk("POST", `/invoices/${second.id}/reject`);
      expect(rejected.status).toBe(200);
      expect(await json<Invoice>(rejected)).toMatchObject({ status: "open", claimed_txid: null });
      const cancelled = await desk("POST", `/invoices/${second.id}/cancel`);
      expect((await json<Invoice>(cancelled)).status).toBe("cancelled");

      const other = await deskSession(h);
      expect(
        (await call(h, "POST", `/api/desk/invoices/${first.id}/cancel`, { cookie: other.cookie }))
          .status,
      ).toBe(404);
    });

    it("confirms an open invoice with a txid from the merchant's wallet", async () => {
      const invoice = await json<Invoice>(
        await desk("POST", "/invoices", { body: { amount_zec: "0.04" } }),
      );
      const noClaim = await desk("POST", `/invoices/${invoice.id}/accept`);
      expect(noClaim.status).toBe(409);
      expect(await errorOf(noClaim)).toBe("NOT_OPEN");
      const bad = await desk("POST", `/invoices/${invoice.id}/accept`, { body: { txid: "nope" } });
      expect(bad.status).toBe(400);
      expect(await errorOf(bad)).toBe("BAD_TXID");
      const unknown = await desk("POST", `/invoices/${invoice.id}/accept`, {
        body: { txid: randomTxid() },
      });
      expect(unknown.status).toBe(404);
      expect(await errorOf(unknown)).toBe("TX_NOT_FOUND");

      const txid = randomTxid();
      putShieldedTx(h.chain.testnet, txid, { height: 1001 });
      syncChain(h, "testnet", 1001);
      const accepted = await desk("POST", `/invoices/${invoice.id}/accept`, { body: { txid } });
      expect(accepted.status).toBe(200);
      expect(await json<Invoice>(accepted)).toMatchObject({
        status: "paid",
        verification: "merchant_accept",
        txid,
      });
    });
  });

  describe("jars", () => {
    it("creates, lists, pages charges, refunds and kills", async () => {
      const created = await desk("POST", "/jars", { body: { cap_zec: "0.01", label: "agent" } });
      expect(created.status).toBe(201);
      const jar = await json<Jar>(created);
      expect(keysOf(jar)).toEqual(sorted(JAR_KEYS));
      const list = await json<Jar[]>(await desk("GET", "/jars"));
      expect(list.map((j) => j.id)).toContain(jar.id);

      const plan = h.services.jars.prepareCharge(session.merchantId, "testnet", jar.id, {
        amount_zec: "0.004",
        memo: "api",
      });
      const charges: JarChargeResult[] = [];
      for (let i = 0; i < 2; i += 1)
        charges.push(await h.db.tx((sql) => h.services.jars.charge(sql, plan)));
      const page = await json<Page<JarCharge>>(
        await desk("GET", `/jars/${jar.id}/charges?limit=1`),
      );
      expect(page.items).toHaveLength(1);
      expect(keysOf(page.items[0])).toEqual(sorted(JAR_CHARGE_KEYS));
      expect(page.next_cursor).not.toBeNull();
      const rest = await json<Page<JarCharge>>(
        await desk("GET", `/jars/${jar.id}/charges?cursor=${page.next_cursor}`),
      );
      expect(rest.items.map((c) => c.id)).toEqual([charges[0]?.invoice_id]);

      const refunded = await desk(
        "POST",
        `/jars/${jar.id}/charges/${charges[0]?.invoice_id}/cancel`,
      );
      expect(refunded.status).toBe(200);
      expect(await json<Jar>(refunded)).toMatchObject({
        spent_zec: "0.004",
        remaining_zec: "0.006",
      });

      const killed = await desk("POST", `/jars/${jar.id}/kill`);
      expect((await json<Jar>(killed)).status).toBe("killed");
      const closed = await desk("POST", `/jars/${jar.id}/charges/${charges[1]?.invoice_id}/cancel`);
      expect(closed.status).toBe(409);
      expect(await json<ApiErrorBody>(closed)).toMatchObject({
        error: "JAR_CLOSED",
        remaining_zec: "0.006",
      });
      expect((await desk("GET", "/jars/jar_unknown/charges")).status).toBe(404);
    });
  });

  describe("grants", () => {
    it("lists, creates (fresh above one day) and revokes", async () => {
      const created = await desk("POST", "/grants", {
        body: { scope: "payroll", expires_in_sec: 600 },
      });
      expect(created.status).toBe(201);
      const grant = await json<GrantCreated>(created);
      expect(keysOf(grant)).toEqual(sorted(GRANT_CREATED_KEYS));
      const list = await json<Grant[]>(await desk("GET", "/grants"));
      expect(list.map((g) => g.id)).toContain(grant.id);
      expect(keysOf(list[0])).toEqual(sorted(GRANT_KEYS));
      expect(JSON.stringify(list)).not.toContain(grant.token);

      const stale = await deskSession(h);
      h.clock.advance(STALE_MS);
      try {
        const day = await call(h, "POST", "/api/desk/grants", {
          cookie: stale.cookie,
          body: { scope: "all", expires_in_sec: 86_400 },
        });
        expect(day.status).toBe(201);
        const week = await call(h, "POST", "/api/desk/grants", {
          cookie: stale.cookie,
          body: { scope: "all", expires_in_sec: 86_401 },
        });
        expect(week.status).toBe(403);
        expect(await errorOf(week)).toBe("SESSION_NOT_FRESH");
      } finally {
        h.clock.advance(-STALE_MS);
      }

      const revoked = await desk("POST", `/grants/${grant.id}/revoke`);
      expect((await json<Grant>(revoked)).state).toBe("revoked");
    });
  });

  describe("webhooks", () => {
    it("creates (fresh), lists, tests, pages deliveries and deletes", async () => {
      const receiver = await webhookReceiver();
      try {
        const noEndpoints = await desk("POST", "/webhooks/test");
        expect(noEndpoints.status).toBe(409);
        expect(await errorOf(noEndpoints)).toBe("NO_ENDPOINTS");

        const created = await desk("POST", "/webhooks", { body: { url: receiver.url } });
        expect(created.status).toBe(201);
        const endpoint = await json<WebhookEndpointCreated>(created);
        expect(keysOf(endpoint)).toEqual(sorted(WEBHOOK_ENDPOINT_CREATED_KEYS));
        const list = await json<WebhookEndpoint[]>(await desk("GET", "/webhooks"));
        expect(list.map((e) => keysOf(e))).toEqual([sorted(WEBHOOK_ENDPOINT_KEYS)]);

        const test = await desk("POST", "/webhooks/test");
        expect(test.status).toBe(200);
        const sent = await json<{ event_id: string; endpoints: number }>(test);
        expect(keysOf(sent)).toEqual(["endpoints", "event_id"]);
        expect(sent.endpoints).toBe(1);
        await h.services.idle();
        expect(receiver.received).toHaveLength(1);

        const deliveries = await json<Page<WebhookDelivery>>(
          await desk("GET", "/webhooks/deliveries"),
        );
        expect(deliveries.items).toHaveLength(1);
        expect(keysOf(deliveries.items[0])).toEqual(sorted(WEBHOOK_DELIVERY_KEYS));
        expect(deliveries.items[0]).toMatchObject({ event_id: sent.event_id, status: "delivered" });

        const removed = await desk("DELETE", `/webhooks/${endpoint.id}`);
        expect(removed.status).toBe(204);
        expect(await removed.text()).toBe("");
        expect(await json<WebhookEndpoint[]>(await desk("GET", "/webhooks"))).toEqual([]);
        expect((await desk("DELETE", `/webhooks/${endpoint.id}`)).status).toBe(404);

        const stale = await deskSession(h);
        h.clock.advance(STALE_MS);
        try {
          const res = await call(h, "POST", "/api/desk/webhooks", {
            cookie: stale.cookie,
            body: { url: receiver.url },
          });
          expect(res.status).toBe(403);
          expect(await errorOf(res)).toBe("SESSION_NOT_FRESH");
        } finally {
          h.clock.advance(-STALE_MS);
        }
      } finally {
        await receiver.close();
      }
    });

    it("limits test sends to 5 per minute", async () => {
      const busy = await deskSession(h);
      const windowStart = Math.floor(h.clock().getTime() / 60_000) * 60_000;
      await h.db`
        insert into rate_limits (bucket, window_start, count)
        values (${`desk:whtest:${busy.merchantId}`}, ${new Date(windowStart)}, 5)`;
      const res = await call(h, "POST", "/api/desk/webhooks/test", { cookie: busy.cookie });
      expect(res.status).toBe(429);
    });
  });

  describe("tags", () => {
    it("creates and lists tags", async () => {
      const created = await desk("POST", "/tags", { body: { name: "deskshop" } });
      expect(created.status).toBe(201);
      const tag = await json<Tag>(created);
      expect(keysOf(tag)).toEqual(sorted(TAG_KEYS));
      expect((await json<Tag[]>(await desk("GET", "/tags"))).map((t) => t.name)).toContain(
        "deskshop",
      );
      const bad = await desk("POST", "/tags", { body: { name: "www" } });
      expect(await errorOf(bad)).toBe("BAD_TAG");
    });
  });

  describe("API keys", () => {
    it("issues (fresh, rate limited), lists and revokes", async () => {
      const created = await desk("POST", "/keys", {
        body: { kind: "merchant", label: "server", network: "testnet" },
      });
      expect(created.status).toBe(201);
      const key = await json<ApiKeyCreated>(created);
      expect(keysOf(key)).toEqual(sorted(API_KEY_CREATED_KEYS));
      expect(key.token).toMatch(/^sk_test_/);
      const mainnet = await json<ApiKeyCreated>(
        await desk("POST", "/keys", {
          body: { kind: "merchant", label: "live", network: "mainnet" },
        }),
      );
      expect(mainnet.token).toMatch(/^sk_live_/);
      const list = await json<ApiKey[]>(await desk("GET", "/keys"));
      expect(list.map((k) => k.id)).toEqual(expect.arrayContaining([key.id, mainnet.id]));
      expect(keysOf(list[0])).toEqual(sorted(API_KEY_KEYS));
      expect(JSON.stringify(list)).not.toContain(key.token);
      const revoked = await desk("POST", `/keys/${key.id}/revoke`);
      expect((await json<ApiKey>(revoked)).revoked_at).not.toBeNull();
      expect((await call(h, "GET", "/v1/invoices", { token: key.token })).status).toBe(401);

      const jar = await json<Jar>(
        await desk("POST", "/jars", { body: { cap_zec: "1", label: "agent" } }),
      );
      const agent = await json<ApiKeyCreated>(
        await desk("POST", "/keys", { body: { kind: "agent", label: "bot", jar_id: jar.id } }),
      );
      expect(agent).toMatchObject({ kind: "agent", jar_id: jar.id, network: "testnet" });
      const unknownJar = await desk("POST", "/keys", {
        body: { kind: "agent", label: "bot", jar_id: "jar_nope" },
      });
      expect(unknownJar.status).toBe(404);

      const windowStart = Math.floor(h.clock().getTime() / 3_600_000) * 3_600_000;
      await h.db`
        insert into rate_limits (bucket, window_start, count)
        values (${`desk:keys:${session.merchantId}`}, ${new Date(windowStart)}, 10)
        on conflict (bucket, window_start) do update set count = 10`;
      const limited = await desk("POST", "/keys", { body: { kind: "merchant", label: "x" } });
      expect(limited.status).toBe(429);

      const stale = await deskSession(h);
      h.clock.advance(STALE_MS);
      try {
        const res = await call(h, "POST", "/api/desk/keys", {
          cookie: stale.cookie,
          body: { kind: "merchant", label: "x" },
        });
        expect(await errorOf(res)).toBe("SESSION_NOT_FRESH");
      } finally {
        h.clock.advance(-STALE_MS);
      }
    });
  });

  describe("viewing keys", () => {
    it("uploads (upsert, fresh), lists and deletes", async () => {
      const owner = await deskSession(h);
      const ufvk = testUfvk("testnet");
      const put = await call(h, "PUT", "/api/desk/viewing-keys/testnet", {
        cookie: owner.cookie,
        body: { ufvk },
      });
      expect(put.status).toBe(200);
      const status = await json<ViewingKeyStatus>(put);
      expect(keysOf(status)).toEqual(sorted(VIEWING_KEY_STATUS_KEYS));
      expect(keysOf(status.scan)).toEqual(sorted(SCAN_KEYS));
      expect(JSON.stringify(status)).not.toContain(ufvk);
      const replaced = await call(h, "PUT", "/api/desk/viewing-keys/testnet", {
        cookie: owner.cookie,
        body: { ufvk, use_key_address: false },
      });
      expect((await json<ViewingKeyStatus>(replaced)).use_key_address).toBe(false);
      const list = await json<ViewingKeyStatus[]>(
        await call(h, "GET", "/api/desk/viewing-keys", { cookie: owner.cookie }),
      );
      expect(list).toHaveLength(1);

      const bad = await call(h, "PUT", "/api/desk/viewing-keys/testnet", {
        cookie: owner.cookie,
        body: { ufvk: "zxviews1nope" },
      });
      expect(bad.status).toBe(400);
      expect(await errorOf(bad)).toBe("BAD_VIEWING_KEY");
      expect(
        (
          await call(h, "PUT", "/api/desk/viewing-keys/regtest", {
            cookie: owner.cookie,
            body: { ufvk },
          })
        ).status,
      ).toBe(404);

      const removed = await call(h, "DELETE", "/api/desk/viewing-keys/testnet", {
        cookie: owner.cookie,
      });
      expect(removed.status).toBe(204);
      expect(
        await json<ViewingKeyStatus[]>(
          await call(h, "GET", "/api/desk/viewing-keys", { cookie: owner.cookie }),
        ),
      ).toEqual([]);

      h.clock.advance(STALE_MS);
      try {
        const stale = await call(h, "PUT", "/api/desk/viewing-keys/testnet", {
          cookie: owner.cookie,
          body: { ufvk },
        });
        expect(await errorOf(stale)).toBe("SESSION_NOT_FRESH");
      } finally {
        h.clock.advance(-STALE_MS);
      }
    });

    it("refuses to keep a receive address that is not the key's own (422, nothing changes)", async () => {
      const owner = await deskSession(h);
      const upload = (ufvk: string, useKeyAddress?: boolean) =>
        call(h, "PUT", "/api/desk/viewing-keys/testnet", {
          cookie: owner.cookie,
          body: useKeyAddress === undefined ? { ufvk } : { ufvk, use_key_address: useKeyAddress },
        });
      const addressOnFile = async () => {
        const [row] = await h.db<{ ua_testnet: string | null }>`
          select ua_testnet from merchants where id = ${owner.merchantId}`;
        return row?.ua_testnet;
      };
      const listed = async () =>
        json<ViewingKeyStatus[]>(
          await call(h, "GET", "/api/desk/viewing-keys", { cookie: owner.cookie }),
        );

      // The session's merchant pays an address of another wallet.
      const foreign = await upload(testUfvk("testnet"), false);
      expect(foreign.status).toBe(422);
      const body = await json<ApiErrorBody>(foreign);
      expect(body.error).toBe("VIEWING_KEY_ADDRESS_MISMATCH");
      // Its advice works: the option on, then the same key again with it off (below).
      expect(body.message).toBe(
        "Shade can't confirm that your receive address belongs to this viewing key, so it might not detect payments to it. Turn on “Use this key's address” for this upload. To use another address of the same wallet, upload the key again afterwards with it turned off, then save that address under Receive addresses.",
      );
      expect(await addressOnFile()).toBe(owner.addresses.testnet);
      expect(await listed()).toEqual([]);

      // Key A provides the address; turning that off keeps it (it is A's own address).
      const keyA = testUfvk("testnet");
      const first = await json<ViewingKeyStatus>(await upload(keyA));
      const managed = await call(h, "PUT", "/api/desk/settings/address", {
        cookie: owner.cookie,
        body: { network: "testnet", address: testAddress("testnet") },
      });
      expect(managed.status).toBe(409);
      expect(await json<ApiErrorBody>(managed)).toMatchObject({
        error: "ADDRESS_MANAGED_BY_KEY",
        message:
          "Your viewing key provides this address. Upload the key again with “Use this key's address” turned off, or delete the key, to use a different address.",
      });
      expect((await upload(keyA, false)).status).toBe(200);
      expect(await addressOnFile()).toBe(first.key_address);
      // Key B cannot take over A's address; A stays active.
      const other = await upload(testUfvk("testnet"), false);
      expect(await errorOf(other)).toBe("VIEWING_KEY_ADDRESS_MISMATCH");
      const keys = await listed();
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ fingerprint: first.fingerprint, use_key_address: false });
      expect(await addressOnFile()).toBe(first.key_address);

      // Settings › address may still set an address Shade cannot confirm (with a warning), and
      // uploading the same key again keeps it.
      const own = testAddress("testnet");
      const saved = await call(h, "PUT", "/api/desk/settings/address", {
        cookie: owner.cookie,
        body: { network: "testnet", address: own },
      });
      expect(saved.status).toBe(200);
      expect((await json<AddressSaved>(saved)).notice).toMatch(/can't confirm/);
      expect((await upload(keyA, false)).status).toBe(200);
      expect(await addressOnFile()).toBe(own);
    });

    it("is 409 HOSTED_DETECTION_DISABLED when the server has no seal key", async () => {
      const owner = await deskSession(h);
      const publicKey = h.config.sealPublicKey;
      h.config.sealPublicKey = null;
      try {
        const res = await call(h, "PUT", "/api/desk/viewing-keys/testnet", {
          cookie: owner.cookie,
          body: { ufvk: testUfvk("testnet") },
        });
        expect(res.status).toBe(409);
        expect(await errorOf(res)).toBe("HOSTED_DETECTION_DISABLED");
      } finally {
        h.config.sealPublicKey = publicKey;
      }
    });
  });
});
