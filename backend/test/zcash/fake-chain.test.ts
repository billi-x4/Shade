import { afterEach, describe, expect, it } from "vitest";
import { decodeUnified, encodeUnified, parseMerchantAddress } from "../../src/zcash/address.ts";
import { DEFAULT_EXPLORER_TX_URL } from "../../src/zcash/explorer.ts";
import { ChainUnavailableError } from "../../src/zcash/lightwalletd.ts";
import { ScannerError } from "../../src/zcash/scanner.ts";
import type { ScannedPayment } from "../../src/zcash/scanner.ts";
import { buildRawTx, createFakeChain, createFakeScanner } from "../support/fake-chain.ts";
import { parseTxSummary } from "../../src/zcash/tx.ts";

const TXID = "abcaab3185ed8cd7d1e2f0e2a0bd001b538566ad18d1befb8848b678072d5fb8";
const ORIGINAL_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
});

describe("createFakeChain", () => {
  it("serves a deterministic chain with a movable tip", async () => {
    const chain = createFakeChain("testnet");
    expect(chain.network).toBe("testnet");
    const tip = await chain.getTip();
    expect(tip.height).toBe(1_000);
    expect(tip.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await chain.getBlock(1_000)).toEqual({
      height: 1_000,
      hash: tip.hash,
      time: expect.any(Number),
    });
    expect(await chain.getBlock(1_001)).toBeNull();

    chain.setTip(1_010, "AA".repeat(32));
    expect(await chain.getTip()).toEqual({ height: 1_010, hash: "aa".repeat(32) });
    const block = await chain.getBlock(1_005);
    expect(block).toEqual(await chain.getBlock(1_005));
    expect(block!.time - (await chain.getBlock(1_004))!.time).toBe(75);
    await expect(chain.getBlock(0)).rejects.toThrow(RangeError);
  });

  it("simulates a reorg with setBlock", async () => {
    const chain = createFakeChain("mainnet");
    const before = await chain.getBlock(990);
    chain.setBlock(990, { hash: "bb".repeat(32), time: 1_790_000_000 });
    expect(await chain.getBlock(990)).toEqual({
      height: 990,
      hash: "bb".repeat(32),
      time: 1_790_000_000,
    });
    expect(before!.hash).not.toBe("bb".repeat(32));
  });

  it("stores transactions from a summary or a lookup", async () => {
    const chain = createFakeChain("testnet");
    chain.putTransaction(TXID.toUpperCase(), { kind: "mined", summary: { ironwoodActions: 2 } });
    const mined = await chain.getTransaction(TXID);
    expect(mined).toMatchObject({ kind: "mined", height: 1_000 });
    if (mined.kind === "mined") expect(parseTxSummary(mined.raw).ironwoodActions).toBe(2);

    chain.putTransaction(TXID, {
      kind: "mempool",
      summary: { transparentInputs: 1, transparentOutputs: 1 },
    });
    expect((await chain.getTransaction(TXID)).kind).toBe("mempool");

    chain.putTransaction(TXID, { kind: "orphaned" });
    expect(await chain.getTransaction(TXID)).toEqual({ kind: "orphaned" });
    chain.putTransaction(TXID, {
      kind: "mined",
      height: 7,
      raw: buildRawTx({ saplingOutputs: 1 }),
    });
    expect(await chain.getTransaction(TXID)).toMatchObject({ kind: "mined", height: 7 });

    expect(await chain.getTransaction("00".repeat(32))).toEqual({ kind: "not_found" });
    await expect(chain.getTransaction("nope")).rejects.toThrow(RangeError);
  });

  it("returns copies, not shared buffers", async () => {
    const chain = createFakeChain("testnet");
    chain.putTransaction(TXID, { kind: "mined", summary: { ironwoodActions: 1 } });
    const first = await chain.getTransaction(TXID);
    if (first.kind === "mined") first.raw.fill(0);
    const second = await chain.getTransaction(TXID);
    if (second.kind === "mined") expect(parseTxSummary(second.raw).ironwoodActions).toBe(1);
  });

  it("fails the next call once", async () => {
    const chain = createFakeChain("testnet");
    chain.failNext();
    await expect(chain.getTip()).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(chain.getTip()).resolves.toMatchObject({ height: 1_000 });
    const custom = new Error("boom");
    chain.failNext(custom);
    await expect(chain.getTransaction(TXID)).rejects.toBe(custom);
    expect((await chain.getInfo()).chainName).toBe("test");
    expect((await createFakeChain("mainnet").getInfo()).chainName).toBe("main");
  });

  it("refuses to run in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => createFakeChain("testnet")).toThrow(/tests only/);
    expect(() => createFakeScanner()).toThrow(/tests only/);
  });
});

describe("createFakeScanner", () => {
  const ufvk = encodeUnified("ufvk", "testnet", [
    { typecode: 3, data: new Uint8Array(96).fill(5) },
  ]);
  const payment = (blockHeight: number, amountZat: bigint): ScannedPayment => ({
    txid: TXID,
    blockHeight,
    blockHash: "cc".repeat(32),
    blockTime: 1_790_000_000,
    pool: "ironwood",
    amountZat,
    memoHash: "sha256:00",
  });

  it("derives a deterministic Orchard-only address Shade accepts", async () => {
    const scanner = createFakeScanner();
    const address = await scanner.keyAddress(ufvk);
    expect(address).toBe(await createFakeScanner().keyAddress(ufvk));
    expect(decodeUnified(address).items.map((i) => i.typecode)).toEqual([3]);
    expect(parseMerchantAddress(address, "testnet")).toMatchObject({ ok: true, address });
    scanner.setKeyAddress(ufvk, "utest1override");
    expect(await scanner.keyAddress(ufvk)).toBe("utest1override");
    await expect(createFakeScanner().keyAddress("not a key")).rejects.toBeInstanceOf(ScannerError);
  });

  it("yields payments in the range, in height order, per key and network", async () => {
    const scanner = createFakeScanner();
    expect(await scanner.available()).toBe(true);
    scanner.addPayment("testnet", ufvk, payment(120, 3n));
    scanner.addPayment("testnet", ufvk, payment(110, 1n));
    scanner.addPayment("testnet", ufvk, payment(200, 9n));
    scanner.addPayment("mainnet", ufvk, payment(115, 7n));
    scanner.addPayment("testnet", "uviewtest1other", payment(115, 8n));
    const found: bigint[] = [];
    for await (const p of scanner.scan({
      network: "testnet",
      ufvk,
      fromHeight: 100,
      toHeight: 150,
    }))
      found.push(p.amountZat);
    expect(found).toEqual([1n, 3n]);
  });

  it("ends an aborted scan with ScannerError", async () => {
    const scanner = createFakeScanner();
    const run = async () => {
      for await (const _p of scanner.scan({
        network: "testnet",
        ufvk,
        fromHeight: 1,
        toHeight: 2,
        signal: AbortSignal.abort(),
      })) {
        // nothing
      }
    };
    await expect(run()).rejects.toMatchObject({ code: "chain_unavailable" });
  });
});

describe("DEFAULT_EXPLORER_TX_URL", () => {
  it("has a {txid} template per network", () => {
    expect(DEFAULT_EXPLORER_TX_URL.testnet).toBe("https://testnet.zecblock.com/tx/{txid}");
    expect(DEFAULT_EXPLORER_TX_URL.mainnet).toBe("https://zecblock.com/tx/{txid}");
  });
});
