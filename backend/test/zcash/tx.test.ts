import { describe, expect, it } from "vitest";
import { buildRawTx } from "../support/fake-chain.ts";
import { ZcashCodecError, isReceivable, parseTxSummary } from "../../src/zcash/tx.ts";
import type { TxSummary } from "../../src/zcash/tx.ts";
import { hex, loadVectors, recordedTransaction, recordedTransactions } from "./fixtures.ts";

const V5_GROUP = 0x26a7270a;
const V6_GROUP = 0xd884b698;
const NU6_3 = 0x37a5165b;

describe("parseTxSummary on real transactions (recorded from lightwalletd)", () => {
  const recorded = recordedTransactions();

  it("has both networks and the shapes Shade must classify", () => {
    expect(recorded.filter((t) => t.network === "testnet").length).toBeGreaterThanOrEqual(5);
    expect(recorded.filter((t) => t.network === "mainnet").length).toBeGreaterThanOrEqual(4);
  });

  it.each(
    recorded.map((t) => [`${t.network} ${t.txid.slice(0, 12)} (${t.description})`, t] as const),
  )("%s matches the block's compact transaction", (_name, tx) => {
    const summary = parseTxSummary(hex(tx.hex));
    const coinbase = tx.compact.index === 0;
    expect(summary).toMatchObject({
      version: tx.version,
      versionGroupId: tx.version === 6 ? V6_GROUP : V5_GROUP,
      branchId: NU6_3,
      // CompactTx omits the coinbase's single null-outpoint input.
      transparentInputs: tx.compact.vin + (coinbase ? 1 : 0),
      transparentOutputs: tx.compact.vout,
      saplingSpends: tx.compact.saplingSpends,
      saplingOutputs: tx.compact.saplingOutputs,
      orchardActions: tx.compact.orchardActions,
      ironwoodActions: tx.compact.ironwoodActions,
    });
    // A mined transaction had not expired (a coinbase's expiry height is its own block height).
    expect(summary.expiryHeight === 0 || summary.expiryHeight >= tx.height).toBe(true);
  });

  it.each([
    ["abcaab3185ed8cd7d1e2f0e2a0bd001b538566ad18d1befb8848b678072d5fb8", true],
    ["00c0259f4f31c463325c499d67003efb616776d3df1feba53d757a13e5daf1fb", false],
    ["a7518544984aa71a02f75c26d4ee23074938d01778ed772602f3a458ff8d4b83", true],
    ["ffc84aff2d233f36193a45d367ace54b56843306ca43f5d4ee813baf54ed14e8", true],
    ["feb68ac841ed236521bf1055555b026f6150e3c0edb30ac5b8527eb9e9c2d2e2", true],
    ["0a98a8f11e6b6ec6f035ad2366f74e0113af347e265766f560b4b16f9b7d3858", true],
    ["44131ec3dec7f439aac38669ba549c06b7b7a9216fb3da1d1dbf42dfe2c42621", false],
    ["3910a8ffc7cca10a14c7cc7a22d92a96f88a826dc16840032234b71dfcb12916", true],
    // Orchard-only actions cannot pay anyone after NU6.3.
    ["0eb255e527ccf7d809a4fd3923c68102d21d8988abbeb08e030a12851e605f73", false],
    ["33718fb6c568541153ba61ff45cc62dd4d314519fc65021248fe95e58a0e1410", true],
  ] as const)("%s: receivable=%s", (txid, receivable) => {
    const summary = parseTxSummary(hex(recordedTransaction(txid).hex));
    expect(isReceivable(summary)).toBe(receivable);
  });

  it("treats the consensus branch id as opaque", () => {
    const raw = hex(
      recordedTransaction("abcaab3185ed8cd7d1e2f0e2a0bd001b538566ad18d1befb8848b678072d5fb8").hex,
    );
    for (const branchId of [0x77190ad9, 0xdeadbeef, 0]) {
      const patched = Uint8Array.from(raw);
      new DataView(patched.buffer).setUint32(8, branchId, true);
      expect(parseTxSummary(patched).branchId).toBe(branchId);
    }
  });

  it("rejects truncated or padded transactions", () => {
    for (const tx of recorded) {
      const raw = hex(tx.hex);
      expect(() => parseTxSummary(raw.subarray(0, raw.length - 1))).toThrow(ZcashCodecError);
      expect(() => parseTxSummary(Uint8Array.from([...raw, 0]))).toThrow(ZcashCodecError);
    }
  });
});

describe("parseTxSummary on zcash-test-vectors", () => {
  it.each(loadVectors("zip_0244.json").map((v, i) => [i, String(v.tx)] as const))(
    "v5 vector %i (zip_0244.json)",
    (_i, tx) => {
      const summary = parseTxSummary(hex(tx));
      expect(summary.version).toBe(5);
      expect(summary.ironwoodActions).toBe(0);
    },
  );

  it.each(loadVectors("zip_0243.json").map((v, i) => [i, String(v.tx)] as const))(
    "v4 vector %i (zip_0243.json)",
    (_i, tx) => {
      const summary = parseTxSummary(hex(tx));
      expect(summary).toMatchObject({
        version: 4,
        branchId: 0,
        orchardActions: 0,
        ironwoodActions: 0,
      });
    },
  );
});

describe("parseTxSummary rejects unsupported headers", () => {
  const v6 = buildRawTx({ ironwoodActions: 2 });
  const withHeader = (header: number, group: number): Uint8Array => {
    const raw = Uint8Array.from(v6);
    const view = new DataView(raw.buffer);
    view.setUint32(0, header, true);
    view.setUint32(4, group, true);
    return raw;
  };

  it.each([
    ["v6 without fOverwintered", withHeader(6, V6_GROUP)],
    ["v6 with the v5 group id", withHeader(0x8000_0006, V5_GROUP)],
    ["v5 with the v6 group id", withHeader(0x8000_0005, V6_GROUP)],
    ["v3 (Overwinter)", withHeader(0x8000_0003, 0x03c48270)],
    ["v7", withHeader(0x8000_0007, V6_GROUP)],
    ["an empty buffer", new Uint8Array(0)],
  ])("%s", (_name, raw) => {
    expect(() => parseTxSummary(raw)).toThrow(ZcashCodecError);
  });

  it("rejects non-byte input", () => {
    expect(() => parseTxSummary("00" as unknown as Uint8Array)).toThrow(ZcashCodecError);
  });
});

describe("buildRawTx", () => {
  const full = (s: Partial<TxSummary>): TxSummary => ({
    version: 6,
    versionGroupId: V6_GROUP,
    branchId: NU6_3,
    expiryHeight: 0,
    transparentInputs: 0,
    transparentOutputs: 0,
    saplingSpends: 0,
    saplingOutputs: 0,
    orchardActions: 0,
    ironwoodActions: 0,
    ...s,
  });

  it.each([
    {},
    { ironwoodActions: 2 },
    { transparentInputs: 2, transparentOutputs: 3 },
    { saplingSpends: 1, saplingOutputs: 2, ironwoodActions: 2, expiryHeight: 4_433_800 },
    { saplingOutputs: 1 },
    { orchardActions: 2, ironwoodActions: 1, branchId: 0x77190ad9 },
    { transparentInputs: 1, ironwoodActions: 2 },
  ])("round-trips v6 %j", (s) => {
    expect(parseTxSummary(buildRawTx(s))).toEqual(full(s));
  });

  it("builds v5 transactions", () => {
    const s = { version: 5, orchardActions: 2, saplingSpends: 1 };
    expect(parseTxSummary(buildRawTx(s))).toEqual(full({ ...s, versionGroupId: V5_GROUP }));
  });

  it("refuses impossible summaries", () => {
    expect(() => buildRawTx({ version: 5, ironwoodActions: 1 })).toThrow(RangeError);
    expect(() => buildRawTx({ version: 4 })).toThrow(RangeError);
    expect(() => buildRawTx({ version: 6, versionGroupId: V5_GROUP })).toThrow(RangeError);
    expect(() => buildRawTx({ saplingOutputs: -1 })).toThrow(RangeError);
  });
});

describe("isReceivable", () => {
  const s = (p: Partial<TxSummary>): TxSummary => parseTxSummary(buildRawTx(p));

  it("requires an Ironwood action or a Sapling output", () => {
    expect(isReceivable(s({ ironwoodActions: 2 }))).toBe(true);
    expect(isReceivable(s({ saplingOutputs: 1 }))).toBe(true);
    expect(isReceivable(s({ orchardActions: 2 }))).toBe(false);
    expect(isReceivable(s({ saplingSpends: 1 }))).toBe(false);
    expect(isReceivable(s({ transparentInputs: 1, transparentOutputs: 1 }))).toBe(false);
  });
});
