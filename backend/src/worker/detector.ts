/**
 * Hosted detection (agents.md §4.8): per (merchant, network) with an active viewing key and live candidate
 * invoices, scan from the cursor (minus the rescan window) to the tip under a lease, match exact
 * amount + memo hash + block window, and settle through the settlement seam.
 *
 * Cost per pass does not grow with a merchant's open invoices: the range is planned from one SQL
 * aggregate and only the candidates carrying a scanned payment's memo hash are loaded to match.
 *
 * Privacy: the viewing key is opened only for the duration of one scan and never logged; the
 * scanner hands over payments without memo text; logs carry key ids and error codes only.
 */
import { randomUUID } from "node:crypto";
import type { Network, ScanErrorCode } from "../contract/index.ts";
import { SealError, openSealed, viewingKeySealContext } from "../platform/crypto.ts";
import type { Logger } from "../platform/logger.ts";
import { ChainUnavailableError, type ChainTip } from "../zcash/lightwalletd.ts";
import { type ScannedPayment, ScannerError } from "../zcash/scanner.ts";
import {
  type CandidateBounds,
  type MatchCandidate,
  type ScanRange,
  chainBlockTime,
  lowestScanHeight,
  matchPayment,
  planScanRange,
  rescanWindow,
  resumeHeight,
} from "./matching.ts";
import {
  type ClaimedViewingKey,
  claimViewingKey,
  listCandidatesByMemoHash,
  listDueViewingKeys,
  recordScanFailure,
  recordScanSuccess,
  releaseViewingKey,
  summarizeCandidates,
} from "./repo.ts";
import type { DetectorTickResult, WorkerDeps } from "./types.ts";

/** A claimed key stays leased this long; the scan timeout keeps every pass well inside it. */
export const SCAN_LEASE_MS = 120_000;
export const SCAN_TIMEOUT_MS = 60_000;
export const MAX_CONCURRENT_SCANS = 2;
/** Keys considered per tick, least recently scanned first; the rest wait for the next tick. */
export const KEYS_PER_TICK = 50;
/** Bounds one pass so a long backlog advances the cursor in steps instead of timing out forever. */
export const MAX_BLOCKS_PER_SCAN = 20_000;
/** A pass that timed out is retried with half its blocks, down to this many (see scanChunks). */
export const MIN_BLOCKS_PER_SCAN = 1_000;
/** A pass ends at least this long before its lease does, however long planning took. */
export const LEASE_MARGIN_MS = 15_000;
/** Lease time a scan needs left after planning to start at all. */
const MIN_SCAN_BUDGET_MS = 5_000;
export const BACKOFF_BASE_MS = 20_000;
export const BACKOFF_MAX_MS = 300_000;

export interface DetectorOptions {
  /** Aborts in-flight scans (worker shutdown); their leases are released without an error. */
  signal?: AbortSignal;
  scanTimeoutMs?: number;
  /**
   * Blocks per pass by viewing-key id, kept across ticks by the worker loop. A pass that times out
   * halves its key's entry, so a backlog the scanner cannot cover in one timeout still advances;
   * each completed pass doubles it back towards {@link MAX_BLOCKS_PER_SCAN}.
   */
  scanChunks?: Map<string, number>;
}

type KeyOutcome =
  | { kind: "skipped" }
  | {
      kind: "scanned";
      seen: number;
      settled: number;
      txidInUse: number;
      lastError: ScanErrorCode | null;
    }
  | { kind: "failed"; code: ScanErrorCode };

/**
 * Codes a successful scan can leave behind: the blocks were covered and the cursor moved, but a
 * match needs the merchant's attention. They never start or lengthen a backoff.
 */
const MATCH_PROBLEMS: readonly ScanErrorCode[] = ["ambiguous_match", "txid_in_use"];

/** Maps any scan failure to the fixed merchant-visible code (never library or server text). */
export function scanErrorCode(err: unknown): ScanErrorCode {
  if (err instanceof SealError) return "key_unavailable";
  if (err instanceof ScannerError) return err.code;
  if (err instanceof ChainUnavailableError) return "chain_unavailable";
  return "scan_failed";
}

/**
 * Exponential backoff after a failed scan: 20 s, doubling up to 5 min. The previous delay is read
 * back from the key's last failure (next_scan_at − last_scan_at), so no extra column is needed. A
 * matching problem from a successful scan ({@link MATCH_PROBLEMS}) is not a failure to double.
 */
export function nextBackoffMs(
  key: Pick<ClaimedViewingKey, "lastError" | "lastScanAt" | "nextScanAt">,
): number {
  if (
    key.lastError !== null &&
    !MATCH_PROBLEMS.some((code) => code === key.lastError) &&
    key.lastScanAt !== null &&
    key.nextScanAt !== null
  ) {
    const previous = key.nextScanAt.getTime() - key.lastScanAt.getTime();
    if (previous > 0) return Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_BASE_MS, previous * 2));
  }
  return BACKOFF_BASE_MS;
}

interface ScanPlan {
  range: ScanRange;
  /** Hash and time of the block at range.to: the cursor saved when the pass succeeds. */
  endHash: string;
  endTime: Date;
}

async function planScan(
  deps: WorkerDeps,
  key: ClaimedViewingKey,
  bounds: CandidateBounds,
  tip: ChainTip,
  maxBlocks: number,
): Promise<ScanPlan | null> {
  const chain = deps.chain[key.network];
  let reorged = false;
  if (key.cursorHeight !== null) {
    const block = await chain.getBlock(key.cursorHeight);
    reorged = block === null || block.hash !== key.cursorHash;
  }
  const rescanBlocks = rescanWindow(deps.config.minConfirmations[key.network]);
  const lo = await lowestScanHeight({
    bounds,
    tipHeight: tip.height,
    resumeFrom: resumeHeight({ cursorHeight: key.cursorHeight, reorged, rescanBlocks }),
    blockTime: chainBlockTime(chain),
  });
  const range = planScanRange({
    lo,
    cursorHeight: key.cursorHeight,
    reorged,
    tipHeight: tip.height,
    rescanBlocks,
    maxBlocks,
  });
  if (range === null) return null;
  // Fetched even when `to` is the tip: its time records how far the scan covered (cursor_time).
  const end = await chain.getBlock(range.to);
  if (end === null) throw new ChainUnavailableError(undefined, "bad_response");
  return { range, endHash: end.hash, endTime: new Date(end.time * 1000) };
}

/** Opens the sealed key and scans; the plaintext key never leaves this function. */
async function scanWithKey(
  deps: WorkerDeps,
  key: ClaimedViewingKey,
  range: ScanRange,
  signal: AbortSignal,
): Promise<ScannedPayment[]> {
  const ufvk = openSealed(
    deps.config.sealPrivateKeys,
    key.sealedKey,
    viewingKeySealContext(key.merchantId, key.network),
  );
  const payments: ScannedPayment[] = [];
  for await (const payment of deps.scanner.scan({
    network: key.network,
    ufvk,
    fromHeight: range.from,
    toHeight: range.to,
    signal,
  })) {
    payments.push(payment);
  }
  return payments;
}

interface SettleSummary {
  seen: number;
  settled: number;
  /** Matches refused: the payment is already recorded on another invoice (e.g. merchant Confirm). */
  txidInUse: number;
  ambiguous: boolean;
}

async function settleMatches(
  deps: WorkerDeps,
  key: ClaimedViewingKey,
  log: Logger,
  payments: readonly ScannedPayment[],
  candidates: readonly MatchCandidate[],
  tip: ChainTip,
  now: Date,
): Promise<SettleSummary> {
  let seen = 0;
  let settled = 0;
  let txidInUse = 0;
  let ambiguous = false;
  const ordered = [...payments].sort((a, b) => a.blockHeight - b.blockHeight);
  for (const payment of ordered) {
    const match = matchPayment(payment, candidates, now);
    if (match.kind === "ambiguous") ambiguous = true;
    if (match.kind !== "match") continue;
    const result = await deps.services.settlement.applyDetection({
      merchantId: key.merchantId,
      network: key.network,
      invoiceId: match.invoiceId,
      txid: payment.txid,
      pool: payment.pool,
      amountZat: payment.amountZat,
      memoHash: payment.memoHash,
      blockHeight: payment.blockHeight,
      blockHash: payment.blockHash,
      blockTime: new Date(payment.blockTime * 1000),
      tipHeight: tip.height,
      source: "shade_worker",
    });
    if (result.deliveryIds.length > 0) deps.services.webhooks.kickDeliveries(result.deliveryIds);
    if (result.outcome === "seen") seen += 1;
    if (result.outcome === "settled") settled += 1;
    if (result.outcome === "txid_in_use") {
      txidInUse += 1;
      // Ids and the code only: never the txid, amount or memo hash next to an invoice id.
      log.warn(
        { code: "txid_in_use", invoice_id: match.invoiceId },
        "a matched payment is already recorded on another invoice; this invoice was not settled",
      );
    }
  }
  return { seen, settled, txidInUse, ambiguous };
}

async function releaseQuietly(deps: WorkerDeps, log: Logger, id: string, lease: string) {
  try {
    await releaseViewingKey(deps.db, { id, lease });
  } catch (err) {
    log.warn({ err }, "could not release the scan lease; it expires on its own");
  }
}

async function processKey(
  deps: WorkerDeps,
  id: string,
  tipFor: (network: Network) => Promise<ChainTip>,
  opts: DetectorOptions,
): Promise<KeyOutcome> {
  const lease = randomUUID();
  const claimedAt = deps.clock();
  const key = await claimViewingKey(deps.db, {
    id,
    lease,
    now: claimedAt,
    lockedUntil: new Date(claimedAt.getTime() + SCAN_LEASE_MS),
  });
  if (key === null) return { kind: "skipped" };
  const log = deps.logger.child({
    component: "detector",
    viewing_key_id: key.id,
    network: key.network,
  });

  let tipHeight: number | null = null;
  let scanTimedOut = false;
  const maxBlocks = opts.scanChunks?.get(key.id) ?? MAX_BLOCKS_PER_SCAN;
  try {
    const summary = await summarizeCandidates(deps.db, key);
    if (summary.count === 0) {
      await releaseViewingKey(deps.db, { id: key.id, lease });
      return { kind: "skipped" };
    }
    const tip = await tipFor(key.network);
    tipHeight = tip.height;
    const plan = await planScan(deps, key, summary, tip, maxBlocks);
    if (plan === null) {
      await releaseViewingKey(deps.db, { id: key.id, lease });
      return { kind: "skipped" };
    }

    // The scan must end inside the lease even when planning (block-time lookups) was slow; with
    // too little lease left it does not start (the light server is slow, not the scan too big).
    const leaseLeftMs =
      claimedAt.getTime() + SCAN_LEASE_MS - LEASE_MARGIN_MS - deps.clock().getTime();
    if (leaseLeftMs < MIN_SCAN_BUDGET_MS) throw new ChainUnavailableError(undefined, "timeout");
    const timeout = AbortSignal.timeout(
      Math.min(opts.scanTimeoutMs ?? SCAN_TIMEOUT_MS, leaseLeftMs),
    );
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let payments: ScannedPayment[];
    try {
      payments = await scanWithKey(deps, key, plan.range, signal);
    } catch (err) {
      scanTimedOut = timeout.aborted && !opts.signal?.aborted;
      throw err;
    }
    if (maxBlocks < MAX_BLOCKS_PER_SCAN) {
      const grown = Math.min(MAX_BLOCKS_PER_SCAN, maxBlocks * 2);
      if (grown === MAX_BLOCKS_PER_SCAN) opts.scanChunks?.delete(key.id);
      else opts.scanChunks?.set(key.id, grown);
    }
    // Matching requires an equal memo hash: these are all the invoices the payments can match.
    const candidates = await listCandidatesByMemoHash(deps.db, {
      merchantId: key.merchantId,
      network: key.network,
      scannedThrough: key.scannedThrough,
      memoHashes: payments.map((payment) => payment.memoHash),
    });
    const outcome = await settleMatches(deps, key, log, payments, candidates, tip, deps.clock());
    // Both are merchant-visible; an ambiguous match (nothing settled) is reported first.
    let lastError: ScanErrorCode | null = null;
    if (outcome.ambiguous) lastError = "ambiguous_match";
    else if (outcome.txidInUse > 0) lastError = "txid_in_use";
    if (outcome.ambiguous) {
      log.warn(
        { code: "ambiguous_match" },
        "a payment matched more than one invoice; none was settled",
      );
    }
    const saved = await recordScanSuccess(deps.db, {
      id: key.id,
      lease,
      now: deps.clock(),
      cursorHeight: plan.range.to,
      cursorHash: plan.endHash,
      cursorTime: plan.endTime,
      tipHeight: tip.height,
      lastError,
    });
    if (!saved) log.warn("scan lease lost before the cursor was saved");
    return {
      kind: "scanned",
      seen: outcome.seen,
      settled: outcome.settled,
      txidInUse: outcome.txidInUse,
      lastError,
    };
  } catch (err) {
    if (opts.signal?.aborted) {
      await releaseQuietly(deps, log, key.id, lease);
      return { kind: "skipped" };
    }
    const code = scanErrorCode(err);
    if (scanTimedOut) {
      opts.scanChunks?.set(key.id, Math.max(MIN_BLOCKS_PER_SCAN, Math.floor(maxBlocks / 2)));
    }
    log.warn({ err, code }, "viewing-key scan failed");
    const failedAt = deps.clock();
    try {
      await recordScanFailure(deps.db, {
        id: key.id,
        lease,
        now: failedAt,
        lastError: code,
        tipHeight,
        nextScanAt: new Date(failedAt.getTime() + nextBackoffMs(key)),
      });
    } catch (writeErr) {
      log.error({ err: writeErr }, "could not record the scan failure");
    }
    return { kind: "failed", code };
  }
}

/**
 * One detector pass over the due viewing keys of every enabled network: one getTip per network,
 * at most {@link MAX_CONCURRENT_SCANS} scans at a time, each key under its own lease.
 */
export async function runDetectorTick(
  deps: WorkerDeps,
  opts: DetectorOptions = {},
): Promise<DetectorTickResult> {
  const now = deps.clock();
  const ids = await listDueViewingKeys(deps.db, {
    networks: deps.config.networks,
    now,
    limit: KEYS_PER_TICK,
  });
  const result: DetectorTickResult = {
    scanned: 0,
    seen: 0,
    settled: 0,
    txidInUse: 0,
    errors: 0,
    lastError: null,
  };
  if (ids.length === 0) return result;

  const tips = new Map<Network, Promise<ChainTip>>();
  const tipFor = (network: Network): Promise<ChainTip> => {
    let tip = tips.get(network);
    if (tip === undefined) {
      tip = deps.chain[network].getTip();
      tips.set(network, tip);
    }
    return tip;
  };

  const queue = [...ids];
  const lanes = Array.from({ length: Math.min(MAX_CONCURRENT_SCANS, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (opts.signal?.aborted) return;
      const outcome = await processKey(deps, id, tipFor, opts);
      if (outcome.kind === "scanned") {
        result.scanned += 1;
        result.seen += outcome.seen;
        result.settled += outcome.settled;
        result.txidInUse += outcome.txidInUse;
        result.lastError = outcome.lastError ?? result.lastError;
      } else if (outcome.kind === "failed") {
        result.errors += 1;
        result.lastError = outcome.code;
      }
    }
  });
  const settledLanes = await Promise.allSettled(lanes);
  const failure = settledLanes.find((lane) => lane.status === "rejected");
  if (failure) throw failure.reason;
  return result;
}
