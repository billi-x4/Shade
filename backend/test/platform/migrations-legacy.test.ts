/**
 * Upgrading a database that already holds v0 data: rows are written the way the legacy store
 * wrote them (rehearse → acceptUnverified, submitTxid), then the v1 migrations run over them.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/platform/config.ts";
import { type Db, openPglite } from "../../src/platform/db.ts";
import { createLogger } from "../../src/platform/logger.ts";
import { MIGRATIONS_DIR, runMigrations } from "../../src/platform/migrate.ts";
import { createServices } from "../../src/services/index.ts";
import { decodeUnified, parseMerchantAddress } from "../../src/zcash/address.ts";
import { createFakeChain, createFakeScanner } from "../support/fake-chain.ts";
import { testAddress } from "../support/harness.ts";

const SHIPPED = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();
/** The v0 schema the legacy store ran on. */
const V0 = SHIPPED.slice(0, 4);
/** What databases such as shade_dev applied before the legacy cleanup shipped. */
const BEFORE_CLEANUP = SHIPPED.filter((name) => name < "0007");

const PAID_AT = new Date("2026-09-30T10:00:00.000Z");
const txid = (byte: string) => byte.repeat(32);

let db: Db;
let dir: string;

beforeEach(async () => {
  db = await openPglite(null);
  dir = mkdtempSync(join(tmpdir(), "shade-legacy-"));
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Applies exactly `names` from the shipped directory (recorded under the same names/checksums). */
async function migrateThrough(names: string[]): Promise<void> {
  for (const name of names) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  await runMigrations(db, { dir });
}

function v1Services() {
  return createServices({
    db,
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    logger: createLogger({ logLevel: "silent", env: "test" }),
    chain: { testnet: createFakeChain("testnet"), mainnet: createFakeChain("mainnet") },
    scanner: createFakeScanner(),
    mailer: { send: async () => {} },
    clock: () => new Date("2026-10-02T12:00:00.000Z"),
  });
}

async function seedV0(address: string): Promise<void> {
  await db`insert into "user" (id, name, email, "emailVerified") values ('u1', 'Legacy', 'l@example.com', true)`;
  await db`insert into merchants (id, user_id, display_name, network, ua_testnet, webhook_secret)
    values ('mer_1', 'u1', 'Legacy shop', 'testnet', ${address}, 'whsec_old')`;
  await db`insert into jars (id, merchant_id, label, cap_zec, spent_zec, address, network)
    values ('jar_1', 'mer_1', 'agent', 1, 0.1, ${address}, 'testnet')`;
  const invoice = (
    id: string,
    status: string,
    verification: string | null,
    tx: string | null,
    paidAt: Date | null,
    jarId: string | null = null,
  ) => db`
    insert into invoices (id, merchant_id, jar_id, amount_zec, memo, memo_hash, tag, network,
      address, zip321, status, verification, txid, expires_at, paid_at, created_at)
    values (${id}, 'mer_1', ${jarId}, 0.1, ${id}, 'sha256:legacy', 'payroll', 'testnet',
      ${address}, 'zcash:legacy', ${status}, ${verification}, ${tx},
      ${new Date("2026-10-30T00:00:00.000Z")}, ${paidAt}, ${new Date("2026-09-30T09:00:00.000Z")})`;
  // rehearse() then acceptUnverified(): no txid check for a rehearsal, so paid without a txid.
  await invoice("inv_accepted_rehearsal", "paid", "merchant_accept", null, PAID_AT);
  // rehearse() alone.
  await invoice("inv_rehearsal", "paid_unverified", "rehearsal", null, PAID_AT);
  // submitTxid(): a payer paste set paid_at.
  await invoice("inv_claim", "paid_unverified", "txid_unverified", txid("a1"), PAID_AT);
  await invoice("inv_claim_rejected", "paid_unverified", "txid_unverified", txid("a2"), PAID_AT);
  // Real settlements and a jar charge keep their payment time.
  await invoice("inv_scanned", "paid", "ivk_scan", txid("b1"), PAID_AT);
  await invoice("inv_accepted", "paid", "merchant_accept", txid("b2"), PAID_AT);
  await invoice("inv_charge", "authorized", "jar_ledger", null, PAID_AT, "jar_1");
}

describe("legacy payment rows", () => {
  it("retires accepted rehearsals and clears payment times that only claims carried", async () => {
    const address = testAddress("testnet");
    await migrateThrough(V0);
    await seedV0(address);
    await migrateThrough(BEFORE_CLEANUP);
    // A claim the merchant rejected after 0005 ran (what rejectClaim did: paid_at untouched).
    await db`update invoices set status = 'open', claimed_txid = null, verification = null
      where id = 'inv_claim_rejected'`;
    await runMigrations(db);

    const rows = await db<{
      id: string;
      status: string;
      verification: string | null;
      txid: string | null;
      claimed_txid: string | null;
      paid_at: Date | null;
    }>`select id, status, verification, txid, claimed_txid, paid_at from invoices order by id`;
    expect(rows).toEqual([
      {
        id: "inv_accepted",
        status: "paid",
        verification: "merchant_accept",
        txid: txid("b2"),
        claimed_txid: null,
        paid_at: PAID_AT,
      },
      {
        id: "inv_accepted_rehearsal",
        status: "cancelled",
        verification: null,
        txid: null,
        claimed_txid: null,
        paid_at: null,
      },
      {
        id: "inv_charge",
        status: "authorized",
        verification: "jar_ledger",
        txid: null,
        claimed_txid: null,
        paid_at: PAID_AT,
      },
      {
        id: "inv_claim",
        status: "paid_unverified",
        verification: "txid_unverified",
        txid: null,
        claimed_txid: txid("a1"),
        paid_at: null,
      },
      {
        id: "inv_claim_rejected",
        status: "open",
        verification: null,
        txid: null,
        claimed_txid: null,
        paid_at: null,
      },
      {
        id: "inv_rehearsal",
        status: "cancelled",
        verification: null,
        txid: null,
        claimed_txid: null,
        paid_at: null,
      },
      {
        id: "inv_scanned",
        status: "paid",
        verification: "ivk_scan",
        txid: txid("b1"),
        claimed_txid: null,
        paid_at: PAID_AT,
      },
    ]);

    // What auditors and payers are served from those rows.
    const services = v1Services();
    const { token } = await services.grants.create("mer_1", "testnet", { scope: "all", days: 7 });
    const view = await services.grants.view(token);
    expect(view.state).toBe("active");
    const receipts = view.state === "active" ? view.receipts : [];
    expect(receipts.map((r) => r.id).sort()).toEqual(["inv_accepted", "inv_charge", "inv_scanned"]);
    expect(receipts.every((r) => r.kind === "jar_charge" || r.txid !== null)).toBe(true);

    const reopened = await services.invoices.getPublic("inv_claim_rejected");
    expect(reopened).toMatchObject({ status: "open", paid_at: null });
    await services.idle();
  }, 60_000);

  it("refuses a payment time on an invoice that has not settled", async () => {
    await migrateThrough(V0);
    await seedV0(testAddress("testnet"));
    await runMigrations(db);
    await expect(
      db`update invoices set paid_at = ${PAID_AT} where id = 'inv_claim'`,
    ).rejects.toMatchObject({ constraint: "invoices_paid_at_settled_check" });
    await db`update invoices set status = 'paid', verification = 'merchant_accept',
      txid = claimed_txid, claimed_txid = null, paid_at = ${PAID_AT} where id = 'inv_claim'`;
  }, 60_000);
});

describe("legacy receive addresses", () => {
  it("pays, charges and resolves a v0 address with a transparent receiver shielded-only", async () => {
    // v0 stored any valid Unified Address, so a wallet's usual P2PKH + Orchard UA is common. The
    // SQL migrations cannot re-encode it (F4Jumble), so the v1 readers must strip it themselves.
    const legacy = testAddress("testnet", { transparent: true });
    const parsed = parseMerchantAddress(legacy, "testnet");
    if (!parsed.ok) throw new Error("expected a valid address");
    const shielded = parsed.address;
    expect(shielded).not.toBe(legacy);
    await migrateThrough(V0);
    await seedV0(legacy);
    await db`insert into tags (id, merchant_id, name) values ('tag_1', 'mer_1', 'legacy-shop')`;
    await runMigrations(db);

    const services = v1Services();
    const invoice = await services.invoices.create("mer_1", "testnet", {
      amount_zec: "0.25",
      memo: "order 7",
    });
    expect(invoice.address).toBe(shielded);
    expect(invoice.zip321?.startsWith(`zcash:${shielded}?amount=0.25&memo=`)).toBe(true);
    const receivers = decodeUnified(shielded).items.map((item) => item.typecode);
    expect(receivers).toEqual([0x03]);

    const plan = services.jars.prepareCharge("mer_1", "testnet", "jar_1", {
      amount_zec: "0.01",
      memo: "call 1",
    });
    const charge = await db.tx((sql) => services.jars.charge(sql, plan));
    expect(charge).toMatchObject({ jar_id: "jar_1", status: "authorized", remaining_zec: "0.89" });

    expect(await services.tags.resolve("legacy-shop")).toEqual({
      name: "legacy-shop",
      network: "testnet",
      address: shielded,
    });
    await services.idle();
  }, 60_000);
});
