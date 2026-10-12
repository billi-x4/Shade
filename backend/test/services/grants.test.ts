import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY, type GrantView } from "../../src/contract/index.ts";
import { sha256Hex } from "../../src/platform/crypto.ts";
import { AppError } from "../../src/platform/errors.ts";
import { csvCell } from "../../src/services/grants.ts";
import { type Harness, createHarness, createMerchant, randomTxid } from "../support/harness.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

type Active = Extract<GrantView, { state: "active" }>;

describe("grants service", () => {
  let h: Harness;
  let merchantId: string;

  /** A paid invoice with the given tag and verification. */
  const paidInvoice = async (tag: string | null, verification: string, memo = "receipt") => {
    const invoice = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.01",
      memo,
      tag,
    });
    await h.db`
      update invoices set status = 'paid', verification = ${verification}, txid = ${randomTxid()},
        paid_at = ${h.clock()} where id = ${invoice.id}`;
    return invoice;
  };

  beforeAll(async () => {
    h = await createHarness();
    merchantId = (await createMerchant(h, { name: "Payroll Co" })).merchantId;
  });
  afterAll(() => h.close());

  it("creates a grant with a one-time token stored only as a hash", async () => {
    const grant = await h.services.grants.create(merchantId, "testnet", {
      scope: "Payroll",
      days: 7,
    });
    expect(grant).toMatchObject({
      scope: "payroll",
      network: "testnet",
      state: "active",
      revoked_at: null,
      last_viewed_at: null,
      note: COPY.grantNote,
    });
    expect(grant.token).toMatch(/^gv_[A-Za-z0-9_-]{43}$/);
    expect(grant.view_url).toBe(`${h.config.appOrigin}/view#${grant.token}`);
    expect(Date.parse(grant.expires_at) - Date.parse(grant.created_at)).toBe(7 * 86_400_000);
    const [row] = await h.db<{ token_hash: string; duration_sec: number; days: number | null }>`
      select token_hash, duration_sec, days from grants where id = ${grant.id}`;
    expect(row).toEqual({ token_hash: sha256Hex(grant.token), duration_sec: 604_800, days: 7 });
  });

  it("accepts days or expires_in_sec (10 minutes to 90 days)", async () => {
    const short = await h.services.grants.create(merchantId, "testnet", {
      scope: "all",
      expires_in_sec: 600,
    });
    expect(Date.parse(short.expires_at) - Date.parse(short.created_at)).toBe(600_000);
    const defaulted = await h.services.grants.create(merchantId, "testnet", { scope: "all" });
    expect(Date.parse(defaulted.expires_at) - Date.parse(defaulted.created_at)).toBe(
      7 * 86_400_000,
    );
    for (const input of [
      { scope: "all", expires_in_sec: 599 },
      { scope: "all", expires_in_sec: 7_776_001 },
      { scope: "all", days: 0 },
      { scope: "all", days: 91 },
      { scope: "all", days: 1.5 },
      { scope: "all", days: 1, expires_in_sec: 600 },
    ]) {
      expect((await rejects(h.services.grants.create(merchantId, "testnet", input))).code).toBe(
        "BAD_DURATION",
      );
    }
    expect(
      (await rejects(h.services.grants.create(merchantId, "testnet", { scope: "pay roll" }))).code,
    ).toBe("BAD_SCOPE");
  });

  it("serves verified receipts in scope and network, newest first", async () => {
    const scanned = await paidInvoice("payroll", "ivk_scan");
    const accepted = await paidInvoice("payroll", "merchant_accept");
    await paidInvoice("payroll", "txid_unverified");
    await paidInvoice("rent", "ivk_scan");
    const open = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "1",
      tag: "payroll",
    });
    const jar = await h.services.jars.create(merchantId, "testnet", {
      cap_zec: "1",
      label: "agent",
    });
    const plan = h.services.jars.prepareCharge(merchantId, "testnet", jar.id, {
      amount_zec: "0.1",
      memo: "api",
    });
    const charge = await h.db.tx((sql) => h.services.jars.charge(sql, plan));

    const payroll = await h.services.grants.create(merchantId, "testnet", {
      scope: "payroll",
      days: 1,
    });
    const view = (await h.services.grants.view(payroll.token)) as Active;
    expect(view).toMatchObject({
      state: "active",
      scope: "payroll",
      network: "testnet",
      merchant_name: "Payroll Co",
      message: COPY.grantNote,
    });
    expect(view.receipts.map((r) => r.id)).toEqual([accepted.id, scanned.id]);
    expect(view.receipts[0]).toMatchObject({
      kind: "invoice",
      amount_zec: "0.01",
      memo: "receipt",
      memo_hash: accepted.memo_hash,
      tag: "payroll",
      verification: "merchant_accept",
    });
    expect(view.receipts.map((r) => r.id)).not.toContain(open.id);

    const all = await h.services.grants.create(merchantId, "testnet", { scope: "all", days: 1 });
    const everything = (await h.services.grants.view(all.token)) as Active;
    expect(everything.receipts[0]).toMatchObject({
      id: charge.invoice_id,
      kind: "jar_charge",
      verification: "jar_ledger",
      txid: null,
      paid_at: null,
    });
    expect(everything.receipts).toHaveLength(4);

    const [row] = await h.db<{ last_viewed_at: Date | null }>`
      select last_viewed_at from grants where id = ${payroll.id}`;
    expect(row?.last_viewed_at).toBeInstanceOf(Date);
  });

  it("exports CSV with escaping and a formula-injection guard", async () => {
    const other = await createMerchant(h);
    const invoice = await h.services.invoices.create(other.merchantId, "testnet", {
      amount_zec: "0.5",
      memo: '=HYPERLINK("http://x"), "quoted"',
      tag: "audit",
    });
    await h.db`
      update invoices set status = 'paid', verification = 'ivk_scan', txid = ${"f".repeat(64)},
        paid_at = ${new Date("2026-10-02T12:00:00.000Z")} where id = ${invoice.id}`;
    const grant = await h.services.grants.create(other.merchantId, "testnet", {
      scope: "audit",
      days: 1,
    });
    const exported = await h.services.grants.exportCsv(grant.token);
    expect(exported.filename).toBe(`shade-receipts-${grant.id}.csv`);
    expect(exported.csv).toBe(
      "paid_at,invoice_id,kind,amount_zec,memo,tag,txid,verification\r\n" +
        `2026-10-02T12:00:00.000Z,${invoice.id},invoice,0.5,"'=HYPERLINK(""http://x""), ""quoted""",audit,${"f".repeat(64)},ivk_scan\r\n`,
    );
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("revokes: the view says so and export is 410 GRANT_REVOKED", async () => {
    const grant = await h.services.grants.create(merchantId, "testnet", { scope: "all", days: 1 });
    const revoked = await h.services.grants.revoke({ merchantId, network: null }, grant.id);
    expect(revoked.state).toBe("revoked");
    expect(await h.services.grants.view(grant.token)).toEqual({
      state: "revoked",
      scope: "all",
      message: COPY.grantNote,
    });
    expect(await rejects(h.services.grants.exportCsv(grant.token))).toMatchObject({
      status: 410,
      code: "GRANT_REVOKED",
    });
    const again = await h.services.grants.revoke({ merchantId, network: "testnet" }, grant.id);
    expect(again.revoked_at).toBe(revoked.revoked_at);
  });

  it("expires: the view says so and export is 410 GRANT_EXPIRED", async () => {
    const grant = await h.services.grants.create(merchantId, "testnet", {
      scope: "all",
      expires_in_sec: 600,
    });
    h.clock.advance(601_000);
    const view = await h.services.grants.view(grant.token);
    expect(view).toMatchObject({ state: "expired", scope: "all", expires_at: grant.expires_at });
    expect((await rejects(h.services.grants.exportCsv(grant.token))).code).toBe("GRANT_EXPIRED");
    const [listed] = (await h.services.grants.list(merchantId, "testnet")).filter(
      (g) => g.id === grant.id,
    );
    expect(listed?.state).toBe("expired");
  });

  it("404s unknown tokens and other merchants' grants", async () => {
    expect((await rejects(h.services.grants.view(`gv_${"A".repeat(43)}`))).status).toBe(404);
    expect((await rejects(h.services.grants.view("not-a-token"))).status).toBe(404);
    expect((await rejects(h.services.grants.exportCsv("gv_short"))).status).toBe(404);
    const grant = await h.services.grants.create(merchantId, "testnet", { scope: "all", days: 1 });
    const stranger = await createMerchant(h);
    expect(
      (
        await rejects(
          h.services.grants.revoke({ merchantId: stranger.merchantId, network: null }, grant.id),
        )
      ).status,
    ).toBe(404);
  });
});
