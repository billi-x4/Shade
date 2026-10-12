import type { Network, ScanErrorCode } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import type { Db } from "../platform/db.ts";
import type { Logger } from "../platform/logger.ts";
import type { SettlementService } from "../services/settlement.ts";
import type { WebhookService } from "../services/webhooks.ts";
import type { ChainClient } from "../zcash/lightwalletd.ts";
import type { Scanner } from "../zcash/scanner.ts";

export type { DetectionInput, DetectionOutcome } from "../services/settlement.ts";

/**
 * The slice of `Services` (seams C) the worker calls. The worker reads its own rows (worker/repo.ts)
 * but moves invoices only through the settlement seam and delivers webhooks only through the
 * webhook service, which owns signing and SSRF-safe egress.
 */
export interface WorkerServices {
  settlement: Pick<SettlementService, "applyDetection" | "markOrphaned">;
  webhooks: Pick<WebhookService, "kickDeliveries" | "deliverDue">;
}

export interface WorkerDeps {
  db: Db;
  config: Config;
  logger: Logger;
  services: WorkerServices;
  scanner: Scanner;
  chain: Record<Network, ChainClient>;
  /** Business time; passed into SQL as a parameter. */
  clock: () => Date;
}

export interface DetectorTickResult {
  /** Viewing keys whose scan completed. */
  scanned: number;
  seen: number;
  settled: number;
  /** Matches not settled because their payment is already recorded on another invoice. */
  txidInUse: number;
  /** Viewing keys whose scan failed (cursor unchanged, backoff set). */
  errors: number;
  lastError: ScanErrorCode | null;
}

export interface PromotionTickResult {
  /** Seen detections looked at this tick. */
  checked: number;
  promoted: number;
  orphaned: number;
  errors: number;
  lastError: ScanErrorCode | null;
}

export interface SweeperTickResult {
  expired: number;
  rateLimitsPurged: number;
  idempotencyKeysPurged: number;
}
