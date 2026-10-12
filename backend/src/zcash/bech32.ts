/** Bech32m (BIP-350) without the 90-character limit, as ZIP-316 requires. */
import { ZcashCodecError } from "./bytes.ts";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;
const BECH32M_CONST = 0x2bc830a3;
const CHECKSUM_LENGTH = 6;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function assertHrp(hrp: string): void {
  if (hrp.length < 1 || hrp.length > 83) throw new ZcashCodecError("Invalid human-readable part");
  for (let i = 0; i < hrp.length; i++) {
    const code = hrp.charCodeAt(i);
    if (code < 33 || code > 126) throw new ZcashCodecError("Invalid human-readable part");
  }
}

/** Lowercases an all-uppercase string; rejects mixed case (BIP-350). */
export function normalizeBech32Case(input: string): string {
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) {
    throw new ZcashCodecError("Mixed-case encoding");
  }
  return lower;
}

/** Decodes a Bech32m string to its HRP and 8-bit payload. Throws ZcashCodecError. */
export function bech32mDecode(input: string): { hrp: string; data: Uint8Array } {
  const text = normalizeBech32Case(input);
  const separator = text.lastIndexOf("1");
  if (separator < 1 || text.length - separator - 1 < CHECKSUM_LENGTH) {
    throw new ZcashCodecError("Missing separator or checksum");
  }
  const hrp = text.slice(0, separator);
  assertHrp(hrp);
  const words: number[] = [];
  for (let i = separator + 1; i < text.length; i++) {
    const value = CHARSET.indexOf(text[i]!);
    if (value < 0) throw new ZcashCodecError("Invalid character");
    words.push(value);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== BECH32M_CONST) {
    throw new ZcashCodecError("Invalid checksum");
  }
  return { hrp, data: fromWords(words.slice(0, -CHECKSUM_LENGTH)) };
}

export function bech32mEncode(hrp: string, data: Uint8Array): string {
  assertHrp(hrp);
  if (hrp !== hrp.toLowerCase()) throw new ZcashCodecError("Invalid human-readable part");
  const words = toWords(data);
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  for (let i = 0; i < CHECKSUM_LENGTH; i++) words.push((mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${words.map((w) => CHARSET[w]).join("")}`;
}

function toWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

/** 5-bit → 8-bit without padding: leftover bits must be fewer than 5 and all zero. */
function fromWords(words: readonly number[]): Uint8Array {
  const out = new Uint8Array(Math.floor((words.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let index = 0;
  for (const word of words) {
    acc = ((acc << 5) | word) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (acc >>> bits) & 0xff;
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) throw new ZcashCodecError("Invalid padding");
  return out;
}
