import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "../../src/contract/index.ts";
import { AppError } from "../../src/platform/errors.ts";
import { encodeCursor } from "../../src/services/common.ts";
import { memoHash } from "../../src/zcash/memo.ts";
import { type Harness, createHarness, createMerchant, createUser } from "../support/harness.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

describe("invoices service", () => {
  let h: Harness;
  let merchantId: string;
  let address: string;

  beforeAll(async () => {
    h = await createHarness();
    const merchant = await createMerchant(h);
    merchantId = merchant.merchantId;
    address = merchant.addresses.testnet ?? "";
  });

  afterAll(() => h.close());

  it("creates an invoice with a unique on-chain memo, memo hash, ZIP-321 URI and pay URL", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.0100",
      memo: "order_1042",
      tag: "PayRoll",
    });
    expect(invoice).toMatchObject({
      status: "open",
      verification: null,
      network: "testnet",
      amount_zec: "0.01",
      memo: "order_1042",
      tag: "payroll",
      address,
      txid: null,
      claimed_txid: null,
      jar_id: null,
      paid_at: null,
      detection: null,
      pay_url: `${h.config.appOrigin}/pay/${invoice.id}`,
    });
    expect(invoice.chain_memo).toMatch(/^order_1042 \(shade:[0-9A-HJKMNP-TV-Z]{8}\)$/);
    expect(invoice.memo_hash).toBe(memoHash(invoice.chain_memo));
    const memoParam = Buffer.from(invoice.chain_memo, "utf8").toString("base64url");
    expect(invoice.zip321).toBe(`zcash:${address}?amount=0.01&memo=${memoParam}`);
    expect(Date.parse(invoice.expires_at) - Date.parse(invoice.created_at)).toBe(3600_000);

    const [row] = await h.db<{ created_height: number | null }>`
      select created_height from invoices where id = ${invoice.id}`;
    expect(row?.created_height).toBe(1000);
    // Scanners start from the recorded tip; every read returns it.
    expect(invoice.created_height).toBe(1000);
    const read = await h.services.invoices.get({ merchantId, network: "testnet" }, invoice.id);
    expect(read.created_height).toBe(1000);
  });

  it("uses shade:<REF> as the chain memo when the merchant memo is empty", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "1" });
    expect(invoice.memo).toBe("");
    expect(invoice.chain_memo).toMatch(/^shade:[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(invoice.tag).toBeNull();
  });

  it("records a null created height when the chain is down, without failing", async () => {
    h.chain.testnet.failNext();
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "0.5" });
    const [row] = await h.db<{ created_height: number | null }>`
      select created_height from invoices where id = ${invoice.id}`;
    expect(row?.created_height).toBeNull();
    expect(invoice.created_height).toBeNull();
  });

  it.each([
    [{ amount_zec: "0" }, "BAD_AMOUNT"],
    [{ amount_zec: "0.123456789" }, "BAD_AMOUNT"],
    [{ amount_zec: "-1" }, "BAD_AMOUNT"],
    [{ amount_zec: "21000001" }, "BAD_AMOUNT"],
    [{ amount_zec: "1", memo: "line\nbreak" }, "BAD_MEMO"],
    [{ amount_zec: "1", memo: "x".repeat(496) }, "BAD_MEMO"],
    [{ amount_zec: "1", tag: "has space" }, "BAD_TAG"],
    [{ amount_zec: "1", tag: "a".repeat(33) }, "BAD_TAG"],
    [{ amount_zec: "1", tag: "all" }, "BAD_TAG"],
    [{ amount_zec: "1", tag: " ALL " }, "BAD_TAG"],
    [{ amount_zec: "1", expires_in_sec: 59 }, "BAD_EXPIRY"],
    [{ amount_zec: "1", expires_in_sec: 604_801 }, "BAD_EXPIRY"],
    [{ amount_zec: "1", expires_in_sec: 90.5 }, "BAD_EXPIRY"],
  ])("rejects %j with %s", async (input, code) => {
    const err = await rejects(h.services.invoices.create(merchantId, "testnet", input));
    expect(err.status).toBe(400);
    expect(err.code).toBe(code);
  });

  it('reserves the label "all" (a grant for "all" covers every receipt) but not labels like it', async () => {
    const err = await rejects(
      h.services.invoices.create(merchantId, "testnet", { amount_zec: "1", tag: "All" }),
    );
    expect(err).toMatchObject({
      status: 400,
      code: "BAD_TAG",
      message: '"all" is reserved. Pick another label.',
    });
    for (const tag of ["all-hands", "allowance", "all_1"]) {
      const invoice = await h.services.invoices.create(merchantId, "testnet", {
        amount_zec: "1",
        tag,
      });
      expect(invoice.tag).toBe(tag);
    }
    // Grant scopes keep their meaning: "all" is the all-receipts scope.
    const grant = await h.services.grants.create(merchantId, "testnet", {
      scope: "ALL",
      days: 1,
    });
    expect(grant.scope).toBe("all");
  });

  it("accepts a 495-byte merchant memo (512 bytes on chain)", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "1",
      memo: "m".repeat(495),
    });
    expect(Buffer.byteLength(invoice.chain_memo)).toBe(512);
  });

  it("needs a receive address (409 NO_ADDRESS) and an enabled network", async () => {
    const bare = await createUser(h);
    const err = await rejects(
      h.services.invoices.create(bare.merchantId, "testnet", { amount_zec: "1" }),
    );
    expect(err).toMatchObject({ status: 409, code: "NO_ADDRESS", message: COPY.noAddress });
    const disabled = await rejects(
      h.services.invoices.create(merchantId, "mainnet", { amount_zec: "1" }),
    );
    expect(disabled).toMatchObject({ status: 403, code: "NETWORK_DISABLED" });
  });

  it("reads an open invoice past expiry as expired without writing it", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "2",
      expires_in_sec: 60,
    });
    h.clock.advance(61_000);
    const read = await h.services.invoices.get({ merchantId, network: "testnet" }, invoice.id);
    expect(read.status).toBe("expired");
    const [row] = await h.db<{
      status: string;
    }>`select status from invoices where id = ${invoice.id}`;
    expect(row?.status).toBe("open");
    const expired = await h.services.invoices.list(merchantId, "testnet", ["expired"], {
      cursor: null,
      limit: 100,
    });
    expect(expired.items.map((i) => i.id)).toContain(invoice.id);
    const open = await h.services.invoices.list(merchantId, "testnet", ["open"], {
      cursor: null,
      limit: 100,
    });
    expect(open.items.map((i) => i.id)).not.toContain(invoice.id);
  });

  it("filters lists by each effective status, alone or combined", async () => {
    const shop = await createMerchant(h);
    const make = (amount: string) =>
      h.services.invoices.create(shop.merchantId, "testnet", { amount_zec: amount });
    const open = await make("1");
    const claimed = await make("2");
    const paid = await make("3");
    const cancelled = await make("4");
    const expired = await make("5");
    await h.db`update invoices set status = 'paid_unverified' where id = ${claimed.id}`;
    await h.db`update invoices set status = 'paid' where id = ${paid.id}`;
    await h.db`update invoices set status = 'cancelled' where id = ${cancelled.id}`;
    await h.db`update invoices set expires_at = ${new Date(Date.now() - 1000)} where id = ${expired.id}`;
    const ids = async (statuses: Parameters<typeof h.services.invoices.list>[2]) =>
      (
        await h.services.invoices.list(shop.merchantId, "testnet", statuses, {
          cursor: null,
          limit: 100,
        })
      ).items.map((i) => i.id);
    expect(await ids(["open"])).toEqual([open.id]);
    expect(await ids(["paid_unverified"])).toEqual([claimed.id]);
    expect(await ids(["paid"])).toEqual([paid.id]);
    expect(await ids(["cancelled"])).toEqual([cancelled.id]);
    expect(await ids(["expired"])).toEqual([expired.id]);
    expect((await ids(["open", "paid", "expired"])).sort()).toEqual(
      [open.id, paid.id, expired.id].sort(),
    );
    expect(await ids([])).toHaveLength(5);
  });

  it("pages newest first with an opaque cursor", async () => {
    const other = await createMerchant(h);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(1000);
      ids.push(
        (
          await h.services.invoices.create(other.merchantId, "testnet", {
            amount_zec: `0.${i + 1}`,
          })
        ).id,
      );
    }
    const first = await h.services.invoices.list(other.merchantId, "testnet", [], {
      cursor: null,
      limit: 2,
    });
    expect(first.items.map((i) => i.id)).toEqual([ids[4], ids[3]]);
    expect(first.next_cursor).not.toBeNull();
    const last = first.items[1];
    expect(first.next_cursor).toBe(encodeCursor(new Date(last?.created_at ?? ""), last?.id ?? ""));
    const second = await h.services.invoices.list(other.merchantId, "testnet", [], {
      cursor: { createdAt: new Date(last?.created_at ?? ""), id: last?.id ?? "" },
      limit: 3,
    });
    expect(second.items.map((i) => i.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(second.next_cursor).toBeNull();
  });

  it("still reports a payment being confirmed once the invoice reads as expired", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "2.5",
      expires_in_sec: 60,
    });
    const seen = await h.services.settlement.applyDetection({
      merchantId,
      network: "testnet",
      invoiceId: invoice.id,
      txid: "cd".repeat(32),
      pool: "ironwood",
      amountZat: 250_000_000n,
      memoHash: invoice.memo_hash,
      blockHeight: null,
      blockHash: null,
      blockTime: null,
      tipHeight: null,
      source: "shade_worker",
    });
    expect(seen.outcome).toBe("seen");
    h.clock.advance(61_000);
    // The pay page and the desk read `progress` / `detection.state` to keep showing the payment.
    expect(await h.services.invoices.getPublic(invoice.id)).toMatchObject({
      status: "expired",
      progress: "seen",
    });
    const desk = await h.services.invoices.get({ merchantId, network: "testnet" }, invoice.id);
    expect(desk).toMatchObject({ status: "expired", detection: { state: "seen" } });
    // The desk list (filtered as expired) carries the same detection, so rows can show it.
    const listed = await h.services.invoices.list(merchantId, "testnet", ["expired"], {
      cursor: null,
      limit: 50,
    });
    expect(listed.items.find((item) => item.id === invoice.id)).toMatchObject({
      status: "expired",
      detection: { state: "seen", txid: "cd".repeat(32) },
    });
  });

  it("cancels open invoices only, and refuses while a payment is being confirmed", async () => {
    const scope = { merchantId, network: "testnet" as const };
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "3" });
    const cancelled = await h.services.invoices.cancelOpen(scope, invoice.id);
    expect(cancelled.status).toBe("cancelled");
    const again = await rejects(h.services.invoices.cancelOpen(scope, invoice.id));
    expect(again).toMatchObject({ status: 409, code: "NOT_OPEN" });

    const pending = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "4" });
    await h.db`
      insert into invoice_detections (id, merchant_id, invoice_id, network, txid, pool, amount_zec,
        memo_hash, observed_at, source, state)
      values ('det_pending', ${merchantId}, ${pending.id}, 'testnet', ${"ab".repeat(32)}, 'ironwood',
        4, ${pending.memo_hash}, now(), 'shade_worker', 'seen')`;
    const blocked = await rejects(h.services.invoices.cancelOpen(scope, pending.id));
    expect(blocked).toMatchObject({ status: 409, code: "PAYMENT_PENDING" });
  });

  it("scopes reads by merchant and network (404 otherwise)", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "5" });
    const stranger = await createMerchant(h);
    const foreign = await rejects(
      h.services.invoices.get({ merchantId: stranger.merchantId, network: null }, invoice.id),
    );
    expect(foreign).toMatchObject({ status: 404, code: "NOT_FOUND" });
    const otherNetwork = await rejects(
      h.services.invoices.get({ merchantId, network: "mainnet" }, invoice.id),
    );
    expect(otherNetwork.status).toBe(404);
  });

  it("serves a minimal public view with the shop name", async () => {
    const shop = await createMerchant(h, { name: "Corner Cafe" });
    const invoice = await h.services.invoices.create(shop.merchantId, "testnet", {
      amount_zec: "0.25",
      memo: "latte",
      tag: "food",
    });
    const view = await h.services.invoices.getPublic(invoice.id);
    expect(view).toEqual({
      id: invoice.id,
      status: "open",
      progress: "awaiting",
      network: "testnet",
      amount_zec: "0.25",
      memo: "latte",
      address: invoice.address,
      zip321: invoice.zip321,
      merchant_name: "Corner Cafe",
      expires_at: invoice.expires_at,
      paid_at: null,
      confirmations: null,
      required_confirmations: 1,
    });
    const anonymous = await createMerchant(h, { name: "" });
    const plain = await h.services.invoices.create(anonymous.merchantId, "testnet", {
      amount_zec: "1",
    });
    expect((await h.services.invoices.getPublic(plain.id)).merchant_name).toBeNull();
  });
});
