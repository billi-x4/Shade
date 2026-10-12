/**
 * Exact wire field sets of the contract DTOs (backend/src/contract/types.ts). HTTP tests compare a
 * response's keys against these, so an extra field (a secret, a memo, a claim) fails loudly.
 */
export const INVOICE_KEYS = [
  "id",
  "status",
  "verification",
  "network",
  "amount_zec",
  "memo",
  "chain_memo",
  "memo_hash",
  "tag",
  "address",
  "zip321",
  "pay_url",
  "txid",
  "claimed_txid",
  "created_height",
  "jar_id",
  "created_at",
  "expires_at",
  "paid_at",
  "detection",
];

export const DETECTION_KEYS = [
  "state",
  "txid",
  "pool",
  "source",
  "block_height",
  "confirmations",
  "required_confirmations",
  "observed_at",
];

export const PUBLIC_INVOICE_KEYS = [
  "id",
  "status",
  "progress",
  "network",
  "amount_zec",
  "memo",
  "address",
  "zip321",
  "merchant_name",
  "expires_at",
  "paid_at",
  "confirmations",
  "required_confirmations",
];

export const JAR_KEYS = [
  "id",
  "label",
  "status",
  "network",
  "cap_zec",
  "spent_zec",
  "remaining_zec",
  "address",
  "charge_count",
  "created_at",
  "killed_at",
  "note",
];

export const JAR_CHARGE_KEYS = [
  "id",
  "jar_id",
  "amount_zec",
  "memo",
  "memo_hash",
  "status",
  "created_at",
];

export const JAR_CHARGE_RESULT_KEYS = [
  "invoice_id",
  "jar_id",
  "amount_zec",
  "memo_hash",
  "remaining_zec",
  "status",
  "created_at",
];

export const GRANT_KEYS = [
  "id",
  "scope",
  "network",
  "state",
  "created_at",
  "expires_at",
  "revoked_at",
  "last_viewed_at",
  "note",
];

export const GRANT_CREATED_KEYS = [...GRANT_KEYS, "token", "view_url"];

export const RECEIPT_KEYS = [
  "id",
  "kind",
  "amount_zec",
  "memo",
  "memo_hash",
  "tag",
  "txid",
  "verification",
  "paid_at",
  "created_at",
];

export const WEBHOOK_ENDPOINT_KEYS = [
  "id",
  "url",
  "network",
  "secret_hint",
  "created_at",
  "disabled_at",
  "disabled_reason",
  "failure_count",
  "last_delivery_at",
];

export const WEBHOOK_ENDPOINT_CREATED_KEYS = [...WEBHOOK_ENDPOINT_KEYS, "secret"];

export const WEBHOOK_DELIVERY_KEYS = [
  "id",
  "event_id",
  "event_type",
  "endpoint_id",
  "endpoint_url",
  "invoice_id",
  "status",
  "attempt",
  "last_status_code",
  "last_error",
  "next_attempt_at",
  "delivered_at",
  "created_at",
];

export const TAG_KEYS = ["id", "name", "display", "network", "address", "created_at"];

export const TAG_RESOLUTION_KEYS = ["name", "network", "address"];

export const API_KEY_KEYS = [
  "id",
  "kind",
  "network",
  "prefix",
  "last4",
  "label",
  "jar_id",
  "created_at",
  "last_used_at",
  "revoked_at",
];

export const API_KEY_CREATED_KEYS = [...API_KEY_KEYS, "token"];

export const VIEWING_KEY_STATUS_KEYS = [
  "id",
  "network",
  "fingerprint",
  "key_address",
  "use_key_address",
  "created_at",
  "scan",
];

export const SCAN_KEYS = [
  "state",
  "cursor_height",
  "tip_height",
  "lag_blocks",
  "last_scan_at",
  "last_error",
];

export const ME_KEYS = ["user", "merchant", "networks_enabled", "hosted_detection"];

export const APP_CONFIG_KEYS = [
  "networks",
  "default_network",
  "min_confirmations",
  "auth",
  "features",
  "explorer_tx_url",
];

/** Sorted keys of a JSON object, for exact shape comparisons. */
export function keysOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  return Object.keys(value).sort();
}

export function sorted(keys: readonly string[]): string[] {
  return [...keys].sort();
}
