/**
 * Webhook signature verification. Each delivery attempt carries
 *   X-Shade-Signature:    sha256=<hex HMAC-SHA256(secret, raw_body)>                (PRD §9)
 *   X-Shade-Signature-V2: t=<unix s of this attempt>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>
 * keyed with the UTF-8 bytes of the full "whsec_…" secret. V2 is required: its signature, then |now − t| ≤
 * tolerance. Shade sends it on every attempt, so a delivery without it is a replay with the header stripped
 * (the body-only signature never expires). `allowLegacySignature` accepts the body-only signature when V2 is
 * absent, for receivers behind a proxy that drops it; they must dedupe by event id.
 */
import { concatBytes, fromHex, hmacSha256, timingSafeEqual, toHex, utf8 } from "./crypto.ts";
import { mapWebhookEvent } from "./mappers.ts";
import type { ShadeEvent } from "./types.ts";
import type { WireWebhookEvent } from "./wire.ts";

const SIGNATURE_HEADER = "x-shade-signature";
const SIGNATURE_V2_HEADER = "x-shade-signature-v2";
const DEFAULT_TOLERANCE_SEC = 300;

export type WebhookVerificationReason =
  | "missing_signature"
  | "malformed_signature"
  | "signature_mismatch"
  | "timestamp_out_of_tolerance"
  | "invalid_payload";

export class WebhookVerificationError extends Error {
  readonly reason: WebhookVerificationReason;

  constructor(reason: WebhookVerificationReason, message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    this.reason = reason;
  }
}

/** Fetch `Headers`, or a plain object such as Node's `IncomingMessage.headers` (any key case). */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookOptions {
  /** Maximum |now − t| in seconds for X-Shade-Signature-V2. Default 300. */
  toleranceSec?: number;
  /** Current time in milliseconds. Default Date.now. */
  now?: () => number;
  /**
   * Accept the body-only X-Shade-Signature when X-Shade-Signature-V2 is absent. Default false: that
   * signature has no timestamp, so a captured delivery would verify forever.
   */
  allowLegacySignature?: boolean;
}

export interface WebhookSignatureHeaders {
  "X-Shade-Signature": string;
  "X-Shade-Signature-V2": string;
}

/**
 * Verifies a delivery and returns the camelCase event. Pass the raw request body exactly as received:
 * re-serialized JSON will not match. Throws WebhookVerificationError (answer 400) on any failure.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  opts: VerifyWebhookOptions = {},
): Promise<ShadeEvent> {
  checkSecret(secret);
  const body = bodyBytes(rawBody);
  const toleranceSec = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (!Number.isFinite(toleranceSec) || toleranceSec < 0) {
    throw new TypeError("verifyWebhook: toleranceSec must be a non-negative number");
  }

  const v2 = readHeader(headers, SIGNATURE_V2_HEADER);
  if (v2 !== null) {
    const { t, timestamp, signatures } = parseV2(v2);
    const expected = await hmacSha256(secret, concatBytes(utf8(`${t}.`), body));
    if (!signatures.some((sig) => timingSafeEqual(sig, expected))) {
      throw new WebhookVerificationError(
        "signature_mismatch",
        "X-Shade-Signature-V2 does not match",
      );
    }
    const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
    if (Math.abs(nowSec - timestamp) > toleranceSec) {
      throw new WebhookVerificationError(
        "timestamp_out_of_tolerance",
        `X-Shade-Signature-V2 timestamp is more than ${toleranceSec} s from now`,
      );
    }
  } else {
    if (!opts.allowLegacySignature) {
      throw new WebhookVerificationError(
        "missing_signature",
        "No X-Shade-Signature-V2 header (Shade sends it on every delivery)",
      );
    }
    const legacy = readHeader(headers, SIGNATURE_HEADER);
    if (legacy === null) {
      throw new WebhookVerificationError(
        "missing_signature",
        "No X-Shade-Signature-V2 or X-Shade-Signature header",
      );
    }
    const signature = parseLegacy(legacy);
    const expected = await hmacSha256(secret, body);
    if (!timingSafeEqual(signature, expected)) {
      throw new WebhookVerificationError("signature_mismatch", "X-Shade-Signature does not match");
    }
  }

  return parseEvent(body);
}

/** Computes both signature headers exactly as Shade sends them, e.g. to test a receiver. */
export async function signWebhook(
  secret: string,
  rawBody: string | Uint8Array,
  timestampSec: number,
): Promise<WebhookSignatureHeaders> {
  checkSecret(secret);
  if (!Number.isSafeInteger(timestampSec) || timestampSec < 0) {
    throw new TypeError("signWebhook: timestampSec must be a non-negative integer (unix seconds)");
  }
  const body = bodyBytes(rawBody);
  const legacy = await hmacSha256(secret, body);
  const v1 = await hmacSha256(secret, concatBytes(utf8(`${timestampSec}.`), body));
  return {
    "X-Shade-Signature": `sha256=${toHex(legacy)}`,
    "X-Shade-Signature-V2": `t=${timestampSec},v1=${toHex(v1)}`,
  };
}

function checkSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret === "") {
    throw new TypeError(
      "Webhook secret is required (the whsec_… value shown when the endpoint was created)",
    );
  }
}

function bodyBytes(rawBody: unknown): Uint8Array {
  if (typeof rawBody === "string") return utf8(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  throw new TypeError(
    "rawBody must be the raw request body as a string or Uint8Array, not parsed JSON",
  );
}

/** Case-insensitive lookup. Repeated values are joined with "," (as fetch Headers does), which then fails parsing. */
function readHeader(headers: WebhookHeaders, name: string): string | null {
  let value: string | string[] | null | undefined;
  if (typeof (headers as Headers).get === "function") {
    value = (headers as Headers).get(name);
  } else {
    const record = headers as Record<string, string | string[] | undefined>;
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() === name) {
        value = record[key];
        break;
      }
    }
  }
  if (value === null || value === undefined) return null;
  const joined = (Array.isArray(value) ? value.join(",") : value).trim();
  return joined === "" ? null : joined;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** `t` is kept verbatim: the signed string is the header's t, not a re-formatted number. */
function parseV2(header: string): { t: string; timestamp: number; signatures: Uint8Array[] } {
  const timestamps: string[] = [];
  const signatures: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) throw malformed("X-Shade-Signature-V2");
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      timestamps.push(value);
    } else if (key === "v1") {
      if (!HEX_SHA256.test(value)) throw malformed("X-Shade-Signature-V2");
      signatures.push(fromHex(value)!);
    }
    // Other keys are future signature schemes; they are ignored rather than rejected.
  }
  const t = timestamps.length === 1 ? timestamps[0]! : "";
  if (!/^\d{1,15}$/.test(t) || signatures.length === 0) throw malformed("X-Shade-Signature-V2");
  return { t, timestamp: Number(t), signatures };
}

function parseLegacy(header: string): Uint8Array {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (match === null) throw malformed("X-Shade-Signature");
  return fromHex(match[1]!)!;
}

function malformed(header: string): WebhookVerificationError {
  return new WebhookVerificationError("malformed_signature", `${header} is malformed`);
}

function parseEvent(body: Uint8Array): ShadeEvent {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebhookVerificationError("invalid_payload", "Webhook body is not UTF-8 JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new WebhookVerificationError("invalid_payload", "Webhook body is not a Shade event");
  }
  const event = data as Partial<WireWebhookEvent>;
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.created_at !== "string" ||
    typeof event.network !== "string"
  ) {
    throw new WebhookVerificationError("invalid_payload", "Webhook body is not a Shade event");
  }
  return mapWebhookEvent({
    id: event.id,
    type: event.type,
    created_at: event.created_at,
    network: event.network,
    invoice_id: event.invoice_id ?? null,
    amount_zec: event.amount_zec ?? null,
    memo_hash: event.memo_hash ?? null,
    txid: event.txid ?? null,
    paid_at: event.paid_at ?? null,
    verification: event.verification ?? null,
  });
}
