import { describe, expect, it } from "vitest";
import {
  MAX_MONEY_ZAT,
  ZAT_PER_ZEC,
  formatZat,
  parseZec,
  zatFromNumeric,
} from "../../src/zcash/money.ts";

describe("parseZec", () => {
  it.each([
    ["1", 100_000_000n],
    ["0.00000001", 1n],
    ["0.5", 50_000_000n],
    ["123.456", 12_345_600_000n],
    ["20999999.99999999", MAX_MONEY_ZAT - 1n],
    ["21000000", MAX_MONEY_ZAT],
    ["21000000.0", MAX_MONEY_ZAT],
  ])("parses %s", (input, zat) => {
    expect(parseZec(input)).toBe(zat);
  });

  it.each([
    "",
    " 1",
    "1 ",
    "01",
    "00.5",
    "1.",
    ".5",
    "1.123456789",
    "-1",
    "+1",
    "1e3",
    "0x10",
    "1,5",
    "21000000.00000001",
    "99999999",
    "100000000",
    "١",
  ])("rejects %j", (input) => {
    expect(parseZec(input)).toBeNull();
  });

  it("rejects zero unless allowed", () => {
    expect(parseZec("0")).toBeNull();
    expect(parseZec("0.00000000")).toBeNull();
    expect(parseZec("0", { allowZero: true })).toBe(0n);
    expect(parseZec("0.00000000", { allowZero: true })).toBe(0n);
  });

  it("rejects non-strings", () => {
    expect(parseZec(1 as unknown as string)).toBeNull();
    expect(parseZec(null as unknown as string)).toBeNull();
  });
});

describe("formatZat", () => {
  it.each([
    [0n, "0"],
    [1n, "0.00000001"],
    [10n, "0.0000001"],
    [ZAT_PER_ZEC, "1"],
    [150_000_000n, "1.5"],
    [123_456_789n, "1.23456789"],
    [MAX_MONEY_ZAT, "21000000"],
  ])("formats %s", (zat, text) => {
    expect(formatZat(zat)).toBe(text);
  });

  it("rejects out-of-range and non-bigint values", () => {
    expect(() => formatZat(-1n)).toThrow(RangeError);
    expect(() => formatZat(MAX_MONEY_ZAT + 1n)).toThrow(RangeError);
    expect(() => formatZat(5 as unknown as bigint)).toThrow(TypeError);
  });

  it("round-trips with parseZec", () => {
    for (const zat of [1n, 7n, 99_999_999n, 100_000_001n, 1_234_567_890_123n, MAX_MONEY_ZAT]) {
      expect(parseZec(formatZat(zat))).toBe(zat);
    }
  });
});

describe("zatFromNumeric", () => {
  it.each([
    ["0.01000000", 1_000_000n],
    ["21000000.00000000", MAX_MONEY_ZAT],
    ["5", 500_000_000n],
    ["0.1234567800", 12_345_678n],
    ["0", 0n],
  ])("converts %s", (text, zat) => {
    expect(zatFromNumeric(text)).toBe(zat);
  });

  it.each(["0.123456789", "-1.00000000", "abc", "1e5", "", " 1"])("rejects %j", (text) => {
    expect(() => zatFromNumeric(text)).toThrow(RangeError);
  });

  it("rejects non-strings", () => {
    expect(() => zatFromNumeric(1 as unknown as string)).toThrow(TypeError);
  });
});
