/**
 * Invoices: creation (unique on-chain memo per invoice), reads with effective status, cancel, and
 * the Invoice / PublicInvoice DTOs. Moving an invoice to paid lives in settlement.ts only.
 */
import type {
  DetectionSource,
  DetectionState,
  Invoice,
  InvoiceDetection,
  InvoiceStatus,
  Network,
  Page,
  PaymentProgress,
  PublicInvoice,
  ShieldedPool,
  Verification,
} from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { newId } from "../platform/crypto.ts";
import type { Db, Sql } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import type { Logger } from "../platform/logger.ts";
import type { ChainClient } from "../zcash/lightwalletd.ts";
import {
  MERCHANT_MEMO_MAX_BYTES,
  chainMemo,
  checkMemoText,
  memoHash,
  newMemoRef,
} from "../zcash/memo.ts";
import { parseZec } from "../zcash/money.ts";
import { buildPaymentUri } from "../zcash/zip321.ts";
import {
  type PageRequest,
  addSeconds,
  assertNetworkEnabled,
  iso,
  isoOrNull,
  nextCursor,
  notFound,
  zatParam,
  zecText,
} from "./common.ts";
import { requireMerchant, requireReceiveAddress } from "./merchants.ts";

/** Which rows a caller may see: a /v1 key is bound to one network, the desk sees all. */
export interface Scope {
  merchantId: string;
  network: Network | null;
}

export interface NetworkScope extends Scope {
  network: Network;
}

export interface InvoiceRow {
  id: string;
  merchant_id: string;
  jar_id: string | null;
  amount_zec: string;
  memo: string;
  memo_hash: string;
  chain_memo: string | null;
  memo_ref: string | null;
  tag: string | null;
  network: Network;
  address: string;
  zip321: string;
  status: InvoiceStatus;
  verification: Verification | null;
  txid: string | null;
  claimed_txid: string | null;
  created_height: number | null;
  paid_height: number | null;
  expires_at: Date;
  paid_at: Date | null;
  created_at: Date;
}

const INVOICE_FIELDS = [
  "id",
  "merchant_id",
  "jar_id",
  "amount_zec",
  "memo",
  "memo_hash",
  "chain_memo",
  "memo_ref",
  "tag",
  "network",
  "address",
  "zip321",
  "status",
  "verification",
  "txid",
  "claimed_txid",
  "created_height",
  "paid_height",
  "expires_at",
  "paid_at",
  "created_at",
] as const;

/** Column list for InvoiceRow selects, optionally qualified with a table alias. */
export function invoiceColumns(alias?: string): string {
  return INVOICE_FIELDS.map((field) => (alias ? `${alias}.${field}` : field)).join(", ");
}

export const INVOICE_COLUMNS = invoiceColumns();

interface DetectionRow {
  invoice_id: string;
  state: DetectionState;
  txid: string;
  pool: ShieldedPool;
  source: DetectionSource;
  block_height: number | null;
  confirmations: number | null;
  observed_at: Date;
}

/** Statuses a non-jar invoice list can filter on (effective status, see {@link effectiveStatus}). */
export type ListStatus = "open" | "paid_unverified" | "paid" | "expired" | "cancelled";
export const LIST_STATUSES: readonly ListStatus[] = [
  "open",
  "paid_unverified",
  "paid",
  "expired",
  "cancelled",
];

/** SQL predicate per list status; `now()` binds the clock parameter and returns its placeholder. */
const LIST_STATUS_SQL: Record<ListStatus, (now: () => string) => string> = {
  open: (now) => `(status = 'open' and expires_at > ${now()})`,
  paid_unverified: () => "status = 'paid_unverified'",
  paid: () => "status = 'paid'",
  expired: (now) => `(status = 'expired' or (status = 'open' and expires_at <= ${now()}))`,
  cancelled: () => "status = 'cancelled'",
};

const INVOICE_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEFAULT_EXPIRY_SEC = 3600;
const MIN_EXPIRY_SEC = 60;
const MAX_EXPIRY_SEC = 7 * 86_400;
const TIP_TIMEOUT_MS = 3000;
/** Soft cap on unpaid (open or claimed) invoices per merchant and network; bounds scanner and desk work. */
const LIVE_INVOICE_LIMIT = 10_000;

/** An open invoice past its expiry reads as expired; the sweeper writes it later. */
export function effectiveStatus(
  row: Pick<InvoiceRow, "status" | "expires_at">,
  now: Date,
): InvoiceStatus {
  return row.status === "open" && row.expires_at.getTime() <= now.getTime()
    ? "expired"
    : row.status;
}

/** Invoice labels and grant scopes: lowercase `^[a-z0-9][a-z0-9_-]{0,31}$`. */
export function normalizeLabel(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return INVOICE_TAG_PATTERN.test(value) ? value : null;
}

/**
 * An invoice label. "all" is reserved: a grant scoped to "all" covers every receipt, so an invoice
 * labelled "all" could never be shared on its own (grant scope parsing keeps "all" as that scope).
 */
function parseInvoiceTag(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const tag = normalizeLabel(raw);
  if (!tag) {
    throw new AppError(
      400,
      "BAD_TAG",
      "Use a short label like payroll: letters, numbers, - or _, up to 32 characters.",
    );
  }
  if (tag === "all") throw new AppError(400, "BAD_TAG", '"all" is reserved. Pick another label.');
  return tag;
}

export function badAmount(what = "Amount"): AppError {
  return new AppError(
    400,
    "BAD_AMOUNT",
    `${what} must be a ZEC amount above zero with at most 8 decimals, like 0.01.`,
  );
}

/** Latest detection per invoice (by last update). */
export async function latestDetections(
  sql: Sql,
  invoiceIds: string[],
): Promise<Map<string, DetectionRow>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await sql<DetectionRow>`
    select distinct on (invoice_id)
      invoice_id, state, txid, pool, source, block_height, confirmations, observed_at
    from invoice_detections
    where invoice_id = any(${invoiceIds}::text[])
    order by invoice_id, updated_at desc, id desc`;
  return new Map(rows.map((row) => [row.invoice_id, row]));
}

/** Builds Invoice / PublicInvoice DTOs (needs config for pay URLs and confirmations). */
export interface InvoiceView {
  invoice(row: InvoiceRow, detection: DetectionRow | undefined): Invoice;
  publicInvoice(
    row: InvoiceRow,
    detection: DetectionRow | undefined,
    merchantName: string,
  ): PublicInvoice;
  /** Loads one invoice with its latest detection; null when the id is unknown. */
  load(sql: Sql, invoiceId: string): Promise<Invoice | null>;
  many(sql: Sql, rows: InvoiceRow[]): Promise<Invoice[]>;
}

export function createInvoiceView(config: Config, clock: () => Date): InvoiceView {
  const detectionDto = (row: DetectionRow, network: Network): InvoiceDetection => ({
    state: row.state,
    txid: row.txid,
    pool: row.pool,
    source: row.source,
    block_height: row.block_height,
    confirmations: row.confirmations,
    required_confirmations: config.minConfirmations[network],
    observed_at: iso(row.observed_at),
  });

  const invoice = (row: InvoiceRow, detection: DetectionRow | undefined): Invoice => {
    const payable = row.jar_id === null;
    return {
      id: row.id,
      status: effectiveStatus(row, clock()),
      verification: row.verification,
      network: row.network,
      amount_zec: zecText(row.amount_zec),
      memo: row.memo,
      chain_memo: row.chain_memo ?? row.memo,
      memo_hash: row.memo_hash,
      tag: row.tag,
      address: payable ? row.address : null,
      zip321: payable ? row.zip321 : null,
      pay_url: payable ? `${config.appOrigin}/pay/${row.id}` : null,
      txid: row.txid,
      claimed_txid: row.claimed_txid,
      created_height: row.created_height,
      jar_id: row.jar_id,
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      paid_at: isoOrNull(row.paid_at),
      detection: detection ? detectionDto(detection, row.network) : null,
    };
  };

  const progressOf = (status: InvoiceStatus, detection: DetectionRow | undefined) => {
    if (status === "paid") return "confirmed" satisfies PaymentProgress;
    if (detection?.state === "seen") return "seen" satisfies PaymentProgress;
    if (status === "paid_unverified") return "reported" satisfies PaymentProgress;
    return "awaiting" satisfies PaymentProgress;
  };

  return {
    invoice,

    publicInvoice(row, detection, merchantName) {
      const status = effectiveStatus(row, clock());
      if (status === "authorized") throw notFound("invoice");
      const onChain = detection?.state === "seen" || detection?.state === "settled";
      return {
        id: row.id,
        status,
        progress: progressOf(status, detection),
        network: row.network,
        amount_zec: zecText(row.amount_zec),
        memo: row.memo,
        address: row.address,
        zip321: row.zip321,
        merchant_name: merchantName === "" ? null : merchantName,
        expires_at: iso(row.expires_at),
        paid_at: isoOrNull(row.paid_at),
        confirmations: onChain ? (detection.confirmations ?? null) : null,
        required_confirmations: config.minConfirmations[row.network],
      };
    },

    async load(sql, invoiceId) {
      const [row] = await sql.query<InvoiceRow>(
        `select ${INVOICE_COLUMNS} from invoices where id = $1`,
        [invoiceId],
      );
      if (!row) return null;
      const detections = await latestDetections(sql, [row.id]);
      return invoice(row, detections.get(row.id));
    },

    async many(sql, rows) {
      const detections = await latestDetections(
        sql,
        rows.filter((row) => row.jar_id === null).map((row) => row.id),
      );
      return rows.map((row) => invoice(row, detections.get(row.id)));
    },
  };
}

export interface InvoiceInput {
  amount_zec: string;
  memo?: string;
  tag?: string | null;
  expires_in_sec?: number;
}

/** A validated invoice, with every external read done, ready to insert inside a transaction. */
export interface InvoicePlan {
  merchantId: string;
  network: Network;
  amountZat: bigint;
  memo: string;
  tag: string | null;
  expiresInSec: number;
  address: string;
  createdHeight: number | null;
}

export interface InvoiceService {
  /** Validates the request, loads the receive address and reads the chain tip (outside any tx). */
  prepare(merchantId: string, network: Network, input: InvoiceInput): Promise<InvoicePlan>;
  /** Inserts a prepared invoice on `sql` (used inside the idempotency transaction). */
  insert(sql: Sql, plan: InvoicePlan): Promise<Invoice>;
  create(merchantId: string, network: Network, input: InvoiceInput): Promise<Invoice>;
  /** `expiresAfter` keeps only invoices whose expires_at is later (scanners skip old expired ones). */
  list(
    merchantId: string,
    network: Network,
    statuses: readonly ListStatus[],
    page: PageRequest,
    expiresAfter?: Date | null,
  ): Promise<Page<Invoice>>;
  get(scope: Scope, invoiceId: string): Promise<Invoice>;
  /** Raw row (any status, jar charges included) within scope, or 404. */
  row(scope: Scope, invoiceId: string): Promise<InvoiceRow>;
  /** Cancels an open non-jar invoice (jar charges go through JarService.cancelCharge). */
  cancelOpen(scope: Scope, invoiceId: string): Promise<Invoice>;
  getPublic(invoiceId: string): Promise<PublicInvoice>;
}

export function createInvoiceService(deps: {
  db: Db;
  config: Config;
  logger: Logger;
  chain: Record<Network, ChainClient>;
  clock: () => Date;
  view: InvoiceView;
}): InvoiceService {
  const { db, config, logger, chain, clock, view } = deps;

  /** The tip anchors the payment window; a slow or down light server must not block invoicing. */
  const tipHeight = async (network: Network): Promise<number | null> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIP_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const tip = await Promise.race([chain[network].getTip(), timeout]);
      if (tip === null) logger.warn({ network }, "chain tip timed out at invoice creation");
      return tip?.height ?? null;
    } catch (err) {
      logger.warn({ err, network }, "chain tip unavailable at invoice creation");
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const selectRow = async (sql: Sql, scope: Scope, invoiceId: string, lock = false) => {
    const params: unknown[] = [invoiceId, scope.merchantId];
    let where = "id = $1 and merchant_id = $2";
    if (scope.network !== null) {
      params.push(scope.network);
      where += " and network = $3";
    }
    const [row] = await sql.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from invoices where ${where}${lock ? " for update" : ""}`,
      params,
    );
    return row ?? null;
  };

  const prepare: InvoiceService["prepare"] = async (merchantId, network, input) => {
    assertNetworkEnabled(config, network);
    const amountZat = parseZec(input.amount_zec);
    if (amountZat === null) throw badAmount();
    const memo = input.memo ?? "";
    const memoCheck = checkMemoText(memo, MERCHANT_MEMO_MAX_BYTES);
    if (!memoCheck.ok) throw new AppError(400, "BAD_MEMO", memoCheck.message);
    const tag = parseInvoiceTag(input.tag);
    const expiresInSec = input.expires_in_sec ?? DEFAULT_EXPIRY_SEC;
    if (
      !Number.isInteger(expiresInSec) ||
      expiresInSec < MIN_EXPIRY_SEC ||
      expiresInSec > MAX_EXPIRY_SEC
    ) {
      throw new AppError(400, "BAD_EXPIRY", "Expiry must be between 1 minute and 7 days.");
    }
    const merchant = await requireMerchant(db, merchantId);
    const address = requireReceiveAddress(merchant, network);
    return {
      merchantId,
      network,
      amountZat,
      memo,
      tag,
      expiresInSec,
      address,
      createdHeight: await tipHeight(network),
    };
  };

  const insert: InvoiceService["insert"] = async (sql, plan) => {
    const now = clock();
    const [live] = await sql<{ count: number }>`
      select count(*)::int as count from invoices
      where merchant_id = ${plan.merchantId} and network = ${plan.network} and jar_id is null
        and (status = 'paid_unverified' or (status = 'open' and expires_at > ${now}))`;
    if ((live?.count ?? 0) >= LIVE_INVOICE_LIMIT) {
      throw new AppError(
        409,
        "INVOICE_LIMIT",
        `This desk already has ${LIVE_INVOICE_LIMIT} unpaid invoices on ${plan.network}. Cancel some or let them expire first.`,
      );
    }
    const expiresAt = addSeconds(now, plan.expiresInSec);
    // memo_ref carries 40 random bits; a collision with the merchant's other refs is retried.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = newId("inv");
      const ref = newMemoRef();
      const onChainMemo = chainMemo(plan.memo, ref);
      const zip321 = buildPaymentUri({
        address: plan.address,
        amountZat: plan.amountZat,
        chainMemo: onChainMemo,
      });
      const [row] = await sql.query<InvoiceRow>(
        `insert into invoices (id, merchant_id, jar_id, amount_zec, memo, memo_hash, chain_memo,
           memo_ref, tag, network, address, zip321, status, verification, created_height,
           expires_at, created_at)
         values ($1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', null, $12, $13, $14)
         on conflict do nothing
         returning ${INVOICE_COLUMNS}`,
        [
          id,
          plan.merchantId,
          zatParam(plan.amountZat),
          plan.memo,
          memoHash(onChainMemo),
          onChainMemo,
          ref,
          plan.tag,
          plan.network,
          plan.address,
          zip321,
          plan.createdHeight,
          expiresAt,
          now,
        ],
      );
      if (row) return view.invoice(row, undefined);
    }
    throw new Error("could not allocate a unique invoice memo reference");
  };

  return {
    prepare,
    insert,

    async create(merchantId, network, input) {
      const plan = await prepare(merchantId, network, input);
      return db.tx((sql) => insert(sql, plan));
    },

    async list(merchantId, network, statuses, page, expiresAfter = null) {
      const params: unknown[] = [];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      const where = [
        `merchant_id = ${bind(merchantId)}`,
        `network = ${bind(network)}`,
        "jar_id is null",
      ];
      if (statuses.length > 0) {
        let nowParam: string | null = null;
        const now = () => (nowParam ??= bind(clock()));
        where.push(`(${statuses.map((s) => LIST_STATUS_SQL[s](now)).join(" or ")})`);
      }
      if (expiresAfter) where.push(`expires_at > ${bind(expiresAfter)}`);
      if (page.cursor) {
        where.push(
          `(created_at, id) < (${bind(page.cursor.createdAt)}::timestamptz, ${bind(page.cursor.id)})`,
        );
      }
      const rows = await db.query<InvoiceRow>(
        `select ${INVOICE_COLUMNS} from invoices where ${where.join(" and ")}
         order by created_at desc, id desc limit ${bind(page.limit + 1)}`,
        params,
      );
      return {
        items: await view.many(db, rows.slice(0, page.limit)),
        next_cursor: nextCursor(rows, page.limit),
      };
    },

    async get(scope, invoiceId) {
      const row = await selectRow(db, scope, invoiceId);
      if (!row) throw notFound("invoice");
      const detections = await latestDetections(db, [row.id]);
      return view.invoice(row, detections.get(row.id));
    },

    async row(scope, invoiceId) {
      const row = await selectRow(db, scope, invoiceId);
      if (!row) throw notFound("invoice");
      return row;
    },

    async cancelOpen(scope, invoiceId) {
      return db.tx(async (sql) => {
        const row = await selectRow(sql, scope, invoiceId, true);
        if (!row || row.jar_id !== null) throw notFound("invoice");
        const status = effectiveStatus(row, clock());
        if (status !== "open") throw notOpen(status);
        const [pending] = await sql`
          select 1 from invoice_detections where invoice_id = ${row.id} and state = 'seen' limit 1`;
        if (pending) {
          throw new AppError(
            409,
            "PAYMENT_PENDING",
            "A payment for this invoice is waiting for confirmations. Wait for it to settle.",
          );
        }
        await sql`update invoices set status = 'cancelled' where id = ${row.id}`;
        const invoice = await view.load(sql, row.id);
        if (!invoice) throw notFound("invoice");
        return invoice;
      });
    },

    async getPublic(invoiceId) {
      const [row] = await db.query<InvoiceRow & { display_name: string }>(
        `select ${invoiceColumns("i")}, m.display_name
         from invoices i join merchants m on m.id = i.merchant_id
         where i.id = $1 and i.jar_id is null`,
        [invoiceId],
      );
      if (!row) throw notFound("invoice");
      const detections = await latestDetections(db, [row.id]);
      return view.publicInvoice(row, detections.get(row.id), row.display_name);
    },
  };
}

/** 409 NOT_OPEN with a message for the invoice's current (effective) status. */
export function notOpen(status: InvoiceStatus): AppError {
  const messages: Partial<Record<InvoiceStatus, string>> = {
    paid: "This invoice is already paid.",
    paid_unverified: "A payer reported a payment for this invoice. Confirm or reject it first.",
    expired: "This invoice has expired.",
    cancelled: "This invoice is already cancelled.",
  };
  return new AppError(409, "NOT_OPEN", messages[status] ?? "This invoice is no longer open.");
}
