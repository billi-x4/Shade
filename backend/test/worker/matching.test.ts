import { describe, expect, it } from "vitest";
import {
  type MatchCandidate,
  type MatchablePayment,
  candidateBounds,
  chainBlockTime,
  isCandidate,
  lastBlockAtOrBefore,
  lowestScanHeight,
  matchPayment,
  planScanRange,
  rescanWindow,
  resumeHeight,
} from "../../src/worker/matching.ts";
import { ChainUnavailableError } from "../../src/zcash/lightwalletd.ts";
import { createFakeChain } from "../support/fake-chain.ts";

const NOW = new Date("2026-10-02T12:00:00Z");
const MIN = 60_000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const unix = (date: Date): number => Math.floor(date.getTime() / 1000);
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    id: "inv_a",
    status: "open",
    amountZat: 1_000_000n,
    memoHash: HASH_A,
    createdAt: at(-10 * MIN),
    expiresAt: at(50 * MIN),
    createdHeight: 1_000,
    ...overrides,
  };
}

function paid(overrides: Partial<MatchablePayment> = {}): MatchablePayment {
  return {
    blockHeight: 1_005,
    blockTime: unix(at(-2 * MIN)),
    amountZat: 1_000_000n,
    memoHash: HASH_A,
    ...overrides,
  };
}

describe("matchPayment", () => {
  it("matches equal memo hash and exact amount inside the window", () => {
    expect(matchPayment(paid(), [candidate()], NOW)).toEqual({ kind: "match", invoiceId: "inv_a" });
  });

  it("requires the exact amount and the same memo hash", () => {
    expect(matchPayment(paid({ amountZat: 1_000_001n }), [candidate()], NOW).kind).toBe("none");
    expect(matchPayment(paid({ amountZat: 999_999n }), [candidate()], NOW).kind).toBe("none");
    expect(matchPayment(paid({ memoHash: HASH_B }), [candidate()], NOW).kind).toBe("none");
  });

  it("accepts a block from created_height − 1 but not earlier", () => {
    expect(matchPayment(paid({ blockHeight: 999 }), [candidate()], NOW).kind).toBe("match");
    expect(matchPayment(paid({ blockHeight: 998 }), [candidate()], NOW).kind).toBe("none");
  });

  it("skips the height rule when the creation height is unknown", () => {
    const unknown = candidate({ createdHeight: null });
    expect(matchPayment(paid({ blockHeight: 10 }), [unknown], NOW).kind).toBe("match");
  });

  it("bounds block time to [created_at − 120 s, expires_at + 60 min]", () => {
    const c = candidate();
    const createdSec = unix(c.createdAt);
    const expiresSec = unix(c.expiresAt);
    expect(matchPayment(paid({ blockTime: createdSec - 120 }), [c], NOW).kind).toBe("match");
    expect(matchPayment(paid({ blockTime: createdSec - 121 }), [c], NOW).kind).toBe("none");
    expect(matchPayment(paid({ blockTime: expiresSec + 3600 }), [c], NOW).kind).toBe("match");
    expect(matchPayment(paid({ blockTime: expiresSec + 3601 }), [c], NOW).kind).toBe("none");
  });

  it("settles an expired invoice inside the grace window", () => {
    const expired = candidate({
      status: "expired",
      createdAt: at(-90 * MIN),
      expiresAt: at(-30 * MIN),
    });
    const payment = paid({ blockTime: unix(at(-20 * MIN)) });
    expect(matchPayment(payment, [expired], NOW)).toEqual({ kind: "match", invoiceId: "inv_a" });
  });

  it("prefers a live invoice over an expired one with the same memo and amount", () => {
    const expired = candidate({ id: "inv_old", status: "expired", expiresAt: at(-5 * MIN) });
    const lazilyExpired = candidate({ id: "inv_lazy", status: "open", expiresAt: at(-1 * MIN) });
    const live = candidate({ id: "inv_live" });
    const claimed = candidate({
      id: "inv_claimed",
      status: "paid_unverified",
      expiresAt: at(-MIN),
    });
    expect(matchPayment(paid(), [expired, lazilyExpired, live], NOW)).toEqual({
      kind: "match",
      invoiceId: "inv_live",
    });
    expect(matchPayment(paid(), [expired, claimed], NOW)).toEqual({
      kind: "match",
      invoiceId: "inv_claimed",
    });
  });

  it("reports more than one remaining match as ambiguous", () => {
    const first = candidate({ id: "inv_1" });
    const second = candidate({ id: "inv_2", status: "paid_unverified" });
    expect(matchPayment(paid(), [first, second], NOW)).toEqual({
      kind: "ambiguous",
      invoiceIds: ["inv_1", "inv_2"],
    });
    const oldA = candidate({ id: "inv_x", status: "expired", expiresAt: at(-MIN) });
    const oldB = candidate({ id: "inv_y", status: "expired", expiresAt: at(-2 * MIN) });
    expect(matchPayment(paid(), [oldA, oldB], NOW).kind).toBe("ambiguous");
  });
});

/**
 * A chain of `tip` blocks whose times are `timeOf(height)`, counting lookups. Heights start at 1
 * for the light server.
 */
function timedChain(tip: number, timeOf: (height: number) => number) {
  const calls: number[] = [];
  return {
    calls,
    blockTime: async (height: number): Promise<number> => {
      if (!Number.isSafeInteger(height) || height < 1 || height > tip) {
        throw new Error(`lookup outside the chain: ${height}`);
      }
      calls.push(height);
      return timeOf(height);
    },
  };
}

describe("candidacy and scan planning", () => {
  it("keeps expired invoices until a scan has covered 70 minutes past expiry", () => {
    const expired = (minutes: number) =>
      candidate({ status: "expired", expiresAt: at(minutes * MIN) });
    // Measured against how far the scan got (block time at the cursor), not the wall clock.
    const scannedThrough = at(-300 * MIN);
    expect(isCandidate(expired(-369), scannedThrough)).toBe(true);
    expect(isCandidate(expired(-371), scannedThrough)).toBe(false);
    expect(isCandidate(expired(-69), NOW)).toBe(true);
    expect(isCandidate(expired(-71), NOW)).toBe(false);
    // Unknown progress keeps every expired invoice.
    expect(isCandidate(expired(-100_000), null)).toBe(true);
    expect(isCandidate(candidate({ status: "open", expiresAt: at(-500 * MIN) }), NOW)).toBe(true);
    const claimed = candidate({ status: "paid_unverified", expiresAt: at(-500 * MIN) });
    expect(isCandidate(claimed, NOW)).toBe(true);
  });

  it("finds the last block at or before a time by galloping down from the tip", async () => {
    const chain = timedChain(100_000, (height) => 1_000_000 + 2 * height);
    const timeAt = (height: number) => 1_000_000 + 2 * height;
    expect(await lastBlockAtOrBefore(chain.blockTime, timeAt(99_990), 1, 100_000)).toBe(99_990);
    expect(await lastBlockAtOrBefore(chain.blockTime, timeAt(99_990) + 1, 1, 100_000)).toBe(99_990);
    expect(await lastBlockAtOrBefore(chain.blockTime, timeAt(100_000), 1, 100_000)).toBe(100_000);
    expect(await lastBlockAtOrBefore(chain.blockTime, timeAt(1_234), 1, 100_000)).toBe(1_234);
    // Every block of the range is later: lowest − 1.
    expect(await lastBlockAtOrBefore(chain.blockTime, 0, 1, 100_000)).toBe(0);
    expect(await lastBlockAtOrBefore(chain.blockTime, timeAt(500), 600, 100_000)).toBe(599);
    // Recent answers are cheap: 10 blocks back from a 100k tip takes a handful of lookups.
    chain.calls.length = 0;
    await lastBlockAtOrBefore(chain.blockTime, timeAt(99_990), 1, 100_000);
    expect(chain.calls.length).toBeLessThanOrEqual(8);
    expect(chain.calls.every((height) => height >= 99_984)).toBe(true);
  });

  it("finds the creation height from block times however fast blocks come", async () => {
    // Testnet bursts: 2 s per block, far faster than any spacing constant would assume.
    const tip = 10_000;
    const tipTime = unix(NOW) - 30;
    const chain = timedChain(tip, (height) => tipTime - 2 * (tip - height));
    const unknown = candidate({ createdHeight: null, createdAt: at(-30 * MIN) });
    // created_at − 120 s is 32 min before NOW, 1890 s before the tip block: height tip − 945.
    const lo = await lowestScanHeight({
      bounds: candidateBounds([unknown]),
      tipHeight: tip,
      resumeFrom: null,
      blockTime: chain.blockTime,
    });
    expect(lo).toBe(tip - 945 - 12 - 2);
    // A payment 2 minutes after creation (tip − 885) lies inside the planned range.
    const range = planScanRange({
      lo,
      cursorHeight: null,
      reorged: false,
      tipHeight: tip,
      rescanBlocks: 12,
      maxBlocks: 20_000,
    });
    expect(range!.from).toBeLessThanOrEqual(tip - 885);
  });

  it("summarizes candidates as the lowest recorded height and the earliest unknown creation", () => {
    expect(candidateBounds([])).toEqual({
      lowestCreatedHeight: null,
      earliestUnknownCreatedAt: null,
    });
    expect(
      candidateBounds([
        candidate({ createdHeight: 9_000 }),
        candidate({ createdHeight: null, createdAt: at(-60 * MIN) }),
        candidate({ createdHeight: 8_500 }),
        candidate({ createdHeight: null, createdAt: at(-120 * MIN) }),
      ]),
    ).toEqual({ lowestCreatedHeight: 8_500, earliestUnknownCreatedAt: at(-120 * MIN) });
  });

  it("searches once, for the earliest invoice without a recorded height", async () => {
    const chain = timedChain(10_000, (height) => unix(NOW) - 75 * (10_000 - height));
    const lo = await lowestScanHeight({
      bounds: candidateBounds([
        candidate({ id: "a", createdHeight: null, createdAt: at(-60 * MIN) }),
        candidate({ id: "b", createdHeight: null, createdAt: at(-120 * MIN) }),
        candidate({ id: "c", createdHeight: 9_990 }),
      ]),
      tipHeight: 10_000,
      resumeFrom: null,
      blockTime: chain.blockTime,
    });
    // 122 min before NOW at 75 s per block is 97.6 blocks back: the last block before is 10_000 − 98.
    expect(lo).toBe(10_000 - 98 - 12 - 2);
    expect(chain.calls.length).toBeLessThanOrEqual(16);

    chain.calls.length = 0;
    expect(
      await lowestScanHeight({
        bounds: candidateBounds([
          candidate({ createdHeight: 9_000 }),
          candidate({ createdHeight: 1 }),
        ]),
        tipHeight: 10_000,
        resumeFrom: null,
        blockTime: chain.blockTime,
      }),
    ).toBe(1);
    expect(chain.calls).toEqual([]);
  });

  it("covers blocks whose timestamps run out of order", async () => {
    // Block 5_000 claims a time 20 s ahead of its successors (allowed: it only has to exceed the
    // median of the previous 11). Every block a payment could match is still inside the range.
    const timeOf = (height: number) => (height === 5_000 ? 2 * height + 20 : 2 * height);
    for (let target = 2 * 5_000 - 4; target <= 2 * 5_000 + 20; target += 1) {
      const chain = timedChain(10_000, timeOf);
      const lo = await lowestScanHeight({
        bounds: candidateBounds([
          candidate({ createdHeight: null, createdAt: new Date(target * 1000 + 120_000) }),
        ]),
        tipHeight: 10_000,
        resumeFrom: null,
        blockTime: chain.blockTime,
      });
      let firstPayable = 1;
      while (timeOf(firstPayable) < target) firstPayable += 1;
      expect(lo).toBeLessThanOrEqual(firstPayable);
    }
  });

  it("only checks above the resume point when a cursor sets the start anyway", async () => {
    const chain = timedChain(10_000, (height) => 2 * height);
    const createdAfter = (height: number) =>
      candidate({ createdHeight: null, createdAt: new Date(2 * height * 1000 + 120_000) });

    // Created long before cursor − R: one lookup shows `lo` cannot be above the resume point.
    let lo = await lowestScanHeight({
      bounds: candidateBounds([createdAfter(5_000)]),
      tipHeight: 10_000,
      resumeFrom: 9_000,
      blockTime: chain.blockTime,
    });
    expect(lo).toBeLessThanOrEqual(9_000);
    expect(chain.calls).toEqual([9_000 + 12 + 2 + 1]);

    // Created after the resume point: the exact height still counts.
    chain.calls.length = 0;
    lo = await lowestScanHeight({
      bounds: candidateBounds([createdAfter(9_500)]),
      tipHeight: 10_000,
      resumeFrom: 9_000,
      blockTime: chain.blockTime,
    });
    expect(lo).toBe(9_500 - 12 - 2);

    // A recorded height at or below the resume point needs no lookup at all.
    chain.calls.length = 0;
    lo = await lowestScanHeight({
      bounds: candidateBounds([createdAfter(9_500), candidate({ createdHeight: 8_000 })]),
      tipHeight: 10_000,
      resumeFrom: 9_000,
      blockTime: chain.blockTime,
    });
    expect(lo).toBe(7_998);
    expect(chain.calls).toEqual([]);

    // Resume point within the margin of the tip: nothing to look up either.
    chain.calls.length = 0;
    lo = await lowestScanHeight({
      bounds: candidateBounds([createdAfter(9_999)]),
      tipHeight: 10_000,
      resumeFrom: 9_990,
      blockTime: chain.blockTime,
    });
    expect(lo).toBeLessThanOrEqual(9_990);
    expect(chain.calls).toEqual([]);
  });

  it("fails instead of guessing when a block time cannot be read", async () => {
    const chain = createFakeChain("testnet");
    chain.setTip(1_000);
    chain.failNext();
    await expect(
      lowestScanHeight({
        bounds: candidateBounds([candidate({ createdHeight: null })]),
        tipHeight: 1_000,
        resumeFrom: null,
        blockTime: chainBlockTime(chain),
      }),
    ).rejects.toBeInstanceOf(ChainUnavailableError);
    // No block at a height the server should have is a bad answer, not an empty chain.
    await expect(chainBlockTime(chain)(1_001)).rejects.toMatchObject({ reason: "bad_response" });
  });

  it("resumes R blocks behind the cursor, 600 after a reorg (NU7's reorg limit)", () => {
    expect(resumeHeight({ cursorHeight: null, reorged: false, rescanBlocks: 12 })).toBeNull();
    expect(resumeHeight({ cursorHeight: 500, reorged: false, rescanBlocks: 12 })).toBe(488);
    expect(resumeHeight({ cursorHeight: 1_000, reorged: true, rescanBlocks: 12 })).toBe(400);
  });

  it("re-scans max(10, minConf + 2) blocks behind the cursor", () => {
    expect(rescanWindow(1)).toBe(10);
    expect(rescanWindow(10)).toBe(12);
  });

  it("plans the range from lo, the cursor window or the reorg window", () => {
    const base = { lo: 900, tipHeight: 1_000, rescanBlocks: 10, maxBlocks: 20_000 };
    expect(planScanRange({ ...base, cursorHeight: null, reorged: false })).toEqual({
      from: 900,
      to: 1_000,
    });
    expect(planScanRange({ ...base, cursorHeight: 990, reorged: false })).toEqual({
      from: 980,
      to: 1_000,
    });
    expect(planScanRange({ ...base, cursorHeight: 990, reorged: true })).toEqual({
      from: 900,
      to: 1_000,
    });
    expect(planScanRange({ ...base, lo: 100, cursorHeight: 990, reorged: true })).toEqual({
      from: 390,
      to: 1_000,
    });
  });

  it("caps one pass at maxBlocks and returns null when the cursor is past the tip", () => {
    expect(
      planScanRange({
        lo: 1,
        cursorHeight: null,
        reorged: false,
        tipHeight: 50_000,
        rescanBlocks: 10,
        maxBlocks: 20_000,
      }),
    ).toEqual({ from: 1, to: 20_000 });
    expect(
      planScanRange({
        lo: 500,
        cursorHeight: 2_500,
        reorged: true,
        tipHeight: 1_800,
        rescanBlocks: 10,
        maxBlocks: 20_000,
      }),
    ).toEqual(null);
  });
});
