/**
 * Live checks against public light servers. Run with SHADE_LIVE_TESTS=1 (network required).
 * The scanner key comes from the library's TEST-ONLY testDeriveKeys and the public BIP-39 test
 * mnemonic, so no real wallet is involved.
 */
import { describe, expect, it } from "vitest";
import { parseMerchantAddress, parseUfvk } from "../../src/zcash/address.ts";
import { createLightwalletdClient } from "../../src/zcash/lightwalletd.ts";
import { memoHash } from "../../src/zcash/memo.ts";
import { parseZec } from "../../src/zcash/money.ts";
import { createLedgerScanner } from "../../src/zcash/scanner.ts";
import type { ScannedPayment } from "../../src/zcash/scanner.ts";
import { isReceivable, parseTxSummary } from "../../src/zcash/tx.ts";
import { fixtureExists, readFixture, recordedTransaction } from "./fixtures.ts";

const LIVE = process.env.SHADE_LIVE_TESTS === "1";
const URLS = {
  testnet: ["https://testnet.zec.rocks:443", "https://zaino.testnet.unsafe.zec.rocks:443"],
  mainnet: ["https://zec.rocks:443", "https://zec-node.cakewallet.com:443"],
};
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NETWORK_TIMEOUT = 60_000;

interface IronwoodNote {
  txid: string;
  block_height: number;
  block_hash: string;
  block_time: number;
  pool: "ironwood";
  amount_zat: string;
  memo_hash: string;
}

/** Recorded by the merchant-facing demo (spec §8); lives next to the other backend fixtures. */
const DEMO_PAYMENT = "../live-testnet-payment.json";

interface LivePayment {
  network: "testnet";
  ufvk: string;
  txid: string;
  block_height: number;
  amount_zec: string;
  memo: string;
}

describe.skipIf(!LIVE)("live lightwalletd", () => {
  it.each([
    ...URLS.testnet.map((u) => ["testnet", u] as const),
    ...URLS.mainnet.map((u) => ["mainnet", u] as const),
  ])(
    "%s %s: info, tip and block agree",
    async (network, url) => {
      const chain = createLightwalletdClient({ urls: [url], network });
      const info = await chain.getInfo();
      expect(info.chainName).toBe(network === "testnet" ? "test" : "main");
      const tip = await chain.getTip();
      expect(tip.height).toBeGreaterThan(network === "testnet" ? 4_433_000 : 3_503_000);
      const block = await chain.getBlock(tip.height);
      expect(block).toMatchObject({ height: tip.height, hash: tip.hash });
      expect(block!.time).toBeGreaterThan(1_790_000_000);
      expect(await chain.getBlock(tip.height + 10_000)).toBeNull();
    },
    NETWORK_TIMEOUT,
  );

  it.each([
    ["testnet", "abcaab3185ed8cd7d1e2f0e2a0bd001b538566ad18d1befb8848b678072d5fb8"],
    ["mainnet", "0a98a8f11e6b6ec6f035ad2366f74e0113af347e265766f560b4b16f9b7d3858"],
  ] as const)(
    "%s: fetches a recorded Ironwood transaction byte for byte",
    async (network, txid) => {
      const chain = createLightwalletdClient({ urls: URLS[network], network });
      const lookup = await chain.getTransaction(txid);
      const recorded = recordedTransaction(txid);
      expect(lookup).toMatchObject({ kind: "mined", height: recorded.height });
      if (lookup.kind !== "mined") return;
      expect(Buffer.from(lookup.raw).toString("hex")).toBe(recorded.hex);
      expect(isReceivable(parseTxSummary(lookup.raw))).toBe(true);
      const block = await chain.getBlock(recorded.height);
      expect(block?.hash).toMatch(/^0{4}/);
    },
    NETWORK_TIMEOUT,
  );

  it(
    "testnet: an unknown txid is not found",
    async () => {
      const chain = createLightwalletdClient({ urls: [URLS.testnet[0]!], network: "testnet" });
      expect(await chain.getTransaction("07".repeat(32))).toEqual({ kind: "not_found" });
    },
    NETWORK_TIMEOUT,
  );

  it(
    "testnet fallback (ZainoD): an unknown txid is unavailable, not not_found",
    async () => {
      // Documented limit (agents.md §3). If this starts failing, Zaino answers NOT_FOUND now and
      // the limit can be dropped from the docs.
      const chain = createLightwalletdClient({ urls: [URLS.testnet[1]!], network: "testnet" });
      await expect(chain.getTransaction("07".repeat(32))).rejects.toMatchObject({
        name: "ChainUnavailableError",
        reason: "grpc_status",
      });
    },
    NETWORK_TIMEOUT,
  );
});

describe.skipIf(!LIVE)("live scanner", () => {
  const scanner = createLedgerScanner({ urls: (network) => URLS[network] });

  async function scan(
    ufvk: string,
    fromHeight: number,
    toHeight: number,
  ): Promise<ScannedPayment[]> {
    const payments: ScannedPayment[] = [];
    for await (const p of scanner.scan({ network: "testnet", ufvk, fromHeight, toHeight }))
      payments.push(p);
    return payments;
  }

  it(
    "scans ~200 recent testnet blocks with a test UFVK without errors",
    async () => {
      expect(await scanner.available()).toBe(true);
      const { testDeriveKeys } = await import("@ledgerhq/zcash-utils");
      const { ufvk } = testDeriveKeys(MNEMONIC, 0, "testnet");
      expect(parseUfvk(ufvk, "testnet")).toMatchObject({ ok: true });
      const address = await scanner.keyAddress(ufvk);
      expect(address.startsWith("utest1")).toBe(true);
      expect(parseMerchantAddress(address, "testnet")).toMatchObject({ ok: true, address });

      const tip = await createLightwalletdClient({
        urls: URLS.testnet,
        network: "testnet",
      }).getTip();
      const payments = await scan(ufvk, tip.height - 199, tip.height);
      for (const p of payments) {
        expect(p.txid).toMatch(/^[0-9a-f]{64}$/);
        expect(p.blockHeight).toBeGreaterThanOrEqual(tip.height - 199);
        expect(p.memoHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    },
    NETWORK_TIMEOUT,
  );

  it(
    "decrypts real Ironwood notes and agrees with lightwalletd on block hashes",
    async () => {
      const { testDeriveKeys } = await import("@ledgerhq/zcash-utils");
      const { ufvk } = testDeriveKeys(MNEMONIC, 0, "testnet");
      const chain = createLightwalletdClient({ urls: URLS.testnet, network: "testnet" });
      const { notes } = readFixture<{ notes: IronwoodNote[] }>("live-ironwood-notes.json");
      for (const note of notes) {
        const payments = await scan(ufvk, note.block_height - 2, note.block_height + 2);
        expect(payments.find((p) => p.txid === note.txid)).toEqual({
          txid: note.txid,
          blockHeight: note.block_height,
          blockHash: note.block_hash,
          blockTime: note.block_time,
          pool: note.pool,
          amountZat: BigInt(note.amount_zat),
          memoHash: note.memo_hash,
        });
        // The scanner and Shade's own client must report hashes in the same (display) order.
        expect(await chain.getBlock(note.block_height)).toEqual({
          height: note.block_height,
          hash: note.block_hash,
          time: note.block_time,
        });
        const lookup = await chain.getTransaction(note.txid);
        expect(lookup).toMatchObject({ kind: "mined", height: note.block_height });
        if (lookup.kind === "mined")
          expect(parseTxSummary(lookup.raw).ironwoodActions).toBeGreaterThan(0);
      }
    },
    NETWORK_TIMEOUT,
  );

  it.skipIf(!fixtureExists(DEMO_PAYMENT))(
    "finds the recorded demo payment with its exact amount and memo hash",
    async () => {
      const recorded = readFixture<LivePayment>(DEMO_PAYMENT);
      const payments = await scan(
        recorded.ufvk,
        recorded.block_height - 5,
        recorded.block_height + 5,
      );
      const match = payments.find((p) => p.txid === recorded.txid);
      expect(match).toMatchObject({
        blockHeight: recorded.block_height,
        pool: "ironwood",
        amountZat: parseZec(recorded.amount_zec),
        memoHash: memoHash(recorded.memo),
      });
    },
    NETWORK_TIMEOUT,
  );
});
