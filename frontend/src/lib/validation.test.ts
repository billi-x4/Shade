import { describe, expect, it } from "vitest";
import { validateInvoice } from "@/features/invoices/invoice-rules";
import {
  checkAddressInput,
  checkAmount,
  checkMemo,
  checkTag,
  checkTagName,
  checkUfvkInput,
  normalizeTagName,
  normalizeTxid,
  safeDeskRedirect,
  utf8Bytes,
  zecToZat,
} from "@/lib/validation";

describe("amounts", () => {
  it("accepts canonical ZEC with up to 8 decimals", () => {
    expect(checkAmount("0.01")).toBeNull();
    expect(checkAmount("21000000")).toBeNull();
    expect(zecToZat("0.00000001")).toBe(1n);
    expect(zecToZat("1.5")).toBe(150_000_000n);
  });

  it("rejects malformed, zero and over-supply amounts", () => {
    expect(checkAmount("")).toBe("Enter an amount in ZEC.");
    expect(checkAmount("0")).toBe("The amount must be more than zero.");
    expect(checkAmount("0.000000001")).not.toBeNull();
    expect(checkAmount("01")).not.toBeNull();
    expect(checkAmount("1,5")).not.toBeNull();
    expect(checkAmount("-1")).not.toBeNull();
    expect(checkAmount("21000000.00000001")).not.toBeNull();
  });
});

describe("memos", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Bytes("é")).toBe(2);
    expect(checkMemo("é".repeat(247))).toBeNull(); // 494 bytes
    expect(checkMemo("é".repeat(248))).toBe("Keep the memo under 496 bytes.");
  });

  it("rejects control characters and broken surrogates", () => {
    expect(checkMemo("line\nbreak")).not.toBeNull();
    expect(checkMemo("\u0085")).not.toBeNull();
    expect(checkMemo("\ud800")).not.toBeNull();
    expect(checkMemo("☕ 250g")).toBeNull();
  });
});

describe("labels and tags", () => {
  it("follows the backend tag shape after lowercasing", () => {
    expect(checkTag("Payroll")).toBeNull();
    expect(checkTag("")).toBeNull();
    expect(checkTag("", { required: true })).toBe("Enter a name.");
    expect(checkTag("-lead")).not.toBeNull();
    expect(checkTag("pay roll")).not.toBeNull();
    expect(checkTag("a".repeat(33))).not.toBeNull();
  });

  it("checks name.shade names against the backend tag pattern, not the label one", () => {
    for (const name of ["my_shop", "north_line", "shop-", "northline-", "-lead", "a".repeat(33)]) {
      expect(checkTagName(name)).toBe(
        "Use up to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
      );
    }
    // The same values are fine as invoice labels and grant scopes.
    expect(checkTag("north_line")).toBeNull();
    expect(checkTag("northline-")).toBeNull();
    for (const name of ["northline", "North-Line", "a", "a".repeat(32), "Northline.shade"]) {
      expect(checkTagName(name)).toBeNull();
    }
    expect(checkTagName("", { required: true })).toBe("Enter a name.");
    expect(checkTagName(".shade", { required: true })).toBe("Enter a name.");
  });

  it("normalizes a name.shade name like the backend", () => {
    expect(normalizeTagName("  Northline.SHADE ")).toBe("northline");
    expect(normalizeTagName("northline")).toBe("northline");
  });
});

describe("invoice form rules", () => {
  it("reports one message per bad field", () => {
    expect(validateInvoice({ amount: "abc", memo: "x".repeat(496), tag: "Not ok" })).toEqual({
      amount: "Use a number like 0.01, with at most 8 decimals.",
      memo: "Keep the memo under 496 bytes.",
      tag: "Use up to 32 lowercase letters, digits, - or _, starting with a letter or digit.",
    });
    expect(validateInvoice({ amount: "0.01", memo: "Order 1042", tag: "" })).toEqual({});
  });

  it('reserves the label "all", which grants read as every receipt', () => {
    for (const tag of ["all", "ALL", " All "]) {
      expect(validateInvoice({ amount: "0.01", memo: "", tag })).toEqual({
        tag: '"all" is reserved. Pick another label.',
      });
    }
    expect(validateInvoice({ amount: "0.01", memo: "", tag: "allowance" })).toEqual({});
  });
});

describe("dangerous pastes", () => {
  const seed = "abandon ".repeat(23) + "art";

  it("stops seed phrases and keys from being used as addresses", () => {
    expect(checkAddressInput(seed, "testnet")).toMatch(/seed phrase/);
    expect(checkAddressInput("secret-extended-key-test1abc", "testnet")).toMatch(/spending key/);
    expect(checkAddressInput("uviewtest1abc", "testnet")).toMatch(/viewing key/);
    expect(checkAddressInput("u1abc", "testnet")).toBe(
      "A testnet Unified Address starts with utest1.",
    );
    expect(checkAddressInput("utest1abc", "testnet")).toBeNull();
  });

  it("asks for a full viewing key on the right network", () => {
    expect(checkUfvkInput("uivktest1abc", "testnet")).toMatch(/full viewing key/);
    expect(checkUfvkInput("uview1abc", "testnet")).toBe(
      "A testnet full viewing key starts with uviewtest1.",
    );
    expect(checkUfvkInput("uviewtest1abc", "testnet")).toBeNull();
  });
});

describe("txids and redirects", () => {
  it("normalizes a pasted txid", () => {
    expect(normalizeTxid(`  ${"AB".repeat(32)} `)).toBe("ab".repeat(32));
    expect(normalizeTxid("ab".repeat(31))).toBeNull();
  });

  it("only allows desk paths after sign-in", () => {
    expect(safeDeskRedirect("/desk/jars")).toBe("/desk/jars");
    expect(safeDeskRedirect("https://evil.example/desk")).toBeNull();
    expect(safeDeskRedirect("//evil.example")).toBeNull();
    expect(safeDeskRedirect("/desk\\..\\evil")).toBeNull();
    expect(safeDeskRedirect(undefined)).toBeNull();
  });
});
