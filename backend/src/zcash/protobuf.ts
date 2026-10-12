/**
 * Minimal protobuf (proto3) codec for the few lightwalletd messages Shade uses. Decoding keeps
 * the last occurrence of each scalar field (proto3 semantics), every occurrence of each
 * length-delimited field (for repeated messages), and skips unknown fields.
 */
import { ZcashCodecError, concatBytes } from "./bytes.ts";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;
const UINT64_MAX = (1n << 64n) - 1n;

function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n || value > UINT64_MAX) throw new RangeError("varint out of range");
  const out: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    out.push(byte);
  } while (rest > 0n);
  return Uint8Array.from(out);
}

function fieldKey(field: number, wireType: number): Uint8Array {
  return encodeVarint(BigInt(field) * 8n + BigInt(wireType));
}

export function encodeUint64Field(field: number, value: number | bigint): Uint8Array {
  return concatBytes([fieldKey(field, WIRE_VARINT), encodeVarint(BigInt(value))]);
}

export function encodeBytesField(field: number, value: Uint8Array): Uint8Array {
  return concatBytes([fieldKey(field, WIRE_BYTES), encodeVarint(BigInt(value.length)), value]);
}

/** Decoded message: scalar varints and length-delimited fields by field number. */
export class ProtoMessage {
  readonly #varints = new Map<number, bigint>();
  readonly #bytes = new Map<number, Uint8Array>();
  readonly #repeated = new Map<number, Uint8Array[]>();

  constructor(buf: Uint8Array) {
    let pos = 0;
    const varint = (): bigint => {
      let result = 0n;
      for (let shift = 0n; shift < 70n; shift += 7n) {
        if (pos >= buf.length) throw new ZcashCodecError("Truncated protobuf varint");
        const byte = buf[pos++]!;
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
          if (result > UINT64_MAX) throw new ZcashCodecError("Protobuf varint overflow");
          return result;
        }
      }
      throw new ZcashCodecError("Protobuf varint too long");
    };
    const skip = (length: number): number => {
      if (length > buf.length - pos) throw new ZcashCodecError("Truncated protobuf field");
      const start = pos;
      pos += length;
      return start;
    };
    while (pos < buf.length) {
      const key = varint();
      const field = Number(key >> 3n);
      const wireType = Number(key & 7n);
      if (field < 1) throw new ZcashCodecError("Invalid protobuf field number");
      if (wireType === WIRE_VARINT) {
        this.#varints.set(field, varint());
      } else if (wireType === WIRE_BYTES) {
        const length = varint();
        if (length > BigInt(buf.length - pos))
          throw new ZcashCodecError("Truncated protobuf field");
        const start = skip(Number(length));
        const value = buf.subarray(start, pos);
        this.#bytes.set(field, value);
        const all = this.#repeated.get(field);
        if (all) all.push(value);
        else this.#repeated.set(field, [value]);
      } else if (wireType === WIRE_FIXED64) {
        skip(8);
      } else if (wireType === WIRE_FIXED32) {
        skip(4);
      } else {
        throw new ZcashCodecError("Unsupported protobuf wire type");
      }
    }
  }

  uint64(field: number): bigint {
    return this.#varints.get(field) ?? 0n;
  }

  bytes(field: number): Uint8Array {
    return this.#bytes.get(field) ?? new Uint8Array(0);
  }

  /** Every occurrence of a length-delimited field in wire order (a `repeated` message field). */
  repeatedBytes(field: number): Uint8Array[] {
    return [...(this.#repeated.get(field) ?? [])];
  }

  string(field: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(field));
  }
}
