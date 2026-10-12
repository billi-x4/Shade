/**
 * Unified Addresses and Unified Viewing Keys (ZIP-316), plus Shade's receive-address and
 * viewing-key policy.
 *
 * Decoding follows ZIP-316 exactly: Bech32m (no length limit) → F4Jumble⁻¹ → 16-byte HRP padding
 * check → typecode/length/value items in strictly ascending typecode order, with the item rules
 * of the encoding's revision. Curve-point validity of receivers is not checked here (it needs
 * Pallas/Jubjub arithmetic); payer wallets and the scanner library check it.
 *
 * Policy messages are plain language for merchants and never echo the input.
 */
import type { Network } from "../contract/index.ts";
import { bech32mDecode, bech32mEncode, normalizeBech32Case } from "./bech32.ts";
import {
  ByteReader,
  MAX_COMPACT_SIZE,
  ZcashCodecError,
  concatBytes,
  encodeCompactSize,
} from "./bytes.ts";
import { f4jumble, f4jumbleInv } from "./f4jumble.ts";

export { ZcashCodecError } from "./bytes.ts";

export type UnifiedKind = "address" | "ufvk" | "uivk";
export interface UnifiedItem {
  typecode: number;
  data: Uint8Array;
}
export interface DecodedUnified {
  kind: UnifiedKind;
  network: Network | "regtest";
  hrp: string;
  revision: 0 | 2;
  items: UnifiedItem[];
}

const P2PKH = 0x00;
const P2SH = 0x01;
const SAPLING = 0x02;
const ORCHARD = 0x03;
const EXPIRY_HEIGHT = 0xe0;
const EXPIRY_TIME = 0xe1;

const isMetadata = (typecode: number): boolean => typecode >= 0xc0 && typecode <= 0xfc;
const isMustUnderstand = (typecode: number): boolean => typecode >= 0xe0 && typecode <= 0xfc;
const isTransparent = (typecode: number): boolean => typecode === P2PKH || typecode === P2SH;

interface HrpInfo {
  kind: UnifiedKind;
  network: Network | "regtest";
  revision: 0 | 2;
  /** False only for Revision 2 `zu` addresses, which must not carry transparent items. */
  transparentAllowed: boolean;
}

const NETWORK_SUFFIX = { mainnet: "", testnet: "test", regtest: "regtest" } as const;
const REV0_PREFIX: Record<UnifiedKind, string> = { address: "u", ufvk: "uview", uivk: "uivk" };

const HRP_TABLE: ReadonlyMap<string, HrpInfo> = (() => {
  const prefixes: Array<Omit<HrpInfo, "network"> & { prefix: string }> = [
    { prefix: "u", kind: "address", revision: 0, transparentAllowed: true },
    { prefix: "zu", kind: "address", revision: 2, transparentAllowed: false },
    { prefix: "tu", kind: "address", revision: 2, transparentAllowed: true },
    { prefix: "uview", kind: "ufvk", revision: 0, transparentAllowed: true },
    { prefix: "uivk", kind: "uivk", revision: 0, transparentAllowed: true },
    { prefix: "uvf", kind: "ufvk", revision: 2, transparentAllowed: true },
    { prefix: "uvi", kind: "uivk", revision: 2, transparentAllowed: true },
  ];
  const table = new Map<string, HrpInfo>();
  for (const { prefix, ...info } of prefixes) {
    for (const network of ["mainnet", "testnet", "regtest"] as const) {
      table.set(prefix + NETWORK_SUFFIX[network], { ...info, network });
    }
  }
  return table;
})();

/** Byte lengths of the item encodings ZIP-316 defines (other typecodes are kept unvalidated). */
const ITEM_LENGTHS: Record<UnifiedKind, Readonly<Record<number, number>>> = {
  address: { [P2PKH]: 20, [P2SH]: 20, [SAPLING]: 43, [ORCHARD]: 43 },
  ufvk: { [P2PKH]: 65, [SAPLING]: 128, [ORCHARD]: 96 },
  uivk: { [P2PKH]: 65, [SAPLING]: 64, [ORCHARD]: 64 },
};

function hrpPadding(hrp: string): Uint8Array {
  const padding = new Uint8Array(16);
  for (let i = 0; i < hrp.length; i++) padding[i] = hrp.charCodeAt(i);
  return padding;
}

function parseItems(raw: Uint8Array): UnifiedItem[] {
  const reader = new ByteReader(raw);
  const items: UnifiedItem[] = [];
  let previous = -1;
  while (reader.remaining > 0) {
    const typecode = reader.compactSize();
    const length = reader.compactSize();
    const data = reader.bytes(length).slice();
    // Strictly ascending order also rules out duplicate typecodes.
    if (typecode <= previous)
      throw new ZcashCodecError("Items are not in ascending typecode order");
    previous = typecode;
    items.push({ typecode, data });
  }
  return items;
}

/** Revision 2 P2SH viewing-key item: a BIP-388 template and its (chain code ‖ pubkey) keys. */
function validateP2shViewingKey(data: Uint8Array): void {
  const reader = new ByteReader(data);
  const template = reader.bytes(reader.compactSize());
  if (template.length === 0 || template.some((b) => b < 0x20 || b > 0x7e)) {
    throw new ZcashCodecError("Invalid P2SH viewing key template");
  }
  const keys = reader.compactSize();
  reader.skip(keys * 65);
  reader.assertEnd();
}

function validateItem(info: HrpInfo, { typecode, data }: UnifiedItem): void {
  if (typecode === EXPIRY_HEIGHT || typecode === EXPIRY_TIME) {
    if (data.length !== (typecode === EXPIRY_HEIGHT ? 4 : 8)) {
      throw new ZcashCodecError("Invalid expiry metadata");
    }
    return;
  }
  if (typecode === P2SH && info.kind !== "address") {
    // Revision 0 viewing keys treat 0x01 as unrecognised; Revision 2 defines it.
    if (info.revision === 2) validateP2shViewingKey(data);
    return;
  }
  const expected = ITEM_LENGTHS[info.kind][typecode];
  if (expected !== undefined && data.length !== expected) {
    throw new ZcashCodecError("Item has the wrong length");
  }
  if (typecode === P2PKH && info.kind !== "address" && data[32] !== 0x02 && data[32] !== 0x03) {
    throw new ZcashCodecError("Invalid transparent public key");
  }
  if (typecode === SAPLING && info.kind === "uivk" && data.subarray(32).every((b) => b === 0)) {
    throw new ZcashCodecError("Invalid Sapling incoming viewing key");
  }
}

function validateItems(info: HrpInfo, items: readonly UnifiedItem[]): void {
  const has = (typecode: number): boolean => items.some((item) => item.typecode === typecode);
  if (!items.some((item) => !isMetadata(item.typecode))) {
    throw new ZcashCodecError("Encoding contains only metadata");
  }
  const p2shRecognised = info.kind === "address" || info.revision === 2;
  if (has(P2PKH) && has(P2SH) && p2shRecognised) {
    throw new ZcashCodecError("Encoding has both P2PKH and P2SH items");
  }
  if (info.revision === 0) {
    if (!has(SAPLING) && !has(ORCHARD)) throw new ZcashCodecError("Encoding has no shielded item");
    if (items.some((item) => isMustUnderstand(item.typecode))) {
      throw new ZcashCodecError("Revision 0 encoding has MUST-understand metadata");
    }
  } else {
    if (!info.transparentAllowed && items.some((item) => isTransparent(item.typecode))) {
      throw new ZcashCodecError("Shielded-only address has a transparent item");
    }
    const unsupported = items.some(
      (item) =>
        isMustUnderstand(item.typecode) &&
        item.typecode !== EXPIRY_HEIGHT &&
        item.typecode !== EXPIRY_TIME,
    );
    if (unsupported) throw new ZcashCodecError("Unsupported MUST-understand metadata");
  }
  for (const item of items) validateItem(info, item);
}

/** Decodes any Unified Address / UFVK / UIVK (Revision 0 or 2). Throws ZcashCodecError. */
export function decodeUnified(encoded: string): DecodedUnified {
  if (typeof encoded !== "string") throw new ZcashCodecError("Expected a string");
  const { hrp, data } = bech32mDecode(encoded);
  const info = HRP_TABLE.get(hrp);
  if (!info) throw new ZcashCodecError("Not a unified address or viewing key");
  const raw = f4jumbleInv(data);
  const padding = hrpPadding(hrp);
  const bodyLength = raw.length - padding.length;
  if (!raw.subarray(bodyLength).every((byte, i) => byte === padding[i])) {
    throw new ZcashCodecError("Invalid padding");
  }
  const items = parseItems(raw.subarray(0, bodyLength));
  validateItems(info, items);
  return { kind: info.kind, network: info.network, hrp, revision: info.revision, items };
}

/** Encodes items (any order) as a Revision 0 Unified Address / UFVK / UIVK. Throws ZcashCodecError. */
export function encodeUnified(
  kind: UnifiedKind,
  network: Network | "regtest",
  items: UnifiedItem[],
): string {
  const hrp = REV0_PREFIX[kind] + NETWORK_SUFFIX[network];
  const info = HRP_TABLE.get(hrp);
  if (!info) throw new ZcashCodecError("Unknown unified encoding");
  const sorted = [...items].sort((a, b) => a.typecode - b.typecode);
  sorted.forEach((item, i) => {
    if (
      !Number.isSafeInteger(item.typecode) ||
      item.typecode < 0 ||
      item.typecode > MAX_COMPACT_SIZE
    ) {
      throw new ZcashCodecError("Invalid typecode");
    }
    if (i > 0 && sorted[i - 1]!.typecode === item.typecode)
      throw new ZcashCodecError("Duplicate typecode");
  });
  validateItems(info, sorted);
  const raw = concatBytes([
    ...sorted.flatMap((item) => [
      encodeCompactSize(item.typecode),
      encodeCompactSize(item.data.length),
      item.data,
    ]),
    hrpPadding(hrp),
  ]);
  return bech32mEncode(hrp, f4jumble(raw));
}

// ── Merchant policy ──────────────────────────────────────────────────────────────────────────

const MAX_INPUT_LENGTH = 1024;
const TRANSPARENT_ADDRESS = /^t[1-3m][1-9A-HJ-NP-Za-km-z]{33}$/;
const SAPLING_ADDRESS_HRPS = new Set(["zs", "ztestsapling", "zregtestsapling"]);
const SAPLING_VIEWING_KEY_HRPS = new Set([
  "zxviews",
  "zxviewtestsapling",
  "zxviewregtestsapling",
  "zivks",
  "zivktestsapling",
  "zivkregtestsapling",
]);
const TEX_HRPS = new Set(["tex", "textest", "texregtest"]);

const UA_START: Record<Network, string> = { mainnet: "u1", testnet: "utest1" };
const UFVK_START: Record<Network, string> = { mainnet: "uview1", testnet: "uviewtest1" };

function pasteAddress(network: Network, nameNetwork = false): string {
  return `Paste a shielded ${nameNetwork ? `${network} ` : ""}Unified Address (starts with ${UA_START[network]}).`;
}

function pasteUfvk(network: Network, nameNetwork = false): string {
  return `Paste a ${nameNetwork ? `${network} ` : ""}full viewing key (starts with ${UFVK_START[network]}).`;
}

type InputClass =
  | { type: "empty" | "too_long" | "seed" | "transparent" | "mixed_case" | "invalid" }
  | { type: "spending_key" | "sapling_address" | "sapling_viewing_key" | "tex" }
  | { type: "unified"; text: string; info: HrpInfo };

function looksLikeSeedPhrase(words: readonly string[]): boolean {
  return words.length >= 12 && words.length <= 24 && words.every((word) => /^[a-z]+$/i.test(word));
}

/** Recognises what was pasted without decoding (except the HRP), so rejections can be specific. */
function classifyInput(raw: unknown): InputClass {
  if (typeof raw !== "string") return { type: "invalid" };
  const trimmed = raw.trim();
  if (trimmed === "") return { type: "empty" };
  if (trimmed.length > MAX_INPUT_LENGTH) return { type: "too_long" };
  if (/\s/.test(trimmed))
    return { type: looksLikeSeedPhrase(trimmed.split(/\s+/)) ? "seed" : "invalid" };
  if (TRANSPARENT_ADDRESS.test(trimmed)) return { type: "transparent" };
  let text: string;
  try {
    text = normalizeBech32Case(trimmed);
  } catch {
    return { type: "mixed_case" };
  }
  const hrp = text.slice(0, Math.max(0, text.lastIndexOf("1")));
  if (hrp.startsWith("secret-")) return { type: "spending_key" };
  if (SAPLING_ADDRESS_HRPS.has(hrp)) return { type: "sapling_address" };
  if (SAPLING_VIEWING_KEY_HRPS.has(hrp)) return { type: "sapling_viewing_key" };
  if (TEX_HRPS.has(hrp)) return { type: "tex" };
  const info = HRP_TABLE.get(hrp);
  return info ? { type: "unified", text, info } : { type: "invalid" };
}

function decodeOrNull(text: string): DecodedUnified | null {
  try {
    return decodeUnified(text);
  } catch (err) {
    if (err instanceof ZcashCodecError) return null;
    throw err;
  }
}

function networkName(network: Network | "regtest"): string {
  return network === "regtest" ? "a regtest" : `a ${network}`;
}

export type MerchantAddressResult =
  | {
      ok: true;
      address: string;
      network: Network;
      strippedTransparent: boolean;
      hasSapling: boolean;
    }
  | { ok: false; message: string };

/**
 * Validates a merchant receive address for `network`. Requires a Revision 0 Unified Address with
 * an Orchard receiver (payments to it land in the Ironwood pool). Returns a shielded-only address:
 * transparent receivers are stripped by re-encoding, and so are receiver types Shade cannot
 * detect payments to, so a payer's wallet can only choose the Orchard or Sapling receiver.
 */
export function parseMerchantAddress(raw: string, network: Network): MerchantAddressResult {
  const fail = (message: string): MerchantAddressResult => ({ ok: false, message });
  const paste = pasteAddress(network);
  const input = classifyInput(raw);
  switch (input.type) {
    case "empty":
      return fail(paste);
    case "too_long":
      return fail("That is too long to be a Zcash address.");
    case "seed":
      return fail(`That looks like a seed phrase. Never share it with anyone. ${paste}`);
    case "spending_key":
      return fail(`That is a spending key. Never share it with anyone. ${paste}`);
    case "transparent":
      return fail(`That is a transparent address, which makes payments public. ${paste}`);
    case "tex":
      return fail(`That is a TEX address, which only accepts transparent funds. ${paste}`);
    case "sapling_address":
      return fail(`That is a Sapling-only address. ${paste}`);
    case "sapling_viewing_key":
      return fail(`That is a viewing key, not an address. ${paste}`);
    case "mixed_case":
      return fail("That address mixes upper and lower case. Copy it again from your wallet.");
    case "invalid":
      return fail("That is not a valid Zcash Unified Address. Copy it again from your wallet.");
    case "unified":
      break;
  }
  if (input.info.kind !== "address") return fail(`That is a viewing key, not an address. ${paste}`);
  if (input.info.revision !== 0) {
    return fail(`Shade does not support this newer address format yet. ${paste}`);
  }
  const decoded = decodeOrNull(input.text);
  if (!decoded)
    return fail("That is not a valid Zcash Unified Address. Copy it again from your wallet.");
  if (decoded.network !== network) {
    return fail(`That is ${networkName(decoded.network)} address. ${pasteAddress(network, true)}`);
  }
  if (!decoded.items.some((item) => item.typecode === ORCHARD)) {
    return fail(
      "This Unified Address has no Orchard receiver, so private payments cannot reach it. Export a current Unified Address from your wallet.",
    );
  }
  const kept = decoded.items.filter(
    (item) => item.typecode === ORCHARD || item.typecode === SAPLING,
  );
  return {
    ok: true,
    address:
      kept.length === decoded.items.length ? input.text : encodeUnified("address", network, kept),
    network,
    strippedTransparent: decoded.items.some((item) => isTransparent(item.typecode)),
    hasSapling: kept.some((item) => item.typecode === SAPLING),
  };
}

export type UfvkResult =
  { ok: true; ufvk: string; network: Network } | { ok: false; message: string };

/** Validates a Unified Full Viewing Key for hosted detection: Revision 0, `network`, Orchard FVK. */
export function parseUfvk(raw: string, network: Network): UfvkResult {
  const fail = (message: string): UfvkResult => ({ ok: false, message });
  const paste = pasteUfvk(network);
  const input = classifyInput(raw);
  switch (input.type) {
    case "empty":
      return fail(paste);
    case "too_long":
      return fail("That is too long to be a Zcash viewing key.");
    case "seed":
      return fail(`That looks like a seed phrase. Never share it with anyone. ${paste}`);
    case "spending_key":
      return fail(`That is a spending key. Never share it with anyone. ${paste}`);
    case "transparent":
    case "tex":
    case "sapling_address":
      return fail(`That is an address, not a viewing key. ${paste}`);
    case "sapling_viewing_key":
      return fail(`That is a Sapling-only viewing key. ${paste}`);
    case "mixed_case":
      return fail("That viewing key mixes upper and lower case. Copy it again from your wallet.");
    case "invalid":
      return fail("That is not a valid full viewing key. Copy it again from your wallet.");
    case "unified":
      break;
  }
  if (input.info.kind === "address") return fail(`That is an address, not a viewing key. ${paste}`);
  if (input.info.kind === "uivk") {
    return fail(`Hosted detection needs a full viewing key, not an incoming viewing key. ${paste}`);
  }
  if (input.info.revision !== 0) {
    return fail(`Shade does not support this newer viewing key format yet. ${paste}`);
  }
  const decoded = decodeOrNull(input.text);
  if (!decoded)
    return fail("That is not a valid full viewing key. Copy it again from your wallet.");
  if (decoded.network !== network) {
    return fail(`That is ${networkName(decoded.network)} viewing key. ${pasteUfvk(network, true)}`);
  }
  if (!decoded.items.some((item) => item.typecode === ORCHARD)) {
    return fail(
      "This viewing key has no Orchard part, so it cannot see private payments. Export a full viewing key from a current wallet.",
    );
  }
  return { ok: true, ufvk: input.text, network };
}

/** The 43-byte Orchard receiver of a Unified Address, or null when absent or not a valid UA. */
export function orchardReceiverOf(address: string): Uint8Array | null {
  if (typeof address !== "string") return null;
  const decoded = decodeOrNull(address.trim());
  if (!decoded || decoded.kind !== "address") return null;
  return decoded.items.find((item) => item.typecode === ORCHARD)?.data ?? null;
}
