/**
 * Settlement and promotion against the real light-server client while it is answered by a ZainoD
 * that reports a mempool transaction at its tip height (observed live 2026-10-03). Testnet needs
 * one confirmation, so taking that height as mined would settle an unmined payment.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Network } from "../../src/contract/index.ts";
import { AppError } from "../../src/platform/errors.ts";
import { createLogger } from "../../src/platform/logger.ts";
import { createInvoiceView } from "../../src/services/invoices.ts";
import { type SettlementService, createSettlementService } from "../../src/services/settlement.ts";
import { runPromotionTick } from "../../src/worker/promotion.ts";
import { type ChainClient, createLightwalletdClient } from "../../src/zcash/lightwalletd.ts";
import { type Harness, createHarness, createMerchant, randomTxid } from "../support/harness.ts";
import { hex, recordedTransaction } from "./fixtures.ts";
import {
  RECORDED,
  ZAINO_INFO,
  blockId,
  closeReplayServers,
  compactBlock,
  ok,
  rawTransaction,
  serve,
} from "./grpc-replay.ts";

const TIP = 4_435_601;
/** A receivable (two Ironwood actions) transaction; the replay answers it for any txid. */
const RAW = hex(recordedTransaction(RECORDED.getTransaction.txid).hex);

let h: Harness;
let merchantId: string;

beforeAll(async () => {
  h = await createHarness();
  merchantId = (await createMerchant(h)).merchantId;
}, 60_000);

afterAll(async () => {
  await h.close();
});

afterEach(closeReplayServers);

async function zaino(): Promise<{
  chain: Record<Network, ChainClient>;
  settlement: SettlementService;
}> {
  const server = await serve({
    GetLightdInfo: ok(hex(ZAINO_INFO)),
    GetLatestBlock: ok(blockId(TIP)),
    GetTransaction: ok(rawTransaction(RAW, TIP)),
    // The tip block, which does not list the (still unmined) transaction.
    GetBlock: ok(compactBlock(TIP, ["11".repeat(32)])),
  });
  const chain = {
    testnet: createLightwalletdClient({ urls: [server.url], network: "testnet", timeoutMs: 2_000 }),
    mainnet: h.chain.mainnet,
  };
  const settlement = createSettlementService({
    db: h.db,
    config: h.config,
    chain,
    clock: h.clock,
    view: createInvoiceView(h.config, h.clock),
    webhooks: h.services.webhooks,
  });
  return { chain, settlement };
}

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

describe("a ZainoD answering a mempool transaction with its tip height", () => {
  it("is not enough to confirm a payer's claim (testnet needs one confirmation)", async () => {
    expect(h.config.minConfirmations.testnet).toBe(1);
    const { settlement } = await zaino();
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "0.01" });
    const txid = randomTxid();
    expect((await settlement.submitPayerTxid(invoice.id, txid)).status).toBe("paid_unverified");

    const err = await rejects(settlement.acceptClaim(merchantId, invoice.id));
    expect(err).toMatchObject({ status: 409, code: "TX_NOT_MINED" });
    const [row] = await h.db<{ status: string; txid: string | null }>`
      select status, txid from invoices where id = ${invoice.id}`;
    expect(row).toEqual({ status: "paid_unverified", txid: null });
  });

  it("records a reported detection as seen without a block, and promotion keeps waiting", async () => {
    const { chain, settlement } = await zaino();
    const invoice = await h.services.invoices.create(merchantId, "testnet", { amount_zec: "0.02" });
    const txid = randomTxid();
    const reported = await settlement.reportDetection(
      { merchantId, network: "testnet" },
      invoice.id,
      { txid, amount_zec: "0.02", memo_hash: invoice.memo_hash, pool: "ironwood" },
    );
    expect(reported.status).toBe("open");
    expect(reported.detection).toMatchObject({ state: "seen", block_height: null });

    const deps = {
      db: h.db,
      config: h.config,
      logger: createLogger({ logLevel: "silent", env: "test" }),
      services: { settlement, webhooks: h.services.webhooks },
      scanner: h.scanner,
      chain,
      clock: h.clock,
    };
    expect(await runPromotionTick(deps)).toMatchObject({ promoted: 0, orphaned: 0, errors: 0 });
    const detections = await h.db<{ state: string; block_height: number | null }>`
      select state, block_height from invoice_detections where invoice_id = ${invoice.id}`;
    expect(detections).toEqual([{ state: "seen", block_height: null }]);
    const [row] = await h.db<{
      status: string;
    }>`select status from invoices where id = ${invoice.id}`;
    expect(row?.status).toBe("open");
  });
});
