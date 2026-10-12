import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DecryptError,
  SealError,
  decodeBase64Key,
  decryptSecret,
  encryptSecret,
  fingerprint,
  generateSealKeyPair,
  hmacSha256Hex,
  newId,
  openSealed,
  randomToken,
  sealKid,
  sealPublicKeyFromPrivate,
  sealTo,
  sha256Hex,
  timingSafeEqualStr,
  viewingKeySealContext,
} from "../../src/platform/crypto.ts";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(8);

function flipChar(text: string, index: number): string {
  const char = text[index] === "A" ? "B" : "A";
  return `${text.slice(0, index)}${char}${text.slice(index + 1)}`;
}

describe("random values and hashes", () => {
  it("makes base64url tokens and prefixed ids", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(12)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newId("inv")).toMatch(/^inv_[A-Za-z0-9_-]{16}$/);
    expect(newId("inv")).not.toBe(newId("inv"));
  });

  it("hashes like node:crypto", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).toBe(
      createHash("sha256")
        .update(Buffer.from([1, 2, 3]))
        .digest("hex"),
    );
    expect(hmacSha256Hex("key", "data")).toBe(
      createHmac("sha256", "key").update("data").digest("hex"),
    );
    expect(fingerprint("uviewtest1secret")).toBe(sha256Hex("uviewtest1secret").slice(0, 16));
  });

  it("compares strings in constant time", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });

  it("decodes 32-byte base64 keys strictly", () => {
    const raw = new Uint8Array(32).map((_, i) => i);
    expect(decodeBase64Key(Buffer.from(raw).toString("base64"))).toEqual(raw);
    expect(decodeBase64Key(Buffer.from(raw).toString("base64url"))).toEqual(raw);
    expect(decodeBase64Key(Buffer.from(raw.slice(0, 31)).toString("base64"))).toBeNull();
    expect(decodeBase64Key("not base64!")).toBeNull();
    expect(decodeBase64Key("")).toBeNull();
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips with the envelope format", () => {
    const sealed = encryptSecret(KEY, "whsec_abc", "whsec|we_1");
    expect(sealed).toMatch(/^enc:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(decryptSecret(KEY, sealed, "whsec|we_1")).toBe("whsec_abc");
  });

  it("uses a fresh IV per call", () => {
    expect(encryptSecret(KEY, "same", "aad")).not.toBe(encryptSecret(KEY, "same", "aad"));
  });

  it("rejects the wrong AAD, the wrong key and any tampering", () => {
    const sealed = encryptSecret(KEY, "whsec_abc", "whsec|we_1");
    expect(() => decryptSecret(KEY, sealed, "whsec|we_2")).toThrow(DecryptError);
    expect(() => decryptSecret(OTHER_KEY, sealed, "whsec|we_1")).toThrow(DecryptError);
    const [prefix, version, iv, body] = sealed.split(":") as [string, string, string, string];
    const tamperedBody = [prefix, version, iv, flipChar(body, 2)].join(":");
    const tamperedIv = [prefix, version, flipChar(iv, 1), body].join(":");
    expect(() => decryptSecret(KEY, tamperedBody, "whsec|we_1")).toThrow(DecryptError);
    expect(() => decryptSecret(KEY, tamperedIv, "whsec|we_1")).toThrow(DecryptError);
    expect(() => decryptSecret(KEY, "enc:v2:abc:def", "whsec|we_1")).toThrow(DecryptError);
    expect(() => decryptSecret(KEY, "garbage", "whsec|we_1")).toThrow(DecryptError);
  });

  it("refuses keys that are not 32 bytes", () => {
    expect(() => encryptSecret(new Uint8Array(16), "x", "aad")).toThrow(RangeError);
  });
});

describe("viewing key seal", () => {
  const context = viewingKeySealContext("m_1", "testnet");

  it("round-trips and binds the envelope to the worker key id", () => {
    const pair = generateSealKeyPair();
    expect(pair.publicKey).toHaveLength(32);
    expect(pair.privateKey).toHaveLength(32);
    expect(sealPublicKeyFromPrivate(pair.privateKey)).toEqual(pair.publicKey);

    const sealed = sealTo(pair.publicKey, "uviewtest1example", context);
    const parts = sealed.split(".");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("vk1");
    expect(parts[1]).toBe(sealKid(pair.publicKey));
    expect(parts[1]).toBe(sha256Hex(pair.publicKey).slice(0, 16));
    expect(Buffer.from(parts[2] ?? "", "base64url")).toHaveLength(32);
    expect(Buffer.from(parts[3] ?? "", "base64url")).toHaveLength(12);
    expect(openSealed([pair.privateKey], sealed, context)).toBe("uviewtest1example");
  });

  it("uses a fresh ephemeral key and nonce every time", () => {
    const pair = generateSealKeyPair();
    const a = sealTo(pair.publicKey, "same", context).split(".");
    const b = sealTo(pair.publicKey, "same", context).split(".");
    expect(a[2]).not.toBe(b[2]);
    expect(a[3]).not.toBe(b[3]);
  });

  it("selects the private key by kid from a rotation list", () => {
    const old = generateSealKeyPair();
    const current = generateSealKeyPair();
    const sealedOld = sealTo(old.publicKey, "old key", context);
    const sealedNew = sealTo(current.publicKey, "new key", context);
    const rotation = [current.privateKey, old.privateKey];
    expect(openSealed(rotation, sealedOld, context)).toBe("old key");
    expect(openSealed(rotation, sealedNew, context)).toBe("new key");
  });

  it("reports an unknown kid distinctly", () => {
    const pair = generateSealKeyPair();
    const sealed = sealTo(pair.publicKey, "x", context);
    const error = (() => {
      try {
        openSealed([generateSealKeyPair().privateKey], sealed, context);
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(SealError);
    expect((error as SealError).code).toBe("unknown_kid");
  });

  it("fails on an AAD mismatch (other merchant or network) and on tampering", () => {
    const pair = generateSealKeyPair();
    const sealed = sealTo(pair.publicKey, "uviewtest1example", context);
    const expectCode = (fn: () => unknown, code: string) => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(SealError);
        expect((err as SealError).code).toBe(code);
        return;
      }
      throw new Error("expected openSealed to throw");
    };
    expectCode(
      () => openSealed([pair.privateKey], sealed, viewingKeySealContext("m_2", "testnet")),
      "decrypt_failed",
    );
    expectCode(
      () => openSealed([pair.privateKey], sealed, viewingKeySealContext("m_1", "mainnet")),
      "decrypt_failed",
    );
    const parts = sealed.split(".");
    const tamperedCt = [...parts.slice(0, 4), flipChar(parts[4] ?? "", 3)].join(".");
    expectCode(() => openSealed([pair.privateKey], tamperedCt, context), "decrypt_failed");
    const otherEphemeral = Buffer.from(generateSealKeyPair().publicKey).toString("base64url");
    const swappedKey = [parts[0], parts[1], otherEphemeral, parts[3], parts[4]].join(".");
    expectCode(() => openSealed([pair.privateKey], swappedKey, context), "decrypt_failed");
    expectCode(() => openSealed([pair.privateKey], "vk2.x.y.z.w", context), "malformed");
    expectCode(
      () => openSealed([pair.privateKey], parts.slice(0, 4).join("."), context),
      "malformed",
    );
  });

  it("rejects a low-order (all-zero shared secret) ephemeral key", () => {
    const pair = generateSealKeyPair();
    const parts = sealTo(pair.publicKey, "x", context).split(".");
    const zeroPoint = Buffer.alloc(32).toString("base64url");
    const forged = [parts[0], parts[1], zeroPoint, parts[3], parts[4]].join(".");
    expect(() => openSealed([pair.privateKey], forged, context)).toThrow(SealError);
  });
});
