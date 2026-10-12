import { describe, expect, it } from "vitest";
import { decodeUnified, encodeUnified } from "../../src/zcash/address.ts";
import { MAX_MONEY_ZAT } from "../../src/zcash/money.ts";
import { Zip321Error, buildPaymentUri } from "../../src/zcash/zip321.ts";
import { loadVectors } from "./fixtures.ts";

const UA = loadVectors("unified_address.json");
const ORCHARD_ONLY = String(UA[27]!.unified_addr);
const SAPLING_ORCHARD = String(UA[6]!.unified_addr);
const WITH_TRANSPARENT = String(UA[9]!.unified_addr);
const URI_GRAMMAR = /^zcash:[a-z0-9]+\?amount=\d+(?:\.\d{1,8})?(?:&memo=[A-Za-z0-9_-]+)?$/;

describe("buildPaymentUri", () => {
  it("matches the ZIP-321 example encodings for amount and memo", () => {
    expect(
      buildPaymentUri({
        address: ORCHARD_ONLY,
        amountZat: 100_000_000n,
        chainMemo: "This is a simple memo.",
      }),
    ).toBe(`zcash:${ORCHARD_ONLY}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg`);
    expect(
      buildPaymentUri({
        address: ORCHARD_ONLY,
        amountZat: 78_900_000n,
        chainMemo: "This is a unicode memo ✨🦄🏆🎉",
      }),
    ).toBe(
      `zcash:${ORCHARD_ONLY}?amount=0.789&memo=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok`,
    );
  });

  it.each([
    [12_345_600_000n, "123.456"],
    [349_140_505_201_255n, "3491405.05201255"],
    [1n, "0.00000001"],
    [MAX_MONEY_ZAT, "21000000"],
  ])("formats %s zatoshis as amount=%s", (amountZat, amount) => {
    const uri = buildPaymentUri({
      address: SAPLING_ORCHARD,
      amountZat,
      chainMemo: "shade:7K3MZ9QA",
    });
    expect(uri).toBe(`zcash:${SAPLING_ORCHARD}?amount=${amount}&memo=c2hhZGU6N0szTVo5UUE`);
    expect(uri).toMatch(URI_GRAMMAR);
  });

  it("carries the exact chain memo as unpadded base64url", () => {
    const memo = "order ~~~ 1042 ??? (shade:7K3MZ9QA)";
    const uri = buildPaymentUri({ address: ORCHARD_ONLY, amountZat: 5_000_000n, chainMemo: memo });
    const encoded = new URL(uri).searchParams.get("memo")!;
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(memo);
    expect(uri).not.toContain("message=");
    expect(uri).not.toContain("label=");
  });

  it("omits the memo parameter for an empty memo", () => {
    expect(buildPaymentUri({ address: ORCHARD_ONLY, amountZat: 1n, chainMemo: "" })).toBe(
      `zcash:${ORCHARD_ONLY}?amount=0.00000001`,
    );
  });

  it("writes the address in lowercase", () => {
    expect(
      buildPaymentUri({ address: ORCHARD_ONLY.toUpperCase(), amountZat: 1n, chainMemo: "" }),
    ).toBe(`zcash:${ORCHARD_ONLY}?amount=0.00000001`);
  });

  it.each([
    ["an address with a transparent receiver", WITH_TRANSPARENT],
    [
      "a Sapling address",
      "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez",
    ],
    ["a transparent address", "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU"],
    ["a viewing key", String(loadVectors("unified_full_viewing_keys.json")[0]!.unified_fvk)],
    ["a Revision 2 address", String(loadVectors("unified_address_r2.json")[0]!.unified_addr)],
    ["garbage", "zcash:nope"],
  ])("rejects %s", (_name, address) => {
    expect(() => buildPaymentUri({ address, amountZat: 1n, chainMemo: "x" })).toThrow(Zip321Error);
  });

  it("rejects non-positive and out-of-range amounts", () => {
    for (const amountZat of [0n, -1n, MAX_MONEY_ZAT + 1n]) {
      expect(() => buildPaymentUri({ address: ORCHARD_ONLY, amountZat, chainMemo: "x" })).toThrow(
        Zip321Error,
      );
    }
  });

  it("rejects memos a wallet cannot write verbatim", () => {
    for (const chainMemo of ["a".repeat(513), "line\nbreak", "x\ud800y"]) {
      expect(() => buildPaymentUri({ address: ORCHARD_ONLY, amountZat: 1n, chainMemo })).toThrow(
        Zip321Error,
      );
    }
    expect(() =>
      buildPaymentUri({ address: ORCHARD_ONLY, amountZat: 1n, chainMemo: "a".repeat(512) }),
    ).not.toThrow();
  });

  it("accepts a testnet Orchard-only address", () => {
    const testnet = encodeUnified("address", "testnet", decodeUnified(ORCHARD_ONLY).items);
    expect(
      buildPaymentUri({ address: testnet, amountZat: 1_000_000n, chainMemo: "shade:7K3MZ9QA" }),
    ).toMatch(/^zcash:utest1[a-z0-9]+\?amount=0\.01&memo=/);
  });
});
