import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expireOverdueInvoices } from "../../src/worker/repo.ts";
import { runSweeperTick } from "../../src/worker/sweeper.ts";
import {
  type Harness,
  MERCHANT,
  NOW,
  TIP,
  createHarness,
  insertDetection,
  insertInvoice,
  insertJar,
  txid,
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

async function statuses(): Promise<Record<string, string>> {
  const rows = await h.db.query<{ id: string; status: string }>(
    "select id, status from invoices order by id",
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

const overdue = { createdAt: at(-120 * MIN), expiresAt: at(-60 * MIN) };

describe("runSweeperTick", () => {
  it("expires open invoices past expiry unless a payment is being confirmed", async () => {
    await insertJar(h.db, "jar_1");
    await insertInvoice(h.db, { id: "inv_overdue", ...overdue });
    await insertInvoice(h.db, { id: "inv_boundary", createdAt: at(-60 * MIN), expiresAt: NOW });
    const pending = await insertInvoice(h.db, { id: "inv_pending", ...overdue });
    await insertDetection(h.db, {
      id: "det_seen",
      invoiceId: "inv_pending",
      txid: txid(1),
      memoHash: pending,
      blockHeight: TIP - 1,
      blockHash: null,
    });
    const orphaned = await insertInvoice(h.db, { id: "inv_orphaned", ...overdue });
    await insertDetection(h.db, {
      id: "det_orphaned",
      invoiceId: "inv_orphaned",
      txid: txid(2),
      memoHash: orphaned,
      blockHeight: TIP - 1,
      blockHash: null,
      state: "orphaned",
    });
    await insertInvoice(h.db, { id: "inv_live", createdAt: at(-10 * MIN), expiresAt: at(MIN) });
    await insertInvoice(h.db, { id: "inv_claimed", status: "paid_unverified", ...overdue });
    await insertInvoice(h.db, {
      id: "inv_charge",
      status: "authorized",
      jarId: "jar_1",
      ...overdue,
    });

    const result = await runSweeperTick(h.deps);

    expect(result).toEqual({ expired: 3, rateLimitsPurged: 0, idempotencyKeysPurged: 0 });
    expect(await statuses()).toEqual({
      inv_boundary: "expired",
      inv_charge: "authorized",
      inv_claimed: "paid_unverified",
      inv_live: "open",
      inv_orphaned: "expired",
      inv_overdue: "expired",
      inv_pending: "open",
    });
    expect((await runSweeperTick(h.deps)).expired).toBe(0);
  });

  it("purges rate-limit windows older than an hour and idempotency records older than a day", async () => {
    await h.db.query(
      `insert into rate_limits (bucket, window_start, count) values
         ('pub:inv:ip:1', $1, 3), ('pub:inv:ip:1', $2, 1)`,
      [at(-61 * MIN), at(-59 * MIN)],
    );
    await h.db.query(
      `insert into api_keys (id, merchant_id, kind, prefix, key_hash, network)
       values ('key_1', $1, 'merchant', 'sk_test_', 'hash_1', 'testnet')`,
      [MERCHANT],
    );
    await h.db.query(
      `insert into idempotency_keys
         (api_key_id, idem_key, request_hash, response_status, response_body, created_at)
       values ('key_1', 'old', 'h', 201, '{}', $1), ('key_1', 'recent', 'h', 201, '{}', $2)`,
      [at(-25 * 60 * MIN), at(-23 * 60 * MIN)],
    );

    const result = await runSweeperTick(h.deps);

    expect(result).toEqual({ expired: 0, rateLimitsPurged: 1, idempotencyKeysPurged: 1 });
    expect(await h.db.query("select window_start from rate_limits")).toEqual([
      { window_start: at(-59 * MIN) },
    ]);
    expect(await h.db.query("select idem_key from idempotency_keys")).toEqual([
      { idem_key: "recent" },
    ]);
  });
});

describe("expireOverdueInvoices", () => {
  it("works in bounded batches", async () => {
    for (const id of ["inv_1", "inv_2", "inv_3"]) await insertInvoice(h.db, { id, ...overdue });

    expect(await expireOverdueInvoices(h.db, { now: NOW, limit: 2 })).toEqual({
      selected: 2,
      expired: 2,
    });
    expect(await expireOverdueInvoices(h.db, { now: NOW, limit: 2 })).toEqual({
      selected: 1,
      expired: 1,
    });
    expect(await expireOverdueInvoices(h.db, { now: NOW, limit: 2 })).toEqual({
      selected: 0,
      expired: 0,
    });
  });
});
