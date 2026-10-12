/** Request parsing shared by the route modules: zod bodies, ids, pagination and filters. */
import type { Context } from "hono";
import { z } from "zod";
import { NETWORKS, type Network } from "../contract/index.ts";
import { AppError } from "../platform/errors.ts";
import type { AppEnv, Principal } from "../platform/http.ts";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type PageRequest,
  decodeCursor,
} from "../services/common.ts";
import { LIST_STATUSES, type ListStatus, type NetworkScope } from "../services/invoices.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const NetworkSchema = z.enum(["testnet", "mainnet"]);

/** Bodiless POSTs: no body (any or no content type) or a JSON object whose fields are ignored. */
export const EmptyBody = z.object({});

export const InvoiceBody = z.object({
  amount_zec: z.string(),
  memo: z.string().optional(),
  tag: z.string().nullable().optional(),
  expires_in_sec: z.number().optional(),
});

export const JarBody = z.object({ cap_zec: z.string(), label: z.string() });

export const ChargeBody = z.object({ amount_zec: z.string(), memo: z.string().optional() });

export const GrantBody = z.object({
  scope: z.string(),
  days: z.number().optional(),
  expires_in_sec: z.number().optional(),
});

export const WebhookBody = z.object({ url: z.string() });

export const TagBody = z.object({ name: z.string() });

export const DetectionBody = z.object({
  txid: z.string(),
  amount_zec: z.string(),
  memo_hash: z.string(),
  pool: z.string(),
  source: z.enum(["merchant_device", "external_scanner"]).optional(),
});

export const ProfileBody = z.object({ display_name: z.string() });

export const AddressBody = z.object({ network: NetworkSchema, address: z.string() });

export const NetworkBody = z.object({ network: NetworkSchema });

export const KeyBody = z.object({
  kind: z.enum(["merchant", "agent"]),
  label: z.string(),
  jar_id: z.string().optional(),
  network: NetworkSchema.optional(),
});

export const ViewingKeyBody = z.object({
  ufvk: z.string(),
  use_key_address: z.boolean().optional(),
});

export const TxidBody = z.object({ txid: z.string() });

/** Desk Confirm: empty for the payer's claim, or the txid the merchant found in their wallet. */
export const AcceptBody = z.object({ txid: z.string().optional() });

export const TokenBody = z.object({ token: z.string() });

/** A path id. Anything that cannot be a Shade id is simply not found. */
export function idParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || !ID_PATTERN.test(value)) {
    throw new AppError(404, "NOT_FOUND", "Not found.");
  }
  return value;
}

export function isShadeId(value: string | undefined): value is string {
  return value !== undefined && ID_PATTERN.test(value);
}

export function networkParam(c: Context<AppEnv>): Network {
  const value = c.req.param("network");
  const network = NETWORKS.find((candidate) => candidate === value);
  if (!network) throw new AppError(404, "NOT_FOUND", "Not found.");
  return network;
}

function invalidQuery(message: string): AppError {
  return new AppError(400, "INVALID_REQUEST", message);
}

/** `?cursor=&limit=` (default 25, 1..100). */
export function pageQuery(c: Context<AppEnv>): PageRequest {
  const raw = c.req.query("limit");
  let limit = DEFAULT_PAGE_LIMIT;
  if (raw !== undefined && raw !== "") {
    limit = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
    if (limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw invalidQuery(`limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}.`);
    }
  }
  return { cursor: decodeCursor(c.req.query("cursor")), limit };
}

/** `?status=open` or a comma list such as `?status=open,paid_unverified,expired`. */
export function statusQuery(c: Context<AppEnv>): ListStatus[] {
  const raw = c.req.query("status");
  if (raw === undefined || raw.trim() === "") return [];
  const statuses: ListStatus[] = [];
  for (const part of raw.split(",")) {
    const status = LIST_STATUSES.find((candidate) => candidate === part.trim());
    if (!status) {
      throw invalidQuery(`status must be a comma list of ${LIST_STATUSES.join(", ")}.`);
    }
    if (!statuses.includes(status)) statuses.push(status);
  }
  return statuses;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `?expires_after=<ISO 8601 date-time>`; absent means no filter. */
export function expiresAfterQuery(c: Context<AppEnv>): Date | null {
  const raw = c.req.query("expires_after");
  if (raw === undefined || raw === "") return null;
  const date = ISO_DATE_TIME.test(raw) ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw invalidQuery("expires_after must be an ISO 8601 date-time such as 2026-10-06T12:00:00Z.");
  }
  return date;
}

/** `?network=`; absent means `fallback`. */
export function networkQuery<F extends Network | null>(
  c: Context<AppEnv>,
  fallback: F,
): Network | F {
  const raw = c.req.query("network");
  if (raw === undefined || raw === "") return fallback;
  const network = NETWORKS.find((candidate) => candidate === raw);
  if (!network) throw invalidQuery("network must be testnet or mainnet.");
  return network;
}

/** The authenticated /v1 key (apiKeyAuth runs first on every protected route). */
export function principalOf(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (!principal) throw new AppError(401, "UNAUTHORIZED", "Missing or invalid API key.");
  return principal;
}

/** A key acts for one merchant on the key's network only. */
export function keyScope(c: Context<AppEnv>): NetworkScope {
  const principal = principalOf(c);
  return { merchantId: principal.merchantId, network: principal.network };
}
