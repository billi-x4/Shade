/** F4Jumble (ZIP-316 §Jumbling): a 4-round unkeyed Feistel permutation over BLAKE2b. */
import { blake2b } from "@noble/hashes/blake2.js";
import { ZcashCodecError } from "./bytes.ts";

const HASH_LENGTH = 64;
export const F4JUMBLE_MIN_LENGTH = 38;
export const F4JUMBLE_MAX_LENGTH = (2 ** 16 + 1) * HASH_LENGTH;

function personalization(
  tag: "UA_F4Jumble_H" | "UA_F4Jumble_G",
  tail: readonly number[],
): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < tag.length; i++) out[i] = tag.charCodeAt(i);
  out.set(tail, tag.length);
  return out;
}

/** H_i(u): BLAKE2b with an `outLength`-byte digest (a parameter-block length, not a truncation). */
function hashH(round: number, input: Uint8Array, outLength: number): Uint8Array {
  return blake2b(input, {
    dkLen: outLength,
    personalization: personalization("UA_F4Jumble_H", [round, 0, 0]),
  });
}

/** G_i(u): the first `outLength` bytes of BLAKE2b-512(pers ‖ [i] ‖ LE16(j), u) for j = 0, 1, … */
function hashG(round: number, input: Uint8Array, outLength: number): Uint8Array {
  const out = new Uint8Array(outLength);
  for (let j = 0, offset = 0; offset < outLength; j++, offset += HASH_LENGTH) {
    const block = blake2b(input, {
      dkLen: HASH_LENGTH,
      personalization: personalization("UA_F4Jumble_G", [round, j & 0xff, j >>> 8]),
    });
    out.set(block.subarray(0, Math.min(HASH_LENGTH, outLength - offset)), offset);
  }
  return out;
}

function xorInto(target: Uint8Array, mask: Uint8Array): Uint8Array {
  for (let i = 0; i < target.length; i++) target[i] = target[i]! ^ mask[i]!;
  return target;
}

function split(message: Uint8Array): [Uint8Array, Uint8Array] {
  if (message.length < F4JUMBLE_MIN_LENGTH || message.length > F4JUMBLE_MAX_LENGTH) {
    throw new ZcashCodecError("Invalid unified encoding length");
  }
  const leftLength = Math.min(HASH_LENGTH, Math.floor(message.length / 2));
  return [message.slice(0, leftLength), message.slice(leftLength)];
}

export function f4jumble(message: Uint8Array): Uint8Array {
  const [a, b] = split(message);
  const x = xorInto(b, hashG(0, a, b.length));
  const y = xorInto(a, hashH(0, x, a.length));
  const d = xorInto(x, hashG(1, y, x.length));
  const c = xorInto(y, hashH(1, d, y.length));
  const out = new Uint8Array(message.length);
  out.set(c);
  out.set(d, c.length);
  return out;
}

export function f4jumbleInv(jumbled: Uint8Array): Uint8Array {
  const [c, d] = split(jumbled);
  const y = xorInto(c, hashH(1, d, c.length));
  const x = xorInto(d, hashG(1, y, d.length));
  const a = xorInto(y, hashH(0, x, y.length));
  const b = xorInto(x, hashG(0, a, x.length));
  const out = new Uint8Array(jumbled.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
