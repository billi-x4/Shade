import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Network } from "../contract/index.ts";

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const SECRET_PREFIX = "enc:v1:";
const SEAL_VERSION = "vk1";
const SEAL_HKDF_INFO = "shade-vk-seal-v1";
const SEAL_AAD_PREFIX = "shade-vk-v1";
// DER headers for raw 32-byte X25519 keys (RFC 8410 SubjectPublicKeyInfo / PKCS#8).
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Random bytes as base64url (no padding). 32 bytes by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** `${prefix}_${base64url(12 random bytes)}` — 96 bits, URL-safe. */
export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** Constant-time string equality (compares SHA-256 digests, so lengths do not leak). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** First 16 hex chars of SHA-256: a short, non-secret label for a secret. */
export function fingerprint(secret: string): string {
  return sha256Hex(secret).slice(0, 16);
}

/**
 * Decodes a base64 (standard or URL alphabet, optional padding) key of exactly `length` bytes.
 * Returns null for anything else, so config errors never echo the value.
 */
export function decodeBase64Key(text: string, length = KEY_BYTES): Uint8Array | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, "base64");
  return bytes.length === length ? new Uint8Array(bytes) : null;
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Raised when a ciphertext or sealed envelope cannot be opened. Messages never include data. */
export class DecryptError extends Error {
  constructor(message = "ciphertext could not be decrypted") {
    super(message);
    this.name = "DecryptError";
  }
}

export type SealErrorCode = "malformed" | "unknown_kid" | "decrypt_failed";

export class SealError extends Error {
  readonly code: SealErrorCode;

  constructor(code: SealErrorCode, message: string) {
    super(message);
    this.name = "SealError";
    this.code = code;
  }
}

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new RangeError("AES-256-GCM key must be 32 bytes");
}

function decodeBase64Url(text: string): Buffer | null {
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  // Reject non-canonical encodings (stray trailing bits) so one ciphertext has one spelling.
  return bytes.toString("base64url") === text ? bytes : null;
}

function gcmSeal(key: Uint8Array, iv: Uint8Array, plaintext: string, aad: string): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/** Returns null when authentication fails. */
function gcmOpen(key: Uint8Array, iv: Uint8Array, sealed: Buffer, aad: string): string | null {
  if (sealed.length < GCM_TAG_BYTES) return null;
  const body = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
  const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * AES-256-GCM with a random 96-bit IV. Output: `enc:v1:<b64url iv>:<b64url ct‖tag>`.
 * `aad` binds the ciphertext to its row (e.g. `whsec|<endpoint_id>`) so it cannot be swapped.
 */
export function encryptSecret(key: Uint8Array, plaintext: string, aad: string): string {
  assertKeyLength(key);
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = gcmSeal(key, iv, plaintext, aad);
  return `${SECRET_PREFIX}${iv.toString("base64url")}:${sealed.toString("base64url")}`;
}

/** Inverse of {@link encryptSecret}. Throws {@link DecryptError} on any tampering or wrong key/AAD. */
export function decryptSecret(key: Uint8Array, ciphertext: string, aad: string): string {
  assertKeyLength(key);
  if (!ciphertext.startsWith(SECRET_PREFIX)) throw new DecryptError();
  const parts = ciphertext.slice(SECRET_PREFIX.length).split(":");
  if (parts.length !== 2) throw new DecryptError();
  const iv = decodeBase64Url(parts[0] ?? "");
  const sealed = decodeBase64Url(parts[1] ?? "");
  if (!iv || iv.length !== GCM_IV_BYTES || !sealed) throw new DecryptError();
  const plaintext = gcmOpen(key, iv, sealed, aad);
  if (plaintext === null) throw new DecryptError();
  return plaintext;
}

function x25519PublicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new RangeError("X25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function x25519PrivateKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new RangeError("X25519 private key must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function rawKeyBytes(der: Buffer): Uint8Array {
  return new Uint8Array(der.subarray(der.length - KEY_BYTES));
}

export function generateSealKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: rawKeyBytes(pair.publicKey.export({ format: "der", type: "spki" })),
    privateKey: rawKeyBytes(pair.privateKey.export({ format: "der", type: "pkcs8" })),
  };
}

/** The raw X25519 public key for a raw private key. */
export function sealPublicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  const pub = createPublicKey(x25519PrivateKeyObject(privateKey));
  return rawKeyBytes(pub.export({ format: "der", type: "spki" }));
}

/** Key id of a worker seal key: first 16 hex chars of SHA-256(raw public key). */
export function sealKid(publicKey: Uint8Array): string {
  return sha256Hex(publicKey).slice(0, 16);
}

/** The context a viewing-key seal is bound to; pass it as `aad` to {@link sealTo}/{@link openSealed}. */
export function viewingKeySealContext(merchantId: string, network: Network): string {
  return `${merchantId}|${network}`;
}

function sealAad(kid: string, context: string): string {
  return `${SEAL_AAD_PREFIX}|${kid}|${context}`;
}

function deriveSealKey(
  privateKey: KeyObject,
  peerPublicKey: KeyObject,
  ephemeralPublic: Uint8Array,
  workerPublic: Uint8Array,
): Buffer {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey: peerPublicKey });
  } catch {
    throw new SealError("malformed", "sealed key has an invalid ephemeral public key");
  }
  if (shared.every((byte) => byte === 0)) {
    throw new SealError("malformed", "sealed key has a low-order ephemeral public key");
  }
  const salt = Buffer.concat([ephemeralPublic, workerPublic]);
  return Buffer.from(hkdfSync("sha256", shared, salt, SEAL_HKDF_INFO, KEY_BYTES));
}

/**
 * Seals `plaintext` to a worker X25519 public key (ephemeral-static ECDH + HKDF-SHA256 + AES-256-GCM).
 * Envelope: `vk1.<kid>.<b64url eph_pub>.<b64url nonce>.<b64url ct‖tag>`; the GCM AAD is
 * `shade-vk-v1|<kid>|<aad>` where `aad` is {@link viewingKeySealContext}.
 */
export function sealTo(publicKey: Uint8Array, plaintext: string, aad: string): string {
  const workerPublic = x25519PublicKeyObject(publicKey);
  const kid = sealKid(publicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublic = rawKeyBytes(ephemeral.publicKey.export({ format: "der", type: "spki" }));
  const key = deriveSealKey(ephemeral.privateKey, workerPublic, ephemeralPublic, publicKey);
  const nonce = randomBytes(GCM_IV_BYTES);
  const sealed = gcmSeal(key, nonce, plaintext, sealAad(kid, aad));
  return [
    SEAL_VERSION,
    kid,
    Buffer.from(ephemeralPublic).toString("base64url"),
    nonce.toString("base64url"),
    sealed.toString("base64url"),
  ].join(".");
}

/**
 * Opens a {@link sealTo} envelope with whichever private key matches its kid (rotation list).
 * Throws {@link SealError}: `unknown_kid` when no key matches, `malformed` / `decrypt_failed` otherwise.
 */
export function openSealed(privateKeys: Uint8Array[], sealed: string, aad: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== SEAL_VERSION) {
    throw new SealError("malformed", "sealed key has an unknown format");
  }
  const kid = parts[1] ?? "";
  const ephemeralPublic = decodeBase64Url(parts[2] ?? "");
  const nonce = decodeBase64Url(parts[3] ?? "");
  const body = decodeBase64Url(parts[4] ?? "");
  if (
    !/^[0-9a-f]{16}$/.test(kid) ||
    !ephemeralPublic ||
    ephemeralPublic.length !== KEY_BYTES ||
    !nonce ||
    nonce.length !== GCM_IV_BYTES ||
    !body ||
    body.length < GCM_TAG_BYTES
  ) {
    throw new SealError("malformed", "sealed key has an unknown format");
  }

  for (const privateKey of privateKeys) {
    const workerPublic = sealPublicKeyFromPrivate(privateKey);
    if (sealKid(workerPublic) !== kid) continue;
    const key = deriveSealKey(
      x25519PrivateKeyObject(privateKey),
      x25519PublicKeyObject(ephemeralPublic),
      ephemeralPublic,
      workerPublic,
    );
    const plaintext = gcmOpen(key, nonce, body, sealAad(kid, aad));
    if (plaintext === null) throw new SealError("decrypt_failed", "sealed key could not be opened");
    return plaintext;
  }
  throw new SealError("unknown_kid", "no private key matches the sealed key id");
}
