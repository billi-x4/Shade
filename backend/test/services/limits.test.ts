import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/platform/errors.ts";
import { type Harness, createHarness, createMerchant } from "../support/harness.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

/**
 * Per-merchant soft caps keep one account from growing the shared scanner and desk work without
 * bound. Rows are seeded in bulk with SQL so the caps can be reached quickly.
 */
describe("per-merchant limits", () => {
  let h: Harness;
  let merchantId: string;
  let address: string;

  beforeAll(async () => {
    h = await createHarness();
    const merchant = await createMerchant(h);
    merchantId = merchant.merchantId;
    address = merchant.addresses.testnet ?? "";
  });
  afterAll(() => h.close());

  it("lists every live API key, then at most 200 revoked ones", async () => {
    const now = h.clock();
    await h.db.query(
      `insert into api_keys (id, merchant_id, kind, prefix, key_hash, label, network, last4,
         created_at, revoked_at)
       select 'key_seed_' || n, $1, 'merchant', 'sk_test_', md5('seed' || n), 'seed', 'testnet', 'abcd',
              $2::timestamptz - make_interval(secs => n),
              case when n <= 210 then $2::timestamptz else null end
       from generate_series(1, 415) as n`,
      [merchantId, now],
    );
    const listed = await h.services.keys.list(merchantId, "testnet");
    const live = listed.filter((key) => key.revoked_at === null);
    // The live keys are the oldest rows, yet every one is listed, first.
    expect(live).toHaveLength(205);
    expect(listed).toHaveLength(405);
    expect(listed.slice(0, 205).every((key) => key.revoked_at === null)).toBe(true);
    expect(listed.slice(205).every((key) => key.revoked_at !== null)).toBe(true);
    const created = listed.slice(205).map((key) => Date.parse(key.created_at));
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  it("refuses a jar past 100 open jars and lists at most 200", async () => {
    const now = h.clock();
    await h.db.query(
      `insert into jars (id, merchant_id, label, cap_zec, spent_zec, status, address, network, created_at)
       select 'jar_seed_' || n, $1, 'seed', 1, 0, case when n > 150 then 'open' else 'killed' end,
              $2, 'testnet', $3::timestamptz - make_interval(secs => n)
       from generate_series(1, 250) as n`,
      [merchantId, address, now],
    );
    const err = await rejects(
      h.services.jars.create(merchantId, "testnet", { cap_zec: "0.01", label: "one more" }),
    );
    expect(err).toMatchObject({ status: 409, code: "JAR_LIMIT" });
    // The open jars are the oldest rows, yet every one is listed (first), so each can be killed.
    const listed = await h.services.jars.list(merchantId, "testnet");
    expect(listed).toHaveLength(200);
    expect(listed.slice(0, 100).every((jar) => jar.status === "open")).toBe(true);

    await h.db`update jars set status = 'killed' where id = 'jar_seed_250'`;
    const created = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "0.01",
      label: "after a kill",
    });
    expect(created.status).toBe("open");
  });

  it("refuses a grant past 100 active grants; expired and revoked ones do not count", async () => {
    const now = h.clock();
    await h.db.query(
      `insert into grants (id, merchant_id, scope, network, duration_sec, token_hash, expires_at,
         revoked_at, created_at)
       select 'grn_seed_' || n, $1, 'all', 'testnet', 600, 'hash_' || n,
              case when n > 150 then $2::timestamptz + interval '1 day'
                   else $2::timestamptz - interval '1 day' end,
              case when n between 1 and 50 then $2::timestamptz else null end,
              $2::timestamptz - make_interval(secs => n)
       from generate_series(1, 250) as n`,
      [merchantId, now],
    );
    const err = await rejects(
      h.services.grants.create(merchantId, "testnet", { scope: "all", expires_in_sec: 600 }),
    );
    expect(err).toMatchObject({ status: 409, code: "GRANT_LIMIT" });
    // The active grants are the oldest rows, yet every one is listed (first), so each can be revoked.
    const listed = await h.services.grants.list(merchantId, "testnet");
    expect(listed).toHaveLength(200);
    expect(listed.slice(0, 100).every((grant) => grant.state === "active")).toBe(true);

    await h.db`update grants set revoked_at = ${now} where id = 'grn_seed_250'`;
    const created = await h.services.grants.create(merchantId, "testnet", {
      scope: "all",
      expires_in_sec: 600,
    });
    expect(created.state).toBe("active");
  });

  it("refuses an invoice past 10,000 unpaid invoices; expired, paid and jar rows do not count", async () => {
    const now = h.clock();
    await h.db.query(
      `insert into invoices (id, merchant_id, amount_zec, memo, memo_hash, network, address, zip321,
         status, expires_at, created_at)
       select 'inv_seed_' || n, $1, 0.01, 'seed', 'sha256:' || md5(n::text), 'testnet', $2, 'zcash:x',
              case when n <= 9999 then 'open' when n = 10000 then 'paid_unverified' else 'expired' end,
              case when n <= 10000 then $3::timestamptz + interval '1 hour'
                   else $3::timestamptz - interval '1 hour' end,
              $3::timestamptz
       from generate_series(1, 10100) as n`,
      [merchantId, address, now],
    );
    const err = await rejects(
      h.services.invoices.create(merchantId, "testnet", { amount_zec: "0.01", memo: "one more" }),
    );
    expect(err).toMatchObject({ status: 409, code: "INVOICE_LIMIT" });

    // An open invoice past its expiry no longer counts, even before the sweeper writes 'expired'.
    await h.db`update invoices set expires_at = ${new Date(now.getTime() - 1000)} where id = 'inv_seed_1'`;
    const created = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.01",
      memo: "after expiry",
    });
    expect(created.status).toBe("open");
  });
});
