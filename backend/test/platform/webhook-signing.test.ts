import { describe, expect, it } from "vitest";
import { signWebhook } from "../../src/platform/webhook-signing.ts";

// Vectors computed independently with `openssl dgst -sha256 -mac HMAC -macopt hexkey:<utf8 secret>`.
const SECRET = "whsec_test_secret";
const BODY = '{"id":"evt_1","type":"invoice.paid"}';

describe("signWebhook", () => {
  it("matches the PRD body signature and the timestamped V2 signature", () => {
    expect(signWebhook(SECRET, BODY, 1_790_000_000)).toEqual({
      "X-Shade-Signature":
        "sha256=2e69958eb5a4f9ec4965663bcad831d2aa9068109d63e8525c7a80fafb46a80d",
      "X-Shade-Signature-V2":
        "t=1790000000,v1=ff2a5f4cede3e411a5663d53e3f7e568ddcebae3cdbdc4403c302eb8b53fe2eb",
    });
  });

  it("keys and signs with UTF-8 bytes", () => {
    expect(signWebhook("whsec_ü", "é", 0)["X-Shade-Signature"]).toBe(
      "sha256=766da045b9e3b7fc6ec30f4f5fb90506ee9bac5e98c2b127d1e30b16913cc5da",
    );
  });

  it("changes V2 with every attempt time but never the body signature", () => {
    const first = signWebhook(SECRET, BODY, 1_790_000_000);
    const retry = signWebhook(SECRET, BODY, 1_790_000_300);
    expect(retry["X-Shade-Signature"]).toBe(first["X-Shade-Signature"]);
    expect(retry["X-Shade-Signature-V2"]).not.toBe(first["X-Shade-Signature-V2"]);
    expect(retry["X-Shade-Signature-V2"].startsWith("t=1790000300,v1=")).toBe(true);
  });

  it("refuses a non-integer or negative timestamp", () => {
    expect(() => signWebhook(SECRET, BODY, 1.5)).toThrow(RangeError);
    expect(() => signWebhook(SECRET, BODY, -1)).toThrow(RangeError);
  });
});
