/**
 * Settlement: the ONLY code that moves an invoice to paid (applyDetection for scanners, acceptClaim
 * for the merchant), plus the payer's txid claim and the claim review. Chain lookups always happen
 * before a transaction opens; state is re-checked under `SELECT … FOR UPDATE`, and both settling
 * paths take a per-(merchant, network, txid) advisory lock first so their txid checks serialise.
 */
import type {
  DetectionSource,
  DetectionState,
  Invoice,
  Network,
  PublicInvoice,
  ShieldedPool,
} from "../contract/index.ts";
import { COPY } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { newId } from "../platform/crypto.ts";
import { type Db, type Sql, isUniqueViolation } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import { type ChainClient, ChainUnavailableError, type TxLookup } from "../zcash/lightwalletd.ts";
import { parseZec, zatFromNumeric } from "../zcash/money.ts";
import { isReceivable, parseTxSummary } from "../zcash/tx.ts";
import { parseTxid, reverseHex } from "../zcash/txid.ts";
import { addSeconds, iso, notFound, zatParam, zecText } from "./common.ts";
import {
  INVOICE_COLUMNS,
  type InvoiceRow,
  type InvoiceView,
  type NetworkScope,
  badAmount,
  effectiveStatus,
  invoiceColumns,
  latestDetections,
  notOpen,
} from "./invoices.ts";
import type { WebhookService } from "./webhooks.ts";

export interface DetectionInput {
  merchantId: string;
  network: Network;
  invoiceId: string;
  txid: string;
  pool: ShieldedPool;
  amountZat: bigint;
  memoHash: string;
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: Date | null;
  tipHeight: number | null;
  source: DetectionSource;
}

export type DetectionOutcome =
  "settled" | "seen" | "settled_after" | "late" | "txid_in_use" | "mismatch";

/** POST /v1/invoices/:id/detections body after zod (pool and source checked here). */
export interface DetectionReport {
  txid: string;
  amount_zec: string;
  memo_hash: string;
  pool: string;
  source?: "merchant_device" | "external_scanner";
}

export interface SettlementService {
  /**
   * Idempotent upsert per (merchant, network, txid, memo hash), the memo group a scanner reports;
   * settles when confirmations reach the minimum. The caller kicks the returned deliveries after
   * this resolves (the transaction has committed).
   */
  applyDetection(
    input: DetectionInput,
  ): Promise<{ outcome: DetectionOutcome; invoiceId: string; deliveryIds: string[] }>;
  /** A `seen` detection whose block was reorged away and whose tx is no longer mined. */
  markOrphaned(detectionId: string): Promise<void>;
  /**
   * Merchant Confirm (`merchant_accept`): of the payer's claim, or, with `txid`, of a payment the
   * merchant found in their own wallet for an invoice that is still open or claimed (when detection
   * is off or cannot read the chain). That txid passes the payer-paste checks first. Either way the
   * tx must be mined with enough confirmations and unused by any other invoice.
   */
  acceptClaim(merchantId: string, invoiceId: string, txid?: string | null): Promise<Invoice>;
  rejectClaim(merchantId: string, invoiceId: string): Promise<Invoice>;
  /** The payer pastes a txid on the pay page (a claim, never a settlement). */
  submitPayerTxid(invoiceId: string, txid: string): Promise<PublicInvoice>;
  /** A merchant-run scanner reports a payment; Shade verifies it on chain, then applyDetection. */
  reportDetection(
    scope: NetworkScope,
    invoiceId: string,
    report: DetectionReport,
  ): Promise<Invoice>;
}

const MEMO_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const POOLS: readonly ShieldedPool[] = ["ironwood", "orchard", "sapling"];
/** agents.md §6.1: expired → paid only when the block time is within 60 minutes after expiry. */
const EXPIRY_GRACE_SEC = 3600;
/** Detection window around the invoice lifetime (matches the hosted detector). */
const WINDOW_BEFORE_CREATED_SEC = 120;
/** Payer paste with an unknown created height: a block more than 10 minutes older is refused. */
const PASTE_SLACK_SEC = 600;
const LOOKUP_CACHE_TTL_MS = 30_000;
const LOOKUP_CACHE_MAX = 1000;
const CHAIN_RETRY_AFTER_SEC = 30;
/**
 * Namespace of the two-key advisory lock that serialises settlement per (merchant, network, txid).
 * Two-key locks never collide with the single bigint key the migration runner uses.
 */
const TXID_LOCK_NAMESPACE = 0x5ade;
/**
 * Unique indexes (migration 0009) that refuse a second settlement of one memo group of a txid, per
 * (merchant, network, txid, memo hash): one transaction pays at most one invoice per memo group. A
 * conflict on them maps a lost race to `txid_in_use` / TXID_IN_USE.
 */
const PAID_TXID_INDEXES = ["invoices_paid_memo_group_unique"];
const DETECTION_TXID_INDEXES = ["invoice_detections_memo_group_unique"];

type Detected = { outcome: DetectionOutcome; deliveryIds: string[] };

function none(outcome: DetectionOutcome): Detected {
  return { outcome, deliveryIds: [] };
}

function isTxidConflict(err: unknown, indexes: readonly string[]): boolean {
  return indexes.some((index) => isUniqueViolation(err, index));
}

/** What a lookup established about a txid; cached per network for 30 s. */
type TxFacts =
  | { kind: "not_found" }
  | { kind: "orphaned" }
  | { kind: "mined"; height: number; receivable: boolean | null }
  | { kind: "mempool"; receivable: boolean | null };

function chainUnavailable(): AppError {
  return new AppError(
    503,
    "CHAIN_UNAVAILABLE",
    "Shade cannot reach the Zcash network right now. Try again in a minute.",
    { retry_after: CHAIN_RETRY_AFTER_SEC },
  );
}

function txNotFound(network: Network): AppError {
  return new AppError(
    404,
    "TX_NOT_FOUND",
    `Shade cannot find that transaction on ${network} yet. ${COPY.lag}`,
  );
}

function notShielded(): AppError {
  return new AppError(
    422,
    "TX_NOT_SHIELDED",
    "That transaction does not pay a shielded address, so it cannot pay this invoice.",
  );
}

function outsideWindow(): AppError {
  return new AppError(
    422,
    "OUTSIDE_WINDOW",
    "That transaction was mined outside this invoice's payment window.",
  );
}

function txidInUse(): AppError {
  return new AppError(409, "TXID_IN_USE", "That transaction already paid another invoice.");
}

function badTxid(message = "A transaction id is 64 hexadecimal characters."): AppError {
  return new AppError(400, "BAD_TXID", message);
}

function factsOf(lookup: TxLookup): TxFacts {
  if (lookup.kind === "not_found") return { kind: "not_found" };
  if (lookup.kind === "orphaned") return { kind: "orphaned" };
  let receivable: boolean | null;
  try {
    receivable = isReceivable(parseTxSummary(lookup.raw));
  } catch {
    receivable = null;
  }
  return lookup.kind === "mined"
    ? { kind: "mined", height: lookup.height, receivable }
    : { kind: "mempool", receivable };
}

async function chainCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ChainUnavailableError) throw chainUnavailable();
    throw err;
  }
}

export function createSettlementService(deps: {
  db: Db;
  config: Config;
  chain: Record<Network, ChainClient>;
  clock: () => Date;
  view: InvoiceView;
  webhooks: WebhookService;
}): SettlementService {
  const { db, config, chain, clock, view, webhooks } = deps;
  const cache = new Map<string, { expiresAt: number; facts: TxFacts }>();

  /** getTransaction with the 30 s per-txid cache (chain failures are never cached). */
  const lookup = async (network: Network, txid: string): Promise<TxFacts> => {
    const key = `${network}:${txid}`;
    const now = clock().getTime();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.facts;
    cache.delete(key);
    const facts = factsOf(await chainCall(() => chain[network].getTransaction(txid)));
    if (cache.size >= LOOKUP_CACHE_MAX) {
      for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
      const oldest = cache.keys().next();
      if (cache.size >= LOOKUP_CACHE_MAX && !oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { expiresAt: now + LOOKUP_CACHE_TTL_MS, facts });
    return facts;
  };

  const blockTime = async (network: Network, height: number): Promise<Date> => {
    const block = await chainCall(() => chain[network].getBlock(height));
    if (!block) throw chainUnavailable();
    return new Date(block.time * 1000);
  };

  /**
   * Payer-paste checks, shared with a merchant's own txid: the transaction exists on the invoice's
   * network (a reversed txid gets its own message), can pay a shielded receiver and, once mined,
   * was mined no earlier than the invoice was created.
   */
  const checkPaymentTx = async (row: InvoiceRow, txid: string): Promise<void> => {
    const network = row.network;
    const facts = await lookup(network, txid);
    if (facts.kind === "not_found") {
      const reversed = await lookup(network, reverseHex(txid));
      if (reversed.kind === "mined" || reversed.kind === "mempool") {
        throw badTxid(
          "That transaction id is in reversed byte order. Copy it again from your wallet or a block explorer.",
        );
      }
      throw txNotFound(network);
    }
    if (facts.kind === "orphaned") {
      throw new AppError(404, "TX_NOT_FOUND", "That transaction is not on the main chain.");
    }
    if (facts.receivable !== true) throw notShielded();
    if (facts.kind === "mined") {
      if (row.created_height !== null) {
        if (facts.height < row.created_height) throw outsideWindow();
      } else {
        const minedAt = await blockTime(network, facts.height);
        const earliest = addSeconds(row.created_at, -PASTE_SLACK_SEC);
        if (minedAt.getTime() < earliest.getTime()) throw outsideWindow();
      }
    }
  };

  /**
   * Taken first in every transaction that can settle `txid` (applyDetection, acceptClaim), so
   * their txid-in-use checks never run against each other's uncommitted writes. Held to commit.
   */
  const lockTxid = async (sql: Sql, merchantId: string, network: Network, txid: string) => {
    await sql.query("select pg_advisory_xact_lock($1, hashtext($2))", [
      TXID_LOCK_NAMESPACE,
      `${merchantId}:${network}:${txid}`,
    ]);
  };

  const lockInvoice = async (sql: Sql, where: string, params: unknown[]) => {
    const [row] = await sql.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from invoices where ${where} for update`,
      params,
    );
    return row ?? null;
  };

  /** Other claims of the same txid revert to open (the payment belongs to the settled invoice). */
  const revertOtherClaims = (sql: Sql, row: InvoiceRow, txid: string) => sql`
    update invoices set status = 'open', claimed_txid = null, verification = null
    where merchant_id = ${row.merchant_id} and network = ${row.network} and id <> ${row.id}
      and status = 'paid_unverified' and claimed_txid = ${txid}`;

  const enqueuePaid = (
    sql: Sql,
    row: InvoiceRow,
    txid: string,
    paidAt: Date,
    verification: "ivk_scan" | "merchant_accept",
  ) =>
    webhooks.enqueueEvent(sql, {
      merchantId: row.merchant_id,
      network: row.network,
      type: "invoice.paid",
      invoiceId: row.id,
      fields: {
        invoice_id: row.id,
        amount_zec: zecText(row.amount_zec),
        memo_hash: row.memo_hash,
        txid,
        paid_at: iso(paidAt),
        verification,
      },
    });

  /**
   * One scanner payment is one memo group of a transaction (the outputs of `txid` to the merchant
   * that carry one memo), so the unit of txid uniqueness is (merchant, network, txid, memo hash):
   * a transaction that pays two invoices with their own memos settles both, and one memo group
   * still settles at most one invoice.
   */
  const settleDetection = async (sql: Sql, input: DetectionInput): Promise<Detected> => {
    await lockTxid(sql, input.merchantId, input.network, input.txid);
    const now = clock();
    const row = await lockInvoice(sql, "id = $1 and merchant_id = $2 and network = $3", [
      input.invoiceId,
      input.merchantId,
      input.network,
    ]);
    if (!row || row.jar_id !== null) throw notFound("invoice");
    if (zatFromNumeric(row.amount_zec) !== input.amountZat || row.memo_hash !== input.memoHash) {
      return none("mismatch");
    }

    const [existing] = await sql<{ id: string; invoice_id: string; state: DetectionState }>`
      select id, invoice_id, state from invoice_detections
      where merchant_id = ${input.merchantId} and network = ${input.network}
        and txid = ${input.txid} and memo_hash = ${input.memoHash}
      for update`;
    if (existing && existing.invoice_id !== row.id) return none("txid_in_use");
    // Another invoice settled by this memo group, or confirmed by the merchant with this txid
    // (merchant_accept never checked the memo), owns the payment.
    const [paidElsewhere] = await sql`
      select 1 from invoices
      where merchant_id = ${input.merchantId} and network = ${input.network}
        and txid = ${input.txid} and id <> ${row.id}
        and (memo_hash = ${input.memoHash} or verification = 'merchant_accept')
      limit 1`;
    if (paidElsewhere) {
      // A `seen` detection of a payment that now belongs elsewhere would otherwise keep this
      // invoice pending forever (no cancel, no expiry, scanned every tick).
      if (existing?.state === "seen") {
        await sql`
          update invoice_detections set state = 'late', updated_at = ${now}
          where id = ${existing.id}`;
      }
      return none("txid_in_use");
    }

    const confirmations =
      input.blockHeight !== null && input.tipHeight !== null
        ? Math.max(0, input.tipHeight - input.blockHeight + 1)
        : null;
    const confirmed =
      confirmations !== null && confirmations >= config.minConfirmations[input.network];
    const status = effectiveStatus(row, now);

    let state: DetectionState;
    if (row.status === "paid") {
      state = existing?.state === "settled" ? "settled" : "settled_after";
    } else if (status === "cancelled") {
      state = "late";
    } else if (status === "expired" && !(await withinGrace(sql, row, input, now))) {
      state = "late";
    } else {
      state = confirmed ? "settled" : "seen";
    }

    if (existing) {
      await sql`
        update invoice_detections
        set pool = ${input.pool}, block_height = ${input.blockHeight},
            block_hash = ${input.blockHash}, block_time = ${input.blockTime},
            confirmations = ${confirmations}, state = ${state}, updated_at = ${now}
        where id = ${existing.id}`;
    } else {
      // The txid lock keeps concurrent writers out; a conflict here means this memo group of the
      // transaction is already recorded on another invoice (one with the same memo hash).
      const inserted = await sql`
        insert into invoice_detections
          (id, merchant_id, invoice_id, network, txid, pool, amount_zec, memo_hash, block_height,
           block_hash, block_time, confirmations, state, source, observed_at, created_at, updated_at)
        values (${newId("det")}, ${input.merchantId}, ${row.id}, ${input.network}, ${input.txid},
                ${input.pool}, ${zatParam(input.amountZat)}, ${input.memoHash}, ${input.blockHeight},
                ${input.blockHash}, ${input.blockTime}, ${confirmations}, ${state}, ${input.source},
                ${now}, ${now}, ${now})
        on conflict do nothing
        returning id`;
      if (inserted.length === 0) return none("txid_in_use");
    }

    if (state !== "settled" || row.status === "paid") return none(state);

    await sql`
      update invoices
      set status = 'paid', verification = 'ivk_scan', txid = ${input.txid}, paid_at = ${now},
          paid_height = ${input.blockHeight},
          claimed_txid = case when claimed_txid = ${input.txid} then claimed_txid else null end
      where id = ${row.id}`;
    await revertOtherClaims(sql, row, input.txid);
    const event = await enqueuePaid(sql, row, input.txid, now, "ivk_scan");
    return { outcome: "settled", deliveryIds: event.deliveryIds };
  };

  const applyDetection: SettlementService["applyDetection"] = async (input) => {
    let result: Detected;
    try {
      result = await db.tx((sql) => settleDetection(sql, input));
    } catch (err) {
      // Backstop for the unique indexes: another settlement of this txid committed first.
      if (!isTxidConflict(err, [...PAID_TXID_INDEXES, ...DETECTION_TXID_INDEXES])) throw err;
      result = none("txid_in_use");
    }
    return { ...result, invoiceId: input.invoiceId };
  };

  /**
   * Expired invoices can still be paid by a scanner within the grace window, unless another live
   * invoice of the merchant expects the same payment.
   */
  const withinGrace = async (sql: Sql, row: InvoiceRow, input: DetectionInput, now: Date) => {
    const deadline = addSeconds(row.expires_at, EXPIRY_GRACE_SEC).getTime();
    const at = input.blockTime ?? now;
    if (at.getTime() > deadline) return false;
    const [competing] = await sql`
      select 1 from invoices
      where merchant_id = ${row.merchant_id} and network = ${row.network} and id <> ${row.id}
        and jar_id is null and memo_hash = ${row.memo_hash} and amount_zec = ${row.amount_zec}
        and status in ('open', 'paid_unverified')
      limit 1`;
    return !competing;
  };

  const loadDto = async (sql: Sql, invoiceId: string): Promise<Invoice> => {
    const invoice = await view.load(sql, invoiceId);
    if (!invoice) throw notFound("invoice");
    return invoice;
  };

  return {
    applyDetection,

    async markOrphaned(detectionId) {
      await db`
        update invoice_detections
        set state = 'orphaned', confirmations = null, updated_at = ${clock()}
        where id = ${detectionId} and state = 'seen'`;
    },

    async acceptClaim(merchantId, invoiceId, ownTxid = null) {
      const [current] = await db.query<InvoiceRow>(
        `select ${INVOICE_COLUMNS} from invoices where id = $1 and merchant_id = $2`,
        [invoiceId, merchantId],
      );
      if (!current || current.jar_id !== null) throw notFound("invoice");
      let txid: string;
      if (ownTxid === null) {
        if (current.status !== "paid_unverified" || current.claimed_txid === null) {
          throw new AppError(
            409,
            "NOT_OPEN",
            "Only an invoice with a payment reported by the payer can be confirmed. Enter the transaction id from your wallet instead.",
          );
        }
        txid = current.claimed_txid;
      } else {
        const parsed = parseTxid(ownTxid);
        if (parsed === null) throw badTxid();
        assertRecordable(current, clock());
        await checkPaymentTx(current, parsed);
        txid = parsed;
      }
      const network = current.network;
      const minConf = config.minConfirmations[network];
      const tx = await chainCall(() => chain[network].getTransaction(txid));
      if (tx.kind === "not_found" || tx.kind === "orphaned") throw txNotFound(network);
      const tip = await chainCall(() => chain[network].getTip());
      const confirmations = tx.kind === "mined" ? tip.height - tx.height + 1 : 0;
      if (tx.kind !== "mined" || confirmations < minConf) {
        throw new AppError(
          409,
          "TX_NOT_MINED",
          `That transaction is not confirmed yet. Confirm it once your wallet shows ${minConf} confirmation${minConf === 1 ? "" : "s"}.`,
        );
      }
      // A recorded payment may settle an invoice past its expiry like a scanner match (§6.1): when
      // the transaction was mined within the grace window. Checked again under the row lock.
      const minedAt = ownTxid === null ? null : await blockTime(network, tx.height);
      const assertInGrace = (row: InvoiceRow, now: Date) => {
        if (minedAt === null || !assertRecordable(row, now)) return;
        if (minedAt.getTime() > addSeconds(row.expires_at, EXPIRY_GRACE_SEC).getTime()) {
          throw new AppError(
            409,
            "EXPIRED",
            "That payment was mined more than an hour after this invoice expired. Settle it with the payer from your wallet.",
          );
        }
      };
      assertInGrace(current, clock());

      try {
        const outcome = await db.tx(async (sql) => {
          await lockTxid(sql, merchantId, network, txid);
          const now = clock();
          const row = await lockInvoice(sql, "id = $1 and merchant_id = $2", [
            invoiceId,
            merchantId,
          ]);
          if (!row) throw notFound("invoice");
          if (ownTxid !== null) {
            assertInGrace(row, now);
          } else if (row.status !== "paid_unverified" || row.claimed_txid !== txid) {
            throw new AppError(409, "NOT_OPEN", "This invoice changed. Reload it and try again.");
          }
          // A merchant_accept checks neither amount nor memo, so the txid must be unused by every
          // other invoice and live detection, whatever their memo group (serialised by lockTxid).
          const [taken] = await sql`
            select 1 from invoices
            where merchant_id = ${merchantId} and network = ${network} and txid = ${txid}
              and id <> ${row.id}
            union all
            select 1 from invoice_detections
            where merchant_id = ${merchantId} and network = ${network} and txid = ${txid}
              and invoice_id <> ${row.id} and state in ('seen', 'settled')
            limit 1`;
          if (taken) throw txidInUse();
          await sql`
            update invoices
            set status = 'paid', verification = 'merchant_accept', txid = ${txid}, paid_at = ${now},
                paid_height = ${tx.height},
                claimed_txid = case when claimed_txid = ${txid} then claimed_txid else null end
            where id = ${row.id}`;
          await revertOtherClaims(sql, row, txid);
          const event = await enqueuePaid(sql, row, txid, now, "merchant_accept");
          return { deliveryIds: event.deliveryIds, invoice: await loadDto(sql, row.id) };
        });
        webhooks.kickDeliveries(outcome.deliveryIds);
        return outcome.invoice;
      } catch (err) {
        if (isTxidConflict(err, PAID_TXID_INDEXES)) throw txidInUse();
        throw err;
      }
    },

    async rejectClaim(merchantId, invoiceId) {
      return db.tx(async (sql) => {
        const row = await lockInvoice(sql, "id = $1 and merchant_id = $2", [invoiceId, merchantId]);
        if (!row || row.jar_id !== null) throw notFound("invoice");
        if (row.status !== "paid_unverified") {
          throw new AppError(409, "NOT_OPEN", "This invoice has no reported payment to reject.");
        }
        await sql`
          update invoices set status = 'open', claimed_txid = null, verification = null
          where id = ${row.id}`;
        return loadDto(sql, row.id);
      });
    },

    async submitPayerTxid(invoiceId, rawTxid) {
      const txid = parseTxid(rawTxid);
      if (txid === null) throw badTxid();
      const [current] = await db.query<InvoiceRow & { display_name: string }>(
        `select ${invoiceColumns("i")}, m.display_name
         from invoices i join merchants m on m.id = i.merchant_id
         where i.id = $1 and i.jar_id is null`,
        [invoiceId],
      );
      if (!current) throw notFound("invoice");
      assertClaimable(current, clock());
      await checkPaymentTx(current, txid);

      return db.tx(async (sql) => {
        const row = await lockInvoice(sql, "id = $1 and jar_id is null", [invoiceId]);
        if (!row) throw notFound("invoice");
        assertClaimable(row, clock());
        await sql`
          update invoices
          set status = 'paid_unverified', verification = 'txid_unverified', claimed_txid = ${txid}
          where id = ${row.id}`;
        const [updated] = await sql.query<InvoiceRow>(
          `select ${INVOICE_COLUMNS} from invoices where id = $1`,
          [row.id],
        );
        if (!updated) throw notFound("invoice");
        const detections = await latestDetections(sql, [row.id]);
        return view.publicInvoice(updated, detections.get(row.id), current.display_name);
      });
    },

    async reportDetection(scope, invoiceId, report) {
      const txid = parseTxid(report.txid);
      if (txid === null) throw badTxid();
      const amountZat = parseZec(report.amount_zec);
      if (amountZat === null) throw badAmount();
      const memoHash = report.memo_hash.trim().toLowerCase();
      if (!MEMO_HASH_PATTERN.test(memoHash)) {
        throw new AppError(
          400,
          "BAD_MEMO_HASH",
          "memo_hash must look like sha256:<64 hex characters>.",
        );
      }
      const pool = POOLS.find((candidate) => candidate === report.pool);
      if (!pool) throw new AppError(400, "BAD_POOL", "pool must be ironwood, orchard or sapling.");

      const network = scope.network;
      const [row] = await db.query<InvoiceRow>(
        `select ${INVOICE_COLUMNS} from invoices
         where id = $1 and merchant_id = $2 and network = $3 and jar_id is null`,
        [invoiceId, scope.merchantId, network],
      );
      if (!row) throw notFound("invoice");
      if (zatFromNumeric(row.amount_zec) !== amountZat) {
        throw new AppError(
          422,
          "AMOUNT_MISMATCH",
          "The detected amount does not match this invoice.",
        );
      }
      if (row.memo_hash !== memoHash) {
        throw new AppError(
          422,
          "MEMO_MISMATCH",
          "The detected memo hash does not match this invoice.",
        );
      }

      // The client's heights and times are ignored: Shade reads them from the chain itself.
      const tx = await chainCall(() => chain[network].getTransaction(txid));
      if (tx.kind === "not_found" || tx.kind === "orphaned") throw txNotFound(network);
      if (!isReceivableTx(tx)) throw notShielded();
      let blockHeight: number | null = null;
      let blockHash: string | null = null;
      let minedAt: Date | null = null;
      let tipHeight: number | null = null;
      if (tx.kind === "mined") {
        const [tip, block] = await Promise.all([
          chainCall(() => chain[network].getTip()),
          chainCall(() => chain[network].getBlock(tx.height)),
        ]);
        if (!block) throw chainUnavailable();
        blockHeight = tx.height;
        blockHash = block.hash;
        minedAt = new Date(block.time * 1000);
        tipHeight = tip.height;
        const earliest = addSeconds(row.created_at, -WINDOW_BEFORE_CREATED_SEC);
        const latest = addSeconds(row.expires_at, EXPIRY_GRACE_SEC);
        const belowCreated = row.created_height !== null && tx.height < row.created_height - 1;
        if (belowCreated || minedAt < earliest || minedAt > latest) throw outsideWindow();
      }

      const result = await applyDetection({
        merchantId: scope.merchantId,
        network,
        invoiceId: row.id,
        txid,
        pool,
        amountZat,
        memoHash,
        blockHeight,
        blockHash,
        blockTime: minedAt,
        tipHeight,
        source: report.source ?? "merchant_device",
      });
      webhooks.kickDeliveries(result.deliveryIds);
      if (result.outcome === "txid_in_use") throw txidInUse();
      if (result.outcome === "mismatch") {
        throw new AppError(409, "NOT_OPEN", "This invoice changed. Reload it and try again.");
      }
      return loadDto(db, row.id);
    },
  };
}

function isReceivableTx(tx: Extract<TxLookup, { raw: Uint8Array }>): boolean {
  try {
    return isReceivable(parseTxSummary(tx.raw));
  } catch {
    return false;
  }
}

/** Payer claims are accepted while the invoice is open (or re-claimed) and not expired. */
/**
 * Record payment (a merchant's own txid): an open or claimed invoice, also past its expiry (then
 * true: the caller checks the transaction was mined within the grace window). Paid and cancelled
 * invoices are refused like a paste.
 */
function assertRecordable(row: InvoiceRow, now: Date): boolean {
  const status = effectiveStatus(row, now);
  if (status === "expired") return true;
  if (status === "paid_unverified") return row.expires_at.getTime() <= now.getTime();
  assertClaimable(row, now);
  return false;
}

function assertClaimable(row: InvoiceRow, now: Date): void {
  const status = effectiveStatus(row, now);
  if (status === "open" || status === "paid_unverified") {
    if (row.expires_at.getTime() > now.getTime()) return;
    throw new AppError(409, "EXPIRED", "This invoice has expired.");
  }
  if (status === "paid") throw new AppError(409, "ALREADY_PAID", "This invoice is already paid.");
  if (status === "expired") throw new AppError(409, "EXPIRED", "This invoice has expired.");
  if (status === "cancelled") throw new AppError(409, "CANCELLED", "This invoice was cancelled.");
  throw notOpen(status);
}
