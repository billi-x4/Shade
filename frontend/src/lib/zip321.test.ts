import { describe, expect, it } from "vitest";
import { paymentMemo } from "@/lib/zip321";

const ADDRESS =
  "utest18z20cdj59zmjdl23hyxzrgn0hr7tlexmmkwav5nwzpgd27yk4y0dc7mwwn3c0cp960swz78h7fqsvxg72jvv4mehvvattdaemqljkrk4";

describe("paymentMemo", () => {
  it("decodes the base64url memo of a Shade payment URI", () => {
    expect(
      paymentMemo(`zcash:${ADDRESS}?amount=0.01&memo=T3JkZXIgMTA0MiAoc2hhZGU6SzdRMk05WEEp`),
    ).toBe("Order 1042 (shade:K7Q2M9XA)");
  });

  it("decodes multi-byte UTF-8 and memos using - and _", () => {
    expect(paymentMemo(`zcash:${ADDRESS}?amount=1&memo=Y2Fmw6kg4piVIChzaGFkZTpLN1EyTTlYQSk`)).toBe(
      "café ☕ (shade:K7Q2M9XA)",
    );
    // "?>?" encodes to "Pz4_" in base64url: the _ must map back to /.
    expect(paymentMemo(`zcash:${ADDRESS}?amount=1&memo=Pz4_`)).toBe("?>?");
  });

  it.each([
    ["no query", `zcash:${ADDRESS}`],
    ["no memo", `zcash:${ADDRESS}?amount=0.01`],
    ["an empty memo", `zcash:${ADDRESS}?amount=0.01&memo=`],
    ["standard base64 padding", `zcash:${ADDRESS}?amount=0.01&memo=T3JkZXI=`],
    ["invalid UTF-8", `zcash:${ADDRESS}?amount=0.01&memo=_w`],
  ])("is null for %s", (_name, uri) => {
    expect(paymentMemo(uri)).toBeNull();
  });
});
