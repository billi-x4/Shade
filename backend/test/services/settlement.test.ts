import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Invoice, WebhookEvent } from "../../src/contract/index.ts";
import type { Db, Row, Sql } from "../../src/platform/db.ts";
import { AppError } from "../../src/platform/errors.ts";
import { createInvoiceView } from "../../src/services/invoices.ts";
import { type DetectionInput, createSettlementService } from "../../src/services/settlement.ts";
import { reverseHex } from "../../src/zcash/txid.ts";
import {
  type Harness,
  createHarness,
  createMerchant,
  putShieldedTx,
  randomTxid,
  syncChain,
} from "../support/harness.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

function detection(
  invoice: Invoice,
  merchantId: string,
  over: Partial<DetectionInput> = {},
): DetectionInput {
  return {
    merchantId,
    network: invoice.network,
    invoiceId: invoice.id,
    txid: randomTxid(),
    pool: "ironwood",
    amountZat: BigInt(Math.round(Number(invoice.amount_zec) * 1e8)),
    memoHash: invoice.memo_hash,
    blockHeight: 1001,
    blockHash: "c".repeat(64),
    blockTime: new Date(),
    tipHeight: 1001,
    source: "shade_worker",
    ...over,
  };
}

async function paidEvents(h: Harness, invoiceId: string) {
  return h.db<{ id: string; payload: string }>`
    select id, payload from webhook_events where invoice_id = ${invoiceId} and type = 'invoice.paid'`;
}

async function status(h: Harness, invoiceId: string) {
  const [row] = await h.db<{
    status: string;
    verification: string | null;
    txid: string | null;
    claimed_txid: string | null;
    paid_height: number | null;
  }>`select status, verification, txid, claimed_txid, paid_height from invoices where id = ${invoiceId}`;
  return row;
}

describe("settlement: applyDetection", () => {
  let h: Harness;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness({ SHADE_MIN_CONFIRMATIONS_TESTNET: "3" });
    merchantId = (await createMerchant(h)).merchantId;
  });
  afterAll(() => h.close());

  const newInvoice = (over: { amount_zec?: string; expires_in_sec?: number } = {}) =>
    h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.01",
      memo: "order",
      ...over,
    });

  it("records a mempool or under-confirmed payment as seen, then settles exactly once", async () => {
    const invoice = await newInvoice();
    const txid = randomTxid();
    const mempool = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { txid, blockHeight: null, blockHash: null, blockTime: null }),
    );
    expect(mempool).toEqual({ outcome: "seen", invoiceId: invoice.id, deliveryIds: [] });

    const shallow = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { txid, blockHeight: 1001, tipHeight: 1002 }),
    );
    expect(shallow.outcome).toBe("seen");
    const seen = await h.services.invoices.get({ merchantId, network: null }, invoice.id);
    expect(seen.status).toBe("open");
    expect(seen.detection).toMatchObject({
      state: "seen",
      txid,
      pool: "ironwood",
      source: "shade_worker",
      block_height: 1001,
      confirmations: 2,
      required_confirmations: 3,
    });
    expect((await h.services.invoices.getPublic(invoice.id)).progress).toBe("seen");

    const settled = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { txid, blockHeight: 1001, tipHeight: 1003 }),
    );
    expect(settled.outcome).toBe("settled");
    expect(await status(h, invoice.id)).toMatchObject({
      status: "paid",
      verification: "ivk_scan",
      txid,
      paid_height: 1001,
    });

    const again = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { txid, blockHeight: 1001, tipHeight: 1010 }),
    );
    expect(again).toEqual({ outcome: "settled", invoiceId: invoice.id, deliveryIds: [] });
    const events = await paidEvents(h, invoice.id);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]?.payload ?? "{}") as WebhookEvent;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "amount_zec",
        "created_at",
        "id",
        "invoice_id",
        "memo_hash",
        "network",
        "paid_at",
        "txid",
        "type",
        "verification",
      ].sort(),
    );
    expect(payload).toMatchObject({
      type: "invoice.paid",
      invoice_id: invoice.id,
      amount_zec: "0.01",
      memo_hash: invoice.memo_hash,
      txid,
      verification: "ivk_scan",
      network: "testnet",
    });
    expect(events[0]?.payload).not.toContain("order");
    const view = await h.services.invoices.getPublic(invoice.id);
    expect(view).toMatchObject({ status: "paid", progress: "confirmed", confirmations: 10 });
  });

  it("reverts other claims of the settling txid to open", async () => {
    const claimed = await newInvoice({ amount_zec: "0.02" });
    const paid = await newInvoice({ amount_zec: "0.03" });
    const txid = randomTxid();
    await h.db`
      update invoices set status = 'paid_unverified', verification = 'txid_unverified',
        claimed_txid = ${txid} where id = ${claimed.id}`;
    const result = await h.services.settlement.applyDetection(
      detection(paid, merchantId, { txid, tipHeight: 1003 }),
    );
    expect(result.outcome).toBe("settled");
    expect(await status(h, claimed.id)).toMatchObject({
      status: "open",
      verification: null,
      claimed_txid: null,
    });
  });

  it("marks a detection on an already-paid invoice settled_after, without an event", async () => {
    const invoice = await newInvoice({ amount_zec: "0.04" });
    await h.services.settlement.applyDetection(detection(invoice, merchantId, { tipHeight: 1003 }));
    const second = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { tipHeight: 1003 }),
    );
    expect(second.outcome).toBe("settled_after");
    expect(await paidEvents(h, invoice.id)).toHaveLength(1);
  });

  it("refuses a memo group (txid + memo hash) already recorded for another invoice", async () => {
    const first = await newInvoice({ amount_zec: "0.05" });
    const second = await newInvoice({ amount_zec: "0.05" });
    // Legacy invoices (no memo_ref) can share a memo hash, so one memo group can match both.
    await h.db`
      update invoices set memo_ref = null, memo_hash = ${first.memo_hash} where id = ${second.id}`;
    const txid = randomTxid();
    await h.services.settlement.applyDetection(
      detection(first, merchantId, { txid, tipHeight: 1003 }),
    );
    const reused = await h.services.settlement.applyDetection(
      detection(second, merchantId, { txid, memoHash: first.memo_hash, tipHeight: 1003 }),
    );
    expect(reused.outcome).toBe("txid_in_use");
    expect((await status(h, second.id))?.status).toBe("open");
  });

  it("frees an invoice whose seen payment the merchant confirmed for another invoice", async () => {
    const watched = await newInvoice({ amount_zec: "0.055" });
    const confirmed = await newInvoice({ amount_zec: "0.056" });
    const txid = randomTxid();
    const seen = await h.services.settlement.applyDetection(
      detection(watched, merchantId, { txid, tipHeight: 1001 }),
    );
    expect(seen.outcome).toBe("seen");
    // What the unserialised accept-vs-detection race used to leave behind.
    await h.db`
      update invoices set status = 'paid', verification = 'merchant_accept', txid = ${txid},
        paid_at = now() where id = ${confirmed.id}`;
    const promoted = await h.services.settlement.applyDetection(
      detection(watched, merchantId, { txid, tipHeight: 1003 }),
    );
    expect(promoted.outcome).toBe("txid_in_use");
    const read = await h.services.invoices.get({ merchantId, network: null }, watched.id);
    expect(read).toMatchObject({ status: "open", detection: { state: "late" } });
    const cancelled = await h.services.invoices.cancelOpen(
      { merchantId, network: null },
      watched.id,
    );
    expect(cancelled.status).toBe("cancelled");
  });

  it("maps a unique-index conflict while settling to txid_in_use", async () => {
    const invoice = await newInvoice({ amount_zec: "0.057" });
    // Fails the paid update the way Postgres does when another settlement of the txid won.
    const conflict = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint: "invoices_paid_memo_group_unique",
    });
    const failing = (sql: Sql): Sql =>
      Object.assign(
        <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> =>
          strings.join("?").includes("verification = 'ivk_scan'")
            ? Promise.reject(conflict)
            : sql<T>(strings, ...values),
        { query: sql.query },
      );
    const db: Db = Object.assign(Object.create(h.db) as Db, {
      tx: <T>(fn: (sql: Sql) => Promise<T>) => h.db.tx((sql) => fn(failing(sql))),
    });
    const settlement = createSettlementService({
      db,
      config: h.config,
      chain: h.chain,
      clock: h.clock,
      view: createInvoiceView(h.config, h.clock),
      webhooks: h.services.webhooks,
    });
    const result = await settlement.applyDetection(
      detection(invoice, merchantId, { tipHeight: 1003 }),
    );
    expect(result).toEqual({ outcome: "txid_in_use", invoiceId: invoice.id, deliveryIds: [] });
    expect((await status(h, invoice.id))?.status).toBe("open");
    expect(await paidEvents(h, invoice.id)).toHaveLength(0);
  });

  it("reports a mismatch without writing anything", async () => {
    const invoice = await newInvoice({ amount_zec: "0.06" });
    const result = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { amountZat: 1n, tipHeight: 1003 }),
    );
    expect(result.outcome).toBe("mismatch");
    const memo = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { memoHash: `sha256:${"0".repeat(64)}`, tipHeight: 1003 }),
    );
    expect(memo.outcome).toBe("mismatch");
    const [count] = await h.db<{ n: number }>`
      select count(*)::int as n from invoice_detections where invoice_id = ${invoice.id}`;
    expect(count?.n).toBe(0);
  });

  it("marks payments to cancelled invoices late", async () => {
    const invoice = await newInvoice({ amount_zec: "0.07" });
    await h.services.invoices.cancelOpen({ merchantId, network: null }, invoice.id);
    const result = await h.services.settlement.applyDetection(
      detection(invoice, merchantId, { tipHeight: 1003 }),
    );
    expect(result.outcome).toBe("late");
    expect((await status(h, invoice.id))?.status).toBe("cancelled");
    expect(await paidEvents(h, invoice.id)).toHaveLength(0);
  });

  it("settles an expired invoice within the 60-minute grace, and not after it", async () => {
    const graceful = await newInvoice({ amount_zec: "0.08", expires_in_sec: 60 });
    const late = await newInvoice({ amount_zec: "0.09", expires_in_sec: 60 });
    const expiresAt = Date.parse(graceful.expires_at);
    h.clock.advance(2 * 3600_000);
    const inside = await h.services.settlement.applyDetection(
      detection(graceful, merchantId, {
        blockTime: new Date(expiresAt + 59 * 60_000),
        tipHeight: 1003,
      }),
    );
    expect(inside.outcome).toBe("settled");
    expect((await status(h, graceful.id))?.status).toBe("paid");
    const outside = await h.services.settlement.applyDetection(
      detection(late, merchantId, {
        blockTime: new Date(Date.parse(late.expires_at) + 61 * 60_000),
        tipHeight: 1003,
      }),
    );
    expect(outside.outcome).toBe("late");
    expect((await status(h, late.id))?.status).toBe("open");
  });

  it("marks a seen detection orphaned", async () => {
    const invoice = await newInvoice({ amount_zec: "0.1" });
    await h.services.settlement.applyDetection(detection(invoice, merchantId, { tipHeight: 1001 }));
    const [row] = await h.db<{ id: string }>`
      select id from invoice_detections where invoice_id = ${invoice.id}`;
    await h.services.settlement.markOrphaned(row?.id ?? "");
    const read = await h.services.invoices.get({ merchantId, network: null }, invoice.id);
    expect(read.detection?.state).toBe("orphaned");
  });

  it("404s detections for jar charges and other merchants", async () => {
    const invoice = await newInvoice({ amount_zec: "0.11" });
    const stranger = await createMerchant(h);
    const err = await rejects(
      h.services.settlement.applyDetection(detection(invoice, stranger.merchantId)),
    );
    expect(err.status).toBe(404);
  });
});

describe("settlement: payer claims and merchant review", () => {
  let h: Harness;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness();
    merchantId = (await createMerchant(h)).merchantId;
  });
  afterAll(() => h.close());
  beforeEach(() => syncChain(h, "testnet", 1000));

  const newInvoice = (amount = "0.01") =>
    h.services.invoices.create(merchantId, "testnet", { amount_zec: amount, memo: "claim" });

  it("validates and normalizes the pasted txid", async () => {
    const invoice = await newInvoice();
    expect(await rejects(h.services.settlement.submitPayerTxid(invoice.id, "nope"))).toMatchObject({
      status: 400,
      code: "BAD_TXID",
    });
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1001 });
    syncChain(h, "testnet", 1001);
    const view = await h.services.settlement.submitPayerTxid(
      invoice.id,
      `  ${txid.toUpperCase()} `,
    );
    expect(view).toMatchObject({ status: "paid_unverified", progress: "reported" });
    expect(Object.keys(view)).not.toContain("claimed_txid");
    expect(await status(h, invoice.id)).toMatchObject({
      status: "paid_unverified",
      verification: "txid_unverified",
      claimed_txid: txid,
      txid: null,
    });
    expect(await paidEvents(h, invoice.id)).toHaveLength(0);
  });

  it("hints at byte-reversed txids, and 404s unknown or orphaned ones", async () => {
    const invoice = await newInvoice("0.02");
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1000 });
    const reversed = await rejects(
      h.services.settlement.submitPayerTxid(invoice.id, reverseHex(txid)),
    );
    expect(reversed.code).toBe("BAD_TXID");
    expect(reversed.message).toMatch(/reversed/);
    const unknown = await rejects(h.services.settlement.submitPayerTxid(invoice.id, randomTxid()));
    expect(unknown).toMatchObject({ status: 404, code: "TX_NOT_FOUND" });
    const orphan = randomTxid();
    h.chain.testnet.putTransaction(orphan, { kind: "orphaned" });
    expect((await rejects(h.services.settlement.submitPayerTxid(invoice.id, orphan))).status).toBe(
      404,
    );
  });

  it("refuses transparent transactions and ones mined before the invoice", async () => {
    const invoice = await newInvoice("0.03");
    const transparent = randomTxid();
    putShieldedTx(
      h.chain.testnet,
      transparent,
      { height: 1000 },
      { transparentInputs: 1, transparentOutputs: 2 },
    );
    expect(
      await rejects(h.services.settlement.submitPayerTxid(invoice.id, transparent)),
    ).toMatchObject({
      status: 422,
      code: "TX_NOT_SHIELDED",
    });
    const orchardOnly = randomTxid();
    putShieldedTx(h.chain.testnet, orchardOnly, { height: 1000 }, { orchardActions: 2 });
    expect(
      (await rejects(h.services.settlement.submitPayerTxid(invoice.id, orchardOnly))).code,
    ).toBe("TX_NOT_SHIELDED");
    const old = randomTxid();
    putShieldedTx(h.chain.testnet, old, { height: 999 });
    expect(await rejects(h.services.settlement.submitPayerTxid(invoice.id, old))).toMatchObject({
      status: 422,
      code: "OUTSIDE_WINDOW",
    });
  });

  it("uses the block time when the created height is unknown", async () => {
    h.chain.testnet.failNext();
    const invoice = await newInvoice("0.035");
    const old = randomTxid();
    putShieldedTx(h.chain.testnet, old, { height: 990 });
    h.chain.testnet.setBlock(990, {
      hash: "d".repeat(64),
      time: Math.floor(Date.now() / 1000) - 3600,
    });
    expect((await rejects(h.services.settlement.submitPayerTxid(invoice.id, old))).code).toBe(
      "OUTSIDE_WINDOW",
    );
    const recent = randomTxid();
    putShieldedTx(h.chain.testnet, recent, { height: 1000 });
    expect((await h.services.settlement.submitPayerTxid(invoice.id, recent)).status).toBe(
      "paid_unverified",
    );
  });

  it("answers 503 CHAIN_UNAVAILABLE with retry_after when the light server is down", async () => {
    const invoice = await newInvoice("0.04");
    h.chain.testnet.failNext();
    const err = await rejects(h.services.settlement.submitPayerTxid(invoice.id, randomTxid()));
    expect(err).toMatchObject({
      status: 503,
      code: "CHAIN_UNAVAILABLE",
      extra: { retry_after: 30 },
    });
  });

  it("caches lookups per txid for 30 seconds", async () => {
    const invoice = await newInvoice("0.045");
    const txid = randomTxid();
    expect((await rejects(h.services.settlement.submitPayerTxid(invoice.id, txid))).code).toBe(
      "TX_NOT_FOUND",
    );
    putShieldedTx(h.chain.testnet, txid, { height: 1000 });
    expect((await rejects(h.services.settlement.submitPayerTxid(invoice.id, txid))).code).toBe(
      "TX_NOT_FOUND",
    );
    h.clock.advance(31_000);
    expect((await h.services.settlement.submitPayerTxid(invoice.id, txid)).status).toBe(
      "paid_unverified",
    );
  });

  it("lets a re-paste replace the claim, and refuses paid, cancelled and expired invoices", async () => {
    const invoice = await newInvoice("0.05");
    const [first, second] = [randomTxid(), randomTxid()];
    putShieldedTx(h.chain.testnet, first, "mempool");
    putShieldedTx(h.chain.testnet, second, { height: 1000 });
    await h.services.settlement.submitPayerTxid(invoice.id, first);
    await h.services.settlement.submitPayerTxid(invoice.id, second);
    expect((await status(h, invoice.id))?.claimed_txid).toBe(second);

    const cancelled = await newInvoice("0.051");
    await h.services.invoices.cancelOpen({ merchantId, network: null }, cancelled.id);
    expect((await rejects(h.services.settlement.submitPayerTxid(cancelled.id, second))).code).toBe(
      "CANCELLED",
    );
    const expiring = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.052",
      expires_in_sec: 60,
    });
    h.clock.advance(61_000);
    expect((await rejects(h.services.settlement.submitPayerTxid(expiring.id, second))).code).toBe(
      "EXPIRED",
    );
  });

  it("accepts a claim only once the tx is mined with enough confirmations", async () => {
    const invoice = await newInvoice("0.06");
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, "mempool");
    await h.services.settlement.submitPayerTxid(invoice.id, txid);
    const notMined = await rejects(h.services.settlement.acceptClaim(merchantId, invoice.id));
    expect(notMined).toMatchObject({ status: 409, code: "TX_NOT_MINED" });

    putShieldedTx(h.chain.testnet, txid, { height: 1001 });
    syncChain(h, "testnet", 1001);
    const accepted = await h.services.settlement.acceptClaim(merchantId, invoice.id);
    expect(accepted).toMatchObject({ status: "paid", verification: "merchant_accept", txid });
    expect(await paidEvents(h, invoice.id)).toHaveLength(1);
    const again = await rejects(h.services.settlement.acceptClaim(merchantId, invoice.id));
    expect(again).toMatchObject({ status: 409, code: "NOT_OPEN" });
  });

  it("confirms an open invoice with a txid from the merchant's own wallet", async () => {
    const invoice = await newInvoice("0.061");
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, "mempool");
    const notMined = await rejects(h.services.settlement.acceptClaim(merchantId, invoice.id, txid));
    expect(notMined).toMatchObject({ status: 409, code: "TX_NOT_MINED" });
    expect((await status(h, invoice.id))?.status).toBe("open");

    putShieldedTx(h.chain.testnet, txid, { height: 1001 });
    syncChain(h, "testnet", 1001);
    const accepted = await h.services.settlement.acceptClaim(
      merchantId,
      invoice.id,
      txid.toUpperCase(),
    );
    expect(accepted).toMatchObject({
      status: "paid",
      verification: "merchant_accept",
      txid,
      claimed_txid: null,
    });
    expect(await paidEvents(h, invoice.id)).toHaveLength(1);
    const again = await rejects(h.services.settlement.acceptClaim(merchantId, invoice.id, txid));
    expect(again).toMatchObject({ status: 409, code: "ALREADY_PAID" });
  });

  it("a merchant txid overrides a payer's claim and reverts other claims of that txid", async () => {
    const invoice = await newInvoice("0.062");
    const other = await newInvoice("0.063");
    const claimed = randomTxid();
    const own = randomTxid();
    putShieldedTx(h.chain.testnet, claimed, { height: 1000 });
    putShieldedTx(h.chain.testnet, own, { height: 1000 });
    await h.services.settlement.submitPayerTxid(invoice.id, claimed);
    await h.services.settlement.submitPayerTxid(other.id, own);

    const accepted = await h.services.settlement.acceptClaim(merchantId, invoice.id, own);
    expect(accepted).toMatchObject({ status: "paid", txid: own, claimed_txid: null });
    expect(await status(h, other.id)).toMatchObject({ status: "open", claimed_txid: null });
  });

  it("checks a merchant txid like a payer paste", async () => {
    const invoice = await newInvoice("0.064");
    const code = async (txid: string) =>
      (await rejects(h.services.settlement.acceptClaim(merchantId, invoice.id, txid))).code;

    expect(await code("not-a-txid")).toBe("BAD_TXID");
    expect(await code(randomTxid())).toBe("TX_NOT_FOUND");
    const transparent = randomTxid();
    putShieldedTx(h.chain.testnet, transparent, { height: 1000 }, { transparentOutputs: 1 });
    expect(await code(transparent)).toBe("TX_NOT_SHIELDED");
    const early = randomTxid();
    putShieldedTx(h.chain.testnet, early, { height: 10 });
    expect(await code(early)).toBe("OUTSIDE_WINDOW");
    const paidElsewhere = await newInvoice("0.065");
    const used = randomTxid();
    putShieldedTx(h.chain.testnet, used, { height: 1000 });
    await h.services.settlement.acceptClaim(merchantId, paidElsewhere.id, used);
    expect(await code(used)).toBe("TXID_IN_USE");
    expect((await status(h, invoice.id))?.status).toBe("open");

    const cancelled = await newInvoice("0.0645");
    await h.services.invoices.cancelOpen({ merchantId, network: null }, cancelled.id);
    const fresh = randomTxid();
    putShieldedTx(h.chain.testnet, fresh, { height: 1000 });
    expect(
      (await rejects(h.services.settlement.acceptClaim(merchantId, cancelled.id, fresh))).code,
    ).toBe("CANCELLED");
  });

  it("records a payment past expiry only when it was mined within the grace window (§6.1)", async () => {
    const inTime = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.066",
      expires_in_sec: 60,
    });
    const late = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.067",
      expires_in_sec: 60,
    });
    h.clock.advance(61_000);
    // Block 1000 is dated before the invoices expired.
    const mined = randomTxid();
    putShieldedTx(h.chain.testnet, mined, { height: 1000 });
    expect(await h.services.settlement.acceptClaim(merchantId, inTime.id, mined)).toMatchObject({
      status: "paid",
      verification: "merchant_accept",
      txid: mined,
    });
    expect(await paidEvents(h, inTime.id)).toHaveLength(1);

    // Block 1100 is dated two hours after expiry: past the one-hour grace.
    h.clock.advance(2 * 3_600_000);
    syncChain(h, "testnet", 1100);
    const tooLate = randomTxid();
    putShieldedTx(h.chain.testnet, tooLate, { height: 1100 });
    const err = await rejects(h.services.settlement.acceptClaim(merchantId, late.id, tooLate));
    expect(err).toMatchObject({ status: 409, code: "EXPIRED" });
    expect((await status(h, late.id))?.status).not.toBe("paid");
  });

  it("refuses to accept a txid that already paid another invoice", async () => {
    const paid = await newInvoice("0.07");
    const claimed = await newInvoice("0.071");
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1000 });
    await h.services.settlement.submitPayerTxid(paid.id, txid);
    await h.services.settlement.submitPayerTxid(claimed.id, txid);
    await h.services.settlement.acceptClaim(merchantId, paid.id);
    // Settling `paid` reverted the other claim of the same txid.
    expect((await status(h, claimed.id))?.status).toBe("open");
    await h.db`update invoices set status = 'paid_unverified', claimed_txid = ${txid} where id = ${claimed.id}`;
    const err = await rejects(h.services.settlement.acceptClaim(merchantId, claimed.id));
    expect(err).toMatchObject({ status: 409, code: "TXID_IN_USE" });
  });

  it("rejects a claim back to open", async () => {
    const invoice = await newInvoice("0.08");
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1000 });
    await h.services.settlement.submitPayerTxid(invoice.id, txid);
    const rejected = await h.services.settlement.rejectClaim(merchantId, invoice.id);
    expect(rejected).toMatchObject({ status: "open", claimed_txid: null, verification: null });
    expect((await rejects(h.services.settlement.rejectClaim(merchantId, invoice.id))).code).toBe(
      "NOT_OPEN",
    );
  });

  it("emits exactly one invoice.paid when accept and a scanner detection race", async () => {
    const invoice = await newInvoice("0.09");
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1000 });
    await h.services.settlement.submitPayerTxid(invoice.id, txid);
    const [accept, scan] = await Promise.allSettled([
      h.services.settlement.acceptClaim(merchantId, invoice.id),
      h.services.settlement.applyDetection({
        ...detection(invoice, merchantId, { txid, blockHeight: 1000, tipHeight: 1000 }),
        amountZat: 9_000_000n,
      }),
    ]);
    expect(scan.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(accept.status);
    expect((await status(h, invoice.id))?.status).toBe("paid");
    expect(await paidEvents(h, invoice.id)).toHaveLength(1);
  });
});

describe("settlement: one transaction paying several invoices (memo groups)", () => {
  let h: Harness;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness();
    merchantId = (await createMerchant(h)).merchantId;
  });
  afterAll(() => h.close());
  beforeEach(() => syncChain(h, "testnet", 1000));

  const newInvoice = (amount: string) =>
    h.services.invoices.create(merchantId, "testnet", { amount_zec: amount, memo: "batch" });

  it("settles each invoice paid by its own memo group of one transaction", async () => {
    const [a, b] = [await newInvoice("0.01"), await newInvoice("0.02")];
    const txid = randomTxid();
    const first = await h.services.settlement.applyDetection(detection(a, merchantId, { txid }));
    const second = await h.services.settlement.applyDetection(detection(b, merchantId, { txid }));
    expect([first.outcome, second.outcome]).toEqual(["settled", "settled"]);
    for (const invoice of [a, b]) {
      expect(await status(h, invoice.id)).toMatchObject({ status: "paid", txid });
      expect(await paidEvents(h, invoice.id)).toHaveLength(1);
    }
    // Re-applying either memo group is idempotent.
    const again = await h.services.settlement.applyDetection(detection(b, merchantId, { txid }));
    expect(again).toEqual({ outcome: "settled", invoiceId: b.id, deliveryIds: [] });
  });

  it("still settles at most one invoice per memo group", async () => {
    const [a, b] = [await newInvoice("0.03"), await newInvoice("0.03")];
    await h.db`update invoices set memo_ref = null, memo_hash = ${a.memo_hash} where id = ${b.id}`;
    const txid = randomTxid();
    await h.services.settlement.applyDetection(detection(a, merchantId, { txid }));
    const reused = await h.services.settlement.applyDetection(
      detection(b, merchantId, { txid, memoHash: a.memo_hash }),
    );
    expect(reused.outcome).toBe("txid_in_use");
    expect((await status(h, b.id))?.status).toBe("open");
  });

  it("refuses a scanner match for a txid the merchant confirmed on another invoice", async () => {
    const [claimed, scanned] = [await newInvoice("0.04"), await newInvoice("0.05")];
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1000 });
    await h.services.settlement.submitPayerTxid(claimed.id, txid);
    await h.services.settlement.acceptClaim(merchantId, claimed.id);
    const result = await h.services.settlement.applyDetection(
      detection(scanned, merchantId, { txid }),
    );
    expect(result.outcome).toBe("txid_in_use");
    expect((await status(h, scanned.id))?.status).toBe("open");
  });

  it("keeps Confirm strict: TXID_IN_USE for a txid a scan settled, whatever the memo", async () => {
    const [scanned, claimed] = [await newInvoice("0.06"), await newInvoice("0.07")];
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1000 });
    await h.services.settlement.applyDetection(detection(scanned, merchantId, { txid }));
    await h.db`
      update invoices set status = 'paid_unverified', verification = 'txid_unverified',
        claimed_txid = ${txid} where id = ${claimed.id}`;
    const err = await rejects(h.services.settlement.acceptClaim(merchantId, claimed.id));
    expect(err).toMatchObject({ status: 409, code: "TXID_IN_USE" });
    expect((await status(h, claimed.id))?.status).toBe("paid_unverified");
  });
});

describe("settlement: merchant-device detections", () => {
  let h: Harness;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness();
    merchantId = (await createMerchant(h)).merchantId;
  });
  afterAll(() => h.close());

  const scope = () => ({ merchantId, network: "testnet" as const });

  it("verifies the reported payment on chain and settles it", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "0.5" });
    const txid = randomTxid();
    putShieldedTx(h.chain.testnet, txid, { height: 1001 });
    syncChain(h, "testnet", 1001);
    const report = { txid, amount_zec: "0.50", memo_hash: invoice.memo_hash, pool: "ironwood" };
    const paid = await h.services.settlement.reportDetection(scope(), invoice.id, report);
    expect(paid).toMatchObject({ status: "paid", verification: "ivk_scan", txid });
    expect(paid.detection).toMatchObject({
      state: "settled",
      source: "merchant_device",
      block_height: 1001,
    });
  });

  it("validates inputs and matches amount and memo hash", async () => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "0.6" });
    const good = {
      txid: randomTxid(),
      amount_zec: "0.6",
      memo_hash: invoice.memo_hash,
      pool: "sapling",
    };
    const cases: [Record<string, string>, string][] = [
      [{ txid: "xyz" }, "BAD_TXID"],
      [{ amount_zec: "abc" }, "BAD_AMOUNT"],
      [{ memo_hash: "md5:00" }, "BAD_MEMO_HASH"],
      [{ pool: "transparent" }, "BAD_POOL"],
      [{ amount_zec: "0.61" }, "AMOUNT_MISMATCH"],
      [{ memo_hash: `sha256:${"1".repeat(64)}` }, "MEMO_MISMATCH"],
    ];
    for (const [over, code] of cases) {
      const err = await rejects(
        h.services.settlement.reportDetection(scope(), invoice.id, { ...good, ...over }),
      );
      expect(err.code).toBe(code);
    }
    expect(
      (await rejects(h.services.settlement.reportDetection(scope(), invoice.id, good))).code,
    ).toBe("TX_NOT_FOUND");
    const early = randomTxid();
    putShieldedTx(h.chain.testnet, early, { height: 900 });
    h.chain.testnet.setBlock(900, {
      hash: "e".repeat(64),
      time: Math.floor(Date.now() / 1000) - 86_400,
    });
    expect(
      (
        await rejects(
          h.services.settlement.reportDetection(scope(), invoice.id, { ...good, txid: early }),
        )
      ).code,
    ).toBe("OUTSIDE_WINDOW");
    const mempool = randomTxid();
    putShieldedTx(h.chain.testnet, mempool, "mempool");
    const seen = await h.services.settlement.reportDetection(scope(), invoice.id, {
      ...good,
      txid: mempool,
    });
    expect(seen.status).toBe("open");
    expect(seen.detection?.state).toBe("seen");
  });
});
