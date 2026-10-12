/**
 * jars.charge_count is kept by triggers on invoices (migration 0013), so it stays exact whatever
 * code writes the charge rows: the jar service, or an API process from before 0012 during a rolling
 * deploy (simulated here with raw SQL that never touches jars).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, createHarness, createMerchant } from "../support/harness.ts";

const MIGRATION = readFileSync(
  new URL("../../migrations/0013_jar_charge_count_trigger.sql", import.meta.url),
  "utf8",
);

describe("jars.charge_count", () => {
  let h: Harness;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness();
    merchantId = (await createMerchant(h)).merchantId;
  });
  afterAll(() => h.close());

  const count = async (jarId: string) =>
    (await h.db<{ charge_count: number }>`select charge_count from jars where id = ${jarId}`)[0]
      ?.charge_count;

  /** A charge written the way pre-0012 code did: it debits spent_zec and never touches charge_count. */
  const rawCharge = async (id: string, jarId: string, status = "authorized") => {
    if (status === "authorized") {
      await h.db`update jars set spent_zec = spent_zec + 0.001 where id = ${jarId}`;
    }
    await h.db.query(
      `insert into invoices (id, merchant_id, jar_id, amount_zec, memo, memo_hash, network, address,
         zip321, status, verification, expires_at, created_at)
       values ($1, $2, $3, 0.001, 'raw', 'sha256:' || md5($1), 'testnet', 'utest1x', '', $4,
         'jar_ledger', now(), now())`,
      [id, merchantId, jarId, status],
    );
  };

  it("counts live charges from the service and from raw writes, and never goes negative", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "1",
      label: "counted",
    });
    const plan = h.services.jars.prepareCharge(merchantId, "testnet", jar.id, {
      amount_zec: "0.002",
    });
    const charged = await h.db.tx((sql) => h.services.jars.charge(sql, plan));
    expect(await count(jar.id)).toBe(1);

    await rawCharge("inv_raw_1", jar.id);
    await rawCharge("inv_raw_2", jar.id, "cancelled");
    expect(await count(jar.id)).toBe(2);

    // Cancelling the raw charge (a refund the old count could not see) stays consistent.
    await h.services.jars.cancelCharge({ merchantId, network: "testnet" }, jar.id, "inv_raw_1");
    expect(await count(jar.id)).toBe(1);
    await h.services.jars.cancelCharge(
      { merchantId, network: "testnet" },
      jar.id,
      charged.invoice_id,
    );
    expect(await count(jar.id)).toBe(0);
    // Only status changes count: other updates of a cancelled charge change nothing.
    await h.db`update invoices set memo = 'edited' where id = 'inv_raw_2'`;
    await h.db`delete from invoices where id = 'inv_raw_2'`;
    expect(await count(jar.id)).toBe(0);
    expect(
      (await h.services.jars.get({ merchantId, network: "testnet" }, jar.id)).charge_count,
    ).toBe(0);
  });

  it("the migration's backfill repairs a drifted count and can run again", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "1",
      label: "drifted",
    });
    await rawCharge("inv_raw_3", jar.id);
    await h.db`update jars set charge_count = 7 where id = ${jar.id}`;
    await h.db.pglite!.exec(MIGRATION);
    expect(await count(jar.id)).toBe(1);
    await h.db.pglite!.exec(MIGRATION);
    await rawCharge("inv_raw_4", jar.id);
    expect(await count(jar.id)).toBe(2);
  });
});
