/** Stable machine-readable error codes. HTTP status travels separately (agents.md §4.10, API errors). */
export const ERROR_CODES = [
  "INVALID_REQUEST", // 400
  "UNSUPPORTED_MEDIA_TYPE", // 415
  "PAYLOAD_TOO_LARGE", // 413
  "UNAUTHORIZED", // 401
  "FORBIDDEN", // 403
  "FORBIDDEN_ORIGIN", // 403
  "EMAIL_UNVERIFIED", // 403
  "SESSION_NOT_FRESH", // 403
  "NETWORK_DISABLED", // 403
  "NOT_FOUND", // 404
  "RATE_LIMITED", // 429
  "IDEMPOTENCY_MISMATCH", // 422
  "IDEMPOTENCY_IN_PROGRESS", // 409
  "NO_ADDRESS", // 409
  "BAD_ADDRESS", // 400
  "BAD_AMOUNT", // 400
  "BAD_MEMO", // 400
  "BAD_TAG", // 400
  "BAD_EXPIRY", // 400
  "BAD_LABEL", // 400
  "BAD_SCOPE", // 400
  "BAD_DURATION", // 400
  "BAD_TXID", // 400
  "BAD_MEMO_HASH", // 400
  "BAD_POOL", // 400
  "BAD_URL", // 400
  "BAD_VIEWING_KEY", // 400
  "ADDRESS_MANAGED_BY_KEY", // 409
  "VIEWING_KEY_ADDRESS_MISMATCH", // 422 (viewing-key upload with use_key_address=false only)
  "NOT_OPEN", // 409
  "PAYMENT_PENDING", // 409
  "ALREADY_PAID", // 409
  "EXPIRED", // 409
  "CANCELLED", // 409
  "TXID_IN_USE", // 409
  "TX_NOT_FOUND", // 404
  "TX_NOT_MINED", // 409
  "TX_NOT_SHIELDED", // 422
  "AMOUNT_MISMATCH", // 422
  "MEMO_MISMATCH", // 422
  "OUTSIDE_WINDOW", // 422
  "JAR_EMPTY", // 402
  "JAR_CLOSED", // 409
  "GRANT_REVOKED", // 410
  "GRANT_EXPIRED", // 410
  "TAG_TAKEN", // 409
  "TAG_LIMIT", // 409
  "INVOICE_LIMIT", // 409
  "JAR_LIMIT", // 409
  "GRANT_LIMIT", // 409
  "ENDPOINT_LIMIT", // 409
  "NO_ENDPOINTS", // 409
  "CHAIN_UNAVAILABLE", // 503
  "HOSTED_DETECTION_DISABLED", // 409
  "INTERNAL", // 500
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Body of every non-2xx JSON response. */
export interface ApiErrorBody {
  error: ErrorCode;
  message: string;
  request_id?: string;
  /** Present on INVALID_REQUEST: field paths and messages only, never the submitted value. */
  issues?: { path: string; message: string }[];
  /** Present on JAR_EMPTY / JAR_CLOSED. */
  remaining_zec?: string;
  /** Seconds; present on RATE_LIMITED and CHAIN_UNAVAILABLE. */
  retry_after?: number;
}
