import { describe, expect, it, vi } from "vitest";
import { createLedgerScanner } from "../../src/zcash/scanner.ts";

vi.mock("@ledgerhq/zcash-utils", () => {
  throw new Error("No prebuilt binary for this platform");
});

describe("createLedgerScanner without the native library", () => {
  const scanner = createLedgerScanner({ urls: () => ["https://testnet.zec.rocks:443"] });

  it("reports itself unavailable instead of crashing", async () => {
    expect(await scanner.available()).toBe(false);
  });

  it("fails key derivation and scans with scan_failed", async () => {
    await expect(scanner.keyAddress("uviewtest1fake")).rejects.toMatchObject({
      code: "scan_failed",
    });
    const scan = async () => {
      for await (const _payment of scanner.scan({
        network: "testnet",
        ufvk: "uviewtest1fake",
        fromHeight: 1,
        toHeight: 2,
      })) {
        // unreachable
      }
    };
    await expect(scan()).rejects.toMatchObject({ code: "scan_failed" });
  });
});
