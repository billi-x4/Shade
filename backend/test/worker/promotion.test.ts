import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPromotionTick } from "../../src/worker/promotion.ts";
import { ChainUnavailableError } from "../../src/zcash/lightwalletd.ts";
import {
  type Harness,
  MERCHANT,
  TIP,
  blockTime,
  createHarness,
  hash,
  insertDetection,
  insertInvoice,
  txid,
} from "./support.ts";

let h: Harness;

beforeEach(async () => {
  h = await createHarness({ minConfirmations: 3 });
});

afterEach(async () => {
  await h.close();
});

async function blockHash(height: number): Promise<string> {
  const block = await h.chain.testnet.getBlock(height);
  if (!block) throw new Error(`no block ${height}`);
  return block.hash;
}

async function seen(
  id: string,
  p: {
    height: number | null;
    blockHash?: string | null;
    n: number;
    network?: "testnet" | "mainnet";
  },
): Promise<string> {
  const memo = await insertInvoice(h.db, { id: `inv_${id}`, network: p.network ?? "testnet" });
  await insertDetection(h.db, {
    id,
    invoiceId: `inv_${id}`,
    network: p.network ?? "testnet",
    txid: txid(p.n),
    memoHash: memo,
    blockHeight: p.height,
    blockHash:
      p.blockHash === undefined
        ? p.height === null
          ? null
          : await blockHash(p.height)
        : p.blockHash,
    blockTime: p.height === null ? null : new Date(blockTime(p.height) * 1000),
    source: "merchant_device",
  });
  return memo;
}

describe("runPromotionTick", () => {
  it("re-applies a detection on the main chain until it has enough confirmations", async () => {
    const memo = await seen("det_1", { height: TIP - 1, n: 1 });

    expect(await runPromotionTick(h.deps)).toEqual({
      checked: 1,
      promoted: 0,
      orphaned: 0,
      errors: 0,
      lastError: null,
    });
    expect(h.fake.applied).toEqual([
      {
        merchantId: MERCHANT,
        network: "testnet",
        invoiceId: "inv_det_1",
        txid: txid(1),
        pool: "ironwood",
        amountZat: 1_000_000n,
        memoHash: memo,
        blockHeight: TIP - 1,
        blockHash: await blockHash(TIP - 1),
        blockTime: new Date(blockTime(TIP - 1) * 1000),
        tipHeight: TIP,
        source: "merchant_device",
      },
    ]);
    expect(h.fake.kicked).toEqual([]);

    h.chain.testnet.setTip(TIP + 1);
    expect(await runPromotionTick(h.deps)).toMatchObject({ promoted: 1 });
    expect(h.fake.applied[1]).toMatchObject({ blockHeight: TIP - 1, tipHeight: TIP + 1 });
    expect(h.fake.kicked).toEqual([["dlv_inv_det_1"]]);
  });

  it("looks a reorged detection up again and re-applies it at its new height", async () => {
    await seen("det_1", { height: TIP - 3, blockHash: hash("orphaned block"), n: 1 });
    h.chain.testnet.putTransaction(txid(1), {
      kind: "mined",
      height: TIP - 2,
      summary: { ironwoodActions: 2 },
    });

    const result = await runPromotionTick(h.deps);

    expect(result).toMatchObject({ promoted: 1, orphaned: 0 });
    expect(h.fake.applied).toEqual([
      expect.objectContaining({
        blockHeight: TIP - 2,
        blockHash: await blockHash(TIP - 2),
        blockTime: new Date(blockTime(TIP - 2) * 1000),
        tipHeight: TIP,
      }),
    ]);
    expect(h.fake.orphaned).toEqual([]);
  });

  it.each([
    ["no longer known", { kind: "not_found" } as const],
    ["back in the mempool", { kind: "mempool", summary: { ironwoodActions: 2 } } as const],
    ["on a side chain", { kind: "orphaned" } as const],
  ])("orphans a reorged detection whose transaction is %s", async (_label, lookup) => {
    await seen("det_1", { height: TIP - 3, blockHash: hash("orphaned block"), n: 1 });
    if (lookup.kind !== "not_found") h.chain.testnet.putTransaction(txid(1), lookup);

    const result = await runPromotionTick(h.deps);

    expect(result).toMatchObject({ promoted: 0, orphaned: 1 });
    expect(h.fake.orphaned).toEqual(["det_1"]);
    expect(h.fake.applied).toEqual([]);
  });

  it("re-checks a mempool detection every tick until it is mined", async () => {
    await seen("det_1", { height: null, n: 1 });
    h.chain.testnet.putTransaction(txid(1), { kind: "mempool", summary: { ironwoodActions: 2 } });

    expect(await runPromotionTick(h.deps)).toMatchObject({ promoted: 0, orphaned: 0, errors: 0 });
    expect(h.fake.applied).toEqual([]);
    expect(h.fake.orphaned).toEqual([]);

    h.chain.testnet.putTransaction(txid(1), {
      kind: "mined",
      height: TIP,
      summary: { ironwoodActions: 2 },
    });
    await runPromotionTick(h.deps);
    expect(h.fake.applied).toEqual([
      expect.objectContaining({
        blockHeight: TIP,
        blockHash: await blockHash(TIP),
        tipHeight: TIP,
      }),
    ]);
  });

  it("orphans a mempool detection whose transaction disappeared", async () => {
    await seen("det_1", { height: null, n: 1 });

    expect(await runPromotionTick(h.deps)).toMatchObject({ orphaned: 1 });
    expect(h.fake.orphaned).toEqual(["det_1"]);
  });

  it("waits when the light server has not reached the detection's block", async () => {
    await seen("det_1", { height: TIP + 5, blockHash: hash("future"), n: 1 });
    const getTransaction = vi.spyOn(h.chain.testnet, "getTransaction");

    expect(await runPromotionTick(h.deps)).toEqual({
      checked: 1,
      promoted: 0,
      orphaned: 0,
      errors: 0,
      lastError: null,
    });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(h.fake.applied).toEqual([]);
  });

  it("counts a network's detections as errors when its tip is unavailable", async () => {
    await seen("det_1", { height: TIP - 1, n: 1 });
    await seen("det_2", { height: TIP - 2, n: 2 });
    h.chain.testnet.failNext();

    expect(await runPromotionTick(h.deps)).toEqual({
      checked: 2,
      promoted: 0,
      orphaned: 0,
      errors: 2,
      lastError: "chain_unavailable",
    });
    expect(h.fake.applied).toEqual([]);
  });

  it("keeps going after one detection fails", async () => {
    await seen("det_1", { height: null, n: 1 });
    await seen("det_2", { height: null, n: 2 });
    h.chain.testnet.putTransaction(txid(2), { kind: "mined", height: TIP, summary: {} });
    const lookup = h.chain.testnet.getTransaction.bind(h.chain.testnet);
    vi.spyOn(h.chain.testnet, "getTransaction").mockImplementation((id) =>
      id === txid(1) ? Promise.reject(new ChainUnavailableError()) : lookup(id),
    );

    const result = await runPromotionTick(h.deps);

    expect(result).toEqual({
      checked: 2,
      promoted: 0,
      orphaned: 0,
      errors: 1,
      lastError: "chain_unavailable",
    });
    expect(h.fake.applied).toEqual([expect.objectContaining({ invoiceId: "inv_det_2" })]);
  });

  it("ignores settled detections and networks that are not enabled", async () => {
    const memo = await insertInvoice(h.db, { id: "inv_done" });
    await insertDetection(h.db, {
      id: "det_done",
      invoiceId: "inv_done",
      txid: txid(9),
      memoHash: memo,
      blockHeight: TIP - 5,
      blockHash: await blockHash(TIP - 5),
      state: "settled",
    });
    await seen("det_main", { height: TIP - 1, n: 3, network: "mainnet" });
    const getTip = vi.spyOn(h.chain.mainnet, "getTip");

    expect(await runPromotionTick(h.deps)).toEqual({
      checked: 0,
      promoted: 0,
      orphaned: 0,
      errors: 0,
      lastError: null,
    });
    expect(getTip).not.toHaveBeenCalled();
    expect(h.fake.applied).toEqual([]);
  });
});
