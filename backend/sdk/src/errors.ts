/** Error codes the Shade API returns (backend/src/contract/errors.ts). */
export type ShadeApiErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "FORBIDDEN_ORIGIN"
  | "EMAIL_UNVERIFIED"
  | "SESSION_NOT_FRESH"
  | "NETWORK_DISABLED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_MISMATCH"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "NO_ADDRESS"
  | "BAD_ADDRESS"
  | "BAD_AMOUNT"
  | "BAD_MEMO"
  | "BAD_TAG"
  | "BAD_EXPIRY"
  | "BAD_LABEL"
  | "BAD_SCOPE"
  | "BAD_DURATION"
  | "BAD_TXID"
  | "BAD_MEMO_HASH"
  | "BAD_POOL"
  | "BAD_URL"
  | "BAD_VIEWING_KEY"
  | "ADDRESS_MANAGED_BY_KEY"
  | "VIEWING_KEY_ADDRESS_MISMATCH"
  | "NOT_OPEN"
  | "PAYMENT_PENDING"
  | "ALREADY_PAID"
  | "EXPIRED"
  | "CANCELLED"
  | "TXID_IN_USE"
  | "TX_NOT_FOUND"
  | "TX_NOT_MINED"
  | "TX_NOT_SHIELDED"
  | "AMOUNT_MISMATCH"
  | "MEMO_MISMATCH"
  | "OUTSIDE_WINDOW"
  | "JAR_EMPTY"
  | "JAR_CLOSED"
  | "GRANT_REVOKED"
  | "GRANT_EXPIRED"
  | "TAG_TAKEN"
  | "TAG_LIMIT"
  | "INVOICE_LIMIT"
  | "JAR_LIMIT"
  | "GRANT_LIMIT"
  | "ENDPOINT_LIMIT"
  | "NO_ENDPOINTS"
  | "CHAIN_UNAVAILABLE"
  | "HOSTED_DETECTION_DISABLED"
  | "INTERNAL";

/**
 * Codes the SDK assigns itself (status 0 for the first three):
 * - TIMEOUT: no complete response within `timeoutMs`.
 * - NETWORK_ERROR: the request never got an HTTP response (DNS, connection, TLS, or a wrong `baseUrl`).
 * - ABORTED: the caller's `signal` aborted the call.
 * - UNEXPECTED_RESPONSE: the response was not a Shade API JSON body (e.g. a proxy error page).
 */
export type ShadeClientErrorCode = "TIMEOUT" | "NETWORK_ERROR" | "ABORTED" | "UNEXPECTED_RESPONSE";

export type ShadeErrorCode = ShadeApiErrorCode | ShadeClientErrorCode;

export interface ShadeErrorInit {
  status: number;
  code: string;
  message: string;
  requestId: string | null;
  remainingZec?: string;
  retryAfter?: number;
  issues?: { path: string; message: string }[];
  cause?: unknown;
}

/** Thrown for every non-2xx response. `code` is stable; `message` is human-readable server copy. */
export class ShadeError extends Error {
  /** HTTP status, or 0 when no response arrived (see ShadeConnectionError). */
  readonly status: number;
  /** A ShadeErrorCode; unknown future server codes pass through unchanged. */
  readonly code: ShadeErrorCode | (string & {});
  /** Quote this when contacting support. */
  readonly requestId: string | null;
  /** Present on JAR_EMPTY and JAR_CLOSED: what the jar can still spend. */
  readonly remainingZec?: string;
  /** Seconds to wait before retrying; present on RATE_LIMITED and CHAIN_UNAVAILABLE. */
  readonly retryAfter?: number;
  /** Present on INVALID_REQUEST: field paths and messages (never the submitted values). */
  readonly issues?: { path: string; message: string }[];

  constructor(init: ShadeErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ShadeError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.remainingZec = init.remainingZec;
    this.retryAfter = init.retryAfter;
    this.issues = init.issues;
  }
}

/** The request got no HTTP response: it timed out, failed at the network layer or was aborted. */
export class ShadeConnectionError extends ShadeError {
  constructor(code: "TIMEOUT" | "NETWORK_ERROR" | "ABORTED", message: string, cause?: unknown) {
    super({ status: 0, code, message, requestId: null, cause });
    this.name = "ShadeConnectionError";
  }
}
