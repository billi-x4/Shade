/**
 * Shade HTTP API data contract (JSON wire shapes). Pure types, shared by the backend,
 * the web app (via the `@shade/contract` alias) and documentation. snake_case on the wire.
 */

export type Network = "testnet" | "mainnet";
export const NETWORKS: readonly Network[] = ["testnet", "mainnet"];

export type InvoiceStatus =
  "open" | "paid_unverified" | "paid" | "authorized" | "expired" | "cancelled";

/**
 * How Shade knows an invoice was paid.
 * - txid_unverified: payer pasted a txid that is on chain and shielded; not proof it paid this shop.
 * - merchant_accept: the merchant confirmed it in their wallet and pressed Confirm.
 * - ivk_scan: a viewing-key scanner decrypted a matching payment (Shade's worker or the merchant's own scanner).
 * - jar_ledger: a jar charge counted against the cap (no chain payment).
 */
export type Verification = "txid_unverified" | "merchant_accept" | "ivk_scan" | "jar_ledger";

export type ShieldedPool = "ironwood" | "orchard" | "sapling";
export type DetectionSource = "shade_worker" | "merchant_device" | "external_scanner";
/**
 * seen: on chain, waiting for confirmations. settled: this detection paid the invoice.
 * settled_after: matched an invoice that was already paid (no event). late: matched a cancelled
 * invoice or one past the expiry grace (no transition; shown to the merchant). orphaned: the block
 * was reorged away before settlement.
 */
export type DetectionState = "seen" | "settled" | "settled_after" | "late" | "orphaned";

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface InvoiceDetection {
  state: DetectionState;
  txid: string;
  pool: ShieldedPool;
  source: DetectionSource;
  block_height: number | null;
  confirmations: number | null;
  required_confirmations: number;
  observed_at: string;
}

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  verification: Verification | null;
  network: Network;
  amount_zec: string;
  /** The merchant memo as authored. */
  memo: string;
  /**
   * The memo the payer wallet writes on chain: `<memo> (shade:<REF>)`, or `shade:<REF>` when the
   * merchant memo is empty. Jar charges: equal to memo. memo_hash covers chain_memo.
   */
  chain_memo: string;
  /** "sha256:" + hex(SHA-256(ZIP-302 512-byte memo field of chain_memo)). */
  memo_hash: string;
  /** Free-text label used for grant scope (e.g. "payroll"); unrelated to name.shade Tag objects. */
  tag: string | null;
  /** Receive address; null for jar charges (never payable). */
  address: string | null;
  /** ZIP-321 payment URI; null for jar charges. */
  zip321: string | null;
  /** Absolute URL of the public pay page; null for jar charges. */
  pay_url: string | null;
  /** Settled txid (display byte order); set only when status is paid. */
  txid: string | null;
  /** Txid a payer pasted (unverified); cleared on reject or when another payment settles it. */
  claimed_txid: string | null;
  /** Chain tip when the invoice was created (null if the light server was unreachable); scanners start here. */
  created_height: number | null;
  jar_id: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  /** Latest scanner detection, if any. */
  detection: InvoiceDetection | null;
}

/** Payer-facing progress on the public pay page. */
export type PaymentProgress = "awaiting" | "reported" | "seen" | "confirmed";

/** Minimal invoice view for anyone holding the pay link. No tag, jar, txid, claim or memo hash. */
export interface PublicInvoice {
  id: string;
  status: Exclude<InvoiceStatus, "authorized">;
  progress: PaymentProgress;
  network: Network;
  amount_zec: string;
  /** Merchant memo for display. The wallet writes chain_memo (inside zip321). */
  memo: string;
  address: string;
  zip321: string;
  merchant_name: string | null;
  expires_at: string;
  paid_at: string | null;
  /** Confirmations so far once the payment has been seen on chain. */
  confirmations: number | null;
  required_confirmations: number;
}

export type JarStatus = "open" | "killed";

export interface Jar {
  id: string;
  label: string;
  status: JarStatus;
  network: Network;
  cap_zec: string;
  spent_zec: string;
  remaining_zec: string;
  address: string;
  charge_count: number;
  created_at: string;
  killed_at: string | null;
  /** COPY.killNote */
  note: string;
}

/** A jar charge is an authorized child invoice: a ledger entry against the cap, never payable. */
export interface JarCharge {
  /** The child invoice id. */
  id: string;
  jar_id: string;
  amount_zec: string;
  memo: string;
  memo_hash: string;
  status: "authorized" | "cancelled";
  created_at: string;
}

/** POST /v1/jars/:id/charge success body (PRD §9). */
export interface JarChargeResult {
  invoice_id: string;
  jar_id: string;
  amount_zec: string;
  memo_hash: string;
  remaining_zec: string;
  status: "authorized";
  created_at: string;
}

export type GrantState = "active" | "expired" | "revoked";

export interface Grant {
  id: string;
  scope: string;
  network: Network;
  state: GrantState;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  /** COPY.grantNote */
  note: string;
}

/** Returned once, at creation. */
export interface GrantCreated extends Grant {
  token: string;
  /** `${APP_ORIGIN}/view#${token}`: the token rides in the URL fragment, never the path. */
  view_url: string;
}

export interface Receipt {
  id: string;
  kind: "invoice" | "jar_charge";
  amount_zec: string;
  memo: string;
  memo_hash: string;
  tag: string | null;
  txid: string | null;
  verification: Verification;
  paid_at: string | null;
  created_at: string;
}

export type GrantView =
  | { state: "missing"; message: string }
  | { state: "revoked"; scope: string; message: string }
  | { state: "expired"; scope: string; expires_at: string; message: string }
  | {
      state: "active";
      scope: string;
      network: Network;
      merchant_name: string | null;
      expires_at: string;
      message: string;
      receipts: Receipt[];
    };

export type WebhookEventType = "invoice.paid" | "webhook.test";

/**
 * Webhook body. The exact stored bytes are re-sent on every attempt. No payer address, no
 * plaintext memo. Receivers dedupe by `id` and treat invoice.paid idempotently per invoice_id.
 */
export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  created_at: string;
  network: Network;
  invoice_id: string | null;
  amount_zec: string | null;
  memo_hash: string | null;
  txid: string | null;
  paid_at: string | null;
  verification: Verification | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  network: Network;
  /** Last 4 characters of the signing secret, for recognition. */
  secret_hint: string;
  created_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
  failure_count: number;
  last_delivery_at: string | null;
}

/** Returned once, at creation. */
export interface WebhookEndpointCreated extends WebhookEndpoint {
  secret: string;
}

/** cancelled: the endpoint was deleted or disabled before this delivery succeeded; it will never be sent. */
export type DeliveryStatus =
  "pending" | "in_flight" | "delivered" | "failed" | "dead" | "cancelled";

export interface WebhookDelivery {
  id: string;
  event_id: string;
  event_type: WebhookEventType;
  endpoint_id: string;
  endpoint_url: string;
  invoice_id: string | null;
  status: DeliveryStatus;
  attempt: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  /** e.g. "asharib.shade" */
  display: string;
  network: Network;
  address: string;
  created_at: string;
}

export interface TagResolution {
  name: string;
  network: Network;
  address: string;
}

export type ApiKeyKind = "merchant" | "agent";

export interface ApiKey {
  id: string;
  kind: ApiKeyKind;
  network: Network;
  /** Non-secret display prefix, e.g. "sk_test_AbCd…". */
  prefix: string;
  /** Last 4 characters of the token. */
  last4: string;
  label: string;
  jar_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Returned once, at creation. */
export interface ApiKeyCreated extends ApiKey {
  token: string;
}

export type ScanState = "idle" | "scanning" | "error" | "disabled";
export type ScanErrorCode =
  | "chain_unavailable"
  | "scan_failed"
  | "key_unavailable"
  | "scanner_unsupported_upgrade"
  | "ambiguous_match"
  /** A matched payment was already settled on another invoice (e.g. the merchant confirmed it there). */
  | "txid_in_use";

export interface ViewingKeyStatus {
  id: string;
  network: Network;
  /** Short non-secret fingerprint of the uploaded key. */
  fingerprint: string;
  /** Default shielded address of this key (payments must reach an address of this key to be detected). */
  key_address: string;
  /** When true, the network receive address is this key's address and cannot be edited separately. */
  use_key_address: boolean;
  created_at: string;
  scan: {
    state: ScanState;
    cursor_height: number | null;
    tip_height: number | null;
    lag_blocks: number | null;
    last_scan_at: string | null;
    last_error: ScanErrorCode | null;
  };
}

export interface Me {
  user: { id: string; email: string; name: string; email_verified: boolean };
  merchant: {
    id: string;
    display_name: string;
    network: Network;
    receive_addresses: Record<Network, string | null>;
  };
  networks_enabled: Network[];
  hosted_detection: boolean;
}

export interface AddressSaved {
  me: Me;
  /** The normalized shielded-only Unified Address that was stored. */
  address: string;
  /**
   * Set when Shade changed the pasted address (e.g. removed a transparent receiver) or cannot confirm it
   * belongs to the uploaded viewing key (payments to an address of another account are not detected).
   */
  notice: string | null;
}

export interface AppConfig {
  networks: Network[];
  default_network: Network;
  min_confirmations: Record<Network, number>;
  auth: {
    email_password: true;
    email_verification_required: boolean;
    password_min_length: number;
  };
  features: { hosted_detection: boolean };
  /** Block explorer URL template per network with a `{txid}` placeholder, or null. */
  explorer_tx_url: Record<Network, string | null>;
}
