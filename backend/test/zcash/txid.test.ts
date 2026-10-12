import { describe, expect, it } from "vitest";
import { parseTxid, reverseHex, txidToProtocolBytes } from "../../src/zcash/txid.ts";

const TXID = "abcaab3185ed8cd7d1e2f0e2a0bd001b538566ad18d1befb8848b678072d5fb8";

describe("parseTxid", () => {
  it("trims and lowercases a 64-hex txid", () => {
    expect(parseTxid(`  ${TXID.toUpperCase()}\n`)).toBe(TXID);
    expect(parseTxid(TXID)).toBe(TXID);
  });

  it.each([
    TXID.slice(1),
    `${TXID}0`,
    `${TXID.slice(1)}g`,
    "",
    `0x${TXID.slice(2)}`,
    `${TXID.slice(0, 32)} ${TXID.slice(32)}`,
  ])("rejects %j", (raw) => {
    expect(parseTxid(raw)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseTxid(undefined as unknown as string)).toBeNull();
  });
});

describe("byte order", () => {
  it("reverses hex byte order", () => {
    expect(reverseHex("0102ff")).toBe("ff0201");
    expect(reverseHex("ABcd")).toBe("cdab");
    expect(reverseHex(reverseHex(TXID))).toBe(TXID);
    expect(() => reverseHex("abc")).toThrow();
    expect(() => reverseHex("zz")).toThrow();
  });

  it("converts display txids to protocol bytes and back", () => {
    const bytes = txidToProtocolBytes(TXID);
    expect(bytes).toHaveLength(32);
    expect(bytes[0]).toBe(0xb8);
    expect(bytes[31]).toBe(0xab);
    expect(Buffer.from(bytes).reverse().toString("hex")).toBe(TXID);
  });

  it("rejects malformed input", () => {
    expect(() => txidToProtocolBytes(TXID.slice(2))).toThrow(RangeError);
    expect(() => txidToProtocolBytes(` ${TXID}`)).toThrow(RangeError);
  });
});
