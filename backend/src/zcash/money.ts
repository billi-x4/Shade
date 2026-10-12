/** ZEC amounts. Shade computes in integer zatoshis (bigint) and formats canonically at the edges. */

export const ZAT_PER_ZEC = 100_000_000n;
/** Protocol MAX_MONEY (protocol spec §5.3). */
export const MAX_MONEY_ZAT = 21_000_000n * ZAT_PER_ZEC;

// No sign, no leading zeros, no exponent, at most 8 decimals ("5.", ".5" and "05" are rejected).
const ZEC_PATTERN = /^(0|[1-9]\d{0,7})(?:\.(\d{1,8}))?$/;
// Postgres numeric text: digits with an optional fraction of any scale.
const NUMERIC_PATTERN = /^(\d+)(?:\.(\d+))?$/;

function toZat(whole: string, fraction: string): bigint {
  return BigInt(whole) * ZAT_PER_ZEC + BigInt(fraction.padEnd(8, "0"));
}

/**
 * Parses a decimal ZEC string from an API caller. Returns null when malformed, above MAX_MONEY,
 * or zero (unless `allowZero`).
 */
export function parseZec(input: string, opts: { allowZero?: boolean } = {}): bigint | null {
  if (typeof input !== "string") return null;
  const match = ZEC_PATTERN.exec(input);
  if (!match) return null;
  const zat = toZat(match[1]!, match[2] ?? "");
  if (zat > MAX_MONEY_ZAT) return null;
  if (zat === 0n && opts.allowZero !== true) return null;
  return zat;
}

/** Canonical decimal ZEC (no trailing zeros, no trailing point). Valid as a ZIP-321 amount. */
export function formatZat(zat: bigint): string {
  if (typeof zat !== "bigint") throw new TypeError("formatZat expects a bigint");
  if (zat < 0n || zat > MAX_MONEY_ZAT) throw new RangeError("Zatoshi amount out of range");
  const whole = zat / ZAT_PER_ZEC;
  const fraction = zat % ZAT_PER_ZEC;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

/** Converts Postgres numeric(20,8) text (e.g. "0.01000000") to zatoshis. Throws RangeError. */
export function zatFromNumeric(text: string): bigint {
  if (typeof text !== "string") throw new TypeError("zatFromNumeric expects a string");
  const match = NUMERIC_PATTERN.exec(text);
  if (!match) throw new RangeError("Not a non-negative decimal amount");
  const fraction = match[2] ?? "";
  if (/[^0]/.test(fraction.slice(8))) throw new RangeError("Amount has more than 8 decimal places");
  return toZat(match[1]!, fraction.slice(0, 8));
}
