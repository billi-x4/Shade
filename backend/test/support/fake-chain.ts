/**
 * In-memory chain client and scanner for tests. Refuses to run with NODE_ENV=production.
 * Unset blocks get deterministic hashes and 75-second spacing; tests override them to simulate
 * reorgs, and queue a one-shot failure with failNext().
 */
import { createHash } from "node:crypto";
import type { Network } from "../../src/contract/index.ts";
import { decodeUnified, encodeUnified } from "../../src/zcash/address.ts";
import type { DecodedUnified } from "../../src/zcash/address.ts";
import { concatBytes, encodeCompactSize } from "../../src/zcash/bytes.ts";
import { ChainUnavailableError } from "../../src/zcash/lightwalletd.ts";
import type {
  ChainBlock,
  ChainClient,
  ChainInfo,
  ChainTip,
  TxLookup,
} from "../../src/zcash/lightwalletd.ts";
import { ScannerError } from "../../src/zcash/scanner.ts";
import type { ScannedPayment, Scanner } from "../../src/zcash/scanner.ts";
import type { TxSummary } from "../../src/zcash/tx.ts";
import { txidToProtocolBytes } from "../../src/zcash/txid.ts";

const FAKE_GENESIS_TIME = 1_700_000_000;
const FAKE_BLOCK_SPACING_SEC = 75;
const DEFAULT_TIP_HEIGHT = 1_000;
const NU6_3_BRANCH_ID = 0x37a5165b;

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The fake Zcash chain and scanner are for tests only");
  }
}

function sha256(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest());
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Normalizes a txid the way the real client validates it (64 hex chars, any case). */
function txidKey(txid: string): string {
  txidToProtocolBytes(txid);
  return txid.toLowerCase();
}

type FakeTransaction =
  TxLookup | { kind: "mined" | "mempool"; summary: Partial<TxSummary>; height?: number };

export function createFakeChain(network: Network): ChainClient & {
  setTip(height: number, hash?: string): void;
  setBlock(height: number, block: { hash: string; time: number }): void;
  putTransaction(txid: string, lookup: FakeTransaction): void;
  failNext(err?: Error): void;
} {
  assertNotProduction();
  const blocks = new Map<number, { hash: string; time: number }>();
  const transactions = new Map<string, TxLookup>();
  let tipHeight = DEFAULT_TIP_HEIGHT;
  let pendingFailure: Error | null = null;

  const blockAt = (height: number): { hash: string; time: number } =>
    blocks.get(height) ?? {
      hash: sha256Hex(`shade-fake-block:${network}:${height}`),
      time: FAKE_GENESIS_TIME + height * FAKE_BLOCK_SPACING_SEC,
    };

  const takeFailure = (): void => {
    const failure = pendingFailure;
    pendingFailure = null;
    if (failure) throw failure;
  };

  const copy = (lookup: TxLookup): TxLookup =>
    "raw" in lookup ? { ...lookup, raw: Uint8Array.from(lookup.raw) } : { ...lookup };

  return {
    network,

    async getTip(): Promise<ChainTip> {
      takeFailure();
      return { height: tipHeight, hash: blockAt(tipHeight).hash };
    },

    async getBlock(height: number): Promise<ChainBlock | null> {
      if (!Number.isSafeInteger(height) || height < 1)
        throw new RangeError("Block height must be a positive integer");
      takeFailure();
      if (height > tipHeight) return null;
      return { height, ...blockAt(height) };
    },

    async getTransaction(txid: string): Promise<TxLookup> {
      const key = txidKey(txid);
      takeFailure();
      const lookup = transactions.get(key);
      return lookup ? copy(lookup) : { kind: "not_found" };
    },

    async getInfo(): Promise<ChainInfo> {
      takeFailure();
      return {
        chainName: network === "mainnet" ? "main" : "test",
        blockHeight: tipHeight,
        version: "fake",
        vendor: "Shade fake chain",
        upgradeName: null,
        upgradeHeight: null,
      };
    },

    setTip(height, hash) {
      if (!Number.isSafeInteger(height) || height < 1)
        throw new RangeError("Tip height must be a positive integer");
      tipHeight = height;
      if (hash !== undefined)
        blocks.set(height, { hash: hash.toLowerCase(), time: blockAt(height).time });
    },

    setBlock(height, block) {
      blocks.set(height, { hash: block.hash.toLowerCase(), time: block.time });
    },

    putTransaction(txid, lookup) {
      const key = txidKey(txid);
      if ("summary" in lookup) {
        const raw = buildRawTx(lookup.summary);
        transactions.set(
          key,
          lookup.kind === "mined"
            ? { kind: "mined", height: lookup.height ?? tipHeight, raw }
            : { kind: "mempool", raw },
        );
      } else {
        transactions.set(key, copy(lookup));
      }
    },

    failNext(err) {
      pendingFailure = err ?? new ChainUnavailableError();
    },
  };
}

/** Deterministic Orchard-only address for a fake UFVK (structurally valid, not a real key's). */
function fakeKeyAddress(ufvk: string): string {
  let decoded: DecodedUnified | null;
  try {
    decoded = decodeUnified(ufvk);
  } catch {
    decoded = null;
  }
  if (decoded?.kind !== "ufvk") {
    throw new ScannerError("scan_failed", "Could not derive an address from the viewing key");
  }
  const receiver = concatBytes([
    sha256(`shade-fake-d:${ufvk}`).subarray(0, 11),
    sha256(`shade-fake-pkd:${ufvk}`),
  ]);
  return encodeUnified("address", decoded.network, [{ typecode: 0x03, data: receiver }]);
}

export function createFakeScanner(): Scanner & {
  addPayment(network: Network, ufvk: string, p: ScannedPayment): void;
  setKeyAddress(ufvk: string, address: string): void;
} {
  assertNotProduction();
  const payments: Array<{ network: Network; ufvk: string; payment: ScannedPayment }> = [];
  const keyAddresses = new Map<string, string>();

  return {
    async available() {
      return true;
    },

    async keyAddress(ufvk) {
      return keyAddresses.get(ufvk) ?? fakeKeyAddress(ufvk);
    },

    async *scan({ network, ufvk, fromHeight, toHeight, signal }) {
      if (
        !Number.isSafeInteger(fromHeight) ||
        !Number.isSafeInteger(toHeight) ||
        fromHeight < 1 ||
        fromHeight > toHeight
      ) {
        throw new RangeError("Scan range must be 1 <= fromHeight <= toHeight");
      }
      const matches = payments
        .filter((e) => e.network === network && e.ufvk === ufvk)
        .map((e) => e.payment)
        .filter((p) => p.blockHeight >= fromHeight && p.blockHeight <= toHeight)
        .sort((a, b) => a.blockHeight - b.blockHeight);
      for (const payment of matches) {
        if (signal?.aborted) throw new ScannerError("chain_unavailable", "Scan aborted");
        yield { ...payment };
      }
      if (signal?.aborted) throw new ScannerError("chain_unavailable", "Scan aborted");
    },

    addPayment(network, ufvk, p) {
      payments.push({ network, ufvk, payment: { ...p } });
    },

    setKeyAddress(ufvk, address) {
      keyAddresses.set(ufvk, address);
    },
  };
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function count(summary: Partial<TxSummary>, field: keyof TxSummary): number {
  const value = summary[field] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${field} must be a non-negative integer`);
  return value;
}

function actionBundle(actions: number): Uint8Array {
  if (actions === 0) return encodeCompactSize(0);
  const proofSize = 2720 + 2272 * actions;
  return concatBytes([
    encodeCompactSize(actions),
    new Uint8Array(actions * 820),
    Uint8Array.of(0x03), // enableSpends | enableOutputs
    new Uint8Array(8 + 32), // valueBalance, anchor
    encodeCompactSize(proofSize),
    new Uint8Array(proofSize + actions * 64 + 64), // proofs, spendAuthSigs, bindingSig
  ]);
}

/**
 * Minimal structurally valid v5/v6 transaction bytes with the given part counts (all-zero
 * contents). Defaults: v6, NU6.3 branch id, nothing in any bundle.
 */
export function buildRawTx(summary: Partial<TxSummary>): Uint8Array {
  const version = summary.version ?? 6;
  if (version !== 5 && version !== 6)
    throw new RangeError("buildRawTx builds v5 or v6 transactions");
  const versionGroupId = version === 6 ? 0xd884b698 : 0x26a7270a;
  if (summary.versionGroupId !== undefined && summary.versionGroupId !== versionGroupId) {
    throw new RangeError("versionGroupId does not match the version");
  }
  const inputs = count(summary, "transparentInputs");
  const outputs = count(summary, "transparentOutputs");
  const spends = count(summary, "saplingSpends");
  const saplingOutputs = count(summary, "saplingOutputs");
  const orchard = count(summary, "orchardActions");
  const ironwood = count(summary, "ironwoodActions");
  if (version === 5 && ironwood > 0)
    throw new RangeError("v5 transactions cannot carry Ironwood actions");
  const sapling = spends + saplingOutputs;
  const parts: Uint8Array[] = [
    u32le(0x8000_0000 + version),
    u32le(versionGroupId),
    u32le(summary.branchId ?? NU6_3_BRANCH_ID),
    u32le(0), // lock_time
    u32le(count(summary, "expiryHeight")),
    encodeCompactSize(inputs),
  ];
  for (let i = 0; i < inputs; i++) {
    parts.push(new Uint8Array(32), u32le(i), encodeCompactSize(0), u32le(0xffff_ffff));
  }
  parts.push(encodeCompactSize(outputs));
  for (let i = 0; i < outputs; i++) parts.push(new Uint8Array(8), encodeCompactSize(0));
  parts.push(
    encodeCompactSize(spends),
    new Uint8Array(spends * 96),
    encodeCompactSize(saplingOutputs),
    new Uint8Array(saplingOutputs * 756),
    new Uint8Array((sapling > 0 ? 8 : 0) + (spends > 0 ? 32 : 0)),
    new Uint8Array(spends * (192 + 64) + saplingOutputs * 192 + (sapling > 0 ? 64 : 0)),
    actionBundle(orchard),
  );
  if (version === 6) parts.push(actionBundle(ironwood));
  return concatBytes(parts);
}
