/**
 * Worker races that a single-session PGlite cannot exercise. Runs only when TEST_DATABASE_URL
 * points at a disposable Postgres; each suite works inside its own schema and drops it afterwards.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSealKeyPair } from "../../src/platform/crypto.ts";
import { type Db, createDb } from "../../src/platform/db.ts";
import { runMigrations } from "../../src/platform/migrate.ts";
import {
  claimViewingKey,
  expireOverdueInvoices,
  listCandidatesByMemoHash,
  listDueViewingKeys,
  summarizeCandidates,
} from "../../src/worker/repo.ts";
import {
  MERCHANT,
  NOW,
  TIP,
  candidateScope,
  insertInvoice,
  insertMerchant,
  insertViewingKey,
  txid,
} from "./support.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIN = 60_000;

describe.skipIf(!databaseUrl)("worker on a real Postgres server", () => {
  const schema = `shade_worker_${randomBytes(4).toString("hex")}`;
  let admin: Db;
  let db: Db;
  const seal = generateSealKeyPair();

  beforeAll(async () => {
    admin = await createDb({ databaseUrl: databaseUrl ?? null, pgliteDir: null, env: "test" });
    await admin.query(`create schema ${schema}`);
    const url = new URL(databaseUrl ?? "");
    url.searchParams.set("options", `-c search_path=${schema}`);
    db = await createDb({ databaseUrl: url.toString(), pgliteDir: null, env: "test" });
    await runMigrations(db);
    await insertMerchant(db, MERCHANT);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.close();
  });

  beforeEach(async () => {
    await db.query("delete from invoice_detections");
    await db.query("delete from invoices");
    await db.query("delete from merchant_viewing_keys");
  });

  it("lets exactly one of many concurrent claimers take the scan lease", async () => {
    await insertViewingKey({ db, sealPublicKey: seal.publicKey }, { id: "vk_race" });
    const leases = Array.from({ length: 8 }, () => randomUUID());

    const claims = await Promise.all(
      leases.map((lease) =>
        claimViewingKey(db, {
          id: "vk_race",
          lease,
          now: NOW,
          lockedUntil: new Date(NOW.getTime() + 120_000),
        }),
      ),
    );

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const [row] = await db.query<{ scan_lease: string }>(
      "select scan_lease from merchant_viewing_keys where id = 'vk_race'",
    );
    expect(leases).toContain(row?.scan_lease);
  });

  it("does not expire an invoice while a settlement holds it and records a payment", async () => {
    const memo = await insertInvoice(db, {
      id: "inv_race",
      createdAt: new Date(NOW.getTime() - 120 * MIN),
      expiresAt: new Date(NOW.getTime() - 60 * MIN),
    });
    let locked: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    // A settlement-like transaction: lock the invoice, record a seen detection, commit later.
    const settlement = db.tx(async (sql) => {
      await sql`select id from invoices where id = 'inv_race' for update`;
      await sql`
        insert into invoice_detections
          (id, merchant_id, invoice_id, txid, pool, amount_zec, memo_hash, block_height,
           observed_at, source, network, state)
        values ('det_race', ${MERCHANT}, 'inv_race', ${txid(1)}, 'ironwood', 0.01, ${memo},
                ${TIP}, ${NOW}, 'shade_worker', 'testnet', 'seen')`;
      locked();
      await finished;
    });
    await lockTaken;

    const whileLocked = await expireOverdueInvoices(db, { now: NOW, limit: 10 });
    finish();
    await settlement;
    const afterCommit = await expireOverdueInvoices(db, { now: NOW, limit: 10 });

    expect(whileLocked).toEqual({ selected: 0, expired: 0 });
    expect(afterCommit).toEqual({ selected: 0, expired: 0 });
    const [row] = await db.query<{ status: string }>(
      "select status from invoices where id = 'inv_race'",
    );
    expect(row?.status).toBe("open");
  });

  it("selects candidates by scan progress on Postgres", async () => {
    const covered = await insertInvoice(db, {
      id: "inv_covered",
      status: "expired",
      createdAt: new Date(NOW.getTime() - 500 * MIN),
      expiresAt: new Date(NOW.getTime() - 371 * MIN),
    });
    const uncovered = await insertInvoice(db, {
      id: "inv_uncovered",
      status: "expired",
      createdAt: new Date(NOW.getTime() - 200 * MIN),
      expiresAt: new Date(NOW.getTime() - 71 * MIN),
    });
    await insertViewingKey(
      { db, sealPublicKey: seal.publicKey },
      {
        id: "vk_progress",
        cursorHeight: TIP - 240,
        cursorTime: new Date(NOW.getTime() - 300 * MIN),
      },
    );

    const scope = await candidateScope(db, "vk_progress");
    const candidates = await listCandidatesByMemoHash(db, {
      ...scope,
      memoHashes: [covered, uncovered],
    });
    const summary = await summarizeCandidates(db, scope);
    const due = await listDueViewingKeys(db, { networks: ["testnet"], now: NOW, limit: 10 });

    expect(candidates.map((c) => c.id)).toEqual(["inv_uncovered"]);
    expect(summary).toEqual({
      count: 1,
      lowestCreatedHeight: TIP - 8,
      earliestUnknownCreatedAt: null,
    });
    expect(due).toEqual(["vk_progress"]);
  });
});
