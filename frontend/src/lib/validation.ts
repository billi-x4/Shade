/**
 * Client-side mirrors of the backend input rules. They exist to give fast, specific
 * feedback next to the field; the backend stays authoritative and its messages are shown as-is.
 */

const ZAT_PER_ZEC = 100_000_000n;
const MAX_ZAT = 21_000_000n * ZAT_PER_ZEC;
const AMOUNT_RE = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;

export const MERCHANT_MEMO_MAX_BYTES = 495;
export const LABEL_MAX = 48;
export const DISPLAY_NAME_MAX = 48;
/** Invoice labels and grant scopes (backend normalizeLabel). */
export const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** name.shade names (backend tags.ts TAG_PATTERN): no underscore, no hyphen at either end. */
export const TAG_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** Grant scope keyword: an invoice label with this value could never be shared on its own. */
export const RESERVED_LABEL = "all";
const TAG_NAME_SUFFIX = ".shade";

const TXID_RE = /^[0-9a-f]{64}$/;
// C0 and C1 control characters (includes newlines and tabs).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Zatoshis for a canonical ZEC string, or null when it is not a valid amount. */
export function zecToZat(raw: string): bigint | null {
  const match = AMOUNT_RE.exec(raw);
  if (!match) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? ".").slice(1).padEnd(8, "0");
  const zat = whole * ZAT_PER_ZEC + BigInt(fraction);
  return zat > MAX_ZAT ? null : zat;
}

/** Error message for an amount field, or null when it is valid. */
export function checkAmount(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter an amount in ZEC.";
  const zat = zecToZat(value);
  if (zat === null) return "Use a number like 0.01, with at most 8 decimals.";
  if (zat === 0n) return "The amount must be more than zero.";
  return null;
}

export function checkMemo(memo: string, maxBytes = MERCHANT_MEMO_MAX_BYTES): string | null {
  if (CONTROL_RE.test(memo)) return "Keep the memo on one line, without control characters.";
  if (LONE_SURROGATE_RE.test(memo)) return "The memo contains a broken character. Retype it.";
  if (utf8Bytes(memo) > maxBytes) return `Keep the memo under ${maxBytes + 1} bytes.`;
  return null;
}

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Invoice labels and grant scopes: lowercase letters, digits, - and _. name.shade names have a
 * stricter shape; use checkTagName for those.
 */
export function checkTag(raw: string, { required = false } = {}): string | null {
  const value = normalizeTag(raw);
  if (value === "") return required ? "Enter a name." : null;
  if (!TAG_RE.test(value)) {
    return "Use up to 32 lowercase letters, digits, - or _, starting with a letter or digit.";
  }
  return null;
}

/** True when an invoice label would collide with the grant scope keyword "all". */
export function isReservedLabel(raw: string): boolean {
  return normalizeTag(raw) === RESERVED_LABEL;
}

/** A name.shade name as the backend stores it: trimmed, lowercased, without a ".shade" suffix. */
export function normalizeTagName(raw: string): string {
  const value = raw.trim().toLowerCase();
  return value.endsWith(TAG_NAME_SUFFIX) ? value.slice(0, -TAG_NAME_SUFFIX.length) : value;
}

/** name.shade names: 1–32 lowercase letters, digits or hyphens, a letter or digit at each end. */
export function checkTagName(raw: string, { required = false } = {}): string | null {
  const value = normalizeTagName(raw);
  if (value === "") return required ? "Enter a name." : null;
  if (!TAG_NAME_RE.test(value)) {
    return "Use up to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.";
  }
  return null;
}

export function checkLabel(raw: string, max = LABEL_MAX): string | null {
  const value = raw.trim();
  if (value === "") return "Give it a short name.";
  if (value.length > max) return `Keep it under ${max + 1} characters.`;
  if (CONTROL_RE.test(value)) return "Keep it on one line.";
  return null;
}

/** Lowercase display-order txid, or null. */
export function normalizeTxid(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return TXID_RE.test(value) ? value : null;
}

export function checkWebhookUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter the URL of your endpoint.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, like https://shop.example/hooks/shade.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an https:// URL.";
  if (url.username || url.password) return "Remove the user name and password from the URL.";
  return null;
}

export function checkPassword(password: string, minLength: number): string | null {
  if (password.length < minLength) return `Use at least ${minLength} characters.`;
  if (password.length > 128) return "Use at most 128 characters.";
  return null;
}

const SEED_WORDS_RE = /^([a-z]+\s+){11,23}[a-z]+$/;

/**
 * Catches the dangerous mistakes before they reach the network: seed phrases, spending keys and
 * viewing keys pasted where an address belongs. Everything else is left to the backend.
 */
export function checkAddressInput(raw: string, network: "testnet" | "mainnet"): string | null {
  const value = raw.trim();
  if (value === "") return "Paste a Unified Address.";
  if (SEED_WORDS_RE.test(value.toLowerCase())) {
    return "That looks like a seed phrase. Never paste it anywhere. Copy the receive address instead.";
  }
  if (value.startsWith("secret-extended-key")) {
    return "That is a spending key. Never share it. Copy the receive address instead.";
  }
  if (/^(uview|uivk)/.test(value)) {
    return "That is a viewing key. Upload it under Detection; paste an address here.";
  }
  const prefix = network === "testnet" ? "utest1" : "u1";
  if (!value.startsWith(prefix)) {
    return network === "testnet"
      ? "A testnet Unified Address starts with utest1."
      : "A mainnet Unified Address starts with u1.";
  }
  return null;
}

export function checkUfvkInput(raw: string, network: "testnet" | "mainnet"): string | null {
  const value = raw.trim();
  if (value === "") return "Paste a full viewing key.";
  if (SEED_WORDS_RE.test(value.toLowerCase())) {
    return "That looks like a seed phrase. Never paste it anywhere. Export the viewing key instead.";
  }
  if (value.startsWith("secret-extended-key")) {
    return "That is a spending key. Never share it. Export the full viewing key instead.";
  }
  if (/^uivk/.test(value)) {
    return "Hosted detection needs a full viewing key (uview…), not an incoming viewing key.";
  }
  const prefix = network === "testnet" ? "uviewtest1" : "uview1";
  if (!value.startsWith(prefix)) return `A ${network} full viewing key starts with ${prefix}.`;
  return null;
}

/** Only same-app desk paths are allowed as post-login destinations (no open redirects). */
export function safeDeskRedirect(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith("/desk")) return null;
  if (raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}
