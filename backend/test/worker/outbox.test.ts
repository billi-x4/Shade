import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextOutboxDelay } from "../../src/worker/index.ts";
import { runOutboxTick } from "../../src/worker/outbox.ts";
import { nextDeliveryDueAt } from "../../src/worker/repo.ts";
import { type Harness, MERCHANT, NOW, createHarness } from "./support.ts";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

describe("runOutboxTick", () => {
  it("drains batches until one finds nothing to deliver", async () => {
    const batches = [3, 2, 0, 7];
    h.fake.deliverDue = async () => batches.shift() ?? 0;

    expect(await runOutboxTick(h.deps)).toBe(5);
    expect(h.fake.deliverDueCalls).toEqual([25, 25, 25]);
  });

  it("stops once the time budget is spent", async () => {
    h.fake.deliverDue = async () => 4;
    let clock = 0;

    const attempts = await runOutboxTick(h.deps, {
      batchSize: 10,
      budgetMs: 25,
      monotonicNow: () => {
        const now = clock;
        clock += 10;
        return now;
      },
    });

    // Budget checks at 10, 20 (continue) and 30 ms (stop): three batches.
    expect(attempts).toBe(12);
    expect(h.fake.deliverDueCalls).toEqual([10, 10, 10]);
  });

  it("stops between batches when the worker shuts down", async () => {
    const controller = new AbortController();
    h.fake.deliverDue = async () => {
      controller.abort();
      return 1;
    };

    expect(await runOutboxTick(h.deps, { signal: controller.signal })).toBe(1);
    expect(h.fake.deliverDueCalls).toHaveLength(1);
  });

  it("propagates a delivery failure to the loop", async () => {
    h.fake.deliverDue = async () => {
      throw new Error("database unavailable");
    };

    await expect(runOutboxTick(h.deps)).rejects.toThrow("database unavailable");
  });
});

describe("outbox idle backoff", () => {
  const base = { now: NOW, intervalMs: 2_000, idleMaxMs: 240_000 };

  it("polls at the interval while there is work", () => {
    expect(nextOutboxDelay({ ...base, attempts: 3, dueAt: null, idleMs: 64_000 })).toEqual({
      delayMs: 2_000,
      idleMs: 2_000,
    });
  });

  it("doubles the idle delay up to 4 minutes when nothing is pending", () => {
    let idleMs = 2_000;
    const delays: number[] = [];
    for (let pass = 0; pass < 9; pass += 1) {
      const next = nextOutboxDelay({ ...base, attempts: 0, dueAt: null, idleMs });
      delays.push(next.delayMs);
      idleMs = next.idleMs;
    }
    expect(delays).toEqual([
      4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 240_000, 240_000, 240_000,
    ]);
  });

  it("wakes for the next scheduled retry", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(nextOutboxDelay({ ...base, attempts: 0, dueAt: at(30_000), idleMs: 64_000 })).toEqual({
      delayMs: 30_000,
      idleMs: 2_000,
    });
    expect(
      nextOutboxDelay({ ...base, attempts: 0, dueAt: at(-5_000), idleMs: 2_000 }).delayMs,
    ).toBe(2_000);
    expect(
      nextOutboxDelay({ ...base, attempts: 0, dueAt: at(3_600_000), idleMs: 2_000 }).delayMs,
    ).toBe(240_000);
  });
});

describe("nextDeliveryDueAt", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  async function delivery(
    id: string,
    status: string,
    nextAttemptAt: Date | null,
    lockedUntil: Date | null,
  ) {
    await h.db.query(
      `insert into webhook_events (id, merchant_id, network, type, payload)
       values ($1, $2, 'testnet', 'webhook.test', '{}')`,
      [`evt_${id}`, MERCHANT],
    );
    await h.db.query(
      `insert into webhook_deliveries
         (id, merchant_id, endpoint_id, event_type, event_id, status, next_attempt_at, locked_until)
       values ($1, $2, 'whe_1', 'webhook.test', $3, $4, $5, $6)`,
      [id, MERCHANT, `evt_${id}`, status, nextAttemptAt, lockedUntil],
    );
  }

  it("returns the earliest retry or lease expiry among pending work", async () => {
    await h.db.query(
      `insert into webhook_endpoints (id, merchant_id, url, network, secret_ciphertext)
       values ('whe_1', $1, 'https://example.com/hook', 'testnet', 'enc:v1:x:y')`,
      [MERCHANT],
    );
    expect(await nextDeliveryDueAt(h.db)).toBeNull();

    await delivery("dlv_done", "delivered", at(-60_000), null);
    await delivery("dlv_dead", "dead", at(-60_000), null);
    expect(await nextDeliveryDueAt(h.db)).toBeNull();

    await delivery("dlv_pending", "pending", at(300_000), null);
    expect(await nextDeliveryDueAt(h.db)).toEqual(at(300_000));
    await delivery("dlv_failed", "failed", at(60_000), null);
    expect(await nextDeliveryDueAt(h.db)).toEqual(at(60_000));
    await delivery("dlv_flight", "in_flight", null, at(30_000));
    expect(await nextDeliveryDueAt(h.db)).toEqual(at(30_000));
  });
});
