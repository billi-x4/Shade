/**
 * The worker's own SQL. Business time always arrives as a parameter; viewing-key cursor and status
 * writes are guarded by the scan lease, so a worker that lost its lease cannot move a cursor.
 */
import type { DetectionSource, Network, ShieldedPool } from "../contract/index.ts";
import type { Db, Sql } from "../platform/db.ts";
import { zatFromNumeric } from "../zcash/money.ts";
import {
  CANDIDATE_RETENTION_MS,
  type CandidateBounds,
  type CandidateStatus,
  type MatchCandidate,
} from "./matching.ts";

export interface ClaimedViewingKey {
  id: string;
  merchantId: string;
  network: Network;
  /** Sealed envelope; only the worker's private keys open it. */
  sealedKey: string;
  cursorHeight: number | null;
  cursorHash: string | null;
  lastError: string | null;
  lastScanAt: Date | null;
  nextScanAt: Date | null;
  /**
   * How far its successful scans have covered, in chain time (see {@link SCANNED_THROUGH}); read
   * with the lease, so it holds for the whole pass.
   */
  scannedThrough: Date | null;
}

/** Whose candidates to read: a claimed key's merchant, network and scan progress. */
export type CandidateScope = Pick<ClaimedViewingKey, "merchantId" | "network" | "scannedThrough">;

export interface SeenDetection {
  id: string;
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
  source: DetectionSource;
}

/**
 * How far the successful scans of the viewing key aliased `k` have covered, in chain time
 * (matching.ts `isCandidate`): the block time at its cursor. A key that has never scanned starts
 * from its first upload (`scan_from`, carried when the same key is uploaded again; else its own
 * created_at), as a first pass looks back only to the candidates of that moment; a cursor
 * without a recorded time is unknown (null).
 */
const SCANNED_THROUGH =
  "(case when k.cursor_height is null then coalesce(k.scan_from, k.created_at) " +
  "else k.cursor_time end)";

/*
 * Candidacy (agents.md §4.8) for invoices aliased `i`: non-jar, open or claimed, or expired and not yet
 * covered by a successful scan up to expiry plus the candidate retention. Tied to scan progress
 * rather than `now`, so a payment mined before expiry is still matched when detection recovers
 * after an outage or a backlog. The two parts are kept apart so each reads a range of one index
 * (merchant, network, status | expires_at): the cost of a pass follows the candidates, not every
 * invoice a merchant has ever let expire.
 */

/** Open and payer-claimed non-jar invoices: always candidates. */
const LIVE_CANDIDATE = "i.jar_id is null and i.status in ('open', 'paid_unverified')";

/**
 * The `expires_at` an expired invoice must exceed to still be a candidate, given an SQL expression
 * for the scanned-through time. Unknown progress (null) keeps every expired invoice.
 */
const expiredCutoff = (scannedThrough: string): string =>
  `coalesce(${scannedThrough} - interval '${CANDIDATE_RETENTION_MS / 1000} seconds', '-infinity')`;

/** Expired non-jar invoices that scans up to `scannedThrough` have not covered yet. */
const expiredCandidate = (scannedThrough: string): string =>
  `i.jar_id is null and i.status = 'expired' and i.expires_at > ${expiredCutoff(scannedThrough)}`;

/** Every candidate, given an SQL expression for the scanned-through time. */
const candidateFilter = (scannedThrough: string): string =>
  `((${LIVE_CANDIDATE}) or (${expiredCandidate(scannedThrough)}))`;

/**
 * Active viewing keys that are neither leased nor backing off and have at least one candidate
 * invoice, least recently scanned first. The expired part compares the latest expiry with the
 * cutoff, which one backward index read answers however many invoices have expired.
 */
export async function listDueViewingKeys(
  db: Db,
  p: { networks: readonly Network[]; now: Date; limit: number },
): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select k.id
     from merchant_viewing_keys k
     where k.revoked_at is null
       and k.network = any($1::text[])
       and (k.scan_locked_until is null or k.scan_locked_until < $2)
       and (k.next_scan_at is null or k.next_scan_at <= $2)
       and (exists (
              select 1 from invoices i
              where i.merchant_id = k.merchant_id and i.network = k.network and ${LIVE_CANDIDATE}
            )
            or (select max(i.expires_at) from invoices i
                where i.merchant_id = k.merchant_id and i.network = k.network
                  and i.jar_id is null and i.status = 'expired')
               > ${expiredCutoff(SCANNED_THROUGH)})
     order by k.last_scan_at asc nulls first, k.id
     limit $3`,
    [[...p.networks], p.now, p.limit],
  );
  return rows.map((row) => row.id);
}

interface ViewingKeyRow {
  id: string;
  merchant_id: string;
  network: Network;
  sealed_key: string;
  cursor_height: number | null;
  cursor_hash: string | null;
  last_error: string | null;
  last_scan_at: Date | null;
  next_scan_at: Date | null;
  scanned_through: Date | null;
}

/** Lease claim (agents.md §4.8); null when the key is revoked, leased elsewhere or backing off. */
export async function claimViewingKey(
  db: Db,
  p: { id: string; lease: string; now: Date; lockedUntil: Date },
): Promise<ClaimedViewingKey | null> {
  const rows = await db.query<ViewingKeyRow>(
    `update merchant_viewing_keys k
     set scan_locked_until = $3, scan_lease = $2
     where k.id = $1
       and k.revoked_at is null
       and (k.scan_locked_until is null or k.scan_locked_until < $4)
       and (k.next_scan_at is null or k.next_scan_at <= $4)
     returning k.id, k.merchant_id, k.network, k.sealed_key, k.cursor_height, k.cursor_hash,
               k.last_error, k.last_scan_at, k.next_scan_at, ${SCANNED_THROUGH} as scanned_through`,
    [p.id, p.lease, p.lockedUntil, p.now],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    merchantId: row.merchant_id,
    network: row.network,
    sealedKey: row.sealed_key,
    cursorHeight: row.cursor_height,
    cursorHash: row.cursor_hash,
    lastError: row.last_error,
    lastScanAt: row.last_scan_at,
    nextScanAt: row.next_scan_at,
    scannedThrough: row.scanned_through,
  };
}

/** Gives the lease back without touching cursor or status (nothing to scan, or shutting down). */
export async function releaseViewingKey(db: Db, p: { id: string; lease: string }): Promise<void> {
  await db.query(
    `update merchant_viewing_keys set scan_locked_until = null, scan_lease = null
     where id = $1 and scan_lease = $2`,
    [p.id, p.lease],
  );
}

/**
 * A fully successful scan: the cursor moves to (height, hash, block time), backoff clears and the
 * lease is released. `lastError` is null or a matching problem (ambiguous_match, txid_in_use).
 * False when the lease was lost. Only this write sets cursor_time, so it always describes covered
 * blocks.
 */
export async function recordScanSuccess(
  db: Db,
  p: {
    id: string;
    lease: string;
    now: Date;
    cursorHeight: number;
    cursorHash: string;
    /** Block time of the block at cursorHeight. */
    cursorTime: Date;
    tipHeight: number;
    lastError: string | null;
  },
): Promise<boolean> {
  const rows = await db.query(
    `update merchant_viewing_keys
     set cursor_height = $3, cursor_hash = $4, cursor_time = $8, tip_height = $5, last_scan_at = $6,
         last_error = $7, next_scan_at = null, scan_locked_until = null, scan_lease = null,
         updated_at = $6
     where id = $1 and scan_lease = $2 and revoked_at is null
     returning id`,
    [p.id, p.lease, p.cursorHeight, p.cursorHash, p.tipHeight, p.now, p.lastError, p.cursorTime],
  );
  return rows.length > 0;
}

/** A failed scan: cursor unchanged, error code recorded, next attempt at `nextScanAt`. */
export async function recordScanFailure(
  db: Db,
  p: {
    id: string;
    lease: string;
    now: Date;
    lastError: string;
    tipHeight: number | null;
    nextScanAt: Date;
  },
): Promise<boolean> {
  const rows = await db.query(
    `update merchant_viewing_keys
     set last_error = $3, tip_height = coalesce($4::bigint, tip_height), last_scan_at = $5,
         next_scan_at = $6, scan_locked_until = null, scan_lease = null, updated_at = $5
     where id = $1 and scan_lease = $2 and revoked_at is null
     returning id`,
    [p.id, p.lease, p.lastError, p.tipHeight, p.now, p.nextScanAt],
  );
  return rows.length > 0;
}

export interface CandidateSummary extends CandidateBounds {
  /** How many invoices a payment can still settle (the key's candidates, agents.md §4.8). */
  count: number;
}

/**
 * Plans a pass without loading candidates: one aggregate over the same rule that made the key due
 * (how many there are, the lowest recorded creation height, the earliest creation time of those
 * without one). Memory stays constant however many invoices a merchant keeps open.
 */
export async function summarizeCandidates(db: Db, p: CandidateScope): Promise<CandidateSummary> {
  const rows = await db.query<{
    n: number;
    lowest_height: number | null;
    earliest_unknown: Date | null;
  }>(
    `select count(*)::int as n,
            min(c.created_height) as lowest_height,
            min(c.created_at) filter (where c.created_height is null) as earliest_unknown
     from (
       select i.created_height, i.created_at from invoices i
       where i.merchant_id = $1 and i.network = $2 and ${LIVE_CANDIDATE}
       union all
       select i.created_height, i.created_at from invoices i
       where i.merchant_id = $1 and i.network = $2 and ${expiredCandidate("$3::timestamptz")}
     ) c`,
    [p.merchantId, p.network, p.scannedThrough],
  );
  const row = rows[0];
  return {
    count: row?.n ?? 0,
    lowestCreatedHeight: row?.lowest_height ?? null,
    earliestUnknownCreatedAt: row?.earliest_unknown ?? null,
  };
}

interface CandidateRow {
  id: string;
  status: CandidateStatus;
  amount_zec: string;
  memo_hash: string;
  created_at: Date;
  expires_at: Date;
  created_height: number | null;
}

/**
 * Candidates (agents.md §4.8) of a viewing key that carry one of `memoHashes`: its merchant's non-jar
 * invoices on its network that a payment can still settle, under the same rule that made the key
 * due. Matching needs an equal memo hash, so these are every invoice the scanned payments can
 * match, and loading them costs what was found rather than what is open. Each v1 invoice has its
 * own memo (unique per merchant and network); only legacy rows can share one.
 */
export async function listCandidatesByMemoHash(
  db: Db,
  p: CandidateScope & { memoHashes: readonly string[] },
): Promise<MatchCandidate[]> {
  const memoHashes = [...new Set(p.memoHashes)];
  if (memoHashes.length === 0) return [];
  const rows = await db.query<CandidateRow>(
    `select i.id, i.status, i.amount_zec, i.memo_hash, i.created_at, i.expires_at, i.created_height
     from invoices i
     where i.merchant_id = $1 and i.network = $2 and i.memo_hash = any($4::text[])
       and ${candidateFilter("$3::timestamptz")}
     order by i.created_at, i.id`,
    [p.merchantId, p.network, p.scannedThrough, memoHashes],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amountZat: zatFromNumeric(row.amount_zec),
    memoHash: row.memo_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdHeight: row.created_height,
  }));
}

interface SeenRow {
  id: string;
  merchant_id: string;
  network: Network;
  invoice_id: string;
  txid: string;
  pool: ShieldedPool;
  amount_zec: string;
  memo_hash: string;
  block_height: number | null;
  block_hash: string | null;
  block_time: Date | null;
  source: DetectionSource;
}

/** Detections waiting for confirmations (any merchant, any source), least recently touched first. */
export async function listSeenDetections(
  db: Db,
  p: { networks: readonly Network[]; limit: number },
): Promise<SeenDetection[]> {
  const rows = await db.query<SeenRow>(
    `select id, merchant_id, network, invoice_id, txid, pool, amount_zec, memo_hash, block_height,
            block_hash, block_time, source
     from invoice_detections
     where state = 'seen' and network = any($1::text[])
     order by updated_at, id
     limit $2`,
    [[...p.networks], p.limit],
  );
  return rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    network: row.network,
    invoiceId: row.invoice_id,
    txid: row.txid,
    pool: row.pool,
    amountZat: zatFromNumeric(row.amount_zec),
    memoHash: row.memo_hash,
    blockHeight: row.block_height,
    blockHash: row.block_hash,
    blockTime: row.block_time,
    source: row.source,
  }));
}

export type HeartbeatInfo = Record<string, string | number | boolean | null>;

export async function writeHeartbeat(
  db: Db,
  p: { name: string; now: Date; info: HeartbeatInfo },
): Promise<void> {
  await db.query(
    `insert into worker_heartbeats (name, last_seen_at, info) values ($1, $2, $3::jsonb)
     on conflict (name) do update set last_seen_at = excluded.last_seen_at, info = excluded.info`,
    [p.name, p.now, JSON.stringify(p.info)],
  );
}

/**
 * Expires up to `limit` open invoices past `expires_at` that have no `seen` detection. The rows are
 * locked first (skipping any a settlement holds) and the detection check is repeated by a second
 * statement, whose fresh snapshot sees every detection committed before the locks were taken.
 * Returns how many rows were selected and how many expired.
 */
export async function expireOverdueInvoices(
  db: Db,
  p: { now: Date; limit: number },
): Promise<{ selected: number; expired: number }> {
  return db.tx(async (sql: Sql) => {
    const due = await sql<{ id: string }>`
      select i.id from invoices i
      where i.status = 'open' and i.expires_at <= ${p.now}
        and not exists (
          select 1 from invoice_detections d where d.invoice_id = i.id and d.state = 'seen'
        )
      order by i.expires_at, i.id
      limit ${p.limit}
      for update of i skip locked`;
    if (due.length === 0) return { selected: 0, expired: 0 };
    const expired = await sql<{ id: string }>`
      update invoices i set status = 'expired'
      where i.id = any(${due.map((row) => row.id)}::text[])
        and i.status = 'open'
        and not exists (
          select 1 from invoice_detections d where d.invoice_id = i.id and d.state = 'seen'
        )
      returning i.id`;
    return { selected: due.length, expired: expired.length };
  });
}

async function countDeleted(db: Db, statement: string, cutoff: Date): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `with deleted as (${statement} returning 1) select count(*) as n from deleted`,
    [cutoff],
  );
  return rows[0]?.n ?? 0;
}

/** Fixed-window rate-limit counters whose window started before `cutoff`. */
export function purgeRateLimits(db: Db, cutoff: Date): Promise<number> {
  return countDeleted(db, "delete from rate_limits where window_start < $1", cutoff);
}

/** Stored idempotent responses created before `cutoff`. */
export function purgeIdempotencyKeys(db: Db, cutoff: Date): Promise<number> {
  return countDeleted(db, "delete from idempotency_keys where created_at < $1", cutoff);
}

/** The earliest moment a webhook delivery becomes claimable, or null when none is pending. */
export async function nextDeliveryDueAt(db: Db): Promise<Date | null> {
  const rows = await db.query<{ due: Date | null }>(
    `select least(
       (select min(next_attempt_at) from webhook_deliveries where status in ('pending', 'failed')),
       (select min(locked_until) from webhook_deliveries where status = 'in_flight')
     ) as due`,
  );
  return rows[0]?.due ?? null;
}
