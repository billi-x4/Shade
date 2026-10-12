/**
 * Memos (ZIP-302) and Shade's on-chain memo reference.
 *
 * Every non-jar invoice carries a unique on-chain memo `<memo> (shade:<REF>)` (or `shade:<REF>`),
 * and matching compares `memoHash(chain_memo)`: SHA-256 over the exact 512-byte memo field a
 * wallet writes, so a scanner can hash what it decrypts without trusting text decoding.
 */
import { createHash, randomBytes } from "node:crypto";

export const MEMO_MAX_BYTES = 512;
/** 512 minus the 17-byte " (shade:XXXXXXXX)" suffix. */
export const MERCHANT_MEMO_MAX_BYTES = 495;

export type MemoCheck = { ok: true; bytes: number } | { ok: false; message: string };

const LONE_SURROGATE = /\p{Surrogate}/u;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MEMO_REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const utf8 = new TextEncoder();

/** C0 controls, DEL and C1 controls (line breaks and tabs included). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Validates memo text: well-formed Unicode, no control characters, at most `maxBytes` UTF-8
 * bytes (default MERCHANT_MEMO_MAX_BYTES; pass MEMO_MAX_BYTES for memos written without a ref).
 */
export function checkMemoText(memo: string, maxBytes: number = MERCHANT_MEMO_MAX_BYTES): MemoCheck {
  if (typeof memo !== "string") return { ok: false, message: "Memo must be text." };
  if (LONE_SURROGATE.test(memo)) {
    return { ok: false, message: "Memo contains characters that cannot be encoded." };
  }
  if (hasControlChar(memo)) {
    return { ok: false, message: "Memo cannot contain line breaks or control characters." };
  }
  const bytes = Buffer.byteLength(memo, "utf8");
  if (bytes > maxBytes) return { ok: false, message: `Memo must be ${maxBytes} bytes or fewer.` };
  return { ok: true, bytes };
}

/** 8 Crockford base32 characters carrying 40 random bits. */
export function newMemoRef(): string {
  const bits = randomBytes(5).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  let ref = "";
  for (let shift = 35n; shift >= 0n; shift -= 5n) ref += CROCKFORD[Number((bits >> shift) & 31n)];
  return ref;
}

/** The memo the payer's wallet writes on chain. `ref` null (jar charges) ⇒ the memo itself. */
export function chainMemo(memo: string, ref: string | null): string {
  if (ref === null) return memo;
  if (!MEMO_REF_PATTERN.test(ref)) throw new RangeError("Invalid memo reference");
  return memo === "" ? `shade:${ref}` : `${memo} (shade:${ref})`;
}

/** The ZIP-302 512-byte memo field: "" ⇒ 0xF6 ‖ 0×511 ("no memo"); text ⇒ UTF-8 ‖ zero padding. */
export function memoField(memo: string): Uint8Array {
  if (typeof memo !== "string" || LONE_SURROGATE.test(memo)) {
    throw new RangeError("Memo is not well-formed text");
  }
  const field = new Uint8Array(MEMO_MAX_BYTES);
  if (memo === "") {
    field[0] = 0xf6;
    return field;
  }
  const bytes = utf8.encode(memo);
  if (bytes.length > MEMO_MAX_BYTES) throw new RangeError("Memo exceeds 512 bytes");
  field.set(bytes);
  return field;
}

/** "sha256:" + hex(SHA-256(memoField(memo))). */
export function memoHash(memo: string): string {
  return `sha256:${createHash("sha256").update(memoField(memo)).digest("hex")}`;
}
