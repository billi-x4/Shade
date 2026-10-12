import { hmacSha256Hex } from "./crypto.ts";

export interface WebhookSignatureHeaders {
  /** PRD §9: `sha256=<hex HMAC-SHA256(utf8(secret), raw_body)>`. */
  "X-Shade-Signature": string;
  /** `t=<unix s of this attempt>,v1=<hex HMAC-SHA256(utf8(secret), t + "." + raw_body)>`. */
  "X-Shade-Signature-V2": string;
}

/**
 * Signs the exact bytes that are sent. The key is the UTF-8 encoding of the full `whsec_…` string.
 * `nowSec` is the time of this attempt, so every retry carries a fresh, replay-bounded V2 signature.
 */
export function signWebhook(
  secret: string,
  rawBody: string,
  nowSec: number,
): WebhookSignatureHeaders {
  if (!Number.isSafeInteger(nowSec) || nowSec < 0) {
    throw new RangeError("nowSec must be a non-negative integer number of seconds");
  }
  return {
    "X-Shade-Signature": `sha256=${hmacSha256Hex(secret, rawBody)}`,
    "X-Shade-Signature-V2": `t=${nowSec},v1=${hmacSha256Hex(secret, `${nowSec}.${rawBody}`)}`,
  };
}
