/**
 * Public camelCase types returned by shade-zcash-sdk. Amounts are decimal ZEC strings (never floats), times are
 * ISO 8601 strings, txids are lowercase display-order hex. The wire API itself is snake_case.
 */

export type Network = "testnet" | "mainnet";

export type InvoiceStatus =
  "open" | "paid_unverified" | "paid" | "authorized" | "expired" | "cancelled";

/**
 * How Shade knows an invoice was paid.
 * - txid_unverified: the payer pasted a shielded txid; not proof it paid this invoice.
 * - merchant_accept: the merchant confirmed the payment in their wallet.
 * - ivk_scan: a viewing-key scanner decrypted a matching payment.
 * - jar_ledger: a jar charge counted against the cap (no chain payment).
 */
export type Verification = "txid_unverified" | "merchant_accept" | "ivk_scan" | "jar_ledger";

export type ShieldedPool = "ironwood" | "orchard" | "sapling";
export type DetectionSource = "shade_worker" | "merchant_device" | "external_scanner";
export type DetectionState = "seen" | "settled" | "settled_after" | "late" | "orphaned";
export type JarStatus = "open" | "killed";
export type GrantState = "active" | "expired" | "revoked";
export type ShadeEventType = "invoice.paid" | "webhook.test";

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` to fetch the next page; null on the last page. */
  nextCursor: string | null;
}

export interface InvoiceDetection {
  state: DetectionState;
  txid: string;
  pool: ShieldedPool;
  source: DetectionSource;
  blockHeight: number | null;
  confirmations: number | null;
  requiredConfirmations: number;
  observedAt: string;
}

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  verification: Verification | null;
  network: Network;
  amountZec: string;
  /** The merchant memo as authored. */
  memo: string;
  /** The memo the payer's wallet writes on chain: `<memo> (shade:<REF>)`, or `shade:<REF>` for an empty memo. */
  chainMemo: string;
  /** "sha256:" + hex SHA-256 of the 512-byte ZIP-302 memo field of chainMemo. */
  memoHash: string;
  tag: string | null;
  /** Receive address; null for jar charges. */
  address: string | null;
  /** ZIP-321 payment URI; null for jar charges. */
  zip321: string | null;
  /** Public pay page; null for jar charges. */
  payUrl: string | null;
  /** Settled txid; set only when status is paid. */
  txid: string | null;
  /** Txid a payer pasted (unverified). */
  claimedTxid: string | null;
  /** Chain tip when the invoice was created (null if the light server was unreachable); scanners start here. */
  createdHeight: number | null;
  jarId: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  /** Latest scanner detection, if any. */
  detection: InvoiceDetection | null;
}

/** An invoice a payer can pay (every invoice that is not a jar charge). */
export type PayableInvoice = Invoice & {
  address: string;
  zip321: string;
  payUrl: string;
  jarId: null;
};

/** A jar is a spending limit recorded by Shade. No ZEC moves when it is created or charged. */
export interface Jar {
  id: string;
  label: string;
  status: JarStatus;
  network: Network;
  capZec: string;
  spentZec: string;
  remainingZec: string;
  address: string;
  chargeCount: number;
  createdAt: string;
  killedAt: string | null;
  note: string;
}

export interface JarChargeResult {
  /** The authorized child invoice. */
  invoiceId: string;
  jarId: string;
  amountZec: string;
  memoHash: string;
  remainingZec: string;
  status: "authorized";
  createdAt: string;
}

export interface Grant {
  id: string;
  scope: string;
  network: Network;
  state: GrantState;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  note: string;
}

/** Returned once, at creation. Share `viewUrl`; the token rides in the URL fragment. */
export interface GrantCreated extends Grant {
  token: string;
  viewUrl: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  network: Network;
  /** Last 4 characters of the signing secret. */
  secretHint: string;
  createdAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
  failureCount: number;
  lastDeliveryAt: string | null;
}

/** Returned once, at creation. Store `secret` (whsec_…) to verify deliveries. */
export interface WebhookEndpointCreated extends WebhookEndpoint {
  secret: string;
}

export interface Tag {
  id: string;
  name: string;
  /** e.g. "asharib.shade" */
  display: string;
  network: Network;
  address: string;
  createdAt: string;
}

export interface TagResolution {
  name: string;
  network: Network;
  address: string;
}

/** A verified webhook event. No payer address, no plaintext memo. Dedupe by `id`. */
export interface ShadeEvent {
  id: string;
  type: ShadeEventType;
  createdAt: string;
  network: Network;
  invoiceId: string | null;
  amountZec: string | null;
  memoHash: string | null;
  txid: string | null;
  paidAt: string | null;
  verification: Verification | null;
}

export interface CreateInvoiceParams {
  /** Decimal ZEC, e.g. "0.01". */
  amountZec: string;
  /** Up to 495 UTF-8 bytes; Shade appends a reference to form the on-chain memo. */
  memo?: string;
  /** 60..604800, default 3600. */
  expiresInSec?: number;
  /** Free-text label used to scope grants, e.g. "payroll". */
  tag?: string;
}

export type ListableInvoiceStatus = Exclude<InvoiceStatus, "authorized">;

export interface ListInvoicesParams {
  status?: ListableInvoiceStatus | ListableInvoiceStatus[];
  /** Only invoices whose expiresAt is later (ISO 8601 string or Date), e.g. recent expiries for a scanner. */
  expiresAfter?: string | Date;
  cursor?: string;
  /** 1..100, default 25. */
  limit?: number;
}

/** A payment found by the merchant's own viewing-key scanner. Shade checks it against the chain. */
export interface ReportDetectionParams {
  txid: string;
  amountZec: string;
  memoHash: string;
  pool: ShieldedPool;
  /** Default merchant_device. */
  source?: Exclude<DetectionSource, "shade_worker">;
}

export interface CreateJarParams {
  /** Spending limit in decimal ZEC. */
  capZec: string;
  label: string;
}

export interface ChargeJarParams {
  amountZec: string;
  memo?: string;
}

/** Duration in whole days (1..90, default 7) or in seconds (600..7776000), not both. */
export type CreateGrantParams =
  | { scope: string; days?: number; expiresInSec?: undefined }
  | { scope: string; expiresInSec: number; days?: undefined };

export interface CreateWebhookParams {
  /** Public https URL that receives signed POSTs. */
  url: string;
}

export interface CreateTagParams {
  /** Lowercase name; resolves as `<name>.shade`. */
  name: string;
}
