/**
 * Viewing-key scanner: adapter over @ledgerhq/zcash-utils (the only module that loads it, lazily,
 * so the server still boots where the native binary is unavailable).
 *
 * The library trial-decrypts compact blocks for a UFVK and fetches full transactions for matches.
 * This adapter keeps only INCOMING notes, groups them per transaction by memo text and emits one
 * ScannedPayment per group with the memo hash; memo text never leaves this module. Library error
 * text is never propagated (it can carry txids); errors map to fixed ScannerError codes.
 */
import type * as ZcashUtils from "@ledgerhq/zcash-utils";
import type { Network, ShieldedPool } from "../contract/index.ts";
import { decodeUnified } from "./address.ts";
import { memoHash } from "./memo.ts";

export interface ScannedPayment {
  txid: string;
  blockHeight: number;
  blockHash: string;
  /** Unix seconds. */
  blockTime: number;
  pool: ShieldedPool;
  amountZat: bigint;
  memoHash: string;
}

export interface Scanner {
  /** False when the native scanner cannot be loaded on this platform. */
  available(): Promise<boolean>;
  /** The key's default Orchard-only Unified Address (diversifier index 0, external scope). */
  keyAddress(ufvk: string): Promise<string>;
  /**
   * Scans [fromHeight, toHeight] inclusive. Completes only when every block was scanned; an
   * abort, timeout or partial scan ends with a ScannerError, never a silent early end.
   */
  scan(p: {
    network: Network;
    ufvk: string;
    fromHeight: number;
    toHeight: number;
    signal?: AbortSignal;
  }): AsyncIterable<ScannedPayment>;
}

export type ScannerErrorCode = "scan_failed" | "chain_unavailable" | "scanner_unsupported_upgrade";

const DEFAULT_MESSAGES: Record<ScannerErrorCode, string> = {
  scan_failed: "Viewing-key scan failed",
  chain_unavailable: "Zcash light server unavailable during the scan",
  scanner_unsupported_upgrade: "The scanner does not support a recent network upgrade",
};

export class ScannerError extends Error {
  override name = "ScannerError";
  readonly code: ScannerErrorCode;

  constructor(code: ScannerErrorCode, message: string = DEFAULT_MESSAGES[code]) {
    super(message);
    this.code = code;
  }
}

type Library = typeof ZcashUtils;
type ShieldedTransaction = ZcashUtils.ShieldedTransaction;
type ShieldedNote = ZcashUtils.ShieldedNote;

let library: Promise<Library | null> | null = null;

function loadLibrary(): Promise<Library | null> {
  library ??= import("@ledgerhq/zcash-utils").then(
    (mod) => mod,
    () => null,
  );
  return library;
}

async function requireLibrary(): Promise<Library> {
  const lib = await loadLibrary();
  if (!lib) throw new ScannerError("scan_failed", "The scanner is not available on this platform");
  return lib;
}

// The library's consensus parser rejects branch ids it does not know: a newer network upgrade.
const UNSUPPORTED_UPGRADE = /consensus ?branch ?id|bundle version for branch|tx parse failed/i;
const CHAIN_FAILURE =
  /grpc connect failed|stream error|getblockrange|gettransaction failed|getsubtreeroots|transport error|timed out|deadline|unavailable|connection reset|broken pipe|h2 protocol/i;

function toScannerError(err: unknown): ScannerError {
  if (err instanceof ScannerError) return err;
  const text = err instanceof Error ? err.message : "";
  if (UNSUPPORTED_UPGRADE.test(text)) return new ScannerError("scanner_unsupported_upgrade");
  if (CHAIN_FAILURE.test(text)) return new ScannerError("chain_unavailable");
  return new ScannerError("scan_failed");
}

const abortedError = (): ScannerError => new ScannerError("chain_unavailable", "Scan aborted");
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function displayHash(value: unknown): string {
  const hash = typeof value === "string" ? value.toLowerCase() : "";
  if (!HASH_PATTERN.test(hash))
    throw new ScannerError("scan_failed", "Scanner returned a malformed hash");
  return hash;
}

/**
 * One payment per memo group of the transaction's incoming notes. A group whose memo cannot be a
 * ZIP-302 text memo (over 512 bytes as rendered, or not well-formed text) is skipped: memos are
 * sender-controlled (ZIP-310), no Shade invoice can carry one, and failing the pass instead would
 * let one stray payment stop every later scan of this key.
 */
function paymentsOf(
  tx: ShieldedTransaction,
  fromHeight: number,
  toHeight: number,
): ScannedPayment[] {
  const { blockHeight, blockTime } = tx;
  if (!Number.isSafeInteger(blockHeight) || blockHeight < fromHeight || blockHeight > toHeight) {
    throw new ScannerError("scan_failed", "Scanner returned a block outside the requested range");
  }
  if (!Number.isSafeInteger(blockTime) || blockTime <= 0) {
    throw new ScannerError("scan_failed", "Scanner returned a malformed block time");
  }
  const txid = displayHash(tx.txid);
  const blockHash = displayHash(tx.blockHash);
  const groups = new Map<string, { amountZat: bigint; pool: ShieldedPool }>();
  const collect = (notes: readonly ShieldedNote[], pool: ShieldedPool): void => {
    for (const note of notes) {
      if (note.transferType !== "incoming") continue;
      if (!Number.isSafeInteger(note.amount) || note.amount < 0) {
        throw new ScannerError("scan_failed", "Scanner returned a malformed amount");
      }
      const group = groups.get(note.memo) ?? { amountZat: 0n, pool };
      group.amountZat += BigInt(note.amount);
      groups.set(note.memo, group);
    }
  };
  // Pools in preference order: a group spanning pools is labelled with the newest one.
  collect(tx.ironwoodNotes, "ironwood");
  collect(tx.orchardNotes, "orchard");
  collect(tx.saplingNotes, "sapling");
  const payments: ScannedPayment[] = [];
  for (const [memo, { amountZat, pool }] of groups) {
    let hash: string;
    try {
      hash = memoHash(memo);
    } catch {
      continue;
    }
    payments.push({ txid, blockHeight, blockHash, blockTime, pool, amountZat, memoHash: hash });
  }
  return payments;
}

function isOrchardOnlyAddress(address: string): boolean {
  try {
    const decoded = decodeUnified(address);
    return (
      decoded.kind === "address" &&
      decoded.revision === 0 &&
      decoded.items.length === 1 &&
      decoded.items[0]!.typecode === 0x03
    );
  } catch {
    return false;
  }
}

interface ScanParams {
  network: Network;
  ufvk: string;
  fromHeight: number;
  toHeight: number;
  signal?: AbortSignal;
}

async function* scanWithServer(
  lib: Library,
  grpcUrl: string,
  p: ScanParams,
): AsyncGenerator<ScannedPayment> {
  let stream: ZcashUtils.TransactionStream;
  try {
    stream = await lib.startSync({
      grpcUrl,
      viewingKey: p.ufvk,
      startHeight: p.fromHeight,
      endHeight: p.toHeight,
      network: p.network,
      orchardOnly: false,
    });
  } catch (err) {
    throw toScannerError(err);
  }
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    stream.cancel();
  };
  p.signal?.addEventListener("abort", cancel, { once: true });
  if (p.signal?.aborted) cancel();
  let complete = false;
  try {
    for (;;) {
      let tx: ShieldedTransaction | null;
      try {
        tx = await stream.next();
      } catch (err) {
        throw p.signal?.aborted ? abortedError() : toScannerError(err);
      }
      if (p.signal?.aborted) throw abortedError();
      if (tx === null) break;
      yield* paymentsOf(tx, p.fromHeight, p.toHeight);
    }
    // next() ends with null on failure too; only stats() reports whether the scan completed.
    let blocksScanned: number;
    try {
      ({ blocksScanned } = await stream.stats());
    } catch (err) {
      throw p.signal?.aborted ? abortedError() : toScannerError(err);
    }
    if (blocksScanned < p.toHeight - p.fromHeight + 1) {
      throw new ScannerError("chain_unavailable", "Scan ended before the last block");
    }
    complete = true;
  } finally {
    p.signal?.removeEventListener("abort", cancel);
    if (!complete) cancel();
  }
}

/** Scanner over the configured light servers (`urls(network)`, tried in order on chain failures). */
export function createLedgerScanner(opts: { urls: (n: Network) => string[] }): Scanner {
  return {
    async available() {
      return (await loadLibrary()) !== null;
    },

    async keyAddress(ufvk) {
      const lib = await requireLibrary();
      const failed = (): ScannerError =>
        new ScannerError("scan_failed", "Could not derive an address from the viewing key");
      let address: string;
      try {
        address = lib.orchardAddressFromUfvk(ufvk).toLowerCase();
      } catch {
        throw failed();
      }
      if (!isOrchardOnlyAddress(address)) throw failed();
      return address;
    },

    async *scan(p) {
      const { fromHeight, toHeight } = p;
      if (
        !Number.isSafeInteger(fromHeight) ||
        !Number.isSafeInteger(toHeight) ||
        fromHeight < 1 ||
        fromHeight > toHeight
      ) {
        throw new RangeError("Scan range must be 1 <= fromHeight <= toHeight");
      }
      if (p.signal?.aborted) throw abortedError();
      const lib = await requireLibrary();
      const urls = opts.urls(p.network);
      // Payments already yielded from a server that failed mid-scan are not repeated.
      const yielded = new Set<string>();
      let failure = new ScannerError("chain_unavailable");
      for (const url of urls) {
        try {
          for await (const payment of scanWithServer(lib, url, p)) {
            const key = `${payment.txid}|${payment.memoHash}`;
            if (yielded.has(key)) continue;
            yielded.add(key);
            yield payment;
          }
          return;
        } catch (err) {
          failure = toScannerError(err);
          if (failure.code !== "chain_unavailable" || p.signal?.aborted) throw failure;
        }
      }
      throw failure;
    },
  };
}
