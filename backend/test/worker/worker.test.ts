import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WorkerHandle, startWorker } from "../../src/worker/index.ts";
import {
  type Harness,
  TIP,
  UFVK,
  createHarness,
  insertInvoice,
  insertViewingKey,
  payment,
  txid,
} from "./support.ts";

const FAST = {
  scanIntervalMs: 20,
  outboxIntervalMs: 10,
  outboxIdleMaxMs: 40,
  sweeperIntervalMs: 20,
  startDelayMs: 0,
  failureBackoffMaxMs: 40,
};

/** Generous: the loops run on real timers and the suite may share the CPU with other files. */
const WAIT = { timeout: 10_000, interval: 20 };

let h: Harness;
let worker: WorkerHandle | null = null;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await worker?.stop();
  worker = null;
  await h.close();
});

async function heartbeats(): Promise<Record<string, Record<string, unknown>>> {
  const rows = await h.db.query<{ name: string; info: Record<string, unknown> }>(
    "select name, info from worker_heartbeats",
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.info]));
}

describe("startWorker", () => {
  it("runs every loop and records a heartbeat for each", async () => {
    const memo = await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 1, memoHash: memo }),
    );

    worker = startWorker(h.deps, { timing: FAST, random: () => 0.5 });

    await vi.waitFor(async () => {
      const beats = await heartbeats();
      expect(Object.keys(beats).sort()).toEqual(["detector", "outbox", "promotion", "sweeper"]);
      expect(h.fake.applied.length).toBeGreaterThan(0);
    }, WAIT);
    const beats = await heartbeats();
    expect(beats.detector).toMatchObject({ ok: true, hosted_detection: true, last_error: null });
    expect(beats.promotion).toMatchObject({ ok: true, errors: 0, last_error: null });
    expect(beats.outbox).toMatchObject({ ok: true, attempts: 0, last_error: null });
    expect(beats.sweeper).toMatchObject({ ok: true, expired: 0, last_error: null });
    expect(h.fake.applied[0]).toMatchObject({ invoiceId: "inv_1", source: "shade_worker" });
    const [row] = await h.db.query<{ last_seen_at: Date }>(
      "select last_seen_at from worker_heartbeats where name = 'detector'",
    );
    expect(row?.last_seen_at).toEqual(h.now.value);
  });

  it("survives failing ticks and reports them in the heartbeat", async () => {
    let failures = 0;
    h.fake.deliverDue = async () => {
      failures += 1;
      throw new Error("database unavailable");
    };

    worker = startWorker(h.deps, { timing: FAST, random: () => 0.5 });

    await vi.waitFor(async () => {
      expect(failures).toBeGreaterThanOrEqual(3);
      expect((await heartbeats()).outbox).toEqual({ ok: false, last_error: "internal" });
    }, WAIT);
    expect(h.logLines.join("\n")).toContain("worker tick failed");

    h.fake.deliverDue = async () => 0;
    await vi.waitFor(async () => {
      expect((await heartbeats()).outbox).toMatchObject({ ok: true, last_error: null });
    }, WAIT);
  });

  it("records the last scan error code of the detector", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.chain.testnet.failNext();

    worker = startWorker(h.deps, { timing: FAST, random: () => 0.5 });

    await vi.waitFor(async () => {
      // Later idle ticks (the key is backing off) keep the failure visible.
      expect((await heartbeats()).detector).toMatchObject({
        ok: false,
        last_error: "chain_unavailable",
      });
    }, WAIT);
  });

  it("keeps the other loops running when the scanner cannot load", async () => {
    await insertInvoice(h.db, { id: "inv_1" });
    await insertViewingKey(h, { id: "vk_1" });
    h.scanner.unavailable = true;

    worker = startWorker(h.deps, { timing: FAST, random: () => 0.5 });

    await vi.waitFor(async () => {
      const beats = await heartbeats();
      expect(beats.detector).toEqual({ ok: true, hosted_detection: false, last_error: null });
      expect(beats.outbox).toBeDefined();
      expect(beats.sweeper).toBeDefined();
    }, WAIT);
    expect(h.scanner.scans).toEqual([]);
    expect(h.logLines.join("\n")).toContain("hosted detection unavailable");
  });

  it("stops scheduling and waits for running ticks", async () => {
    worker = startWorker(h.deps, { timing: FAST, random: () => 0.5 });
    await vi.waitFor(() => expect(h.fake.deliverDueCalls.length).toBeGreaterThan(0), WAIT);

    await worker.stop();
    const calls = h.fake.deliverDueCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.fake.deliverDueCalls.length).toBe(calls);
    expect(h.logLines.join("\n")).toContain("worker stopped");
  });
});
