/**
 * Background worker: independent loops for the detector, promotion, webhook outbox and sweeper.
 * Each loop schedules its next run only after the current one finished (no overlap), adds ±10 %
 * jitter, records a heartbeat, and survives any tick failure. Runs as its own process
 * (bin/worker.ts) or inside the dev server (SHADE_WORKER=inline).
 */
import type { Logger } from "../platform/logger.ts";
import { ChainUnavailableError } from "../zcash/lightwalletd.ts";
import { ScannerError } from "../zcash/scanner.ts";
import { runDetectorTick } from "./detector.ts";
import { runOutboxTick } from "./outbox.ts";
import { runPromotionTick } from "./promotion.ts";
import { type HeartbeatInfo, nextDeliveryDueAt, writeHeartbeat } from "./repo.ts";
import { runSweeperTick } from "./sweeper.ts";
import type { WorkerDeps } from "./types.ts";

export { runDetectorTick } from "./detector.ts";
export { runOutboxTick } from "./outbox.ts";
export { runPromotionTick } from "./promotion.ts";
export { runSweeperTick } from "./sweeper.ts";
export type * from "./types.ts";

export interface WorkerTiming {
  /** Detector and promotion cadence; defaults to SHADE_SCAN_INTERVAL_SEC. */
  scanIntervalMs: number;
  outboxIntervalMs: number;
  /** Upper bound of the outbox idle backoff when no delivery is pending. */
  outboxIdleMaxMs: number;
  sweeperIntervalMs: number;
  /** Delay before each loop's first run (jittered), spreading replicas that start together. */
  startDelayMs: number;
  /** Ceiling of the per-loop backoff after consecutive tick failures. */
  failureBackoffMaxMs: number;
}

export interface WorkerOptions {
  timing?: Partial<WorkerTiming>;
  /** Source of jitter in [0, 1); injectable for tests. */
  random?: () => number;
}

export interface WorkerHandle {
  /** Stops scheduling, aborts in-flight scans and waits for running ticks to finish. */
  stop(): Promise<void>;
}

const JITTER = 0.1;

/** Error code recorded in a heartbeat when a whole tick failed. */
function tickErrorCode(err: unknown): string {
  if (err instanceof ScannerError) return err.code;
  if (err instanceof ChainUnavailableError) return "chain_unavailable";
  return "internal";
}

interface TickReport {
  info: HeartbeatInfo;
  /** Overrides the loop's regular interval for the next run. */
  nextDelayMs?: number;
}

interface LoopSpec {
  name: string;
  intervalMs: number;
  tick: (signal: AbortSignal) => Promise<TickReport>;
}

interface LoopContext {
  deps: WorkerDeps;
  logger: Logger;
  signal: AbortSignal;
  timing: WorkerTiming;
  random: () => number;
}

function jittered(ms: number, random: () => number): number {
  return Math.max(0, Math.round(ms * (1 - JITTER + 2 * JITTER * random())));
}

function startLoop(ctx: LoopContext, spec: LoopSpec): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let failures = 0;
  let stopped = false;

  const heartbeat = async (info: HeartbeatInfo): Promise<void> => {
    try {
      await writeHeartbeat(ctx.deps.db, { name: spec.name, now: ctx.deps.clock(), info });
    } catch (err) {
      ctx.logger.warn({ err, loop: spec.name }, "worker heartbeat failed");
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(
      () => {
        timer = null;
        running = runOnce().finally(() => {
          running = null;
        });
      },
      jittered(delayMs, ctx.random),
    );
  };

  const runOnce = async (): Promise<void> => {
    let delayMs: number;
    try {
      const report = await spec.tick(ctx.signal);
      failures = 0;
      await heartbeat(report.info);
      delayMs = report.nextDelayMs ?? spec.intervalMs;
    } catch (err) {
      failures += 1;
      ctx.logger.error({ err, loop: spec.name }, "worker tick failed");
      await heartbeat({ ok: false, last_error: tickErrorCode(err) });
      delayMs = Math.min(spec.intervalMs * 2 ** failures, ctx.timing.failureBackoffMaxMs);
    }
    schedule(delayMs);
  };

  schedule(ctx.timing.startDelayMs);
  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}

/**
 * Outcome of the most recent tick that did any work: a tick with nothing to scan or promote keeps
 * the previous verdict, so an idle pass never hides the last failure from the heartbeat.
 */
function lastVerdict() {
  let verdict: { ok: boolean; last_error: string | null } = { ok: true, last_error: null };
  return (worked: boolean, errors: number, lastError: string | null) => {
    if (worked) verdict = { ok: errors === 0, last_error: lastError };
    return verdict;
  };
}

function detectorLoop(ctx: LoopContext): LoopSpec {
  const { deps } = ctx;
  // Hosted detection needs the native scanner; without it the other loops still run.
  const available = deps.scanner.available().catch(() => false);
  void available.then((ok) => {
    if (!ok) {
      ctx.logger.warn(
        "hosted detection unavailable: the scanner library cannot load on this platform; running promotion, outbox and sweeper only",
      );
    }
  });
  const verdict = lastVerdict();
  // Per-key pass sizes, kept for the life of this worker (detector.ts DetectorOptions.scanChunks).
  const scanChunks = new Map<string, number>();
  return {
    name: "detector",
    intervalMs: ctx.timing.scanIntervalMs,
    async tick(signal): Promise<TickReport> {
      if (!(await available)) {
        return { info: { ok: true, hosted_detection: false, last_error: null } };
      }
      const result = await runDetectorTick(deps, { signal, scanChunks });
      return {
        info: {
          ...verdict(result.scanned + result.errors > 0, result.errors, result.lastError),
          hosted_detection: true,
          scanned: result.scanned,
          seen: result.seen,
          settled: result.settled,
          txid_in_use: result.txidInUse,
          errors: result.errors,
        },
      };
    },
  };
}

function promotionLoop(ctx: LoopContext): LoopSpec {
  const verdict = lastVerdict();
  return {
    name: "promotion",
    intervalMs: ctx.timing.scanIntervalMs,
    async tick(signal): Promise<TickReport> {
      const result = await runPromotionTick(ctx.deps, { signal });
      return {
        info: {
          ...verdict(result.checked > 0, result.errors, result.lastError),
          checked: result.checked,
          promoted: result.promoted,
          orphaned: result.orphaned,
          errors: result.errors,
        },
      };
    },
  };
}

/**
 * When the outbox polls next. While attempts are being made: every interval. After an empty pass:
 * at the next scheduled retry (never sooner than the interval), or, when nothing is pending at all,
 * after an idle delay that doubles up to the maximum. Deliveries created by the API are attempted
 * right after commit, so the poll only has to serve retries.
 */
export function nextOutboxDelay(p: {
  attempts: number;
  /** Earliest claimable delivery after the pass, or null when none is pending. */
  dueAt: Date | null;
  now: Date;
  idleMs: number;
  intervalMs: number;
  idleMaxMs: number;
}): { delayMs: number; idleMs: number } {
  if (p.attempts > 0) return { delayMs: p.intervalMs, idleMs: p.intervalMs };
  if (p.dueAt === null) {
    const idleMs = Math.min(p.idleMs * 2, p.idleMaxMs);
    return { delayMs: idleMs, idleMs };
  }
  const untilDue = p.dueAt.getTime() - p.now.getTime();
  return {
    delayMs: Math.min(Math.max(untilDue, p.intervalMs), p.idleMaxMs),
    idleMs: p.intervalMs,
  };
}

function outboxLoop(ctx: LoopContext): LoopSpec {
  const { deps, timing } = ctx;
  let idleMs = timing.outboxIntervalMs;
  return {
    name: "outbox",
    intervalMs: timing.outboxIntervalMs,
    async tick(signal): Promise<TickReport> {
      const attempts = await runOutboxTick(deps, { signal });
      const next = nextOutboxDelay({
        attempts,
        dueAt: attempts > 0 ? null : await nextDeliveryDueAt(deps.db),
        now: deps.clock(),
        idleMs,
        intervalMs: timing.outboxIntervalMs,
        idleMaxMs: timing.outboxIdleMaxMs,
      });
      idleMs = next.idleMs;
      return { info: { ok: true, attempts, last_error: null }, nextDelayMs: next.delayMs };
    },
  };
}

function sweeperLoop(ctx: LoopContext): LoopSpec {
  return {
    name: "sweeper",
    intervalMs: ctx.timing.sweeperIntervalMs,
    async tick(): Promise<TickReport> {
      const result = await runSweeperTick(ctx.deps);
      return {
        info: {
          ok: true,
          expired: result.expired,
          rate_limits_purged: result.rateLimitsPurged,
          idempotency_keys_purged: result.idempotencyKeysPurged,
          last_error: null,
        },
      };
    },
  };
}

export function startWorker(deps: WorkerDeps, opts: WorkerOptions = {}): WorkerHandle {
  const timing: WorkerTiming = {
    scanIntervalMs: deps.config.scanIntervalSec * 1000,
    outboxIntervalMs: 2_000,
    outboxIdleMaxMs: 240_000,
    sweeperIntervalMs: 60_000,
    startDelayMs: 1_000,
    failureBackoffMaxMs: 300_000,
    ...opts.timing,
  };
  const logger = deps.logger.child({ component: "worker" });
  const controller = new AbortController();
  const ctx: LoopContext = {
    deps,
    logger,
    signal: controller.signal,
    timing,
    random: opts.random ?? Math.random,
  };
  if (deps.config.sealPrivateKeys.length === 0) {
    logger.warn(
      "VIEWING_KEY_SEAL_PRIVATE_KEYS is not set: uploaded viewing keys cannot be opened and report key_unavailable",
    );
  }
  const loops = [detectorLoop(ctx), promotionLoop(ctx), outboxLoop(ctx), sweeperLoop(ctx)].map(
    (spec) => startLoop(ctx, spec),
  );
  logger.info(
    { networks: deps.config.networks, scan_interval_sec: deps.config.scanIntervalSec },
    "worker started",
  );

  let stopping: Promise<void> | null = null;
  return {
    stop() {
      stopping ??= (async () => {
        controller.abort();
        await Promise.all(loops.map((loop) => loop.stop()));
        logger.info("worker stopped");
      })();
      return stopping;
    },
  };
}
