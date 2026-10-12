/**
 * Webhook outbox drain: delivers due attempts in batches through the webhook service (which owns the
 * lease claim, signing and SSRF-safe egress) until a batch finds nothing or the time budget is spent.
 */
import type { WorkerDeps } from "./types.ts";

export const OUTBOX_BATCH_SIZE = 25;
export const OUTBOX_BUDGET_MS = 30_000;

export interface OutboxOptions {
  batchSize?: number;
  budgetMs?: number;
  /** Stops between batches (worker shutdown). */
  signal?: AbortSignal;
  /** Monotonic milliseconds; injectable for tests. */
  monotonicNow?: () => number;
}

/** Returns the number of delivery attempts made. */
export async function runOutboxTick(deps: WorkerDeps, opts: OutboxOptions = {}): Promise<number> {
  const batchSize = opts.batchSize ?? OUTBOX_BATCH_SIZE;
  const budgetMs = opts.budgetMs ?? OUTBOX_BUDGET_MS;
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  let attempts = 0;
  for (;;) {
    const batch = await deps.services.webhooks.deliverDue(batchSize);
    attempts += batch;
    if (batch === 0 || opts.signal?.aborted || monotonicNow() - startedAt >= budgetMs) {
      return attempts;
    }
  }
}
