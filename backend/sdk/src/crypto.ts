/** WebCrypto helpers that run unchanged on Node ≥ 20, browsers and edge runtimes. */

const encoder = new TextEncoder();

type WebCrypto = typeof globalThis.crypto;

function webCrypto(): WebCrypto {
  const c = globalThis.crypto as WebCrypto | undefined;
  if (c === undefined || c.subtle === undefined) {
    throw new Error(
      "shade-zcash-sdk needs WebCrypto (globalThis.crypto.subtle), available in Node 20+ and modern runtimes",
    );
  }
  return c;
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** HMAC-SHA256 keyed with the UTF-8 bytes of `secret`. */
export async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const { subtle } = webCrypto();
  const key = await subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", key, concatBytes(data)));
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Decodes an even-length hex string (either case); null when it is not hex. */
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Compares without an early exit, so timing does not reveal how many leading bytes matched. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** RFC 9562 v4 UUID. `crypto.randomUUID` needs a secure context in browsers, so fall back to getRandomValues. */
export function randomUuid(): string {
  const c = webCrypto();
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
