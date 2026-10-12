import { describe, expect, it } from "vitest";
import {
  MEMO_MAX_BYTES,
  MERCHANT_MEMO_MAX_BYTES,
  chainMemo,
  checkMemoText,
  memoField,
  memoHash,
  newMemoRef,
} from "../../src/zcash/memo.ts";

describe("memoHash (ZIP-302 memo field)", () => {
  it.each([
    ["", "sha256:fe079fddb054f739dbd8cfd06eef30fd5fbf7d02779ba3aff628013d952c643d"],
    ["order_1042", "sha256:c8c635ab00c9198684fec71dad1e2e19693610696e6f381ba1cc15c622cb7b20"],
    [
      "This is a simple memo.",
      "sha256:bc48def82b6299bbe748b4c2b21c30bcec98b18a9b5dbd59e82ddbf944bde02b",
    ],
  ])("hashes %j", (memo, hash) => {
    expect(memoHash(memo)).toBe(hash);
  });
});

describe("memoField", () => {
  it('encodes "" as 0xF6 followed by zeros ("no memo")', () => {
    const field = memoField("");
    expect(field).toHaveLength(512);
    expect(field[0]).toBe(0xf6);
    expect(field.subarray(1).every((b) => b === 0)).toBe(true);
  });

  it("encodes text as UTF-8 padded with zeros", () => {
    const field = memoField("é!");
    expect([...field.subarray(0, 4)]).toEqual([0xc3, 0xa9, 0x21, 0]);
    expect(field.subarray(3).every((b) => b === 0)).toBe(true);
  });

  it("accepts exactly 512 bytes and rejects more", () => {
    expect(memoField("a".repeat(512))).toHaveLength(512);
    expect(() => memoField("a".repeat(513))).toThrow(RangeError);
  });

  it("rejects lone surrogates instead of silently replacing them", () => {
    expect(() => memoField("x\ud800y")).toThrow(RangeError);
  });
});

describe("checkMemoText", () => {
  it("counts UTF-8 bytes", () => {
    expect(checkMemoText("order 1")).toEqual({ ok: true, bytes: 7 });
    expect(checkMemoText("é🦄")).toEqual({ ok: true, bytes: 6 });
    expect(checkMemoText("")).toEqual({ ok: true, bytes: 0 });
  });

  it("defaults to the merchant limit, leaving room for the shade reference", () => {
    expect(checkMemoText("a".repeat(MERCHANT_MEMO_MAX_BYTES)).ok).toBe(true);
    const tooLong = checkMemoText("a".repeat(MERCHANT_MEMO_MAX_BYTES + 1));
    expect(tooLong).toEqual({ ok: false, message: "Memo must be 495 bytes or fewer." });
    expect(checkMemoText("a".repeat(MEMO_MAX_BYTES), MEMO_MAX_BYTES).ok).toBe(true);
    expect(checkMemoText("é".repeat(256), MEMO_MAX_BYTES).ok).toBe(true);
    expect(checkMemoText("é".repeat(257), MEMO_MAX_BYTES).ok).toBe(false);
  });

  it.each(["line\nbreak", "tab\there", "nul\u0000", "del\u007f", "nel\u0085", "c1\u009f", "\r"])(
    "rejects control characters in %j",
    (memo) => {
      expect(checkMemoText(memo)).toEqual({
        ok: false,
        message: "Memo cannot contain line breaks or control characters.",
      });
    },
  );

  it.each(["\ud800", "a\udc00", "\udfff\ud800"])("rejects lone surrogates %#", (memo) => {
    expect(checkMemoText(memo)).toEqual({
      ok: false,
      message: "Memo contains characters that cannot be encoded.",
    });
  });

  it("accepts non-breaking spaces and emoji", () => {
    expect(checkMemoText("a b 🦄🎉").ok).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(checkMemoText(42 as unknown as string).ok).toBe(false);
  });
});

describe("newMemoRef", () => {
  it("produces 8 Crockford base32 characters", () => {
    for (let i = 0; i < 200; i++) expect(newMemoRef()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("does not repeat", () => {
    const refs = new Set(Array.from({ length: 1000 }, () => newMemoRef()));
    expect(refs.size).toBe(1000);
  });
});

describe("chainMemo", () => {
  it("appends the shade reference", () => {
    expect(chainMemo("", "7K3MZ9QA")).toBe("shade:7K3MZ9QA");
    expect(chainMemo("order 1042", "7K3MZ9QA")).toBe("order 1042 (shade:7K3MZ9QA)");
  });

  it("returns the memo itself without a reference (jar charges)", () => {
    expect(chainMemo("api:search", null)).toBe("api:search");
    expect(chainMemo("", null)).toBe("");
  });

  it.each(["7k3mz9qa", "7K3MZ9QI", "7K3MZ9Q", "7K3MZ9QAB", "shade:XX"])(
    "rejects reference %j",
    (ref) => {
      expect(() => chainMemo("x", ref)).toThrow(RangeError);
    },
  );

  it("fits a maximum-length merchant memo in the 512-byte field", () => {
    const memo = chainMemo("a".repeat(MERCHANT_MEMO_MAX_BYTES), newMemoRef());
    expect(Buffer.byteLength(memo)).toBe(MEMO_MAX_BYTES);
    expect(memoField(memo)).toHaveLength(MEMO_MAX_BYTES);
  });
});
