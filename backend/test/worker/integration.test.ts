/**
 * The worker driving the real services (settlement, webhooks) on PGlite with the fake chain and
 * scanner: a hosted-detection payment goes seen → paid with exactly one invoice.paid event, a
 * payment mined before expiry still settles when detection recovers long after the sweeper ran, a
 * payment the merchant already confirmed elsewhere is reported as txid_in_use, and uploading the
 * same key again after a key_unavailable outage (in place, or after deleting it) keeps looking for
 * the payments made during the outage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMailer } from "../../src/platform/mailer.ts";
import { type Services, createServices } from "../../src/services/index.ts";
import { runDetectorTick } from "../../src/worker/detector.ts";
import { runPromotionTick } from "../../src/worker/promotion.ts";
import { runSweeperTick } from "../../src/worker/sweeper.ts";
import type { WorkerDeps } from "../../src/worker/types.ts";
import { ScannerError } from "../../src/zcash/scanner.ts";
import {
  type Harness,
  MERCHANT,
  NOW,
  TIP,
  UFVK,
  createHarness,
  failingScan,
  insertInvoice,
  insertViewingKey,
  payment,
  txid,
  viewingKeyState,
} from "./support.ts";

let h: Harness;
let services: Services;
let deps: WorkerDeps;

beforeEach(async () => {
  h = await createHarness({ minConfirmations: 2 });
  services = createServices({
    db: h.db,
    config: h.config,
    logger: h.deps.logger,
    chain: h.chain,
    scanner: h.scanner,
    mailer: createMailer(h.config, h.deps.logger),
    clock: h.deps.clock,
  });
  deps = { ...h.deps, services };
});

afterEach(async () => {
  await services.idle();
  await h.close();
});

async function invoiceRow(id: string) {
  const [row] = await h.db.query<{
    status: string;
    verification: string | null;
    txid: string | null;
  }>("select status, verification, txid from invoices where id = $1", [id]);
  return row;
}

describe("worker with the real settlement service", () => {
  it("records a fresh payment as seen, then promotion settles it once confirmed", async () => {
    const memo = await insertInvoice(h.db, {
      id: "inv_1",
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP, memoHash: memo }),
    );

    expect(await runDetectorTick(deps)).toMatchObject({ scanned: 1, seen: 1, settled: 0 });
    expect(await invoiceRow("inv_1")).toEqual({ status: "open", verification: null, txid: null });
    const [detection] = await h.db.query<{ state: string; confirmations: number; source: string }>(
      "select state, confirmations, source from invoice_detections where invoice_id = 'inv_1'",
    );
    expect(detection).toEqual({ state: "seen", confirmations: 1, source: "shade_worker" });

    // A payment being confirmed keeps the invoice open past expiry.
    h.now.value = new Date(NOW.getTime() + 60 * 60_000);
    expect((await runSweeperTick(deps)).expired).toBe(0);

    h.chain.testnet.setTip(TIP + 1);
    expect(await runPromotionTick(deps)).toMatchObject({ checked: 1, promoted: 1 });
    expect(await invoiceRow("inv_1")).toEqual({
      status: "paid",
      verification: "ivk_scan",
      txid: txid(1),
    });
    const events = await h.db.query<{ type: string }>(
      "select type from webhook_events where invoice_id = 'inv_1'",
    );
    expect(events).toEqual([{ type: "invoice.paid" }]);

    // Nothing left to do: the paid invoice is no longer a candidate or a seen detection.
    expect(await runDetectorTick(deps)).toMatchObject({ scanned: 0, errors: 0 });
    expect(await runPromotionTick(deps)).toMatchObject({ checked: 0 });
  });

  it("settles a payment mined before expiry when detection recovers more than 70 minutes after it", async () => {
    const MIN = 60_000;
    // Expires at NOW + 50 min; paid at once, in block TIP − 5 (about 7 minutes before NOW).
    const memo = await insertInvoice(h.db, {
      id: "inv_1",
      createdAt: new Date(NOW.getTime() - 10 * MIN),
    });
    // The key was scanning fine: its cursor sits a little below the payment.
    await insertViewingKey(h, {
      id: "vk_1",
      cursorHeight: TIP - 20,
      cursorHash: (await h.chain.testnet.getBlock(TIP - 20))!.hash,
    });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(1), height: TIP - 5, memoHash: memo }),
    );

    // Hosted detection breaks (e.g. the scanner after a network upgrade); the cursor stays put.
    h.scanner.next.push(failingScan(new ScannerError("scanner_unsupported_upgrade")));
    expect(await runDetectorTick(deps)).toMatchObject({
      errors: 1,
      lastError: "scanner_unsupported_upgrade",
    });

    // The sweeper keeps running and expires the invoice on time.
    h.now.value = new Date(NOW.getTime() + 51 * MIN);
    expect((await runSweeperTick(deps)).expired).toBe(1);

    // Detection recovers 75 minutes after expiry; the chain has moved on by 100 blocks.
    h.now.value = new Date(NOW.getTime() + 125 * MIN);
    h.chain.testnet.setTip(TIP + 100);
    expect(await runDetectorTick(deps)).toMatchObject({ scanned: 1, settled: 1, errors: 0 });

    expect(await invoiceRow("inv_1")).toEqual({
      status: "paid",
      verification: "ivk_scan",
      txid: txid(1),
    });
    const events = await h.db.query<{ type: string }>(
      "select type from webhook_events where invoice_id = 'inv_1'",
    );
    expect(events).toEqual([{ type: "invoice.paid" }]);
    expect(await viewingKeyState(h.db, "vk_1")).toMatchObject({
      cursor_height: TIP + 100,
      cursor_time: new Date((await h.chain.testnet.getBlock(TIP + 100))!.time * 1000),
    });
  });

  it("leaves an invoice open and shows txid_in_use when its payment was confirmed on another invoice", async () => {
    // The merchant confirmed txid(3) on inv_a (Confirm checks no memo); the scanner then finds that
    // transaction carrying inv_b's memo.
    await insertInvoice(h.db, { id: "inv_a", status: "paid" });
    await h.db.query(
      `update invoices set txid = $1, verification = 'merchant_accept', paid_at = $2
       where id = 'inv_a'`,
      [txid(3), NOW],
    );
    const memo = await insertInvoice(h.db, { id: "inv_b" });
    await insertViewingKey(h, { id: "vk_1" });
    h.fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(h.chain.testnet, { txid: txid(3), height: TIP - 1, memoHash: memo }),
    );

    expect(await runDetectorTick(deps)).toMatchObject({
      scanned: 1,
      settled: 0,
      txidInUse: 1,
      errors: 0,
      lastError: "txid_in_use",
    });
    expect(await invoiceRow("inv_b")).toEqual({ status: "open", verification: null, txid: null });
    expect(await h.db.query("select 1 from webhook_events where invoice_id = 'inv_b'")).toEqual([]);
    // The merchant sees the code (not scan_failed) on the detection page.
    const [status] = await services.viewingKeys.list(MERCHANT);
    expect(status?.scan).toMatchObject({ state: "error", last_error: "txid_in_use" });
  });

  // A fresh key row starts its candidate window at its upload, so both paths depend on
  // viewingKeys.upload() carrying the same key's scan progress (cursor height, hash and chain time)
  // into the new row: from the active row it replaces, or from the row a delete revoked.
  it.each([
    ["replaced in place", false],
    ["deleted, then uploaded again", true],
  ])(
    "settles a payment made during a key_unavailable outage once the same key is %s",
    async (_how, deleteFirst) => {
      const MIN = 60_000;
      // Expires at NOW + 50 min. The key is uploaded and scans fine: its cursor reaches the tip.
      const memo = await insertInvoice(h.db, {
        id: "inv_1",
        createdAt: new Date(NOW.getTime() - 10 * MIN),
      });
      await services.viewingKeys.upload(MERCHANT, "testnet", { ufvk: UFVK });
      expect(await runDetectorTick(deps)).toMatchObject({ scanned: 1, settled: 0, errors: 0 });

      // The worker can no longer open the key (its private seal key is missing). The payer pays two
      // blocks later, before expiry; every pass fails and the cursor stays where it was.
      const keyless: WorkerDeps = { ...deps, config: { ...deps.config, sealPrivateKeys: [] } };
      h.now.value = new Date(NOW.getTime() + 5 * MIN);
      h.chain.testnet.setTip(TIP + 4);
      h.fakeScanner.addPayment(
        "testnet",
        UFVK,
        await payment(h.chain.testnet, { txid: txid(1), height: TIP + 2, memoHash: memo }),
      );
      expect(await runDetectorTick(keyless)).toMatchObject({
        errors: 1,
        lastError: "key_unavailable",
      });

      // Nothing was detected, so the sweeper expires the invoice on time.
      h.now.value = new Date(NOW.getTime() + 51 * MIN);
      expect((await runSweeperTick(deps)).expired).toBe(1);

      // A day later the merchant follows the desk's advice and uploads the same key again; the
      // worker can open it once more. The chain has moved on by a day.
      h.now.value = new Date(NOW.getTime() + 24 * 60 * MIN);
      h.chain.testnet.setTip(TIP + 1_152);
      if (deleteFirst) {
        await services.viewingKeys.remove(MERCHANT, "testnet");
        h.now.value = new Date(h.now.value.getTime() + MIN);
      }
      await services.viewingKeys.upload(MERCHANT, "testnet", { ufvk: UFVK });

      expect(await runDetectorTick(deps)).toMatchObject({ scanned: 1, settled: 1, errors: 0 });
      expect(await invoiceRow("inv_1")).toEqual({
        status: "paid",
        verification: "ivk_scan",
        txid: txid(1),
      });
      const events = await h.db.query<{ type: string }>(
        "select type from webhook_events where invoice_id = 'inv_1'",
      );
      expect(events).toEqual([{ type: "invoice.paid" }]);
    },
  );

  // A key that never completed a scan has no cursor to carry: its window starts at its first
  // upload (scan_from), which the re-upload keeps.
  it.each([
    ["replaced in place", false],
    ["deleted, then uploaded again", true],
  ])(
    "settles a payment made before a key's first scan ever worked once the same key is %s",
    async (_how, deleteFirst) => {
      const MIN = 60_000;
      const memo = await insertInvoice(h.db, {
        id: "inv_1",
        createdAt: new Date(NOW.getTime() - 10 * MIN),
      });
      await services.viewingKeys.upload(MERCHANT, "testnet", { ufvk: UFVK });
      h.fakeScanner.addPayment(
        "testnet",
        UFVK,
        await payment(h.chain.testnet, { txid: txid(1), height: TIP - 1, memoHash: memo }),
      );
      // From the first pass on, the worker cannot open the key.
      const keyless: WorkerDeps = { ...deps, config: { ...deps.config, sealPrivateKeys: [] } };
      expect(await runDetectorTick(keyless)).toMatchObject({
        errors: 1,
        lastError: "key_unavailable",
      });
      h.now.value = new Date(NOW.getTime() + 51 * MIN);
      expect((await runSweeperTick(deps)).expired).toBe(1);

      // A day later the same key again: the invoice expired long before this upload.
      h.now.value = new Date(NOW.getTime() + 24 * 60 * MIN);
      h.chain.testnet.setTip(TIP + 1_152);
      if (deleteFirst) {
        await services.viewingKeys.remove(MERCHANT, "testnet");
        h.now.value = new Date(h.now.value.getTime() + MIN);
      }
      await services.viewingKeys.upload(MERCHANT, "testnet", { ufvk: UFVK });

      expect(await runDetectorTick(deps)).toMatchObject({ scanned: 1, settled: 1, errors: 0 });
      expect(await invoiceRow("inv_1")).toEqual({
        status: "paid",
        verification: "ivk_scan",
        txid: txid(1),
      });
    },
  );
});
