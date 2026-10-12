/**
 * snake_case JSON shapes of the Shade HTTP API, copied from the backend wire contract
 * (backend/src/contract/types.ts and errors.ts). SDK-private: the public surface is camelCase (types.ts).
 * The SDK publishes on its own, so it never imports from backend/.
 */
import type {
  DetectionSource,
  DetectionState,
  GrantState,
  InvoiceStatus,
  JarStatus,
  Network,
  ShadeEventType,
  ShieldedPool,
  Verification,
} from "./types.ts";

export interface WirePage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface WireInvoiceDetection {
  state: DetectionState;
  txid: string;
  pool: ShieldedPool;
  source: DetectionSource;
  block_height: number | null;
  confirmations: number | null;
  required_confirmations: number;
  observed_at: string;
}

export interface WireInvoice {
  id: string;
  status: InvoiceStatus;
  verification: Verification | null;
  network: Network;
  amount_zec: string;
  memo: string;
  chain_memo: string;
  memo_hash: string;
  tag: string | null;
  address: string | null;
  zip321: string | null;
  pay_url: string | null;
  txid: string | null;
  claimed_txid: string | null;
  created_height: number | null;
  jar_id: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  detection: WireInvoiceDetection | null;
}

export interface WireJar {
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
  note: string;
}

export interface WireJarChargeResult {
  invoice_id: string;
  jar_id: string;
  amount_zec: string;
  memo_hash: string;
  remaining_zec: string;
  status: "authorized";
  created_at: string;
}

export interface WireGrant {
  id: string;
  scope: string;
  network: Network;
  state: GrantState;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  note: string;
}

export interface WireGrantCreated extends WireGrant {
  token: string;
  view_url: string;
}

export interface WireWebhookEndpoint {
  id: string;
  url: string;
  network: Network;
  secret_hint: string;
  created_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
  failure_count: number;
  last_delivery_at: string | null;
}

export interface WireWebhookEndpointCreated extends WireWebhookEndpoint {
  secret: string;
}

export interface WireTag {
  id: string;
  name: string;
  display: string;
  network: Network;
  address: string;
  created_at: string;
}

export interface WireTagResolution {
  name: string;
  network: Network;
  address: string;
}

export interface WireWebhookEvent {
  id: string;
  type: ShadeEventType;
  created_at: string;
  network: Network;
  invoice_id: string | null;
  amount_zec: string | null;
  memo_hash: string | null;
  txid: string | null;
  paid_at: string | null;
  verification: Verification | null;
}

/** Body of every non-2xx JSON response. */
export interface WireErrorBody {
  error: string;
  message: string;
  request_id?: string;
  issues?: { path: string; message: string }[];
  remaining_zec?: string;
  retry_after?: number;
}
