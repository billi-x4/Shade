import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { ZcashCodecError } from "../../src/zcash/bytes.ts";
import {
  F4JUMBLE_MAX_LENGTH,
  F4JUMBLE_MIN_LENGTH,
  f4jumble,
  f4jumbleInv,
} from "../../src/zcash/f4jumble.ts";
import { hex, loadVectors } from "./fixtures.ts";

describe("F4Jumble (zcash-test-vectors f4jumble.json)", () => {
  const vectors = loadVectors("f4jumble.json");

  it("has the official vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
  });

  it.each(vectors.map((v, i) => [i, v] as const))(
    "vector %i jumbles and unjumbles",
    (_i, vector) => {
      const normal = hex(String(vector.normal));
      const jumbled = hex(String(vector.jumbled));
      expect(Buffer.from(f4jumble(normal)).toString("hex")).toBe(vector.jumbled);
      expect(Buffer.from(f4jumbleInv(jumbled)).toString("hex")).toBe(vector.normal);
    },
  );

  it.each(
    loadVectors("f4jumble_long.json").map(
      (v) => [Number(v.length), String(v.jumbled_hash)] as const,
    ),
  )("long vector of %i bytes (f4jumble_long.json)", (length, jumbledHash) => {
    const message = new Uint8Array(length);
    for (let i = 0; i < length; i++) message[i] = i & 0xff;
    const jumbled = f4jumble(message);
    expect(Buffer.from(blake2b(jumbled)).toString("hex")).toBe(jumbledHash);
    expect(Buffer.from(f4jumbleInv(jumbled)).equals(Buffer.from(message))).toBe(true);
  });

  it("rejects lengths outside 38..4194368", () => {
    expect(() => f4jumble(new Uint8Array(F4JUMBLE_MIN_LENGTH - 1))).toThrow(ZcashCodecError);
    expect(() => f4jumbleInv(new Uint8Array(F4JUMBLE_MIN_LENGTH - 1))).toThrow(ZcashCodecError);
    expect(() => f4jumble(new Uint8Array(F4JUMBLE_MAX_LENGTH + 1))).toThrow(ZcashCodecError);
    expect(f4jumble(new Uint8Array(F4JUMBLE_MIN_LENGTH))).toHaveLength(F4JUMBLE_MIN_LENGTH);
  });

  it("does not mutate its input", () => {
    const input = new Uint8Array(48).fill(7);
    f4jumble(input);
    f4jumbleInv(input);
    expect(input.every((b) => b === 7)).toBe(true);
  });
});
