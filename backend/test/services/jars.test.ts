import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "../../src/contract/index.ts";
import { AppError } from "../../src/platform/errors.ts";
import { memoHash } from "../../src/zcash/memo.ts";
import { type Harness, createHarness, createMerchant, createUser } from "../support/harness.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

describe("jars service", () => {
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

  const charge = (jarId: string, amount: string, memo?: string) => {
    const plan = h.services.jars.prepareCharge(merchantId, "testnet", jarId, {
      amount_zec: amount,
      ...(memo === undefined ? {} : { memo }),
    });
    return h.db.tx((sql) => h.services.jars.charge(sql, plan));
  };

  it("creates a jar as a spending limit on the merchant's address", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "0.0500",
      label: " research-agent ",
    });
    expect(jar).toMatchObject({
      label: "research-agent",
      status: "open",
      network: "testnet",
      cap_zec: "0.05",
      spent_zec: "0",
      remaining_zec: "0.05",
      address,
      charge_count: 0,
      killed_at: null,
      note: COPY.killNote,
    });
  });

  it("validates cap and label and needs an address", async () => {
    expect(
      (await rejects(h.services.jars.create(merchantId, "testnet", { cap_zec: "0", label: "x" })))
        .code,
    ).toBe("BAD_AMOUNT");
    expect(
      (await rejects(h.services.jars.create(merchantId, "testnet", { cap_zec: "1", label: "  " })))
        .code,
    ).toBe("BAD_LABEL");
    expect(
      (
        await rejects(
          h.services.jars.create(merchantId, "testnet", { cap_zec: "1", label: "a".repeat(49) }),
        )
      ).code,
    ).toBe("BAD_LABEL");
    const bare = await createUser(h);
    expect(
      (
        await rejects(
          h.services.jars.create(bare.merchantId, "testnet", { cap_zec: "1", label: "x" }),
        )
      ).code,
    ).toBe("NO_ADDRESS");
  });

  it("charges until the cap, then 402 JAR_EMPTY with the remaining allowance", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "0.006",
      label: "agent",
    });
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await charge(jar.id, "0.002", "api:search"));
    expect(results.map((r) => r.remaining_zec)).toEqual(["0.004", "0.002", "0"]);
    expect(results[0]).toMatchObject({
      jar_id: jar.id,
      amount_zec: "0.002",
      memo_hash: memoHash("api:search"),
      status: "authorized",
    });
    const empty = await rejects(charge(jar.id, "0.002"));
    expect(empty).toMatchObject({
      status: 402,
      code: "JAR_EMPTY",
      message: COPY.jarEmpty,
      extra: { remaining_zec: "0" },
    });
    const [listed] = (await h.services.jars.list(merchantId, "testnet")).filter(
      (j) => j.id === jar.id,
    );
    expect(listed).toMatchObject({ spent_zec: "0.006", remaining_zec: "0", charge_count: 3 });

    const child = await h.services.invoices.get(
      { merchantId, network: "testnet" },
      results[0]?.invoice_id ?? "",
    );
    expect(child).toMatchObject({
      status: "authorized",
      verification: "jar_ledger",
      jar_id: jar.id,
      chain_memo: "api:search",
      address: null,
      zip321: null,
      pay_url: null,
    });
    // Jar charges are not payable: the public pay page 404s them.
    expect((await rejects(h.services.invoices.getPublic(child.id))).status).toBe(404);
    // And they are not listed with invoices.
    const page = await h.services.invoices.list(merchantId, "testnet", [], {
      cursor: null,
      limit: 100,
    });
    expect(page.items.map((i) => i.id)).not.toContain(child.id);
  });

  it("validates charge amounts and memos (up to 512 bytes, no ref)", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "1",
      label: "memo",
    });
    expect(() =>
      h.services.jars.prepareCharge(merchantId, "testnet", jar.id, { amount_zec: "x" }),
    ).toThrow(AppError);
    expect(() =>
      h.services.jars.prepareCharge(merchantId, "testnet", jar.id, {
        amount_zec: "0.1",
        memo: "y".repeat(513),
      }),
    ).toThrow(/512/);
    const ok = await charge(jar.id, "0.1", "z".repeat(512));
    expect(ok.status).toBe("authorized");
  });

  it("kills a jar: further charges are 409 JAR_CLOSED, kill is idempotent", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "0.01",
      label: "kill",
    });
    await charge(jar.id, "0.004");
    const killed = await h.services.jars.kill({ merchantId, network: "testnet" }, jar.id);
    expect(killed).toMatchObject({ status: "killed", spent_zec: "0.004", note: COPY.killNote });
    expect(killed.killed_at).not.toBeNull();
    const closed = await rejects(charge(jar.id, "0.001"));
    expect(closed).toMatchObject({
      status: 409,
      code: "JAR_CLOSED",
      message: COPY.jarClosed,
      extra: { remaining_zec: "0.006" },
    });
    const again = await h.services.jars.kill({ merchantId, network: null }, jar.id);
    expect(again.killed_at).toBe(killed.killed_at);
  });

  it("refunds a cancelled charge only while the jar is open", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "0.01",
      label: "refund",
    });
    const first = await charge(jar.id, "0.004");
    const second = await charge(jar.id, "0.003");
    const scope = { merchantId, network: null };
    const { jar: refunded, invoice } = await h.services.jars.cancelCharge(
      scope,
      jar.id,
      first.invoice_id,
    );
    expect(refunded).toMatchObject({ spent_zec: "0.003", remaining_zec: "0.007", charge_count: 1 });
    expect(invoice.status).toBe("cancelled");
    expect(
      (await rejects(h.services.jars.cancelCharge(scope, jar.id, first.invoice_id))).code,
    ).toBe("NOT_OPEN");

    const page = await h.services.jars.charges(merchantId, jar.id, { cursor: null, limit: 10 });
    expect(page.items.map((c) => [c.id, c.status])).toEqual([
      [second.invoice_id, "authorized"],
      [first.invoice_id, "cancelled"],
    ]);

    await h.services.jars.kill(scope, jar.id);
    const closed = await rejects(h.services.jars.cancelCharge(scope, jar.id, second.invoice_id));
    expect(closed).toMatchObject({ status: 409, code: "JAR_CLOSED" });
  });

  it("scopes jars by merchant and network", async () => {
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "1",
      label: "scoped",
    });
    const stranger = await createMerchant(h);
    expect(
      (
        await rejects(
          h.services.jars.kill({ merchantId: stranger.merchantId, network: null }, jar.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (await rejects(h.services.jars.kill({ merchantId, network: "mainnet" }, jar.id))).status,
    ).toBe(404);
    const plan = h.services.jars.prepareCharge(stranger.merchantId, "testnet", jar.id, {
      amount_zec: "0.1",
    });
    expect((await rejects(h.db.tx((sql) => h.services.jars.charge(sql, plan)))).status).toBe(404);
  });
});
