/**
 * Races that one PGlite session cannot exercise. Runs only when TEST_DATABASE_URL points at a
 * disposable Postgres; each suite migrates its own schema and drops it afterwards.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Network } from "../../src/contract/index.ts";
import { createApp } from "../../src/http/app.ts";
import { createAuth } from "../../src/platform/auth.ts";
import { loadConfig } from "../../src/platform/config.ts";
import { type Db, type Row, type Sql, createDb } from "../../src/platform/db.ts";
import { AppError } from "../../src/platform/errors.ts";
import { createLogger } from "../../src/platform/logger.ts";
import { runMigrations } from "../../src/platform/migrate.ts";
import { createBackground } from "../../src/services/background.ts";
import { type Services, createServices } from "../../src/services/index.ts";
import { createFakeChain, createFakeScanner } from "../support/fake-chain.ts";
import {
  createClock,
  putShieldedTx,
  randomTxid,
  testAddress,
  webhookReceiver,
} from "../support/harness.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * A Db whose transactions pause right after their first statement matching `pattern` until
 * `release()` is called; `paused` resolves when one got there. Deterministic interleavings.
 */
function gated(db: Db, pattern: RegExp) {
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => (reached = resolve));
  const opened = new Promise<void>((resolve) => (release = resolve));
  const wrap = (sql: Sql): Sql => {
    let fired = false;
    const after = async <T>(text: string, result: Promise<T>): Promise<T> => {
      const value = await result;
      if (!fired && pattern.test(text)) {
        fired = true;
        reached();
        await opened;
      }
      return value;
    };
    return Object.assign(
      <T = Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
        after(strings.join("?"), sql<T>(strings, ...values)),
      {
        query: <T = Row>(text: string, params?: unknown[]) =>
          after(text, sql.query<T>(text, params)),
      },
    );
  };
  const gatedDb: Db = Object.assign(
    <T = Row>(strings: TemplateStringsArray, ...values: unknown[]) => db<T>(strings, ...values),
    {
      kind: db.kind,
      pool: db.pool,
      pglite: db.pglite,
      query: db.query,
      close: () => db.close(),
      tx: <T>(fn: (sql: Sql) => Promise<T>) => db.tx((sql) => fn(wrap(sql))),
    },
  );
  return { db: gatedDb, paused, release };
}

/** Settles (or rejects) after `ms`, reporting whether `promise` was still pending by then. */
async function pendingAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !done;
}

function schemaUrl(schema: string): string {
  const url = new URL(databaseUrl ?? "");
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

describe.skipIf(!databaseUrl)("services on a real Postgres server", () => {
  const schema = `shade_services_${randomBytes(4).toString("hex")}`;
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    SHADE_WEBHOOK_ALLOW_PRIVATE: "true",
  });
  const logger = createLogger({ logLevel: "silent", env: "test" });
  const clock = createClock();
  const chain = { testnet: createFakeChain("testnet"), mainnet: createFakeChain("mainnet") };
  let admin: Db;
  let dbs: Db[];

  /** Independent service stacks over separate pools, like two API or worker processes. */
  const stack = (db: Db): Services =>
    createServices({
      db,
      config,
      logger,
      chain,
      scanner: createFakeScanner(),
      mailer: { send: async () => {} },
      clock,
    });

  const merchant = async (db: Db, network: Network = "testnet") => {
    const userId = `user_${randomBytes(6).toString("hex")}`;
    await db`
      insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'Race Shop', ${`${userId}@example.com`}, true, now(), now())`;
    const services = stack(db);
    const record = await services.merchants.ensure({ id: userId, name: "Race Shop" });
    await db.query(
      `update merchants set ${network === "mainnet" ? "ua_mainnet" : "ua_testnet"} = $1 where id = $2`,
      [testAddress(network), record.id],
    );
    return record.id;
  };

  beforeAll(async () => {
    admin = await createDb({ databaseUrl: databaseUrl ?? null, pgliteDir: null, env: "test" });
    await admin.query(`create schema ${schema}`);
    dbs = await Promise.all(
      [0, 1, 2].map(() =>
        createDb({ databaseUrl: schemaUrl(schema), pgliteDir: null, env: "test" }),
      ),
    );
    await runMigrations(dbs[0]!);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(dbs.map((db) => db.close()));
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.close();
  });

  it("concurrent jar charges at the cap: exactly floor(cap / amount) succeed", async () => {
    const db = dbs[0]!;
    const merchantId = await merchant(db);
    const services = dbs.map(stack);
    const jar = await services[0]!.jars.create(merchantId, "testnet", {
      cap_zec: "0.01",
      label: "race",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => {
        const s = services[i % services.length]!;
        const plan = s.jars.prepareCharge(merchantId, "testnet", jar.id, { amount_zec: "0.003" });
        return dbs[i % dbs.length]!.tx((sql) => s.jars.charge(sql, plan));
      }),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const empty = results.filter(
      (r) =>
        r.status === "rejected" && r.reason instanceof AppError && r.reason.code === "JAR_EMPTY",
    );
    expect(ok).toHaveLength(3);
    expect(empty).toHaveLength(9);
    const [state] = await db<{
      spent_zec: string;
    }>`select spent_zec from jars where id = ${jar.id}`;
    expect(state?.spent_zec).toBe("0.00900000");
  });

  it("a charge racing kill is either authorized or JAR_CLOSED, never JAR_EMPTY", async () => {
    const merchantId = await merchant(dbs[0]!);
    const services = dbs.map(stack);
    const jar = await services[0]!.jars.create(merchantId, "testnet", {
      cap_zec: "1",
      label: "kill race",
    });
    const charges = Array.from({ length: 6 }, (_, i) => {
      const s = services[(i % 2) + 1]!;
      const plan = s.jars.prepareCharge(merchantId, "testnet", jar.id, { amount_zec: "0.01" });
      return dbs[(i % 2) + 1]!.tx((sql) => s.jars.charge(sql, plan));
    });
    const kill = services[0]!.jars.kill({ merchantId, network: null }, jar.id);
    const results = await Promise.allSettled([...charges, kill]);
    for (const result of results.slice(0, 6)) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "JAR_CLOSED" });
      }
    }
  });

  it("two outbox claimers never double-claim a delivery", async () => {
    const receiver = await webhookReceiver();
    try {
      const merchantId = await merchant(dbs[0]!);
      const [a, b] = [stack(dbs[1]!), stack(dbs[2]!)];
      await a.webhooks.createEndpoint(merchantId, "testnet", receiver.url);
      const events: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        const event = await dbs[0]!.tx((sql) =>
          a.webhooks.enqueueEvent(sql, {
            merchantId,
            network: "testnet",
            type: "webhook.test",
            invoiceId: null,
            fields: {
              invoice_id: null,
              amount_zec: null,
              memo_hash: null,
              txid: null,
              paid_at: null,
              verification: null,
            },
          }),
        );
        events.push(event.eventId);
      }
      const attempts = await Promise.all([a.webhooks.deliverDue(30), b.webhooks.deliverDue(30)]);
      expect(attempts[0] + attempts[1]).toBe(30);
      const received = receiver.received.map((hook) => String(hook.headers["x-shade-event-id"]));
      expect(received.sort()).toEqual([...events].sort());
    } finally {
      await receiver.close();
    }
  });

  it("acceptClaim racing applyDetection emits exactly one invoice.paid", async () => {
    const merchantId = await merchant(dbs[0]!);
    const [a, b] = [stack(dbs[1]!), stack(dbs[2]!)];
    for (let round = 0; round < 5; round += 1) {
      const invoice = await a.invoices.create(merchantId, "testnet", { amount_zec: "0.01" });
      const txid = randomTxid();
      putShieldedTx(chain.testnet, txid, { height: 1000 });
      await a.settlement.submitPayerTxid(invoice.id, txid);
      await Promise.allSettled([
        a.settlement.acceptClaim(merchantId, invoice.id),
        b.settlement.applyDetection({
          merchantId,
          network: "testnet",
          invoiceId: invoice.id,
          txid,
          pool: "ironwood",
          amountZat: 1_000_000n,
          memoHash: invoice.memo_hash,
          blockHeight: 1000,
          blockHash: "c".repeat(64),
          blockTime: new Date(),
          tipHeight: 1000,
          source: "shade_worker",
        }),
      ]);
      const events = await dbs[0]!<{ n: number }>`
        select count(*)::int as n from webhook_events
        where invoice_id = ${invoice.id} and type = 'invoice.paid'`;
      expect(events[0]?.n).toBe(1);
    }
  });

  /**
   * The payer of B pastes the txid of A's payment while the scanner reports it for A. Settlement of
   * one txid is serialised, so whichever runs second sees the first one's committed result.
   */
  const acceptRace = async (pattern: RegExp, detection: { blockHeight: number | null }) => {
    const merchantId = await merchant(dbs[0]!);
    const scanner = stack(dbs[2]!);
    const a = await scanner.invoices.create(merchantId, "testnet", { amount_zec: "0.01" });
    const b = await scanner.invoices.create(merchantId, "testnet", { amount_zec: "0.02" });
    const txid = randomTxid();
    putShieldedTx(chain.testnet, txid, { height: 1000 });
    await scanner.settlement.submitPayerTxid(b.id, txid);

    const gate = gated(dbs[1]!, pattern);
    const accept = stack(gate.db).settlement.acceptClaim(merchantId, b.id);
    await gate.paused;
    const detect = scanner.settlement.applyDetection({
      merchantId,
      network: "testnet",
      invoiceId: a.id,
      txid,
      pool: "ironwood",
      amountZat: 1_000_000n,
      memoHash: a.memo_hash,
      blockHeight: detection.blockHeight,
      blockHash: detection.blockHeight === null ? null : "c".repeat(64),
      blockTime: detection.blockHeight === null ? null : new Date(),
      tipHeight: detection.blockHeight,
      source: "shade_worker",
    });
    // The detection waits for the paused Confirm instead of racing its checks.
    const waited = await pendingAfter(detect, 300);
    gate.release();
    const [accepted, detected] = await Promise.all([accept, detect]);
    return { merchantId, a, b, accepted, detected, waited, services: scanner };
  };

  it("a seen detection racing Confirm of the same txid never strands the scanned invoice", async () => {
    // Confirm paused after its txid-in-use check; the detection would record A as `seen`.
    const race = await acceptRace(/union all/, { blockHeight: null });
    expect(race.waited).toBe(true);
    expect(race.accepted).toMatchObject({ status: "paid", verification: "merchant_accept" });
    expect(race.detected.outcome).toBe("txid_in_use");
    const pending = await dbs[0]!<{ n: number }>`
      select count(*)::int as n from invoice_detections
      where invoice_id = ${race.a.id} and state = 'seen'`;
    expect(pending[0]?.n).toBe(0);
    const cancelled = await race.services.invoices.cancelOpen(
      { merchantId: race.merchantId, network: null },
      race.a.id,
    );
    expect(cancelled.status).toBe("cancelled");
  });

  it("a settling detection racing an uncommitted Confirm answers txid_in_use, not 23505", async () => {
    // Confirm paused after writing B's txid, before commit.
    const race = await acceptRace(/merchant_accept/, { blockHeight: 1000 });
    expect(race.waited).toBe(true);
    expect(race.accepted.status).toBe("paid");
    expect(race.detected.outcome).toBe("txid_in_use");
    const rows = await dbs[0]!<{ id: string; status: string }>`
      select id, status from invoices where id = any(${[race.a.id, race.b.id]}::text[])`;
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [race.a.id]: "open",
      [race.b.id]: "paid",
    });
  });

  it("a duplicate Idempotency-Key in flight creates one invoice", async () => {
    const db = dbs[0]!;
    const services = stack(db);
    const merchantId = await merchant(db);
    const key = await services.keys.issue(merchantId, {
      kind: "merchant",
      label: "idem",
      network: "testnet",
    });
    const authBackground = createBackground(logger);
    const auth = createAuth({
      config,
      db,
      mailer: { send: async () => {} },
      logger,
      background: authBackground,
      onUserCreated: async () => {},
    });
    const app = createApp({ config, logger, db, auth, services });
    const idemKey = `race-${randomBytes(8).toString("hex")}`;
    const send = () =>
      app.request("/v1/invoices", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.token}`,
          "content-type": "application/json",
          "idempotency-key": idemKey,
        },
        body: JSON.stringify({ amount_zec: "0.05", memo: "once" }),
      });
    const responses = await Promise.all([send(), send(), send()]);
    // As at server shutdown: deferred auth work finishes before afterAll closes the pool.
    await authBackground.idle();
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    const rows = await db<{ n: number }>`
      select count(*)::int as n from invoices where merchant_id = ${merchantId} and memo = 'once'`;
    expect(rows[0]?.n).toBe(1);
  });
});
