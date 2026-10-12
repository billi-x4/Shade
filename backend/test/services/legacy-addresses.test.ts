/**
 * Receive addresses stored by v0, which accepted any u/utest string: the SQL migrations cannot
 * re-encode them, so a merchant row or a jar can still hold a Unified Address with a transparent
 * receiver (or none with Orchard). Invoicing, jar charges and tags must use what saving the
 * address today would store, and refuse with a re-save hint instead of a 500.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ApiErrorBody,
  Invoice,
  JarChargeResult,
  Me,
  Network,
  TagResolution,
} from "../../src/contract/index.ts";
import { repairStoredAddresses } from "../../src/services/stored-addresses.ts";
import { decodeUnified, encodeUnified, parseMerchantAddress } from "../../src/zcash/address.ts";
import {
  type Harness,
  call,
  createHarness,
  deskSession,
  json,
  merchantKey,
  testAddress,
} from "../support/harness.ts";

const TRANSPARENT_P2PKH = 0x00;

/** The usual wallet UA v0 accepted: P2PKH + Orchard. */
function v0Address(network: Network): string {
  return testAddress(network, { transparent: true });
}

/** A v0-era UA with no Orchard receiver (P2PKH + Sapling): never privately payable by Shade. */
function v0AddressWithoutOrchard(network: Network): string {
  return encodeUnified("address", network, [
    { typecode: TRANSPARENT_P2PKH, data: new Uint8Array(randomBytes(20)) },
    { typecode: 0x02, data: new Uint8Array(randomBytes(43)) },
  ]);
}

function stripped(address: string): string {
  const parsed = parseMerchantAddress(address, "testnet");
  if (!parsed.ok) throw new Error("expected a parseable address");
  return parsed.address;
}

function typecodes(address: string): number[] {
  return decodeUnified(address).items.map((item) => item.typecode);
}

describe("receive addresses stored before v1", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  /** A desk merchant whose stored testnet address and jar are what v0 wrote. */
  async function legacyMerchant(address: string) {
    const session = await deskSession(h);
    await h.db`update merchants set ua_testnet = ${address} where id = ${session.merchantId}`;
    const jarId = `jar_legacy${randomBytes(6).toString("hex")}`;
    await h.db`
      insert into jars (id, merchant_id, label, cap_zec, spent_zec, status, address, network, created_at)
      values (${jarId}, ${session.merchantId}, 'agent', 1, 0.1, 'open', ${address}, 'testnet', now())`;
    const tag = `legacy${randomBytes(4).toString("hex")}`;
    await h.db`
      insert into tags (id, merchant_id, name, network, created_at)
      values (${`tag_${tag}`}, ${session.merchantId}, ${tag}, 'testnet', now())`;
    const { token } = await merchantKey(h, session.merchantId);
    return { ...session, jarId, tag, token };
  }

  it("invoices, charges and resolves a v0 address with a transparent receiver, shielded-only", async () => {
    const legacy = v0Address("testnet");
    expect(typecodes(legacy)).toContain(TRANSPARENT_P2PKH);
    const shielded = stripped(legacy);
    const m = await legacyMerchant(legacy);

    const created = await call(h, "POST", "/v1/invoices", {
      token: m.token,
      body: { amount_zec: "0.01", memo: "order 7" },
    });
    expect(created.status).toBe(201);
    const invoice = await json<Invoice>(created);
    expect(invoice.address).toBe(shielded);
    expect(invoice.zip321?.startsWith(`zcash:${shielded}?amount=0.01&memo=`)).toBe(true);
    expect(typecodes(invoice.address ?? "")).not.toContain(TRANSPARENT_P2PKH);

    // Desk invoice creation goes through the same address check.
    const desk = await call(h, "POST", "/api/desk/invoices", {
      cookie: m.cookie,
      body: { amount_zec: "0.02" },
    });
    expect(desk.status).toBe(201);
    expect((await json<Invoice>(desk)).address).toBe(shielded);

    // The legacy jar charges (its own stored address), runs dry, then closes.
    const charge = (amount: string) =>
      call(h, "POST", `/v1/jars/${m.jarId}/charge`, {
        token: m.token,
        body: { amount_zec: amount, memo: "api:search" },
      });
    const ok = await charge("0.5");
    expect(ok.status).toBe(201);
    const charged = await json<JarChargeResult>(ok);
    expect(charged.remaining_zec).toBe("0.4");
    const [row] = await h.db<{ address: string; zip321: string }>`
      select address, zip321 from invoices where id = ${charged.invoice_id}`;
    expect(row?.address).toBe(shielded);
    expect(row?.zip321.startsWith(`zcash:${shielded}?`)).toBe(true);
    const empty = await charge("0.5");
    expect(empty.status).toBe(402);
    expect((await json<ApiErrorBody>(empty)).error).toBe("JAR_EMPTY");
    expect((await call(h, "POST", `/v1/jars/${m.jarId}/kill`, { token: m.token })).status).toBe(
      200,
    );
    const closed = await charge("0.1");
    expect(closed.status).toBe(409);
    expect((await json<ApiErrorBody>(closed)).error).toBe("JAR_CLOSED");

    const resolved = await call(h, "GET", `/v1/tags/${m.tag}`);
    expect(resolved.status).toBe(200);
    expect(await json<TagResolution>(resolved)).toEqual({
      name: m.tag,
      network: "testnet",
      address: shielded,
    });

    const me = await json<Me>(await call(h, "GET", "/api/desk/me", { cookie: m.cookie }));
    expect(me.merchant.receive_addresses.testnet).toBe(shielded);
  });

  it("asks to save a v0 address without an Orchard receiver again, never a 500", async () => {
    const m = await legacyMerchant(v0AddressWithoutOrchard("testnet"));

    const created = await call(h, "POST", "/v1/invoices", {
      token: m.token,
      body: { amount_zec: "0.01" },
    });
    expect(created.status).toBe(409);
    const body = await json<ApiErrorBody>(created);
    expect(body.error).toBe("NO_ADDRESS");
    expect(body.message).toMatch(/save your receive address again/i);
    const jar = await call(h, "POST", "/v1/jars", {
      token: m.token,
      body: { cap_zec: "1", label: "agent" },
    });
    expect(jar.status).toBe(409);
    const tag = await call(h, "POST", "/v1/tags", { token: m.token, body: { name: "freshname" } });
    expect(tag.status).toBe(409);

    // The jar is a ledger, not a payment target: it still charges, then answers 402 and 409.
    const charge = (amount: string) =>
      call(h, "POST", `/v1/jars/${m.jarId}/charge`, {
        token: m.token,
        body: { amount_zec: amount },
      });
    const ok = await charge("0.9");
    expect(ok.status).toBe(201);
    const [row] = await h.db<{ zip321: string }>`
      select zip321 from invoices where id = ${(await json<JarChargeResult>(ok)).invoice_id}`;
    expect(row?.zip321).toBe("");
    expect((await charge("0.1")).status).toBe(402);
    await call(h, "POST", `/v1/jars/${m.jarId}/kill`, { token: m.token });
    expect((await charge("0.1")).status).toBe(409);

    expect((await call(h, "GET", `/v1/tags/${m.tag}`)).status).toBe(404);
    const me = await json<Me>(await call(h, "GET", "/api/desk/me", { cookie: m.cookie }));
    expect(me.merchant.receive_addresses.testnet).toBeNull();

    // Saving it again from the wallet's current address fixes invoicing.
    const fresh = testAddress("testnet");
    const saved = await call(h, "PUT", "/api/desk/settings/address", {
      cookie: m.cookie,
      body: { network: "testnet", address: fresh },
    });
    expect(saved.status).toBe(200);
    expect(
      (await call(h, "POST", "/v1/invoices", { token: m.token, body: { amount_zec: "0.01" } }))
        .status,
    ).toBe(201);
  });

  it("repairs stored rows once: rewrites to shielded-only, clears unpayable merchant addresses", async () => {
    // Everything earlier tests left behind is repaired too; count from a clean pass.
    await repairStoredAddresses(h.db);
    const legacy = v0Address("testnet");
    const withTransparent = await legacyMerchant(legacy);
    const withoutOrchard = await legacyMerchant(v0AddressWithoutOrchard("testnet"));
    const current = await deskSession(h);

    expect(await repairStoredAddresses(h.db)).toEqual({
      merchantsRewritten: 1,
      merchantsCleared: 1,
      jarsRewritten: 1,
    });
    const merchants = await h.db<{ id: string; ua_testnet: string | null }>`
      select id, ua_testnet from merchants
      where id = any(${[withTransparent.merchantId, withoutOrchard.merchantId, current.merchantId]}::text[])`;
    const byId = new Map(merchants.map((row) => [row.id, row.ua_testnet]));
    expect(byId.get(withTransparent.merchantId)).toBe(stripped(legacy));
    expect(byId.get(withoutOrchard.merchantId)).toBeNull();
    expect(byId.get(current.merchantId)).toBe(current.addresses.testnet);
    const [jar] = await h.db<{ address: string }>`
      select address from jars where id = ${withTransparent.jarId}`;
    expect(jar?.address).toBe(stripped(legacy));

    expect(await repairStoredAddresses(h.db)).toEqual({
      merchantsRewritten: 0,
      merchantsCleared: 0,
      jarsRewritten: 0,
    });
  });
});
