/**
 * The real shade-zcash-sdk against the real app (fetch = app.request): the PRD §9 calls, with every
 * camelCase result compared to a mechanical camelCase conversion of the wire body the server sent,
 * so a field the SDK drops or renames, or one the server adds, fails here.
 */
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { COPY, ERROR_CODES } from "../src/contract/index.ts";
import type { ErrorCode } from "../src/contract/index.ts";
import { Shade, ShadeError } from "../sdk/src/index.ts";
import type { ShadeApiErrorCode } from "../sdk/src/index.ts";
import {
  type Harness,
  createHarness,
  createMerchant,
  merchantKey,
  putShieldedTx,
  randomTxid,
  syncChain,
  webhookReceiver,
} from "./support/harness.ts";

function camel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camel);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase()),
      camel(inner),
    ]),
  );
}

describe("SDK ↔ API contract", () => {
  it("the SDK's error-code union is exactly the contract's (checked by typecheck)", () => {
    expectTypeOf<ShadeApiErrorCode>().toEqualTypeOf<ErrorCode>();
    expect(ERROR_CODES.length).toBeGreaterThan(40);
  });

  let h: Harness;
  let shade: Shade;
  let merchantId: string;
  const wire: unknown[] = [];

  /** An SDK client whose fetch is the app, recording each JSON response body. */
  const client = (apiKey: string) =>
    new Shade({
      apiKey,
      baseUrl: "http://localhost",
      fetch: async (input, init) => {
        const res = await h.app.request(input, init);
        wire.push(res.status === 204 ? null : await res.clone().json());
        return res;
      },
    });

  /** The last wire body, camelCased: what the SDK result must equal. */
  const lastWire = () => camel(wire.at(-1));

  beforeAll(async () => {
    h = await createHarness();
    merchantId = (await createMerchant(h)).merchantId;
    shade = client((await merchantKey(h, merchantId)).token);
  });
  afterAll(() => h.close());

  it("invoices.create / get / list / cancel", async () => {
    const inv = await shade.invoices.create({
      amountZec: "0.01",
      memo: "demo",
      expiresInSec: 3600,
      tag: "payroll",
    });
    expect(inv).toEqual(lastWire());
    // created_height → createdHeight: the chain tip when the invoice was made (the harness tip).
    expect(inv).toMatchObject({ createdHeight: 1000 });
    expect(inv.payUrl).toBe(`${h.config.appOrigin}/pay/${inv.id}`);
    expect(inv.zip321.startsWith("zcash:")).toBe(true);
    expect(inv.address).toMatch(/^utest1/);

    const got = await shade.invoices.get(inv.id);
    expect(got).toEqual(lastWire());
    const page = await shade.invoices.list({ status: ["open"], limit: 10 });
    expect(page).toEqual(lastWire());
    expect(page.items.map((i) => i.id)).toContain(inv.id);

    const cancelled = await shade.invoices.cancel(inv.id);
    expect(cancelled).toEqual(lastWire());
    expect(cancelled.status).toBe("cancelled");
  });

  it("invoices.reportDetection maps the detection summary", async () => {
    const inv = await shade.invoices.create({ amountZec: "0.02", memo: "device" });
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1001 });
    syncChain(h, "testnet", 1001);
    const paid = await shade.invoices.reportDetection(inv.id, {
      txid,
      amountZec: "0.02",
      memoHash: inv.memoHash,
      pool: "ironwood",
    });
    expect(paid).toEqual(lastWire());
    expect(paid.detection).toMatchObject({
      state: "settled",
      source: "merchant_device",
      requiredConfirmations: 1,
    });
  });

  it("jars.create / charge until JAR_EMPTY / kill, and JAR_CLOSED after", async () => {
    const jar = await shade.jars.create({ capZec: "0.006", label: "research-agent" });
    expect(jar).toEqual(lastWire());
    expect(jar.note).toBe(COPY.killNote);
    const agentKey = await h.services.keys.issue(merchantId, {
      kind: "agent",
      label: "agent",
      jar_id: jar.id,
    });
    const agent = client(agentKey.token);

    const remaining: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const charge = await agent.jars.charge(jar.id, { amountZec: "0.002", memo: "api:search" });
      expect(charge).toEqual(lastWire());
      remaining.push(charge.remainingZec);
    }
    expect(remaining).toEqual(["0.004", "0.002", "0"]);
    // The agent reads its own budget.
    const budget = await agent.jars.get(jar.id);
    expect(budget).toEqual(lastWire());
    expect(budget).toMatchObject({ remainingZec: "0", chargeCount: 3 });

    const empty = await agent.jars
      .charge(jar.id, { amountZec: "0.002", memo: "api:search" })
      .catch((err: unknown) => err);
    expect(empty).toBeInstanceOf(ShadeError);
    expect(empty).toMatchObject({
      status: 402,
      code: "JAR_EMPTY",
      message: COPY.jarEmpty,
      remainingZec: "0",
    });
    expect((empty as ShadeError).requestId).toMatch(/^req_/);

    const killed = await shade.jars.kill(jar.id);
    expect(killed).toEqual(lastWire());
    expect(killed.status).toBe("killed");
    const closed = await agent.jars
      .charge(jar.id, { amountZec: "0.001" })
      .catch((err: unknown) => err);
    expect(closed).toMatchObject({ status: 409, code: "JAR_CLOSED", remainingZec: "0" });
  });

  it("grants.create / revoke", async () => {
    const grant = await shade.grants.create({ scope: "payroll", days: 7 });
    expect(grant).toEqual(lastWire());
    expect(grant.viewUrl).toBe(`${h.config.appOrigin}/view#${grant.token}`);
    const short = await shade.grants.create({ scope: "all", expiresInSec: 600 });
    expect(short).toEqual(lastWire());
    const revoked = await shade.grants.revoke(grant.id);
    expect(revoked).toEqual(lastWire());
    expect(revoked.state).toBe("revoked");
  });

  it("webhooks.create / list / delete", async () => {
    const receiver = await webhookReceiver();
    try {
      const endpoint = await shade.webhooks.create({ url: receiver.url });
      expect(endpoint).toEqual(lastWire());
      expect(endpoint.secret).toMatch(/^whsec_/);
      expect(endpoint.secretHint).toBe(endpoint.secret.slice(-4));
      const listed = await shade.webhooks.list();
      expect(listed).toEqual(lastWire());
      const { secret: _secret, ...withoutSecret } = endpoint;
      expect(listed).toContainEqual(withoutSecret);
      await shade.webhooks.delete(endpoint.id);
      expect((await shade.webhooks.list()).map((e) => e.id)).not.toContain(endpoint.id);
      const again = await shade.webhooks.delete(endpoint.id).catch((err: unknown) => err);
      expect(again).toMatchObject({ status: 404, code: "NOT_FOUND" });
    } finally {
      await receiver.close();
    }
  });

  it("tags.create / resolve (resolve sends no key and accepts name.shade)", async () => {
    const tag = await shade.tags.create({ name: "asharib" });
    expect(tag).toEqual(lastWire());
    expect(tag.display).toBe("asharib.shade");
    const resolved = await shade.tags.resolve("asharib.shade");
    expect(resolved).toEqual(lastWire());
    expect(resolved).toEqual({ name: "asharib", network: "testnet", address: tag.address });
  });

  it("surfaces validation errors with issues and request ids", async () => {
    const err = await shade.invoices.create({ amountZec: "nope" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: "BAD_AMOUNT" });
    expect((err as ShadeError).requestId).toBeTruthy();
    const missing = await shade.invoices.get("inv_missing").catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
