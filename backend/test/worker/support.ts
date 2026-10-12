/** Test harness for the worker: migrated in-memory PGlite, fake chain/scanner, fake services. */
import { Writable } from "node:stream";
import type { DetectionSource, Network, ShieldedPool } from "../../src/contract/index.ts";
import { type Config, loadConfig } from "../../src/platform/config.ts";
import {
  fingerprint,
  generateSealKeyPair,
  sealKid,
  sealTo,
  viewingKeySealContext,
} from "../../src/platform/crypto.ts";
import type { Db } from "../../src/platform/db.ts";
import { createLogger } from "../../src/platform/logger.ts";
import { createTestDb } from "../support/test-db.ts";
import { type CandidateScope, claimViewingKey, releaseViewingKey } from "../../src/worker/repo.ts";
import type {
  DetectionInput,
  DetectionOutcome,
  WorkerDeps,
  WorkerServices,
} from "../../src/worker/types.ts";
import { encodeUnified } from "../../src/zcash/address.ts";
import { chainMemo, memoHash, newMemoRef } from "../../src/zcash/memo.ts";
import { formatZat } from "../../src/zcash/money.ts";
import { type ScannedPayment, type Scanner, ScannerError } from "../../src/zcash/scanner.ts";
import { createFakeChain, createFakeScanner } from "../support/fake-chain.ts";
import { hex, loadVectors } from "../zcash/fixtures.ts";

/**
 * The fake chain gives unset blocks the time 1_700_000_000 + 75 × height. TIP is chosen so those
 * default times land in late September 2026, and the test clock sits 30 s after the tip block.
 */
export const TIP = 1_200_000;
export const blockTime = (height: number): number => 1_700_000_000 + 75 * height;
export const NOW = new Date((blockTime(TIP) + 30) * 1000);
export const MERCHANT = "mer_test";
export const OTHER_MERCHANT = "mer_other";

const ORCHARD_FVK = loadVectors("unified_full_viewing_keys.json").find(
  (row) => typeof row.orchard_fvk_bytes === "string",
)?.orchard_fvk_bytes as string;

/** A testnet UFVK carrying the Orchard full viewing key of the first ZIP-316 test vector. */
export const UFVK = encodeUnified("ufvk", "testnet", [{ typecode: 0x03, data: hex(ORCHARD_FVK) }]);
export const KEY_ADDRESS = "utest1fakekeyaddress";

export const hash = (label: string | number): string =>
  Buffer.from(String(label).padEnd(32, "#").slice(0, 32)).toString("hex");
export const txid = (n: number): string => n.toString(16).padStart(64, "a");

export type FakeChain = ReturnType<typeof createFakeChain>;
export type FakeScanner = ReturnType<typeof createFakeScanner>;

export interface FakeServices {
  services: WorkerServices;
  applied: DetectionInput[];
  orphaned: string[];
  kicked: string[][];
  /** Decides each applyDetection outcome; default: seen until min confirmations, then settled. */
  decide: (input: DetectionInput) => DetectionOutcome;
  deliverDue: (limit?: number) => Promise<number>;
  deliverDueCalls: Array<number | undefined>;
}

export function createFakeServices(minConfirmations: number): FakeServices {
  const fake: FakeServices = {
    applied: [],
    orphaned: [],
    kicked: [],
    deliverDueCalls: [],
    decide: (input) =>
      input.blockHeight !== null &&
      input.tipHeight !== null &&
      input.tipHeight - input.blockHeight + 1 >= minConfirmations
        ? "settled"
        : "seen",
    deliverDue: async () => 0,
    services: {
      settlement: {
        applyDetection: async (input) => {
          fake.applied.push(input);
          const outcome = fake.decide(input);
          return {
            outcome,
            invoiceId: input.invoiceId,
            deliveryIds: outcome === "settled" ? [`dlv_${input.invoiceId}`] : [],
          };
        },
        markOrphaned: async (detectionId) => {
          fake.orphaned.push(detectionId);
        },
      },
      webhooks: {
        kickDeliveries: (ids) => {
          fake.kicked.push(ids);
        },
        deliverDue: (limit) => {
          fake.deliverDueCalls.push(limit);
          return fake.deliverDue(limit);
        },
      },
    },
  };
  return fake;
}

type ScanParams = Parameters<Scanner["scan"]>[0];
type ScanImpl = (p: ScanParams) => AsyncIterable<ScannedPayment>;

/**
 * Wraps a scanner to record every scan call. `next` queues one-shot replacements for the following
 * scans (failures, hangs); `available` can be switched off.
 */
export function recordingScanner(inner: Scanner): Scanner & {
  scans: Array<{ network: Network; ufvk: string; fromHeight: number; toHeight: number }>;
  next: ScanImpl[];
  unavailable: boolean;
} {
  const wrapper = {
    scans: [] as Array<{ network: Network; ufvk: string; fromHeight: number; toHeight: number }>,
    next: [] as ScanImpl[],
    unavailable: false,
    available: async () => !wrapper.unavailable && (await inner.available()),
    keyAddress: (ufvk: string) => inner.keyAddress(ufvk),
    scan(p: ScanParams): AsyncIterable<ScannedPayment> {
      wrapper.scans.push({
        network: p.network,
        ufvk: p.ufvk,
        fromHeight: p.fromHeight,
        toHeight: p.toHeight,
      });
      const replacement = wrapper.next.shift();
      return replacement ? replacement(p) : inner.scan(p);
    },
  };
  return wrapper;
}

/** A scan that fails with `err` before yielding anything. */
export function failingScan(err: Error): ScanImpl {
  return async function* () {
    yield* [];
    throw err;
  };
}

/**
 * A scan that waits until `release()` is called or its signal aborts (then fails the way the real
 * scanner does). `started` resolves once the scan is running.
 */
export function blockingScan(): {
  impl: ScanImpl;
  started: Promise<void>;
  release: () => void;
} {
  let markStarted: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release: () => release(),
    impl: async function* (p) {
      markStarted();
      await new Promise<void>((resolve, reject) => {
        void released.then(resolve);
        p.signal?.addEventListener(
          "abort",
          () => reject(new ScannerError("chain_unavailable", "Scan aborted")),
          { once: true },
        );
      });
      yield* [];
    },
  };
}

export interface Harness {
  db: Db;
  config: Config;
  deps: WorkerDeps;
  chain: { testnet: FakeChain; mainnet: FakeChain };
  fakeScanner: FakeScanner;
  scanner: ReturnType<typeof recordingScanner>;
  fake: FakeServices;
  sealPublicKey: Uint8Array;
  logLines: string[];
  now: { value: Date };
  close(): Promise<void>;
}

export async function createHarness(
  opts: { minConfirmations?: number; networks?: Network[] } = {},
): Promise<Harness> {
  const db = await createTestDb();
  const seal = generateSealKeyPair();
  const minConfirmations = opts.minConfirmations ?? 1;
  const config: Config = {
    ...loadConfig({ NODE_ENV: "test" }),
    networks: opts.networks ?? ["testnet"],
    minConfirmations: { testnet: minConfirmations, mainnet: 10 },
    sealPublicKey: seal.publicKey,
    sealPrivateKeys: [seal.privateKey],
  };
  const logLines: string[] = [];
  const logger = createLogger(
    { logLevel: "debug", env: "test" },
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        logLines.push(chunk.toString("utf8"));
        done();
      },
    }),
  );
  const chain = { testnet: createFakeChain("testnet"), mainnet: createFakeChain("mainnet") };
  chain.testnet.setTip(TIP);
  chain.mainnet.setTip(TIP);
  const fakeScanner = createFakeScanner();
  const scanner = recordingScanner(fakeScanner);
  const fake = createFakeServices(minConfirmations);
  const now = { value: NOW };
  const deps: WorkerDeps = {
    db,
    config,
    logger,
    services: fake.services,
    scanner,
    chain,
    clock: () => now.value,
  };
  await insertMerchant(db, MERCHANT);
  await insertMerchant(db, OTHER_MERCHANT);
  return {
    db,
    config,
    deps,
    chain,
    fakeScanner,
    scanner,
    fake,
    sealPublicKey: seal.publicKey,
    logLines,
    now,
    close: () => db.close(),
  };
}

export async function insertMerchant(db: Db, id: string): Promise<void> {
  const userId = `usr_${id}`;
  await db.query(
    `insert into "user" (id, name, email, "emailVerified") values ($1, '', $2, true)`,
    [userId, `${id}@example.test`],
  );
  await db.query(
    `insert into merchants (id, user_id, display_name, network) values ($1, $2, '', 'testnet')`,
    [id, userId],
  );
}

export interface InvoiceFixture {
  id: string;
  merchantId?: string;
  network?: Network;
  status?: string;
  amountZat?: bigint;
  memo?: string;
  /** Defaults to a unique on-chain memo; null marks a legacy row (no memo_ref). */
  memoRef?: string | null;
  createdAt?: Date;
  expiresAt?: Date;
  createdHeight?: number | null;
  jarId?: string | null;
}

/** Inserts an invoice and returns its memo hash. */
export async function insertInvoice(db: Db, f: InvoiceFixture): Promise<string> {
  const memoRef = f.memoRef === undefined ? newMemoRef() : f.memoRef;
  const memo = f.memo ?? "";
  const onChainMemo = chainMemo(memo, memoRef);
  const memoHashValue = memoHash(onChainMemo);
  const createdAt = f.createdAt ?? new Date(NOW.getTime() - 10 * 60_000);
  await db.query(
    `insert into invoices
       (id, merchant_id, jar_id, amount_zec, memo, memo_hash, network, address, zip321, status,
        expires_at, created_at, memo_ref, chain_memo, created_height)
     values ($1, $2, $3, $4, $5, $6, $7, 'utest1merchant', 'zcash:utest1merchant', $8, $9, $10,
             $11, $12, $13)`,
    [
      f.id,
      f.merchantId ?? MERCHANT,
      f.jarId ?? null,
      formatZat(f.amountZat ?? 1_000_000n),
      memo,
      memoHashValue,
      f.network ?? "testnet",
      f.status ?? "open",
      f.expiresAt ?? new Date(createdAt.getTime() + 60 * 60_000),
      createdAt,
      memoRef,
      onChainMemo,
      f.createdHeight === undefined ? TIP - 8 : f.createdHeight,
    ],
  );
  return memoHashValue;
}

export async function insertJar(db: Db, id: string, merchantId = MERCHANT): Promise<void> {
  await db.query(
    `insert into jars (id, merchant_id, label, cap_zec, address, network)
     values ($1, $2, 'agent', 1, 'utest1merchant', 'testnet')`,
    [id, merchantId],
  );
}

export interface ViewingKeyFixture {
  id: string;
  merchantId?: string;
  network?: Network;
  ufvk?: string;
  /** Seal to this public key instead of the worker's (e.g. an unknown kid). */
  sealPublicKey?: Uint8Array;
  cursorHeight?: number | null;
  cursorHash?: string | null;
  /** Block time at the cursor; defaults to the fake chain's time of cursorHeight. */
  cursorTime?: Date | null;
  lastError?: string | null;
  lastScanAt?: Date | null;
  nextScanAt?: Date | null;
  scanLockedUntil?: Date | null;
  scanLease?: string | null;
  revokedAt?: Date | null;
  /** Upload time; defaults to the test clock's NOW. */
  createdAt?: Date;
}

export async function insertViewingKey(
  h: Pick<Harness, "db" | "sealPublicKey">,
  f: ViewingKeyFixture,
): Promise<void> {
  const merchantId = f.merchantId ?? MERCHANT;
  const network = f.network ?? "testnet";
  const publicKey = f.sealPublicKey ?? h.sealPublicKey;
  const ufvk = f.ufvk ?? UFVK;
  const cursorHeight = f.cursorHeight ?? null;
  const cursorTime =
    f.cursorTime !== undefined
      ? f.cursorTime
      : cursorHeight === null
        ? null
        : new Date(blockTime(cursorHeight) * 1000);
  await h.db.query(
    `insert into merchant_viewing_keys
       (id, merchant_id, network, sealed_key, seal_kid, fingerprint, key_address, cursor_height,
        cursor_hash, last_error, last_scan_at, next_scan_at, scan_locked_until, scan_lease,
        revoked_at, cursor_time, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
    [
      f.id,
      merchantId,
      network,
      sealTo(publicKey, ufvk, viewingKeySealContext(merchantId, network)),
      sealKid(publicKey),
      fingerprint(ufvk),
      KEY_ADDRESS,
      cursorHeight,
      f.cursorHash ?? null,
      f.lastError ?? null,
      f.lastScanAt ?? null,
      f.nextScanAt ?? null,
      f.scanLockedUntil ?? null,
      f.scanLease ?? null,
      f.revokedAt ?? null,
      cursorTime,
      f.createdAt ?? NOW,
    ],
  );
}

export interface ViewingKeyState {
  cursor_height: number | null;
  cursor_hash: string | null;
  cursor_time: Date | null;
  tip_height: number | null;
  last_error: string | null;
  last_scan_at: Date | null;
  next_scan_at: Date | null;
  scan_locked_until: Date | null;
  scan_lease: string | null;
}

/** A key's candidate scope as the detector reads it: claims its scan lease and gives it back. */
export async function candidateScope(db: Db, id: string): Promise<CandidateScope> {
  const lease = "lease_candidate_scope";
  const key = await claimViewingKey(db, {
    id,
    lease,
    now: NOW,
    lockedUntil: new Date(NOW.getTime() + 60_000),
  });
  if (key === null) throw new Error(`viewing key ${id} could not be claimed`);
  await releaseViewingKey(db, { id, lease });
  return { merchantId: key.merchantId, network: key.network, scannedThrough: key.scannedThrough };
}

export async function viewingKeyState(db: Db, id: string): Promise<ViewingKeyState> {
  const rows = await db.query<ViewingKeyState>(
    `select cursor_height, cursor_hash, cursor_time, tip_height, last_error, last_scan_at,
            next_scan_at, scan_locked_until, scan_lease
     from merchant_viewing_keys where id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error(`no viewing key ${id}`);
  return rows[0];
}

export interface DetectionFixture {
  id: string;
  invoiceId: string;
  merchantId?: string;
  network?: Network;
  txid: string;
  pool?: ShieldedPool;
  amountZat?: bigint;
  memoHash: string;
  blockHeight: number | null;
  blockHash: string | null;
  blockTime?: Date | null;
  state?: string;
  source?: DetectionSource;
}

export async function insertDetection(db: Db, f: DetectionFixture): Promise<void> {
  await db.query(
    `insert into invoice_detections
       (id, merchant_id, invoice_id, txid, pool, amount_zec, memo_hash, block_height, observed_at,
        source, network, block_hash, block_time, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      f.id,
      f.merchantId ?? MERCHANT,
      f.invoiceId,
      f.txid,
      f.pool ?? "ironwood",
      formatZat(f.amountZat ?? 1_000_000n),
      f.memoHash,
      f.blockHeight,
      NOW,
      f.source ?? "shade_worker",
      f.network ?? "testnet",
      f.blockHash,
      f.blockTime ?? null,
      f.state ?? "seen",
    ],
  );
}

/** A scanned payment for `memoHashValue`, mined at `height` (default fake block time and hash). */
export function payment(
  chain: FakeChain,
  p: { txid: string; height: number; memoHash: string; amountZat?: bigint; time?: number },
): Promise<ScannedPayment> {
  return chain.getBlock(p.height).then((block) => {
    if (!block) throw new Error(`no block ${p.height}`);
    return {
      txid: p.txid,
      blockHeight: p.height,
      blockHash: block.hash,
      blockTime: p.time ?? block.time,
      pool: "ironwood",
      amountZat: p.amountZat ?? 1_000_000n,
      memoHash: p.memoHash,
    };
  });
}
