/** Low-level byte helpers shared by the Zcash codecs (Unified encodings, transactions). */

/** Malformed Zcash encoding (address, viewing key, transaction). Messages never include the input. */
export class ZcashCodecError extends Error {
  override name = "ZcashCodecError";
}

/** Bitcoin MAX_SIZE: the largest compactSize value Zcash accepts (also ZIP-316's typecode/length cap). */
export const MAX_COMPACT_SIZE = 0x0200_0000;

const HEX_PATTERN = /^(?:[0-9a-fA-F]{2})*$/;

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

/** Strict hex decoder (even length, hex digits only). Throws ZcashCodecError. */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || !HEX_PATTERN.test(hex)) {
    throw new ZcashCodecError("Invalid hex string");
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Canonical compactSize encoding. */
export function encodeCompactSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COMPACT_SIZE) {
    throw new ZcashCodecError("compactSize value out of range");
  }
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, value >>> 8);
  return Uint8Array.of(
    0xfe,
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    value >>> 24,
  );
}

/** Sequential reader over a byte array; every read is bounds-checked. */
export class ByteReader {
  readonly #buf: Uint8Array;
  #pos = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
  }

  get remaining(): number {
    return this.#buf.length - this.#pos;
  }

  bytes(length: number): Uint8Array {
    this.#require(length);
    const out = this.#buf.subarray(this.#pos, this.#pos + length);
    this.#pos += length;
    return out;
  }

  skip(length: number): void {
    this.#require(length);
    this.#pos += length;
  }

  u8(): number {
    this.#require(1);
    return this.#buf[this.#pos++]!;
  }

  u16le(): number {
    const b = this.bytes(2);
    return b[0]! | (b[1]! << 8);
  }

  u32le(): number {
    const b = this.bytes(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  /** compactSize, rejecting non-canonical encodings and values above `max`. */
  compactSize(max = MAX_COMPACT_SIZE): number {
    const first = this.u8();
    let value: number;
    if (first < 0xfd) {
      value = first;
    } else if (first === 0xfd) {
      value = this.u16le();
      if (value < 0xfd) throw new ZcashCodecError("Non-canonical compactSize");
    } else if (first === 0xfe) {
      value = this.u32le();
      if (value < 0x1_0000) throw new ZcashCodecError("Non-canonical compactSize");
    } else {
      // 8-byte form: canonical only for values >= 2^32, which always exceed MAX_COMPACT_SIZE.
      throw new ZcashCodecError("compactSize value out of range");
    }
    if (value > max) throw new ZcashCodecError("compactSize value out of range");
    return value;
  }

  assertEnd(): void {
    if (this.remaining !== 0) throw new ZcashCodecError("Unexpected trailing bytes");
  }

  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new ZcashCodecError("Unexpected end of data");
    }
  }
}
