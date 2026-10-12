import { describe, expect, it, vi } from "vitest";
import { encodeUnified } from "../../src/zcash/address.ts";
import { memoHash } from "../../src/zcash/memo.ts";
import { ScannerError, createLedgerScanner } from "../../src/zcash/scanner.ts";
import type { ScannedPayment } from "../../src/zcash/scanner.ts";

interface Behavior {
  transactions: unknown[];
  startError?: Error;
  statsError?: Error;
  blocksScanned?: number;
  /** next() blocks until cancel() is called. */
  hang?: boolean;
}

const lib = vi.hoisted(() => ({
  behaviors: new Map<string, Behavior>(),
  calls: [] as Array<Record<string, unknown>>,
  cancels: 0,
  address: "",
  addressError: null as Error | null,
}));

vi.mock("@ledgerhq/zcash-utils", () => ({
  startSync: async (params: { grpcUrl: string; startHeight: number; endHeight: number }) => {
    lib.calls.push(params);
    const behavior = lib.behaviors.get(params.grpcUrl) ?? { transactions: [] };
    if (behavior.startError) throw behavior.startError;
    let index = 0;
    let cancelled = false;
    let wake: (() => void) | null = null;
    return {
      async next() {
        if (behavior.hang && !cancelled) await new Promise<void>((resolve) => (wake = resolve));
        if (cancelled) return null;
        return behavior.transactions[index++] ?? null;
      },
      cancel() {
        cancelled = true;
        lib.cancels++;
        wake?.();
      },
      async stats() {
        if (cancelled) throw new Error("sync task was dropped before completing");
        if (behavior.statsError) throw behavior.statsError;
        const blocksScanned = behavior.blocksScanned ?? params.endHeight - params.startHeight + 1;
        return { blocksScanned, elapsedMs: 1, spentKnownNullifiers: [] };
      },
    };
  },
  orchardAddressFromUfvk: () => {
    if (lib.addressError) throw lib.addressError;
    return lib.address;
  },
}));

const A = "https://a.example:443";
const B = "https://b.example:443";
const MEMO = "order 7 (shade:7K3MZ9QA)";

function reset(behaviors: Record<string, Behavior> = {}): void {
  lib.behaviors = new Map(Object.entries(behaviors));
  lib.calls = [];
  lib.cancels = 0;
  lib.addressError = null;
}

const note = (amount: number, memo: string, transferType = "incoming") => ({
  amount,
  memo,
  transferType,
  pool: "?",
  isSpent: false,
});

function shieldedTx(p: {
  txid?: string;
  height?: number;
  sapling?: unknown[];
  orchard?: unknown[];
  ironwood?: unknown[];
}) {
  return {
    txid: p.txid ?? "AB".repeat(32),
    hex: "",
    blockHeight: p.height ?? 105,
    blockHash: "CD".repeat(32),
    blockTime: 1_790_000_000,
    fee: 10_000,
    transparentOut: 0,
    hasTransparentInputs: false,
    saplingNotes: p.sapling ?? [],
    orchardNotes: p.orchard ?? [],
    ironwoodNotes: p.ironwood ?? [],
  };
}

const scanner = (urls = [A, B]) => createLedgerScanner({ urls: () => urls });
const params = {
  network: "testnet" as const,
  ufvk: "uviewtest1fake",
  fromHeight: 100,
  toHeight: 110,
};

async function collect(iterable: AsyncIterable<ScannedPayment>): Promise<ScannedPayment[]> {
  const out: ScannedPayment[] = [];
  for await (const payment of iterable) out.push(payment);
  return out;
}

async function scanError(iterable: AsyncIterable<ScannedPayment>): Promise<ScannerError> {
  const err = await collect(iterable).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScannerError);
  return err as ScannerError;
}

describe("createLedgerScanner: payments", () => {
  it("emits one payment per memo group of incoming notes, without memo text", async () => {
    reset({
      [A]: {
        transactions: [
          shieldedTx({
            ironwood: [
              note(100_000, MEMO),
              note(50_000, MEMO),
              note(7, "change", "internal"),
              note(9, "sent", "outgoing"),
            ],
            orchard: [note(30, MEMO)],
            sapling: [note(20, "other")],
          }),
        ],
      },
    });
    const payments = await collect(scanner().scan(params));
    expect(payments).toEqual([
      {
        txid: "ab".repeat(32),
        blockHeight: 105,
        blockHash: "cd".repeat(32),
        blockTime: 1_790_000_000,
        pool: "ironwood",
        amountZat: 150_030n,
        memoHash: memoHash(MEMO),
      },
      {
        txid: "ab".repeat(32),
        blockHeight: 105,
        blockHash: "cd".repeat(32),
        blockTime: 1_790_000_000,
        pool: "sapling",
        amountZat: 20n,
        memoHash: memoHash("other"),
      },
    ]);
    const serialized = JSON.stringify(payments, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialized).not.toContain("order 7");
    expect(serialized).not.toContain("other");
  });

  it("labels Orchard-only groups as orchard and skips transactions without incoming notes", async () => {
    reset({
      [A]: {
        transactions: [
          shieldedTx({ orchard: [note(5, "x")] }),
          shieldedTx({ ironwood: [note(9, "y", "outgoing")] }),
        ],
      },
    });
    const payments = await collect(scanner().scan(params));
    expect(payments.map((p) => [p.pool, p.amountZat])).toEqual([["orchard", 5n]]);
  });

  it("passes the scan range and key to the library", async () => {
    reset();
    await collect(scanner().scan(params));
    expect(lib.calls).toEqual([
      {
        grpcUrl: A,
        viewingKey: "uviewtest1fake",
        startHeight: 100,
        endHeight: 110,
        network: "testnet",
        orchardOnly: false,
      },
    ]);
  });

  it("skips a memo group that cannot be a text memo, keeping the rest of the transaction", async () => {
    // A lossy rendering of a binary memo: 200 replacement characters are 600 UTF-8 bytes.
    reset({
      [A]: {
        transactions: [
          shieldedTx({ ironwood: [note(3, "�".repeat(200)), note(4, MEMO)] }),
          shieldedTx({ txid: "02".repeat(32), ironwood: [note(5, String.fromCharCode(0xd800))] }),
        ],
      },
    });
    const payments = await collect(scanner().scan(params));
    expect(payments.map((p) => [p.amountZat, p.memoHash])).toEqual([[4n, memoHash(MEMO)]]);
  });

  it.each([
    ["a malformed txid", shieldedTx({ txid: "xyz", ironwood: [note(1, "m")] })],
    ["a block outside the range", shieldedTx({ height: 111, ironwood: [note(1, "m")] })],
    ["an unsafe amount", shieldedTx({ ironwood: [note(2 ** 53, "m")] })],
    ["a negative amount", shieldedTx({ ironwood: [note(-1, "m")] })],
  ])("fails the scan on %s", async (_name, tx) => {
    reset({ [A]: { transactions: [tx] } });
    expect((await scanError(scanner().scan(params))).code).toBe("scan_failed");
    expect(lib.calls).toHaveLength(1);
  });
});

describe("createLedgerScanner: errors and failover", () => {
  it("fails over when the scan fails mid-way, without repeating payments", async () => {
    const first = shieldedTx({ txid: "01".repeat(32), ironwood: [note(1, "a")] });
    const second = shieldedTx({ txid: "02".repeat(32), height: 108, ironwood: [note(2, "b")] });
    reset({
      [A]: {
        transactions: [first],
        statsError: new Error("stream error: code: 'Operation was attempted past the valid range'"),
      },
      [B]: { transactions: [first, second] },
    });
    const payments = await collect(scanner().scan(params));
    expect(payments.map((p) => p.amountZat)).toEqual([1n, 2n]);
    expect(lib.calls.map((c) => c.grpcUrl)).toEqual([A, B]);
  });

  it("fails over when a server cannot be reached", async () => {
    reset({
      [A]: { transactions: [], startError: new Error("gRPC connect failed: transport error") },
      [B]: { transactions: [shieldedTx({ ironwood: [note(3, "c")] })] },
    });
    expect((await collect(scanner().scan(params))).map((p) => p.amountZat)).toEqual([3n]);
  });

  it("reports chain_unavailable when every server fails", async () => {
    const failure = {
      transactions: [],
      startError: new Error("gRPC connect failed: transport error"),
    };
    reset({ [A]: failure, [B]: failure });
    const err = await scanError(scanner().scan(params));
    expect(err.code).toBe("chain_unavailable");
    expect(err.message).not.toContain("gRPC");
  });

  it("treats a short scan as incomplete", async () => {
    reset({
      [A]: { transactions: [], blocksScanned: 5 },
      [B]: { transactions: [], blocksScanned: 10 },
    });
    expect((await scanError(scanner().scan(params))).code).toBe("chain_unavailable");
  });

  it("maps unknown consensus branch ids to scanner_unsupported_upgrade without failing over", async () => {
    reset({
      [A]: {
        transactions: [],
        statsError: new Error(
          "GetTransaction failed: TX parse failed: unrecognized consensus branch id 0x77190ad9",
        ),
      },
    });
    const err = await scanError(scanner().scan(params));
    expect(err.code).toBe("scanner_unsupported_upgrade");
    expect(err.message).not.toContain("0x77190ad9");
    expect(lib.calls).toHaveLength(1);
  });

  it("maps key errors to scan_failed without failing over or echoing the error", async () => {
    reset({
      [A]: {
        transactions: [],
        startError: new Error("decrypt error: UFVK decode failed: NotUnified"),
      },
    });
    const err = await scanError(scanner().scan(params));
    expect(err.code).toBe("scan_failed");
    expect(err.message).not.toMatch(/UFVK|decrypt/);
    expect(lib.calls).toHaveLength(1);
  });

  it("reports chain_unavailable when no server is configured", async () => {
    reset();
    expect((await scanError(scanner([]).scan(params))).code).toBe("chain_unavailable");
  });

  it("rejects invalid ranges", async () => {
    reset();
    for (const range of [
      { fromHeight: 0, toHeight: 10 },
      { fromHeight: 11, toHeight: 10 },
      { fromHeight: 1.5, toHeight: 10 },
    ]) {
      await expect(collect(scanner().scan({ ...params, ...range }))).rejects.toThrow(RangeError);
    }
  });
});

describe("createLedgerScanner: cancellation", () => {
  it("does not start when already aborted", async () => {
    reset();
    const err = await scanError(scanner().scan({ ...params, signal: AbortSignal.abort() }));
    expect(err.code).toBe("chain_unavailable");
    expect(lib.calls).toHaveLength(0);
  });

  it("cancels the library stream on abort and ends with an error, not a silent stop", async () => {
    reset({ [A]: { transactions: [], hang: true }, [B]: { transactions: [] } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const err = await scanError(scanner().scan({ ...params, signal: controller.signal }));
    expect(err.code).toBe("chain_unavailable");
    expect(lib.cancels).toBe(1);
    expect(lib.calls).toHaveLength(1);
  });

  it("cancels the library stream when the consumer stops early", async () => {
    reset({
      [A]: {
        transactions: [
          shieldedTx({ ironwood: [note(1, "a")] }),
          shieldedTx({ ironwood: [note(2, "b")] }),
        ],
      },
    });
    for await (const payment of scanner().scan(params)) {
      expect(payment.amountZat).toBe(1n);
      break;
    }
    expect(lib.cancels).toBe(1);
  });
});

describe("createLedgerScanner: keys", () => {
  const orchardOnly = encodeUnified("address", "testnet", [
    { typecode: 3, data: new Uint8Array(43).fill(9) },
  ]);

  it("is available when the library loads", async () => {
    expect(await scanner().available()).toBe(true);
  });

  it("returns the key's Orchard-only address", async () => {
    reset();
    lib.address = orchardOnly.toUpperCase();
    expect(await scanner().keyAddress("uviewtest1fake")).toBe(orchardOnly);
  });

  it("refuses an address that is not Orchard-only", async () => {
    reset();
    lib.address = encodeUnified("address", "testnet", [
      { typecode: 0, data: new Uint8Array(20) },
      { typecode: 3, data: new Uint8Array(43).fill(9) },
    ]);
    await expect(scanner().keyAddress("uviewtest1fake")).rejects.toMatchObject({
      code: "scan_failed",
    });
  });

  it("maps library failures to scan_failed without echoing them", async () => {
    reset();
    lib.addressError = new Error("invalid UFVK: bech32m decoding failed");
    const err = await scanner()
      .keyAddress("uviewtest1fake")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScannerError);
    expect((err as ScannerError).code).toBe("scan_failed");
    expect((err as ScannerError).message).not.toContain("bech32m");
  });
});
