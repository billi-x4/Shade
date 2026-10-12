/**
 * Offline checks against the real @ledgerhq/zcash-utils binary (skipped where it cannot load):
 * keys it derives must pass Shade's own ZIP-316 validation. testDeriveKeys is the library's
 * TEST-ONLY helper; production code never derives keys from a mnemonic.
 */
import { describe, expect, it } from "vitest";
import {
  decodeUnified,
  orchardReceiverOf,
  parseMerchantAddress,
  parseUfvk,
} from "../../src/zcash/address.ts";
import { createLedgerScanner } from "../../src/zcash/scanner.ts";

const lib = await import("@ledgerhq/zcash-utils").catch(() => null);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe.skipIf(lib === null)("real scanner library (offline)", () => {
  const scanner = createLedgerScanner({ urls: () => [] });

  it("loads", async () => {
    expect(await scanner.available()).toBe(true);
  });

  it.each(["testnet", "mainnet"] as const)(
    "derives a %s UFVK that parseUfvk accepts",
    (network) => {
      const { ufvk } = lib!.testDeriveKeys(MNEMONIC, 0, network);
      expect(parseUfvk(ufvk, network)).toEqual({ ok: true, ufvk, network });
      const orchard = decodeUnified(ufvk).items.find((item) => item.typecode === 0x03);
      expect(orchard?.data).toHaveLength(96);
      expect(parseUfvk(ufvk, network === "testnet" ? "mainnet" : "testnet").ok).toBe(false);
    },
  );

  it.each([
    ["testnet", "utest1"],
    ["mainnet", "u1"],
  ] as const)(
    "keyAddress gives a %s Orchard-only address Shade accepts unchanged",
    async (network, prefix) => {
      const { ufvk } = lib!.testDeriveKeys(MNEMONIC, 0, network);
      const address = await scanner.keyAddress(ufvk);
      expect(address.startsWith(prefix)).toBe(true);
      expect(parseMerchantAddress(address, network)).toEqual({
        ok: true,
        address,
        network,
        strippedTransparent: false,
        hasSapling: false,
      });
      expect(orchardReceiverOf(address)).toHaveLength(43);
    },
  );
});
