/**
 * Promotion (agents.md §4.8): every tick, for every `seen` detection of any merchant and source, confirm
 * its block is still on the main chain and re-apply it with the current tip, so the settlement
 * seam settles it once it has enough confirmations. A detection whose block was reorged away is
 * looked up again: mined elsewhere ⇒ re-applied at the new height, otherwise orphaned. A detection
 * recorded from the mempool (no height yet) is looked up again on every tick.
 */
import type { Network } from "../contract/index.ts";
import type { ChainTip } from "../zcash/lightwalletd.ts";
import { parseTxid } from "../zcash/txid.ts";
import { scanErrorCode } from "./detector.ts";
import { type SeenDetection, listSeenDetections } from "./repo.ts";
import type { PromotionTickResult, WorkerDeps } from "./types.ts";

/** Seen detections checked per tick, least recently updated first. */
export const SEEN_PER_TICK = 200;

type Promotion = "settled" | "waiting" | "orphaned";

interface ConfirmedBlock {
  height: number;
  hash: string;
  time: Date;
}

async function reapply(
  deps: WorkerDeps,
  detection: SeenDetection,
  block: ConfirmedBlock,
  tip: ChainTip,
): Promise<Promotion> {
  const result = await deps.services.settlement.applyDetection({
    merchantId: detection.merchantId,
    network: detection.network,
    invoiceId: detection.invoiceId,
    txid: detection.txid,
    pool: detection.pool,
    amountZat: detection.amountZat,
    memoHash: detection.memoHash,
    blockHeight: block.height,
    blockHash: block.hash,
    blockTime: block.time,
    // The block exists, so the chain is at least that tall even if the tip read was older.
    tipHeight: Math.max(tip.height, block.height),
    source: detection.source,
  });
  if (result.deliveryIds.length > 0) deps.services.webhooks.kickDeliveries(result.deliveryIds);
  return result.outcome === "settled" ? "settled" : "waiting";
}

async function promote(
  deps: WorkerDeps,
  detection: SeenDetection,
  tip: ChainTip,
): Promise<Promotion> {
  const chain = deps.chain[detection.network];
  if (detection.blockHeight !== null && detection.blockHash !== null) {
    const block = await chain.getBlock(detection.blockHeight);
    // This light server has not reached the height yet: check again next tick.
    if (block === null) return "waiting";
    if (block.hash === detection.blockHash) {
      return reapply(
        deps,
        detection,
        { height: block.height, hash: block.hash, time: new Date(block.time * 1000) },
        tip,
      );
    }
  }

  // Recorded from the mempool, or its block was reorged away: look the transaction up again.
  const txid = parseTxid(detection.txid);
  const lookup = txid === null ? null : await chain.getTransaction(txid);
  if (lookup?.kind === "mined") {
    const block = await chain.getBlock(lookup.height);
    if (block === null) return "waiting";
    return reapply(
      deps,
      detection,
      { height: block.height, hash: block.hash, time: new Date(block.time * 1000) },
      tip,
    );
  }
  if (lookup?.kind === "mempool" && detection.blockHeight === null) return "waiting";
  await deps.services.settlement.markOrphaned(detection.id);
  return "orphaned";
}

export interface PromotionOptions {
  /** Stops between detections (worker shutdown). */
  signal?: AbortSignal;
}

export async function runPromotionTick(
  deps: WorkerDeps,
  opts: PromotionOptions = {},
): Promise<PromotionTickResult> {
  const detections = await listSeenDetections(deps.db, {
    networks: deps.config.networks,
    limit: SEEN_PER_TICK,
  });
  const result: PromotionTickResult = {
    checked: detections.length,
    promoted: 0,
    orphaned: 0,
    errors: 0,
    lastError: null,
  };
  if (detections.length === 0) return result;

  const log = deps.logger.child({ component: "promotion" });
  const byNetwork = new Map<Network, SeenDetection[]>();
  for (const detection of detections) {
    byNetwork.set(detection.network, [...(byNetwork.get(detection.network) ?? []), detection]);
  }

  for (const [network, group] of byNetwork) {
    let tip: ChainTip;
    try {
      tip = await deps.chain[network].getTip();
    } catch (err) {
      const code = scanErrorCode(err);
      result.errors += group.length;
      result.lastError = code;
      log.warn({ err, code, network }, "promotion skipped: chain tip unavailable");
      continue;
    }
    for (const detection of group) {
      if (opts.signal?.aborted) return result;
      try {
        const outcome = await promote(deps, detection, tip);
        if (outcome === "settled") result.promoted += 1;
        if (outcome === "orphaned") result.orphaned += 1;
      } catch (err) {
        const code = scanErrorCode(err);
        result.errors += 1;
        result.lastError = code;
        log.warn({ err, code, detection_id: detection.id }, "promotion check failed");
      }
    }
  }
  return result;
}
