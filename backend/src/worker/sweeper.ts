/**
 * Housekeeping: writes `expired` for open invoices past expiry (skipping any with a payment being
 * confirmed), and purges rate-limit windows older than 1 h and idempotency records older than 24 h.
 */
import { expireOverdueInvoices, purgeIdempotencyKeys, purgeRateLimits } from "./repo.ts";
import type { SweeperTickResult, WorkerDeps } from "./types.ts";

export const EXPIRE_BATCH_SIZE = 500;
/** Bounds one tick; anything left over is expired on the next one. */
export const EXPIRE_MAX_BATCHES = 20;
export const RATE_LIMIT_RETENTION_MS = 60 * 60_000;
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;

export async function runSweeperTick(deps: WorkerDeps): Promise<SweeperTickResult> {
  const now = deps.clock();
  let expired = 0;
  for (let batch = 0; batch < EXPIRE_MAX_BATCHES; batch += 1) {
    const result = await expireOverdueInvoices(deps.db, { now, limit: EXPIRE_BATCH_SIZE });
    expired += result.expired;
    if (result.selected < EXPIRE_BATCH_SIZE) break;
  }
  const rateLimitsPurged = await purgeRateLimits(
    deps.db,
    new Date(now.getTime() - RATE_LIMIT_RETENTION_MS),
  );
  const idempotencyKeysPurged = await purgeIdempotencyKeys(
    deps.db,
    new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS),
  );
  return { expired, rateLimitsPurged, idempotencyKeysPurged };
}
