import { describe, expect, it } from "vitest";
import {
  decodeUnified,
  encodeUnified,
  orchardReceiverOf,
  parseMerchantAddress,
  parseUfvk,
} from "../../src/zcash/address.ts";
import type { UnifiedItem } from "../../src/zcash/address.ts";
import { bech32mDecode, bech32mEncode } from "../../src/zcash/bech32.ts";
import { ZcashCodecError, concatBytes, encodeCompactSize } from "../../src/zcash/bytes.ts";
import { f4jumble } from "../../src/zcash/f4jumble.ts";
import { hex, loadVectors } from "./fixtures.ts";
import type { VectorRow } from "./fixtures.ts";

const UA = loadVectors("unified_address.json");
const UA_R2 = loadVectors("unified_address_r2.json");
const UFVK = loadVectors("unified_full_viewing_keys.json");
const UIVK = loadVectors("unified_incoming_viewing_keys.json");
const UVK_R2 = loadVectors("unified_viewing_keys_r2.json");

function le(value: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let rest = BigInt(value);
  for (let i = 0; i < bytes; i++, rest >>= 8n) out[i] = Number(rest & 0xffn);
  return out;
}

/** Items described by a vector row: `columns` maps column name → typecode. */
function itemsOf(
  row: VectorRow,
  columns: Record<string, number>,
  unknown?: [string, string],
): UnifiedItem[] {
  const items: UnifiedItem[] = [];
  for (const [column, typecode] of Object.entries(columns)) {
    const value = row[column];
    if (value != null) items.push({ typecode, data: hex(String(value)) });
  }
  if (row.expiry_height != null)
    items.push({ typecode: 0xe0, data: le(Number(row.expiry_height), 4) });
  if (row.expiry_time != null) items.push({ typecode: 0xe1, data: le(Number(row.expiry_time), 8) });
  // Some rows name an unknown typecode with null bytes: no such item is present.
  if (unknown && row[unknown[0]] != null && row[unknown[1]] != null) {
    items.push({ typecode: Number(row[unknown[0]]), data: hex(String(row[unknown[1]])) });
  }
  return items.sort((a, b) => a.typecode - b.typecode);
}

const plain = (items: UnifiedItem[]): Array<[number, string]> =>
  items.map((i) => [i.typecode, Buffer.from(i.data).toString("hex")]);

/** Encodes raw item bytes the ZIP-316 way, so malformed contents can be tested. */
function craft(
  hrp: string,
  items: Array<[number, Uint8Array]> | Uint8Array,
  paddingHrp = hrp,
): string {
  const raw =
    items instanceof Uint8Array
      ? items
      : concatBytes(
          items.flatMap(([t, d]) => [encodeCompactSize(t), encodeCompactSize(d.length), d]),
        );
  const padding = new Uint8Array(16);
  padding.set(Buffer.from(paddingHrp, "ascii"));
  return bech32mEncode(hrp, f4jumble(concatBytes([raw, padding])));
}

const ORCHARD = new Uint8Array(43).fill(3);
const SAPLING = new Uint8Array(43).fill(2);
const P2PKH = new Uint8Array(20).fill(1);

const ADDRESS_COLUMNS = { p2pkh_bytes: 0, p2sh_bytes: 1, sapling_raw_addr: 2, orchard_raw_addr: 3 };

describe("decodeUnified / encodeUnified against zcash-test-vectors", () => {
  it("decodes and re-encodes every Revision 0 Unified Address", () => {
    expect(UA.length).toBe(60);
    for (const row of UA) {
      const encoded = String(row.unified_addr);
      const decoded = decodeUnified(encoded);
      expect(decoded).toMatchObject({ kind: "address", network: "mainnet", hrp: "u", revision: 0 });
      expect(plain(decoded.items)).toEqual(
        plain(itemsOf(row, ADDRESS_COLUMNS, ["unknown_typecode", "unknown_bytes"])),
      );
      expect(encodeUnified("address", "mainnet", decoded.items)).toBe(encoded);
    }
  });

  it("decodes and re-encodes every UFVK", () => {
    expect(UFVK.length).toBe(20);
    for (const row of UFVK) {
      const encoded = String(row.unified_fvk);
      const decoded = decodeUnified(encoded);
      expect(decoded).toMatchObject({
        kind: "ufvk",
        network: "mainnet",
        hrp: "uview",
        revision: 0,
      });
      const columns = { t_key_bytes: 0, sapling_fvk_bytes: 2, orchard_fvk_bytes: 3 };
      expect(plain(decoded.items)).toEqual(
        plain(itemsOf(row, columns, ["unknown_fvk_typecode", "unknown_fvk_bytes"])),
      );
      expect(encodeUnified("ufvk", "mainnet", decoded.items)).toBe(encoded);
    }
  });

  it("decodes and re-encodes every UIVK", () => {
    expect(UIVK.length).toBe(20);
    for (const row of UIVK) {
      const encoded = String(row.unified_ivk);
      const decoded = decodeUnified(encoded);
      expect(decoded).toMatchObject({ kind: "uivk", network: "mainnet", hrp: "uivk", revision: 0 });
      const columns = { t_key_bytes: 0, sapling_ivk_bytes: 2, orchard_ivk_bytes: 3 };
      expect(plain(decoded.items)).toEqual(
        plain(itemsOf(row, columns, ["unknown_ivk_typecode", "unknown_ivk_bytes"])),
      );
      expect(encodeUnified("uivk", "mainnet", decoded.items)).toBe(encoded);
    }
  });

  it("decodes every Revision 2 Unified Address (zu/tu with expiry metadata)", () => {
    expect(UA_R2.length).toBe(60);
    for (const row of UA_R2) {
      const encoded = String(row.unified_addr);
      const decoded = decodeUnified(encoded);
      expect(decoded.kind).toBe("address");
      expect(decoded.revision).toBe(2);
      expect(["zu", "tu"]).toContain(decoded.hrp);
      expect(plain(decoded.items)).toEqual(plain(itemsOf(row, ADDRESS_COLUMNS)));
    }
  });

  it("decodes every Revision 2 UFVK, UIVK and derived address", () => {
    for (const row of UVK_R2) {
      const fvk = decodeUnified(String(row.unified_fvk));
      expect(fvk).toMatchObject({ kind: "ufvk", revision: 2, hrp: "uvf" });
      const fvkColumns = {
        t_p2pkh_fvk_bytes: 0,
        p2sh_fvk_bytes: 1,
        sapling_fvk_bytes: 2,
        orchard_fvk_bytes: 3,
      };
      expect(plain(fvk.items)).toEqual(plain(itemsOf(row, fvkColumns)));

      const ivk = decodeUnified(String(row.unified_ivk));
      expect(ivk).toMatchObject({ kind: "uivk", revision: 2, hrp: "uvi" });
      const ivkColumns = {
        t_p2pkh_ivk_bytes: 0,
        p2sh_ivk_bytes: 1,
        sapling_ivk_bytes: 2,
        orchard_ivk_bytes: 3,
      };
      expect(plain(ivk.items)).toEqual(plain(itemsOf(row, ivkColumns)));

      const ua = decodeUnified(String(row.derived_ua));
      expect(ua).toMatchObject({ kind: "address", revision: 2 });
      const receivers = ua.items.filter((i) => i.typecode < 0xc0);
      const expected = itemsOf(row, {
        p2pkh_addr: 0,
        p2sh_addr: 1,
        sapling_raw_addr: 2,
        orchard_raw_addr: 3,
      });
      expect(plain(receivers)).toEqual(plain(expected.filter((i) => i.typecode < 0xc0)));
    }
  });

  it("accepts all-uppercase encodings and reports the lowercase HRP", () => {
    const encoded = String(UA[27]!.unified_addr);
    expect(decodeUnified(encoded.toUpperCase()).hrp).toBe("u");
  });

  it("encodes testnet and regtest HRPs and sorts unordered items", () => {
    const items = [
      { typecode: 3, data: ORCHARD },
      { typecode: 2, data: SAPLING },
    ];
    const testnet = encodeUnified("address", "testnet", items);
    expect(testnet.startsWith("utest1")).toBe(true);
    expect(decodeUnified(testnet)).toMatchObject({ network: "testnet", hrp: "utest" });
    expect(decodeUnified(testnet).items.map((i) => i.typecode)).toEqual([2, 3]);
    expect(
      decodeUnified(encodeUnified("ufvk", "regtest", [{ typecode: 3, data: new Uint8Array(96) }]))
        .hrp,
    ).toBe("uviewregtest");
  });
});

describe("decodeUnified rejects malformed encodings", () => {
  const valid = String(UA[27]!.unified_addr);

  it.each([
    ["a corrupted checksum", `${valid.slice(0, -1)}${valid.endsWith("q") ? "p" : "q"}`],
    ["mixed case", `${valid.slice(0, 10).toUpperCase()}${valid.slice(10)}`],
    ["a non-bech32 character", `${valid.slice(0, 20)}b${valid.slice(21)}`],
    ["no separator", valid.replace("1", "")],
    ["an unknown prefix", craft("zz", [[3, ORCHARD]])],
    ["the wrong padding", craft("u", [[3, ORCHARD]], "utest")],
    [
      "items out of order",
      craft("u", [
        [3, ORCHARD],
        [2, SAPLING],
      ]),
    ],
    [
      "a duplicate typecode",
      craft("u", [
        [3, ORCHARD],
        [3, ORCHARD],
      ]),
    ],
    [
      "both P2PKH and P2SH",
      craft("u", [
        [0, P2PKH],
        [1, P2PKH],
        [3, ORCHARD],
      ]),
    ],
    [
      "no shielded receiver",
      craft("u", [
        [0, P2PKH],
        [0xfffa, new Uint8Array(30)],
      ]),
    ],
    [
      "MUST-understand metadata in Revision 0",
      craft("u", [
        [3, ORCHARD],
        [0xe0, new Uint8Array(4)],
      ]),
    ],
    ["only metadata", craft("tu", [[0xc0, new Uint8Array(40)]])],
    [
      "a short Orchard receiver",
      craft("u", [
        [3, new Uint8Array(42)],
        [0xfffa, new Uint8Array(4)],
      ]),
    ],
    ["a truncated item", craft("u", concatBytes([Uint8Array.of(3, 60), ORCHARD]))],
    [
      "a non-canonical compactSize",
      craft("u", concatBytes([Uint8Array.of(0xfd, 3, 0, 43), ORCHARD])),
    ],
    ["a payload shorter than 38 bytes", bech32mEncode("u", new Uint8Array(20))],
    [
      "a transparent receiver in a zu address",
      craft("zu", [
        [0, P2PKH],
        [3, ORCHARD],
      ]),
    ],
    [
      "unknown MUST-understand metadata in Revision 2",
      craft("zu", [
        [3, ORCHARD],
        [0xe5, new Uint8Array(4)],
      ]),
    ],
    [
      "malformed expiry metadata",
      craft("zu", [
        [3, ORCHARD],
        [0xe0, new Uint8Array(3)],
      ]),
    ],
    ["a short Orchard FVK", craft("uview", [[3, new Uint8Array(95)]])],
    ["a zero Sapling IVK", craft("uivk", [[2, new Uint8Array(64)]])],
    [
      "an invalid transparent key",
      craft("uview", [
        [0, new Uint8Array(65)],
        [3, new Uint8Array(96)],
      ]),
    ],
  ])("rejects %s", (_name, encoded) => {
    expect(() => decodeUnified(encoded)).toThrow(ZcashCodecError);
  });

  it("rejects invalid items on encode", () => {
    expect(() => encodeUnified("address", "mainnet", [{ typecode: 0, data: P2PKH }])).toThrow(
      ZcashCodecError,
    );
    expect(() =>
      encodeUnified("address", "mainnet", [
        { typecode: 3, data: ORCHARD },
        { typecode: 3, data: ORCHARD },
      ]),
    ).toThrow(ZcashCodecError);
    expect(() => encodeUnified("address", "mainnet", [{ typecode: -1, data: ORCHARD }])).toThrow(
      ZcashCodecError,
    );
  });
});

describe("bech32m against ZIP-320 TEX vectors", () => {
  it.each(
    loadVectors("zip_0320.json").map((v) => [String(v.tex_addr), String(v.p2pkh_bytes)] as const),
  )("%s", (tex, p2pkh) => {
    expect(Buffer.from(bech32mDecode(tex).data).toString("hex")).toBe(p2pkh);
    expect(bech32mEncode("tex", hex(p2pkh))).toBe(tex);
  });
});

describe("parseMerchantAddress", () => {
  const orchardOnly = String(UA[27]!.unified_addr);
  const transparentSaplingOnly = String(UA[0]!.unified_addr);
  const transparentOrchard = String(UA[9]!.unified_addr);
  const transparentSaplingOrchard = String(UA[3]!.unified_addr);
  const orchardUnknown = String(UA[36]!.unified_addr);
  const testnetOf = (encoded: string): string =>
    encodeUnified("address", "testnet", decodeUnified(encoded).items);

  const reject = (raw: string, network: "mainnet" | "testnet" = "mainnet"): string => {
    const result = parseMerchantAddress(raw, network);
    if (result.ok) throw new Error("expected a rejection");
    // Messages never echo what was pasted.
    if (raw.trim().length >= 12) expect(result.message).not.toContain(raw.trim().slice(0, 12));
    return result.message;
  };

  it("accepts an Orchard-only address unchanged", () => {
    expect(parseMerchantAddress(orchardOnly, "mainnet")).toEqual({
      ok: true,
      address: orchardOnly,
      network: "mainnet",
      strippedTransparent: false,
      hasSapling: false,
    });
  });

  it("rejects a P2PKH + Sapling address for missing Orchard", () => {
    expect(reject(transparentSaplingOnly)).toMatch(/no Orchard receiver/);
  });

  it("strips the transparent receiver from P2PKH + Orchard and re-encodes", () => {
    const result = parseMerchantAddress(transparentOrchard, "mainnet");
    expect(result).toMatchObject({
      ok: true,
      network: "mainnet",
      strippedTransparent: true,
      hasSapling: false,
    });
    if (!result.ok) return;
    expect(result.address).not.toBe(transparentOrchard);
    const decoded = decodeUnified(result.address);
    expect(decoded.items.map((i) => i.typecode)).toEqual([3]);
    expect(decoded.items[0]!.data).toEqual(orchardReceiverOf(transparentOrchard));
    expect(parseMerchantAddress(result.address, "mainnet")).toMatchObject({
      ok: true,
      strippedTransparent: false,
    });
  });

  it("keeps Sapling next to Orchard", () => {
    const result = parseMerchantAddress(transparentSaplingOrchard, "mainnet");
    expect(result).toMatchObject({ ok: true, strippedTransparent: true, hasSapling: true });
    if (result.ok)
      expect(decodeUnified(result.address).items.map((i) => i.typecode)).toEqual([2, 3]);
    expect(parseMerchantAddress(String(UA[6]!.unified_addr), "mainnet")).toMatchObject({
      ok: true,
      address: String(UA[6]!.unified_addr),
      strippedTransparent: false,
      hasSapling: true,
    });
  });

  it("drops receiver types Shade cannot detect payments to", () => {
    const result = parseMerchantAddress(orchardUnknown, "mainnet");
    expect(result).toMatchObject({ ok: true, strippedTransparent: false });
    if (result.ok) expect(decodeUnified(result.address).items.map((i) => i.typecode)).toEqual([3]);
  });

  it("normalizes whitespace and an all-uppercase address", () => {
    expect(parseMerchantAddress(`  ${orchardOnly.toUpperCase()}\n`, "mainnet")).toMatchObject({
      ok: true,
      address: orchardOnly,
    });
  });

  it("accepts testnet addresses on testnet only", () => {
    const testnet = testnetOf(orchardOnly);
    expect(parseMerchantAddress(testnet, "testnet")).toMatchObject({
      ok: true,
      address: testnet,
      network: "testnet",
    });
    expect(reject(testnet, "mainnet")).toBe(
      "That is a testnet address. Paste a shielded mainnet Unified Address (starts with u1).",
    );
    expect(reject(orchardOnly, "testnet")).toBe(
      "That is a mainnet address. Paste a shielded testnet Unified Address (starts with utest1).",
    );
    const regtest = encodeUnified("address", "regtest", [{ typecode: 3, data: ORCHARD }]);
    expect(reject(regtest, "testnet")).toMatch(/^That is a regtest address\./);
  });

  it.each([
    ["t1 (mainnet P2PKH)", String(loadVectors("zip_0320.json")[0]!.t_addr)],
    ["t3 (mainnet P2SH)", "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd"],
    ["tm (testnet P2PKH)", "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU"],
    ["t2 (testnet P2SH)", "t2UNzUUx8mWBCRYPRezvA363EYXyEpHokyi"],
  ])("rejects a transparent address: %s", (_name, address) => {
    expect(reject(address)).toMatch(/^That is a transparent address/);
  });

  it("rejects TEX addresses", () => {
    const tex = loadVectors("zip_0320.json")[0]!;
    expect(reject(String(tex.tex_addr))).toMatch(/^That is a TEX address/);
    expect(reject(bech32mEncode("textest", hex(String(tex.p2pkh_bytes))), "testnet")).toMatch(
      /^That is a TEX address/,
    );
  });

  it("rejects Sapling-only addresses", () => {
    const sapling =
      "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez";
    expect(reject(sapling, "testnet")).toMatch(/^That is a Sapling-only address/);
    expect(reject(`zs1${"q".repeat(75)}`)).toMatch(/^That is a Sapling-only address/);
  });

  it("rejects Revision 2 addresses as not supported yet", () => {
    const zu = UA_R2.map((r) => String(r.unified_addr)).find((a) => a.startsWith("zu1"))!;
    const tu = UA_R2.map((r) => String(r.unified_addr)).find((a) => a.startsWith("tu1"))!;
    expect(reject(zu)).toMatch(/does not support this newer address format yet/);
    expect(reject(tu)).toMatch(/does not support this newer address format yet/);
  });

  it("rejects viewing keys pasted as an address", () => {
    for (const key of [
      String(UFVK[0]!.unified_fvk),
      String(UIVK[0]!.unified_ivk),
      String(UVK_R2[0]!.unified_fvk),
    ]) {
      expect(reject(key)).toMatch(/^That is a viewing key, not an address/);
    }
    expect(reject(`zxviews1${"q".repeat(280)}`)).toMatch(/^That is a viewing key, not an address/);
  });

  it("rejects spending keys and seed phrases without echoing them", () => {
    expect(reject(`secret-extended-key-main1${"q".repeat(270)}`)).toMatch(
      /^That is a spending key\. Never share it/,
    );
    expect(reject(`secret-extended-key-test1${"q".repeat(270)}`, "testnet")).toMatch(
      /^That is a spending key/,
    );
    const twelve =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(reject(twelve)).toMatch(/^That looks like a seed phrase\. Never share it/);
    expect(reject(`${"zoo ".repeat(23)}wrong`)).toMatch(/^That looks like a seed phrase/);
    expect(reject("pay me at my address please")).toMatch(
      /^That is not a valid Zcash Unified Address/,
    );
  });

  it("rejects empty, oversized, mixed-case and malformed input", () => {
    expect(reject("   ")).toBe("Paste a shielded Unified Address (starts with u1).");
    expect(reject(`u1${"q".repeat(1100)}`)).toBe("That is too long to be a Zcash address.");
    expect(reject(`U1${orchardOnly.slice(2)}`)).toMatch(/mixes upper and lower case/);
    expect(reject(`${orchardOnly.slice(0, -1)}${orchardOnly.endsWith("q") ? "p" : "q"}`)).toMatch(
      /^That is not a valid Zcash Unified Address/,
    );
    expect(reject("hello")).toMatch(/^That is not a valid Zcash Unified Address/);
    expect(parseMerchantAddress(42 as unknown as string, "mainnet").ok).toBe(false);
  });
});

describe("parseUfvk", () => {
  const withOrchard = UFVK.find((r) => r.orchard_fvk_bytes != null)!;
  const withoutOrchard = UFVK.find((r) => r.orchard_fvk_bytes == null)!;

  const reject = (raw: string, network: "mainnet" | "testnet" = "mainnet"): string => {
    const result = parseUfvk(raw, network);
    if (result.ok) throw new Error("expected a rejection");
    if (raw.trim().length >= 12) expect(result.message).not.toContain(raw.trim().slice(0, 12));
    return result.message;
  };

  it("accepts a UFVK with an Orchard full viewing key", () => {
    const ufvk = String(withOrchard.unified_fvk);
    expect(parseUfvk(`  ${ufvk.toUpperCase()} `, "mainnet")).toEqual({
      ok: true,
      ufvk,
      network: "mainnet",
    });
    const testnet = encodeUnified("ufvk", "testnet", decodeUnified(ufvk).items);
    expect(parseUfvk(testnet, "testnet")).toEqual({ ok: true, ufvk: testnet, network: "testnet" });
  });

  it("rejects a UFVK without Orchard", () => {
    expect(reject(String(withoutOrchard.unified_fvk))).toMatch(/no Orchard part/);
  });

  it("rejects a UFVK for the other network", () => {
    expect(reject(String(withOrchard.unified_fvk), "testnet")).toBe(
      "That is a mainnet viewing key. Paste a testnet full viewing key (starts with uviewtest1).",
    );
  });

  it("asks for a full viewing key when given an incoming viewing key", () => {
    expect(reject(String(UIVK[0]!.unified_ivk))).toMatch(
      /^Hosted detection needs a full viewing key/,
    );
  });

  it("rejects Revision 2 viewing keys, addresses, spending keys and seeds", () => {
    expect(reject(String(UVK_R2[0]!.unified_fvk))).toMatch(/newer viewing key format/);
    expect(reject(String(UA[27]!.unified_addr))).toMatch(/^That is an address, not a viewing key/);
    expect(reject("tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU", "testnet")).toMatch(/^That is an address/);
    expect(reject(`secret-extended-key-main1${"q".repeat(270)}`)).toMatch(
      /^That is a spending key/,
    );
    const seed = Array.from({ length: 24 }, () => "abandon").join(" ");
    expect(reject(seed)).toMatch(/^That looks like a seed phrase/);
    expect(reject(`zxviews1${"q".repeat(280)}`)).toMatch(/Sapling-only viewing key/);
    expect(reject("")).toBe("Paste a full viewing key (starts with uview1).");
    expect(reject("uview1notavalidkey")).toMatch(/^That is not a valid full viewing key/);
  });
});

describe("orchardReceiverOf", () => {
  it("returns the Orchard receiver bytes", () => {
    for (const row of UA.filter((r) => r.orchard_raw_addr != null)) {
      expect(Buffer.from(orchardReceiverOf(String(row.unified_addr))!).toString("hex")).toBe(
        row.orchard_raw_addr,
      );
    }
  });

  it("returns null without an Orchard receiver or for anything but an address", () => {
    expect(orchardReceiverOf(String(UA[0]!.unified_addr))).toBeNull();
    expect(orchardReceiverOf(String(UFVK[0]!.unified_fvk))).toBeNull();
    expect(orchardReceiverOf("not an address")).toBeNull();
    expect(orchardReceiverOf(null as unknown as string)).toBeNull();
  });
});
