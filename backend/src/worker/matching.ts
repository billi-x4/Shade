/**
 * Payment matching and scan-range planning, shared by the hosted detector and the merchant-device
 * scanner (bin/scan-local.ts). Matching compares memo hashes, never memo text. Everything here is
 * pure except `lowestScanHeight`, which reads block times through the lookup it is given.
 */
import { type ChainClient, ChainUnavailableError } from "../zcash/lightwalletd.ts";

/** Invoice statuses that can still be paid by a scanned payment (agents.md §4.8 candidates). */
export type CandidateStatus = "open" | "paid_unverified" | "expired";

export interface MatchCandidate {
  id: string;
  status: CandidateStatus;
  amountZat: bigint;
  memoHash: string;
  createdAt: Date;
  expiresAt: Date;
  /** Chain tip when the invoice was created; null when the chain was unreachable then. */
  createdHeight: number | null;
}

export interface MatchablePayment {
  blockHeight: number;
  /** Unix seconds. */
  blockTime: number;
  amountZat: bigint;
  memoHash: string;
}

export type MatchResult =
  | { kind: "none" }
  | { kind: "match"; invoiceId: string }
  | { kind: "ambiguous"; invoiceIds: string[] };

/** A payment may be mined at most this long before the invoice was created (clock skew). */
export const EARLY_WINDOW_MS = 120_000;
/** Expired invoices settle from payments mined up to this long after expiry. */
export const EXPIRY_GRACE_MS = 60 * 60_000;
/**
 * An expired invoice stays a candidate until a successful scan has covered the chain this long past
 * its expiry, in block time: the grace window plus slack for block-time skew.
 */
export const CANDIDATE_RETENTION_MS = 70 * 60_000;
/**
 * Rescan this far back when the block at the cursor no longer matches (reorg). NU7 (ZIP 218) raised
 * the consensus reorg limit from 99 to 600 blocks along with 25 s blocks; 600 covers both.
 */
export const REORG_RESCAN_BLOCKS = 600;
/** `lo` sits this many blocks below the earliest candidate's creation height (agents.md §4.8). */
export const LO_MARGIN_BLOCKS = 2;
/**
 * Block timestamps are not monotonic: consensus only requires each one to exceed the median of the
 * 11 before it (and stay within 90 minutes of that median). A search by timestamp can therefore land
 * a few blocks late, so a creation height found that way is lowered by this many blocks.
 */
export const TIMESTAMP_MARGIN_BLOCKS = 12;

function inWindow(candidate: MatchCandidate, payment: MatchablePayment): boolean {
  if (candidate.createdHeight !== null && payment.blockHeight < candidate.createdHeight - 1) {
    return false;
  }
  const minedAt = payment.blockTime * 1000;
  return (
    minedAt >= candidate.createdAt.getTime() - EARLY_WINDOW_MS &&
    minedAt <= candidate.expiresAt.getTime() + EXPIRY_GRACE_MS
  );
}

/** Open and not yet past expiry, or a payer-claimed invoice awaiting proof. */
function isLive(candidate: MatchCandidate, now: Date): boolean {
  return (
    candidate.status === "paid_unverified" ||
    (candidate.status === "open" && candidate.expiresAt.getTime() > now.getTime())
  );
}

/**
 * Matches one scanned payment against a merchant's candidate invoices: equal memo hash, exact
 * amount, and the block window (height ≥ created_height − 1 when known; block time within
 * [created_at − 120 s, expires_at + 60 min]). An expired invoice is only chosen when no live invoice
 * matches. More than one remaining match is ambiguous and settles nothing.
 */
export function matchPayment(
  payment: MatchablePayment,
  candidates: readonly MatchCandidate[],
  now: Date,
): MatchResult {
  const hits = candidates.filter(
    (candidate) =>
      candidate.memoHash === payment.memoHash &&
      candidate.amountZat === payment.amountZat &&
      inWindow(candidate, payment),
  );
  if (hits.length === 0) return { kind: "none" };
  const live = hits.filter((candidate) => isLive(candidate, now));
  const pool = live.length > 0 ? live : hits;
  if (pool.length === 1) return { kind: "match", invoiceId: pool[0]!.id };
  return { kind: "ambiguous", invoiceIds: pool.map((candidate) => candidate.id) };
}

/**
 * Candidacy (agents.md §4.8). Open and claimed invoices always qualify. An expired invoice qualifies until a
 * successful scan has covered the chain up to its expiry plus {@link CANDIDATE_RETENTION_MS}:
 * `scannedThrough` is the block time at the scan cursor (where a first scan starts: now), or null
 * when that is unknown, which keeps every expired invoice. Measuring progress in chain time, not
 * wall-clock time, keeps a payment found by a scan that lagged behind (outage, backlog, a scanner
 * run every few hours).
 */
export function isCandidate(candidate: MatchCandidate, scannedThrough: Date | null): boolean {
  return (
    candidate.status !== "expired" ||
    scannedThrough === null ||
    candidate.expiresAt.getTime() > scannedThrough.getTime() - CANDIDATE_RETENTION_MS
  );
}

/** Unix seconds of the block at `height` (1 ≤ height ≤ tip); rejects when the chain cannot answer. */
export type BlockTimeLookup = (height: number) => Promise<number>;

/**
 * Block times read from a light server. No block at a height at or below the tip that server
 * reported is a bad answer, so the lookup fails (and the pass with it) instead of guessing.
 */
export function chainBlockTime(chain: Pick<ChainClient, "getBlock">): BlockTimeLookup {
  return async (height) => {
    const block = await chain.getBlock(height);
    if (block === null) throw new ChainUnavailableError(undefined, "bad_response");
    return block.time;
  };
}

/**
 * Searches heights `lowest`..`highest` (1 ≤ lowest ≤ highest) for the last block whose time is at or
 * before `atSec`: gallops down from `highest` (recent heights are the usual answer), then bisects.
 * Returns `lowest − 1` when even block `lowest` is later (0 when every block is). Timestamps are not
 * monotonic, so the result is one height h with time(h) ≤ atSec < time(h + 1) (a block above
 * `highest` counts as later), not necessarily the last; callers widen it by
 * {@link TIMESTAMP_MARGIN_BLOCKS}. About 2·log2(highest − result) lookups.
 */
export async function lastBlockAtOrBefore(
  blockTime: BlockTimeLookup,
  atSec: number,
  lowest: number,
  highest: number,
): Promise<number> {
  // Invariant: `before` is at or before atSec (or below the range), `after` is later (or above it).
  let before = lowest - 1;
  let after = highest + 1;
  if (lowest > 1) {
    if ((await blockTime(lowest)) > atSec) return lowest - 1;
    before = lowest;
  }
  for (let step = 1; after - step > before; step *= 2) {
    const probe = after - step;
    if ((await blockTime(probe)) <= atSec) {
      before = probe;
      break;
    }
    after = probe;
  }
  while (after - before > 1) {
    const mid = before + Math.floor((after - before) / 2);
    if ((await blockTime(mid)) <= atSec) before = mid;
    else after = mid;
  }
  return before;
}

/** Where a pass with a cursor resumes: `cursor − R`, or `cursor − 600` after a reorg; null without one. */
export function resumeHeight(p: {
  cursorHeight: number | null;
  reorged: boolean;
  rescanBlocks: number;
}): number | null {
  if (p.cursorHeight === null) return null;
  return p.cursorHeight - (p.reorged ? REORG_RESCAN_BLOCKS : p.rescanBlocks);
}

/**
 * What {@link lowestScanHeight} needs to know about a candidate set. The hosted detector reads it
 * with one SQL aggregate, so planning a pass never loads the candidates themselves.
 */
export interface CandidateBounds {
  /** Lowest recorded creation height; null when no candidate has one. */
  lowestCreatedHeight: number | null;
  /** Earliest `created_at` among candidates without a recorded height; null when there are none. */
  earliestUnknownCreatedAt: Date | null;
}

/** {@link CandidateBounds} of candidates already in memory (the merchant-device scanner). */
export function candidateBounds(
  candidates: readonly Pick<MatchCandidate, "createdHeight" | "createdAt">[],
): CandidateBounds {
  let lowestCreatedHeight: number | null = null;
  let earliestUnknownMs: number | null = null;
  for (const candidate of candidates) {
    if (candidate.createdHeight !== null) {
      lowestCreatedHeight =
        lowestCreatedHeight === null
          ? candidate.createdHeight
          : Math.min(lowestCreatedHeight, candidate.createdHeight);
    } else {
      const createdMs = candidate.createdAt.getTime();
      earliestUnknownMs =
        earliestUnknownMs === null ? createdMs : Math.min(earliestUnknownMs, createdMs);
    }
  }
  return {
    lowestCreatedHeight,
    earliestUnknownCreatedAt: earliestUnknownMs === null ? null : new Date(earliestUnknownMs),
  };
}

/**
 * `lo` (agents.md §4.8): the lowest height any candidate can be paid at, minus a 2-block margin. Uses the
 * lowest recorded creation height; for invoices without one, the chain is searched once (for the
 * earliest of them) for the last block mined before `created_at − 120 s`, lowered by
 * {@link TIMESTAMP_MARGIN_BLOCKS}. There is no block-spacing estimate: spacing varies far too much
 * (testnet bursts of seconds per block) for one to be a safe bound.
 *
 * `resumeFrom` is where the pass starts anyway when it has a cursor ({@link resumeHeight}). A `lo`
 * at or below it plans the same range, so the search then only checks whether the creation height
 * lies above it (one lookup, or none). The result is exact whenever it is above `resumeFrom`.
 * A failed lookup rejects: the pass fails and is retried rather than scanning from a guess.
 */
export async function lowestScanHeight(p: {
  bounds: CandidateBounds;
  tipHeight: number;
  resumeFrom: number | null;
  blockTime: BlockTimeLookup;
}): Promise<number> {
  const { lowestCreatedHeight, earliestUnknownCreatedAt } = p.bounds;
  let lowest =
    lowestCreatedHeight === null ? p.tipHeight : Math.min(p.tipHeight, lowestCreatedHeight);
  const lo = (): number => Math.max(1, lowest - LO_MARGIN_BLOCKS);
  if (earliestUnknownCreatedAt === null) return lo();
  const earliestUnknownMs = earliestUnknownCreatedAt.getTime();
  if (p.resumeFrom !== null && lo() <= p.resumeFrom) return lo();

  // A found height at or below searchFrom − 1 puts `lo` at or below resumeFrom: no need to know it.
  const searchFrom =
    p.resumeFrom === null
      ? 1
      : Math.max(1, p.resumeFrom + TIMESTAMP_MARGIN_BLOCKS + LO_MARGIN_BLOCKS + 1);
  const atSec = Math.floor((earliestUnknownMs - EARLY_WINDOW_MS) / 1000);
  const created =
    searchFrom > p.tipHeight
      ? searchFrom - 1
      : await lastBlockAtOrBefore(p.blockTime, atSec, searchFrom, p.tipHeight);
  lowest = Math.min(lowest, created - TIMESTAMP_MARGIN_BLOCKS);
  return lo();
}

/** `R` (agents.md §4.8): blocks re-scanned behind the cursor on every pass. */
export function rescanWindow(minConfirmations: number): number {
  return Math.max(10, minConfirmations + 2);
}

export interface ScanRange {
  from: number;
  to: number;
}

/**
 * Blocks to scan this pass: from `lo` on the first pass, else from `cursor − R` (or `cursor − 600`
 * after a reorg), never below `lo`, up to the tip but at most `maxBlocks` blocks so a long backlog
 * still makes progress inside the scan timeout. Null when there is nothing to scan (the light server
 * is behind the cursor).
 */
export function planScanRange(p: {
  lo: number;
  cursorHeight: number | null;
  reorged: boolean;
  tipHeight: number;
  rescanBlocks: number;
  maxBlocks: number;
}): ScanRange | null {
  const resume = resumeHeight(p);
  const start = resume === null ? p.lo : Math.max(p.lo, resume);
  const from = Math.max(1, start);
  if (from > p.tipHeight) return null;
  return { from, to: Math.min(p.tipHeight, from + p.maxBlocks - 1) };
}
