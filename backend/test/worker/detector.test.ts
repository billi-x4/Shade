import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSealKeyPair, sealTo, viewingKeySealContext } from "../../src/platform/crypto.ts";
import { nextBackoffMs, runDetectorTick } from "../../src/worker/detector.ts";
import {
  listCandidatesByMemoHash,
  listDueViewingKeys,
  summarizeCandidates,
} from "../../src/worker/repo.ts";
import { ChainUnavailableError } from "../../src/zcash/lightwalletd.ts";
import { ScannerError } from "../../src/zcash/scanner.ts";
import { readFixture } from "../zcash/fixtures.ts";
import {
  type Harness,
  MERCHANT,
  NOW,
  OTHER_MERCHANT,
  TIP,
  UFVK,
  blockTime,
  blockingScan,
  candidateScope,
  createHarness,
  failingScan,
  hash,
  insertInvoice,
  insertJar,
  insertMerchant,
  insertViewingKey,
  payment,
  txid,
  viewingKeyState,
} from "./support.ts";

const MIN = 60_000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

async function blockHash(height: number): Promise<string> {
  const block = await h.chain.testnet.getBlock(height);
  if (!block) throw new Error(`no block ${height}`);
  return block.hash;
}

describe("runDetectorTick", () => {
  it("settles a matching payment and moves the cursor to the tip", async () => {
    const memo = await insertInvoice(h.db, { id: "inv_1", createdHeight: TIP - 8 });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 2, memoHash: memo }),
    );

    const result = await runDetectorTick(h.deps);

    expect(result).toEqual({
      scanned: 1,
      seen: 0,
      settled: 1,
      txidInUse: 0,
      errors: 0,
      lastError: null,
    });
    // First pass: from lo = created_height − 2 to the tip.
    expect(h.scanner.scans).toEqual([
      { network: "testnet", ufvk: UFVK, fromHeight: TIP - 10, toHeight: TIP },
    ]);
    expect(h.fake.applied).toEqual([
      {
        merchantId: MERCHANT,
        network: "testnet",
        invoiceId: "inv_1",
        txid: txid(1),
        pool: "ironwood",
        amountZat: 1_000_000n,
        memoHash: memo,
        blockHeight: TIP - 2,
        blockHash: await blockHash(TIP - 2),
        blockTime: new Date(blockTime(TIP - 2) * 1000),
        tipHeight: TIP,
        source: "shade_worker",
      },
    ]);
    expect(h.fake.kicked).toEqual([["dlv_inv_1"]]);
    expect(await viewingKeyState(h.db, "vk_1")).toEqual({
      cursor_height: TIP,
      cursor_hash: await blockHash(TIP),
      cursor_time: new Date(blockTime(TIP) * 1000),
      tip_height: TIP,
      last_error: null,
      last_scan_at: NOW,
      next_scan_at: null,
      scan_locked_until: null,
      scan_lease: null,
    });
  });

  it("records a payment below the confirmation threshold as seen", async () => {
    await h.close();
    h = await createHarness({ minConfirmations: 3 });
    const memo = await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP, memoHash: memo }),
    );

    const result = await runDetectorTick(h.deps);

    expect(result).toMatchObject({ scanned: 1, seen: 1, settled: 0 });
    expect(h.fake.applied[0]).toMatchObject({ blockHeight: TIP, tipHeight: TIP });
    expect(h.fake.kicked).toEqual([]);
    expect((await viewingKeyState(h.db, "vk_1")).cursor_height).toBe(TIP);
  });

  it("settles the matching invoice of a real recorded Ironwood payment", async () => {
    const recorded = readFixture<{
      notes: Array<{
        txid: string;
        block_height: number;
        block_hash: string;
        block_time: number;
        amount_zat: string;
        memo_hash: string;
      }>;
    }>("live-ironwood-notes.json").notes[0]!;
    const createdAt = new Date((recorded.block_time - 300) * 1000);
    h.now.value = new Date((recorded.block_time + 600) * 1000);
    h.chain.testnet.setTip(recorded.block_height + 7);
    h.chain.testnet.setBlock(recorded.block_height, {
      hash: recorded.block_hash,
      time: recorded.block_time,
    });
    // A legacy invoice (no memo ref) for 0.1 ZEC with an empty memo: its hash is the recorded one.
    const memo = await insertInvoice(h.db, {
      id: "inv_real",
      memoRef: null,
      amountZat: BigInt(recorded.amount_zat),
      createdAt,
      createdHeight: recorded.block_height - 3,
    });
    expect(memo).toBe(recorded.memo_hash);
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment("testnet", UFVK, {
      txid: recorded.txid,
      blockHeight: recorded.block_height,
      blockHash: recorded.block_hash,
      blockTime: recorded.block_time,
      pool: "ironwood",
      amountZat: BigInt(recorded.amount_zat),
      memoHash: recorded.memo_hash,
    });

    const result = await runDetectorTick(h.deps);

    expect(result.settled).toBe(1);
    expect(h.fake.applied).toEqual([
      expect.objectContaining({
        invoiceId: "inv_real",
        txid: recorded.txid,
        amountZat: 10_000_000n,
        memoHash: recorded.memo_hash,
        blockHeight: recorded.block_height,
        blockHash: recorded.block_hash,
        blockTime: new Date(recorded.block_time * 1000),
        tipHeight: recorded.block_height + 7,
      }),
    ]);
  });

  it("plans and matches without loading a merchant's open invoices, however many there are", async () => {
    // A merchant with thousands of open invoices: each pass used to load and match all of them.
    const OPEN = 3_000;
    await h.db.query(
      `insert into invoices
         (id, merchant_id, amount_zec, memo, memo_hash, network, address, zip321, status,
          expires_at, created_at, memo_ref, chain_memo, created_height)
       select 'inv_bulk_' || g, $1, 0.01, '', 'sha256:' || md5(g::text), 'testnet', 'utest1merchant',
              'zcash:utest1merchant', 'open', $2, $3, 'ref' || g, 'ref' || g, $4 + (g % 5)
       from generate_series(1, $5::int) g`,
      [MERCHANT, at(50 * MIN), at(-10 * MIN), TIP - 30, OPEN],
    );
    const memo = await insertInvoice(h.db, { id: "inv_paid_now", createdHeight: TIP - 8 });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 2, memoHash: memo }),
    );
    const query = vi.spyOn(h.db, "query");

    const result = await runDetectorTick(h.deps);

    expect(result).toMatchObject({ scanned: 1, settled: 1, errors: 0 });
    expect(h.fake.applied.map((input) => input.invoiceId)).toEqual(["inv_paid_now"]);
    // The range still starts below the lowest creation height among all of them.
    expect(h.scanner.scans).toEqual([
      { network: "testnet", ufvk: UFVK, fromHeight: TIP - 32, toHeight: TIP },
    ]);
    // No statement of the pass returned more than one row (the key, the plan aggregate, the hit).
    const rowCounts = await Promise.all(
      query.mock.results.map(async (call) => ((await call.value) as unknown[]).length),
    );
    expect(rowCounts.length).toBeGreaterThan(0);
    expect(Math.max(...rowCounts)).toBeLessThanOrEqual(1);
  });

  it("skips keys without candidates and leaves them untouched", async () => {
    await insertJar(h.db, "jar_1");
    await insertInvoice(h.db, { id: "inv_paid", status: "paid" });
    await insertInvoice(h.db, { id: "inv_cancelled", status: "cancelled" });
    await insertInvoice(h.db, { id: "inv_charge", status: "authorized", jarId: "jar_1" });
    await insertInvoice(h.db, {
      id: "inv_stale",
      status: "expired",
      createdAt: at(-200 * MIN),
      expiresAt: at(-71 * MIN),
    });
    await insertInvoice(h.db, { id: "inv_other", merchantId: OTHER_MERCHANT });
    await insertInvoice(h.db, { id: "inv_main", network: "mainnet" });
    // Recently expired, but a jar charge, another merchant's or another network's invoice.
    const recent = { status: "expired", createdAt: at(-90 * MIN), expiresAt: at(-30 * MIN) };
    await insertInvoice(h.db, { id: "inv_jar_expired", jarId: "jar_1", ...recent });
    await insertInvoice(h.db, { id: "inv_other_expired", merchantId: OTHER_MERCHANT, ...recent });
    await insertInvoice(h.db, { id: "inv_main_expired", network: "mainnet", ...recent });
    await insertViewingKey(h, { id: "vk_1" });

    const result = await runDetectorTick(h.deps);

    expect(result).toEqual({
      scanned: 0,
      seen: 0,
      settled: 0,
      txidInUse: 0,
      errors: 0,
      lastError: null,
    });
    expect(h.scanner.scans).toEqual([]);
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: null,
      last_scan_at: null,
      scan_lease: null,
    });
  });

  it("selects open, claimed and uncovered expired non-jar invoices of the key's merchant and network", async () => {
    await insertJar(h.db, "jar_1");
    const memos: string[] = [];
    const add = async (fixture: Parameters<typeof insertInvoice>[1]) => {
      memos.push(await insertInvoice(h.db, fixture));
    };
    await add({ id: "inv_open" });
    await add({
      id: "inv_lazy",
      createdAt: at(-300 * MIN),
      expiresAt: at(-180 * MIN),
      createdHeight: null,
    });
    await add({ id: "inv_claimed", status: "paid_unverified", createdHeight: TIP - 20 });
    await add({
      id: "inv_expired",
      status: "expired",
      createdAt: at(-120 * MIN),
      expiresAt: at(-69 * MIN),
      createdHeight: null,
    });
    await add({
      id: "inv_stale",
      status: "expired",
      createdAt: at(-400 * MIN),
      expiresAt: at(-71 * MIN),
      createdHeight: TIP - 400,
    });
    await add({ id: "inv_paid", status: "paid", createdHeight: TIP - 500 });
    await add({ id: "inv_cancelled", status: "cancelled", createdHeight: TIP - 500 });
    await add({ id: "inv_charge", status: "authorized", jarId: "jar_1", createdHeight: TIP - 500 });
    await add({ id: "inv_other", merchantId: OTHER_MERCHANT, createdHeight: TIP - 500 });
    await add({ id: "inv_main", network: "mainnet", createdHeight: TIP - 500 });
    // Uploaded now and never scanned: a first pass looks back 70 minutes past expiry from here.
    await insertViewingKey(h, { id: "vk_1" });

    const scope = await candidateScope(h.db, "vk_1");
    expect(scope).toEqual({ merchantId: MERCHANT, network: "testnet", scannedThrough: NOW });
    const candidates = await listCandidatesByMemoHash(h.db, { ...scope, memoHashes: memos });

    expect(candidates.map((c) => c.id).sort()).toEqual([
      "inv_claimed",
      "inv_expired",
      "inv_lazy",
      "inv_open",
    ]);
    expect(candidates.find((c) => c.id === "inv_open")).toMatchObject({
      status: "open",
      amountZat: 1_000_000n,
      createdHeight: TIP - 8,
    });
    // The pass is planned from an aggregate over the same rows, never from a full load.
    expect(await summarizeCandidates(h.db, scope)).toEqual({
      count: 4,
      lowestCreatedHeight: TIP - 20,
      earliestUnknownCreatedAt: at(-300 * MIN),
    });
    // Only the invoices whose memo hash was found are loaded.
    const [openMemo] = memos;
    expect(
      (
        await listCandidatesByMemoHash(h.db, {
          ...scope,
          memoHashes: [openMemo!, openMemo!, hash("unrelated")],
        })
      ).map((c) => c.id),
    ).toEqual(["inv_open"]);
    expect(await listCandidatesByMemoHash(h.db, { ...scope, memoHashes: [] })).toEqual([]);
  });

  it("keeps an expired invoice until a successful scan has covered 70 minutes past expiry", async () => {
    await insertInvoice(h.db, {
      id: "inv_recent",
      status: "expired",
      createdAt: at(-200 * MIN),
      expiresAt: at(-71 * MIN),
    });
    await insertInvoice(h.db, {
      id: "inv_old",
      status: "expired",
      createdAt: at(-500 * MIN),
      expiresAt: at(-371 * MIN),
    });
    const memos = [
      ...(await h.db.query<{ memo_hash: string }>("select memo_hash from invoices")).map(
        (row) => row.memo_hash,
      ),
    ];
    const candidateIds = async () => {
      const scope = await candidateScope(h.db, "vk_1");
      const ids = (await listCandidatesByMemoHash(h.db, { ...scope, memoHashes: memos }))
        .map((c) => c.id)
        .sort();
      expect((await summarizeCandidates(h.db, scope)).count).toBe(ids.length);
      return ids;
    };
    const due = () => listDueViewingKeys(h.db, { networks: ["testnet"], now: NOW, limit: 50 });

    // The last successful scan reached a block from 5 hours ago (an outage or a backlog): the
    // invoice whose grace window it has not covered yet is still looked for, whatever `now` is.
    await insertViewingKey(h, {
      id: "vk_1",
      cursorHeight: TIP - 240,
      cursorHash: await blockHash(TIP - 240),
      cursorTime: at(-300 * MIN),
    });
    expect(await candidateIds()).toEqual(["inv_recent"]);
    expect(await due()).toEqual(["vk_1"]);

    // Caught up past both grace windows: nothing left to look for, the key is not due.
    await h.db.query("update merchant_viewing_keys set cursor_time = $1 where id = 'vk_1'", [
      at(-MIN),
    ]);
    expect(await candidateIds()).toEqual([]);
    expect(await due()).toEqual([]);

    // A cursor without a recorded time (scanned before it was stored) keeps every expired invoice.
    await h.db.query("update merchant_viewing_keys set cursor_time = null where id = 'vk_1'");
    expect(await candidateIds()).toEqual(["inv_old", "inv_recent"]);
    expect(await due()).toEqual(["vk_1"]);

    // Never scanned: measured from the upload.
    await h.db.query(
      `update merchant_viewing_keys set cursor_height = null, cursor_hash = null, created_at = $1
       where id = 'vk_1'`,
      [at(-200 * MIN)],
    );
    expect(await candidateIds()).toEqual(["inv_recent"]);
    expect(await due()).toEqual(["vk_1"]);
  });

  it("settles nothing when a payment matches two invoices", async () => {
    const first = await insertInvoice(h.db, { id: "inv_a", memoRef: null, memo: "order_1" });
    const second = await insertInvoice(h.db, { id: "inv_b", memoRef: null, memo: "order_1" });
    expect(first).toBe(second);
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 1, memoHash: first }),
    );

    const result = await runDetectorTick(h.deps);

    expect(result).toEqual({
      scanned: 1,
      seen: 0,
      settled: 0,
      txidInUse: 0,
      errors: 0,
      lastError: "ambiguous_match",
    });
    expect(h.fake.applied).toEqual([]);
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: TIP,
      last_error: "ambiguous_match",
      next_scan_at: null,
    });
  });

  it("counts a match already recorded on another invoice as txid_in_use, without a backoff", async () => {
    const memo = await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(9), height: TIP - 1, memoHash: memo }),
    );
    h.fake.decide = () => "txid_in_use";

    const result = await runDetectorTick(h.deps);

    expect(result).toEqual({
      scanned: 1,
      seen: 0,
      settled: 0,
      txidInUse: 1,
      errors: 0,
      lastError: "txid_in_use",
    });
    expect(h.fake.applied.map((input) => input.invoiceId)).toEqual(["inv_1"]);
    expect(h.fake.kicked).toEqual([]);
    // The scan itself succeeded: the cursor moves and no backoff is set.
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: TIP,
      last_error: "txid_in_use",
      next_scan_at: null,
      scan_lease: null,
    });
    // One warning with the code and the invoice id only.
    const lines = h.logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const warnings = lines.filter((line) => line.code === "txid_in_use");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ invoice_id: "inv_1", viewing_key_id: "vk_1" });
    for (const field of ["txid", "amount_zec", "amountZat", "memo_hash", "memoHash"]) {
      expect(warnings[0]).not.toHaveProperty(field);
    }
    const logs = h.logLines.join("\n");
    expect(logs).not.toContain(txid(9));
    expect(logs).not.toContain(memo.slice("sha256:".length));

    // A key whose last pass ended with txid_in_use is due again at once.
    h.now.value = at(MIN);
    expect(
      await listDueViewingKeys(h.db, { networks: ["testnet"], now: h.now.value, limit: 10 }),
    ).toEqual(["vk_1"]);
  });

  it("reports ambiguous_match before txid_in_use when one pass has both", async () => {
    const taken = await insertInvoice(h.db, { id: "inv_taken" });
    const first = await insertInvoice(h.db, { id: "inv_a", memoRef: null, memo: "order_2" });
    await insertInvoice(h.db, { id: "inv_b", memoRef: null, memo: "order_2" });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 2, memoHash: taken }),
    );
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(2), height: TIP - 1, memoHash: first }),
    );
    h.fake.decide = () => "txid_in_use";

    const result = await runDetectorTick(h.deps);

    expect(result).toMatchObject({ scanned: 1, txidInUse: 1, lastError: "ambiguous_match" });
    expect(h.fake.applied.map((input) => input.invoiceId)).toEqual(["inv_taken"]);
    expect((await viewingKeyState(h.db, "vk_1")).last_error).toBe("ambiguous_match");
  });

  it("re-scans R blocks behind a valid cursor", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdHeight: TIP - 200 });
    await insertViewingKey(h, {
      id: "vk_1",
      cursorHeight: TIP - 50,
      cursorHash: await blockHash(TIP - 50),
    });

    await runDetectorTick(h.deps);

    expect(h.scanner.scans).toEqual([
      expect.objectContaining({ fromHeight: TIP - 60, toHeight: TIP }),
    ]);
  });

  it("re-scans 600 blocks when the block at the cursor changed (reorg)", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdHeight: TIP - 800 });
    await insertViewingKey(h, { id: "vk_1", cursorHeight: TIP - 50, cursorHash: hash("old") });

    await runDetectorTick(h.deps);

    expect(h.scanner.scans).toEqual([
      expect.objectContaining({ fromHeight: TIP - 650, toHeight: TIP }),
    ]);
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: TIP,
      cursor_hash: await blockHash(TIP),
    });
  });

  it("never scans below lo, even after a reorg", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdHeight: TIP - 20 });
    await insertViewingKey(h, { id: "vk_1", cursorHeight: TIP - 5, cursorHash: hash("old") });

    await runDetectorTick(h.deps);

    expect(h.scanner.scans[0]).toMatchObject({ fromHeight: TIP - 22 });
  });

  it("advances a long backlog in bounded steps", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdHeight: 1_000 });
    await insertViewingKey(h, { id: "vk_1" });

    await runDetectorTick(h.deps);
    expect(h.scanner.scans[0]).toMatchObject({ fromHeight: 998, toHeight: 20_997 });
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: 20_997,
      cursor_hash: await blockHash(20_997),
      // How far this pass covered, not the tip: the backlog's invoices stay candidates.
      cursor_time: new Date(blockTime(20_997) * 1000),
      tip_height: TIP,
    });

    await runDetectorTick(h.deps);
    expect(h.scanner.scans[1]).toMatchObject({ fromHeight: 20_987, toHeight: 40_986 });
  });

  it("finds where to start from block times when the creation height was not recorded", async () => {
    // A testnet burst: the last 1000 blocks came 2 s apart, far faster than any spacing guess.
    for (let height = TIP - 1_000; height <= TIP; height += 1) {
      h.chain.testnet.setBlock(height, {
        hash: hash(`fast-${height}`),
        time: blockTime(TIP) - 2 * (TIP - height),
      });
    }
    const memo = await insertInvoice(h.db, {
      id: "inv_1",
      createdAt: at(-30 * MIN),
      createdHeight: null,
    });
    await insertViewingKey(h, { id: "vk_1" });
    // Paid 2 minutes after creation, 825 blocks below the tip.
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 825, memoHash: memo }),
    );

    const result = await runDetectorTick(h.deps);

    // created_at − 120 s falls on block TIP − 945, lowered by the timestamp and lo margins.
    expect(h.scanner.scans).toEqual([
      expect.objectContaining({ fromHeight: TIP - 945 - 12 - 2, toHeight: TIP }),
    ]);
    expect(result).toMatchObject({ scanned: 1, settled: 1, errors: 0 });
    expect(h.fake.applied).toEqual([
      expect.objectContaining({ invoiceId: "inv_1", blockHeight: TIP - 825 }),
    ]);
  });

  it("fails the pass instead of guessing when a block time cannot be read", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdAt: at(-30 * MIN), createdHeight: null });
    await insertViewingKey(h, { id: "vk_1" });
    vi.spyOn(h.chain.testnet, "getBlock").mockRejectedValueOnce(new ChainUnavailableError());

    const result = await runDetectorTick(h.deps);

    expect(result).toMatchObject({ scanned: 0, errors: 1, lastError: "chain_unavailable" });
    expect(h.scanner.scans).toEqual([]);
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: null,
      cursor_time: null,
      last_error: "chain_unavailable",
      next_scan_at: new Date(NOW.getTime() + 20_000),
    });
  });

  it("keeps the cursor on failure and backs off exponentially up to 5 minutes", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    const cursorHash = await blockHash(TIP - 5);
    await insertViewingKey(h, { id: "vk_1", cursorHeight: TIP - 5, cursorHash });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      h.scanner.next.push(failingScan(new ScannerError("chain_unavailable")));
      const result = await runDetectorTick(h.deps);
      expect(result).toEqual({
        scanned: 0,
        seen: 0,
        settled: 0,
        txidInUse: 0,
        errors: 1,
        lastError: "chain_unavailable",
      });
      const state = await viewingKeyState(h.db, "vk_1");
      expect(state).toMatchObject({
        cursor_height: TIP - 5,
        cursor_hash: cursorHash,
        tip_height: TIP,
        last_error: "chain_unavailable",
        last_scan_at: h.now.value,
        scan_lease: null,
        scan_locked_until: null,
      });
      const delay = state.next_scan_at!.getTime() - h.now.value.getTime();
      delays.push(delay);

      // Not due before the backoff has passed.
      h.now.value = new Date(h.now.value.getTime() + delay - 1);
      const scans = h.scanner.scans.length;
      await runDetectorTick(h.deps);
      expect(h.scanner.scans.length).toBe(scans);
      h.now.value = new Date(h.now.value.getTime() + 1);
    }
    expect(delays).toEqual([20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);

    const result = await runDetectorTick(h.deps);
    expect(result).toMatchObject({ scanned: 1, errors: 0, lastError: null });
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: TIP,
      last_error: null,
      next_scan_at: null,
    });
  });

  it("does not advance the cursor when settling a match fails", async () => {
    const memo = await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 1, memoHash: memo }),
    );
    h.fake.decide = () => {
      throw new Error("database unavailable");
    };

    const result = await runDetectorTick(h.deps);

    expect(result).toMatchObject({ errors: 1, lastError: "scan_failed" });
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: null,
      last_error: "scan_failed",
      next_scan_at: new Date(NOW.getTime() + 20_000),
    });
  });

  it("reports key_unavailable when the key was sealed to an unknown worker key", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1", sealPublicKey: generateSealKeyPair().publicKey });

    const result = await runDetectorTick(h.deps);

    expect(result).toMatchObject({ errors: 1, lastError: "key_unavailable" });
    expect(h.scanner.scans).toEqual([]);
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: null,
      last_error: "key_unavailable",
      next_scan_at: new Date(NOW.getTime() + 20_000),
    });
  });

  it("refuses a sealed key that belongs to another merchant", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    await h.db.query("update merchant_viewing_keys set sealed_key = $1 where id = $2", [
      sealTo(h.sealPublicKey, UFVK, viewingKeySealContext(OTHER_MERCHANT, "testnet")),
      "vk_1",
    ]);

    const result = await runDetectorTick(h.deps);

    expect(result).toMatchObject({ errors: 1, lastError: "key_unavailable" });
    expect(h.scanner.scans).toEqual([]);
  });

  it("records chain_unavailable for every key when the tip cannot be read, with one tip call", async () => {
    await insertMerchant(h.db, "mer_3");
    await insertInvoice(h.db, { id: "inv_1" });
    await insertInvoice(h.db, { id: "inv_3", merchantId: "mer_3" });
    await insertViewingKey(h, { id: "vk_1" });
    await insertViewingKey(h, { id: "vk_3", merchantId: "mer_3" });
    const getTip = vi.spyOn(h.chain.testnet, "getTip");
    h.chain.testnet.failNext();

    const result = await runDetectorTick(h.deps);

    expect(getTip).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 0, errors: 2, lastError: "chain_unavailable" });
    for (const id of ["vk_1", "vk_3"]) {
      expect(await viewingKeyState(h.db, id)).toMatchObject({
        last_error: "chain_unavailable",
        tip_height: null,
      });
    }
  });

  it("aborts a scan that exceeds the timeout", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.scanner.next.push(blockingScan().impl);

    const result = await runDetectorTick(h.deps, { scanTimeoutMs: 20 });

    expect(result).toMatchObject({ errors: 1, lastError: "chain_unavailable" });
    expect((await viewingKeyState(h.db, "vk_1")).cursor_height).toBeNull();
  });

  it("halves the next pass after a timeout, so a slow backlog still advances, then grows back", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdHeight: 1_000 });
    await insertViewingKey(h, { id: "vk_1" });
    const scanChunks = new Map<string, number>();
    h.scanner.next.push(blockingScan().impl);

    const timedOut = await runDetectorTick(h.deps, { scanTimeoutMs: 20, scanChunks });
    expect(timedOut).toMatchObject({ errors: 1 });
    expect(h.scanner.scans[0]).toMatchObject({ fromHeight: 998, toHeight: 20_997 });
    expect(scanChunks.get("vk_1")).toBe(10_000);

    h.now.value = new Date(h.now.value.getTime() + 60_000);
    await runDetectorTick(h.deps, { scanChunks });
    expect(h.scanner.scans[1]).toMatchObject({ fromHeight: 998, toHeight: 10_997 });
    expect((await viewingKeyState(h.db, "vk_1")).cursor_height).toBe(10_997);
    // A completed pass doubles the size back to the cap, which clears the entry.
    expect(scanChunks.has("vk_1")).toBe(false);

    await runDetectorTick(h.deps, { scanChunks });
    expect(h.scanner.scans[2]).toMatchObject({ fromHeight: 10_987, toHeight: 30_986 });
  });

  it("keeps the pass size when a scan fails for another reason than its timeout", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdHeight: 1_000 });
    await insertViewingKey(h, { id: "vk_1" });
    const scanChunks = new Map([["vk_1", 4_000]]);
    h.scanner.next.push(failingScan(new ScannerError("chain_unavailable")));

    await runDetectorTick(h.deps, { scanChunks });
    expect(scanChunks.get("vk_1")).toBe(4_000);
  });

  it("never shrinks a pass below the floor", async () => {
    await insertInvoice(h.db, { id: "inv_1", createdHeight: 1_000 });
    await insertViewingKey(h, { id: "vk_1" });
    const scanChunks = new Map([["vk_1", 1_500]]);
    h.scanner.next.push(blockingScan().impl);

    await runDetectorTick(h.deps, { scanTimeoutMs: 20, scanChunks });
    expect(h.scanner.scans[0]).toMatchObject({ fromHeight: 998, toHeight: 2_497 });
    expect(scanChunks.get("vk_1")).toBe(1_000);
  });

  it("releases the lease without an error when the worker stops mid-scan", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    const scan = blockingScan();
    h.scanner.next.push(scan.impl);
    const controller = new AbortController();

    const tick = runDetectorTick(h.deps, { signal: controller.signal });
    await scan.started;
    controller.abort();
    const result = await tick;

    expect(result).toEqual({
      scanned: 0,
      seen: 0,
      settled: 0,
      txidInUse: 0,
      errors: 0,
      lastError: null,
    });
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: null,
      last_error: null,
      next_scan_at: null,
      scan_lease: null,
      scan_locked_until: null,
    });
  });

  it("skips a key leased by another worker until the lease expires", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, {
      id: "vk_1",
      scanLease: "other-worker",
      scanLockedUntil: at(60_000),
    });

    await runDetectorTick(h.deps);
    expect(h.scanner.scans).toEqual([]);
    expect((await viewingKeyState(h.db, "vk_1")).scan_lease).toBe("other-worker");

    h.now.value = at(60_001);
    await runDetectorTick(h.deps);
    expect(h.scanner.scans).toHaveLength(1);
    expect((await viewingKeyState(h.db, "vk_1")).scan_lease).toBeNull();
  });

  it("lets only one of two concurrent ticks scan a key", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    const scan = blockingScan();
    h.scanner.next.push(scan.impl);

    const first = runDetectorTick(h.deps);
    await scan.started;
    const second = await runDetectorTick(h.deps);
    scan.release();

    expect(second.scanned).toBe(0);
    expect((await first).scanned).toBe(1);
    expect(h.scanner.scans).toHaveLength(1);
  });

  it("does not move a cursor after its lease was taken over", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    const scan = blockingScan();
    h.scanner.next.push(scan.impl);

    const tick = runDetectorTick(h.deps);
    await scan.started;
    await h.db.query(
      "update merchant_viewing_keys set scan_lease = 'other-worker' where id = 'vk_1'",
    );
    scan.release();
    await tick;

    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: null,
      scan_lease: "other-worker",
    });
  });

  it("runs at most two scans at a time", async () => {
    const scans = [blockingScan(), blockingScan(), blockingScan()];
    for (const [index, merchant] of ["mer_a", "mer_b", "mer_c"].entries()) {
      await insertMerchant(h.db, merchant);
      await insertInvoice(h.db, { id: `inv_${merchant}`, merchantId: merchant });
      await insertViewingKey(h, { id: `vk_${merchant}`, merchantId: merchant });
      h.scanner.next.push(scans[index]!.impl);
    }

    const tick = runDetectorTick(h.deps);
    await Promise.all([scans[0]!.started, scans[1]!.started]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.scanner.scans).toHaveLength(2);
    scans[0]!.release();
    await scans[2]!.started;
    expect(h.scanner.scans).toHaveLength(3);
    scans[1]!.release();
    scans[2]!.release();

    expect((await tick).scanned).toBe(3);
  });

  it("ignores revoked keys and networks that are not enabled", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertInvoice(h.db, { id: "inv_main", network: "mainnet" });
    await insertViewingKey(h, { id: "vk_1", revokedAt: at(-MIN) });
    await insertViewingKey(h, { id: "vk_main", network: "mainnet" });

    await runDetectorTick(h.deps);

    expect(h.scanner.scans).toEqual([]);
  });

  it("never logs the viewing key, txids or memo hashes", async () => {
    const memo = await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(7), height: TIP - 1, memoHash: memo }),
    );
    await runDetectorTick(h.deps);
    h.now.value = at(10 * MIN);
    h.scanner.next.push(failingScan(new ScannerError("scan_failed")));
    await runDetectorTick(h.deps);

    const logs = h.logLines.join("\n");
    expect(logs).toContain("viewing-key scan failed");
    expect(logs).not.toContain(UFVK);
    expect(logs).not.toContain(txid(7));
    expect(logs).not.toContain(memo.slice("sha256:".length));
  });
});

describe("nextBackoffMs", () => {
  it("starts at 20 s and ignores a previous matching problem (ambiguous_match, txid_in_use)", () => {
    const base = { lastScanAt: NOW, nextScanAt: null };
    expect(nextBackoffMs({ ...base, lastError: null })).toBe(20_000);
    expect(
      nextBackoffMs({ lastError: "ambiguous_match", lastScanAt: NOW, nextScanAt: at(5_000) }),
    ).toBe(20_000);
    expect(
      nextBackoffMs({ lastError: "txid_in_use", lastScanAt: NOW, nextScanAt: at(200_000) }),
    ).toBe(20_000);
    expect(
      nextBackoffMs({ lastError: "scan_failed", lastScanAt: NOW, nextScanAt: at(200_000) }),
    ).toBe(300_000);
  });
});
