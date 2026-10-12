import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebhookEvent } from "../../src/contract/index.ts";
import { AppError } from "../../src/platform/errors.ts";
import {
  ENDPOINT_FAILING_WINDOW_SEC,
  RETRY_SCHEDULE_SEC,
  retryDelaySec,
} from "../../src/services/webhooks.ts";
import {
  type Harness,
  createHarness,
  createMerchant,
  randomTxid,
  webhookReceiver,
} from "../support/harness.ts";

async function rejects(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

interface DeliveryState {
  status: string;
  attempt: number;
  next_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  lease_id: string | null;
}

async function deliveriesOf(h: Harness, eventId: string): Promise<DeliveryState[]> {
  return h.db<DeliveryState>`
    select status, attempt, next_attempt_at, last_status_code, last_error, lease_id
    from webhook_deliveries where event_id = ${eventId} order by created_at`;
}

/** Settles `n` new testnet invoices (hosted detection); returns their invoice.paid deliveries. */
async function settleInvoices(h: Harness, merchantId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const invoice = await h.services.invoices.create(merchantId, "testnet", {
      amount_zec: "0.01",
    });
    const result = await h.services.settlement.applyDetection({
      merchantId,
      network: "testnet",
      invoiceId: invoice.id,
      txid: randomTxid(),
      pool: "ironwood",
      amountZat: 1_000_000n,
      memoHash: invoice.memo_hash,
      blockHeight: 1000,
      blockHash: "c".repeat(64),
      blockTime: h.clock(),
      tipHeight: 1000,
      source: "shade_worker",
    });
    ids.push(...result.deliveryIds);
  }
  return ids;
}

async function statusCounts(h: Harness): Promise<Record<string, number>> {
  const rows = await h.db<{ status: string; n: number }>`
    select status, count(*)::int as n from webhook_deliveries group by status`;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

describe("webhooks service", () => {
  let h: Harness;
  const receivers: { close(): Promise<void> }[] = [];

  // A database per test: deliverDue claims every due delivery, so tests must not share one.
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
    await Promise.all(receivers.splice(0).map((r) => r.close()));
  });

  const receiver = async (respond?: Parameters<typeof webhookReceiver>[0]) => {
    const r = await webhookReceiver(respond);
    receivers.push(r);
    return r;
  };

  it("validates URLs, returns the secret once and stores it encrypted", async () => {
    const { merchantId } = await createMerchant(h);
    expect(
      (await rejects(h.services.webhooks.createEndpoint(merchantId, "testnet", "ftp://x"))).code,
    ).toBe("BAD_URL");
    expect(
      (await rejects(h.services.webhooks.createEndpoint(merchantId, "testnet", "not a url"))).code,
    ).toBe("BAD_URL");
    const r = await receiver();
    const endpoint = await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    expect(endpoint).toMatchObject({
      url: r.url,
      network: "testnet",
      disabled_at: null,
      disabled_reason: null,
      failure_count: 0,
      last_delivery_at: null,
    });
    expect(endpoint.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(endpoint.secret_hint).toBe(endpoint.secret.slice(-4));
    const [row] = await h.db<{ secret_ciphertext: string }>`
      select secret_ciphertext from webhook_endpoints where id = ${endpoint.id}`;
    expect(row?.secret_ciphertext).toMatch(/^enc:v1:/);
    expect(row?.secret_ciphertext).not.toContain(endpoint.secret.slice(6));
    const listed = await h.services.webhooks.listEndpoints(merchantId, "testnet");
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0] ?? {})).not.toContain("secret");
  });

  it("caps enabled endpoints at 5 per merchant and network", async () => {
    const { merchantId } = await createMerchant(h);
    const r = await receiver();
    for (let i = 0; i < 5; i += 1)
      await h.services.webhooks.createEndpoint(merchantId, "testnet", `${r.url}?n=${i}`);
    const err = await rejects(h.services.webhooks.createEndpoint(merchantId, "testnet", r.url));
    expect(err).toMatchObject({ status: 409, code: "ENDPOINT_LIMIT" });
  });

  it("sends a signed test event right after commit", async () => {
    const { merchantId } = await createMerchant(h);
    expect((await rejects(h.services.webhooks.sendTest(merchantId, "testnet"))).code).toBe(
      "NO_ENDPOINTS",
    );
    const r = await receiver();
    const endpoint = await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    const sent = await h.services.webhooks.sendTest(merchantId, "testnet");
    expect(sent.endpoints).toBe(1);
    await h.services.idle();

    expect(r.received).toHaveLength(1);
    const hook = r.received[0];
    const event = JSON.parse(hook?.body ?? "{}") as WebhookEvent;
    expect(event).toEqual({
      id: sent.event_id,
      type: "webhook.test",
      created_at: expect.any(String),
      network: "testnet",
      invoice_id: null,
      amount_zec: null,
      memo_hash: null,
      txid: null,
      paid_at: null,
      verification: null,
    });
    expect(hook?.headers["content-type"]).toBe("application/json");
    expect(hook?.headers["user-agent"]).toBe("Shade-Webhooks/1");
    expect(hook?.headers["x-shade-event-id"]).toBe(sent.event_id);
    const body = hook?.body ?? "";
    expect(hook?.headers["x-shade-signature"]).toBe(
      `sha256=${createHmac("sha256", endpoint.secret).update(body).digest("hex")}`,
    );
    const v2 = String(hook?.headers["x-shade-signature-v2"]);
    const t = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(v2);
    expect(t).not.toBeNull();
    expect(Math.abs(Number(t?.[1]) - Date.now() / 1000)).toBeLessThan(30);
    expect(t?.[2]).toBe(
      createHmac("sha256", endpoint.secret).update(`${t?.[1]}.${body}`).digest("hex"),
    );

    const [delivery] = await deliveriesOf(h, sent.event_id);
    expect(delivery).toMatchObject({
      status: "delivered",
      attempt: 1,
      last_status_code: 200,
      lease_id: null,
    });
    const [after] = await h.services.webhooks.listEndpoints(merchantId, "testnet");
    expect(after?.last_delivery_at).not.toBeNull();

    const page = await h.services.webhooks.deliveries(merchantId, "testnet", {
      cursor: null,
      limit: 10,
    });
    expect(page.items[0]).toMatchObject({
      event_id: sent.event_id,
      event_type: "webhook.test",
      endpoint_id: endpoint.id,
      endpoint_url: r.url,
      invoice_id: null,
      status: "delivered",
      attempt: 1,
      last_status_code: 200,
      last_error: null,
      next_attempt_at: null,
    });
  });

  it("retries failures on the schedule with jitter, then gives up after 10 attempts", async () => {
    const { merchantId } = await createMerchant(h);
    const r = await receiver(() => ({ status: 500 }));
    await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    const sent = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    let [delivery] = await deliveriesOf(h, sent.event_id);
    expect(delivery).toMatchObject({
      status: "failed",
      attempt: 1,
      last_status_code: 500,
      last_error: "http_500",
    });
    const wait = (delivery?.next_attempt_at?.getTime() ?? 0) - h.clock().getTime();
    expect(wait).toBeGreaterThan(4_000);
    expect(wait).toBeLessThanOrEqual(5_600);

    expect(await h.services.webhooks.deliverDue()).toBe(0);
    for (let attempt = 2; attempt <= 10; attempt += 1) {
      h.clock.advance(RETRY_SCHEDULE_SEC[attempt - 2]! * 1100 + 1000);
      expect(await h.services.webhooks.deliverDue()).toBe(1);
      [delivery] = await deliveriesOf(h, sent.event_id);
      expect(delivery?.attempt).toBe(attempt);
    }
    expect(delivery).toMatchObject({ status: "dead", attempt: 10, next_attempt_at: null });
    expect(r.received).toHaveLength(10);
  });

  it("lets Retry-After on 429/503 lengthen a retry up to twice the step, never shorten it", () => {
    // Shorter than the scheduled step: the schedule (with jitter) wins.
    expect(retryDelaySec(1, 2, () => 0)).toBeCloseTo(4.5);
    expect(retryDelaySec(1, 2, () => 1)).toBeCloseTo(5.5);
    expect(retryDelaySec(1, 1, () => 0.5)).toBeCloseTo(5);
    expect(retryDelaySec(2, 100, () => 0)).toBeCloseTo(270);
    expect(retryDelaySec(2, 100, () => 1)).toBeCloseTo(330);
    expect(retryDelaySec(9, 0, () => 0.5)).toBe(86_400);
    // Longer: honoured, capped at twice the step.
    expect(retryDelaySec(1, 8, () => 0)).toBe(8);
    expect(retryDelaySec(1, 100, () => 0)).toBe(10);
    expect(retryDelaySec(2, 450, () => 0)).toBe(450);
    expect(retryDelaySec(2, 10_000, () => 1)).toBe(600);
    expect(retryDelaySec(1, undefined, () => 0)).toBeCloseTo(4.5);
    expect(retryDelaySec(1, undefined, () => 1)).toBeCloseTo(5.5);
    expect(retryDelaySec(9, undefined, () => 0.5)).toBe(86_400);
  });

  it("waits longer when a 429 response's Retry-After asks for it", async () => {
    const { merchantId } = await createMerchant(h);
    const r = await receiver(() => ({ status: 429, headers: { "retry-after": "8" } }));
    await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    const sent = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    const [delivery] = await deliveriesOf(h, sent.event_id);
    expect(delivery?.last_error).toBe("http_429");
    const wait = (delivery?.next_attempt_at?.getTime() ?? 0) - h.clock().getTime();
    expect(wait).toBeGreaterThan(7_000);
    expect(wait).toBeLessThanOrEqual(8_100);
  });

  it("does not let a short Retry-After use up the retries of an invoice.paid delivery", async () => {
    const { merchantId } = await createMerchant(h);
    let down = true;
    const r = await receiver(() =>
      down ? { status: 503, headers: { "retry-after": "1" } } : { status: 204 },
    );
    await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    const deliveryIds = await settleInvoices(h, merchantId, 1);
    h.services.webhooks.kickDeliveries(deliveryIds);
    await h.services.idle();
    // The worker's outbox loop polls every 2 s while attempts are being made.
    for (let elapsed = 0; elapsed < 60; elapsed += 2) {
      h.clock.advance(2_000);
      await h.services.webhooks.deliverDue();
    }
    const [during] = await h.db<{ status: string; attempt: number }>`
      select status, attempt from webhook_deliveries where id = ${deliveryIds[0] ?? ""}`;
    expect(during?.status).toBe("failed");
    expect(during?.attempt).toBeLessThanOrEqual(3);

    down = false;
    h.clock.advance(400_000);
    expect(await h.services.webhooks.deliverDue()).toBe(1);
    const [after] = await h.db<{ status: string }>`
      select status from webhook_deliveries where id = ${deliveryIds[0] ?? ""}`;
    expect(after?.status).toBe("delivered");
  });

  it("treats 3xx as a failure and 410 as gone (endpoint disabled, pending cancelled)", async () => {
    const { merchantId } = await createMerchant(h);
    const redirect = await receiver(() => ({
      status: 302,
      headers: { location: "http://127.0.0.1:1/" },
    }));
    await h.services.webhooks.createEndpoint(merchantId, "testnet", redirect.url);
    const first = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    expect((await deliveriesOf(h, first.event_id))[0]).toMatchObject({
      status: "failed",
      last_error: "redirect",
    });

    const other = await createMerchant(h);
    const gone = await receiver(() => ({ status: 410 }));
    const endpoint = await h.services.webhooks.createEndpoint(
      other.merchantId,
      "testnet",
      gone.url,
    );
    const sent = await h.services.webhooks.sendTest(other.merchantId, "testnet");
    await h.services.idle();
    expect((await deliveriesOf(h, sent.event_id))[0]).toMatchObject({
      status: "dead",
      last_status_code: 410,
    });
    const [disabled] = await h.services.webhooks.listEndpoints(other.merchantId, "testnet");
    expect(disabled).toMatchObject({ id: endpoint.id, disabled_reason: "gone_410" });
    expect(disabled?.disabled_at).not.toBeNull();
    expect((await rejects(h.services.webhooks.sendTest(other.merchantId, "testnet"))).code).toBe(
      "NO_ENDPOINTS",
    );
  });

  it("turns an endpoint off after 20 failures spanning 3 days, keeping queued retries", async () => {
    const { merchantId } = await createMerchant(h);
    let fail = true;
    const r = await receiver(() => ({ status: fail ? 503 : 204 }));
    const endpoint = await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    await h.db`update webhook_endpoints set failure_count = 18 where id = ${endpoint.id}`;
    await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    expect((await h.services.webhooks.listEndpoints(merchantId, "testnet"))[0]?.failure_count).toBe(
      19,
    );
    fail = false;
    h.clock.advance(10_000);
    expect(await h.services.webhooks.deliverDue()).toBe(1);
    expect((await h.services.webhooks.listEndpoints(merchantId, "testnet"))[0]?.failure_count).toBe(
      0,
    );

    // 20 failures in a row, but within minutes of the last success: still on.
    fail = true;
    h.clock.advance(1_000);
    await h.db`update webhook_endpoints set failure_count = 18 where id = ${endpoint.id}`;
    const first = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    h.clock.advance(60_000);
    const second = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    let [state] = await h.services.webhooks.listEndpoints(merchantId, "testnet");
    expect(state).toMatchObject({ failure_count: 20, disabled_reason: null, disabled_at: null });

    // Still failing 3 days after the first failure since that success: turned off.
    h.clock.advance(ENDPOINT_FAILING_WINDOW_SEC * 1000);
    const third = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    [state] = await h.services.webhooks.listEndpoints(merchantId, "testnet");
    expect(state).toMatchObject({ failure_count: 21, disabled_reason: "failing" });
    expect(state?.disabled_at).not.toBeNull();
    // Turning off stops new events only; what was queued keeps retrying and is delivered once
    // the receiver is back.
    expect((await rejects(h.services.webhooks.sendTest(merchantId, "testnet"))).code).toBe(
      "NO_ENDPOINTS",
    );
    for (const sent of [first, second, third]) {
      expect((await deliveriesOf(h, sent.event_id))[0]?.status).toBe("failed");
    }
    fail = false;
    h.clock.advance(400_000);
    expect(await h.services.webhooks.deliverDue()).toBe(3);
    for (const sent of [first, second, third]) {
      expect((await deliveriesOf(h, sent.event_id))[0]?.status).toBe("delivered");
    }
  });

  it("keeps an endpoint on through a short outage with many deliveries in flight", async () => {
    const { merchantId } = await createMerchant(h);
    let down = true;
    const r = await receiver(() => ({ status: down ? 503 : 204 }));
    await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    // Ten invoices settle while the receiver restarts (a deploy of under a minute).
    const deliveryIds = await settleInvoices(h, merchantId, 10);
    expect(deliveryIds).toHaveLength(10);
    h.services.webhooks.kickDeliveries(deliveryIds);
    await h.services.idle();
    // The worker retries 5 s later; still down. That is 20 failed attempts in a row.
    h.clock.advance(6_000);
    expect(await h.services.webhooks.deliverDue(25)).toBe(10);
    await h.services.idle();
    const [during] = await h.services.webhooks.listEndpoints(merchantId, "testnet");
    expect(during).toMatchObject({ failure_count: 20, disabled_at: null, disabled_reason: null });
    expect(await statusCounts(h)).toEqual({ failed: 10 });

    down = false;
    h.clock.advance(400_000);
    expect(await h.services.webhooks.deliverDue(25)).toBe(10);
    expect(await statusCounts(h)).toEqual({ delivered: 10 });
    const [after] = await h.services.webhooks.listEndpoints(merchantId, "testnet");
    expect(after).toMatchObject({ failure_count: 0, disabled_at: null });
  });

  it("still cancels queued deliveries when the receiver answers 410 Gone", async () => {
    const { merchantId } = await createMerchant(h);
    let gone = false;
    const r = await receiver(() => ({ status: gone ? 410 : 503 }));
    await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    const first = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    h.clock.advance(60_000);
    gone = true;
    const second = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    expect((await deliveriesOf(h, second.event_id))[0]?.status).toBe("dead");
    expect((await deliveriesOf(h, first.event_id))[0]?.status).toBe("cancelled");
    expect(await h.services.webhooks.deliverDue()).toBe(0);
  });

  it("reclaims expired leases, skips live ones, and ignores results from a lost lease", async () => {
    const { merchantId } = await createMerchant(h);
    const r = await receiver();
    await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    const event = await h.db.tx((sql) =>
      h.services.webhooks.enqueueEvent(sql, {
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
    const id = event.deliveryIds[0] ?? "";
    await h.db`
      update webhook_deliveries set status = 'in_flight', lease_id = 'lease_other', attempt = 1,
        locked_until = ${new Date(h.clock().getTime() + 30_000)} where id = ${id}`;
    expect(await h.services.webhooks.deliverDue()).toBe(0);
    h.clock.advance(31_000);
    expect(await h.services.webhooks.deliverDue()).toBe(1);
    const [delivery] = await deliveriesOf(h, event.eventId);
    expect(delivery).toMatchObject({ status: "delivered", attempt: 2 });
    expect(r.received).toHaveLength(1);
  });

  it("fans invoice.paid out to the enabled endpoints of the invoice's network only", async () => {
    const mainnet = await createHarness({ SHADE_NETWORKS: "testnet,mainnet" });
    try {
      const merchant = await createMerchant(mainnet, { networks: ["testnet", "mainnet"] });
      const r = await webhookReceiver();
      receivers.push(r);
      const testnetEndpoint = await mainnet.services.webhooks.createEndpoint(
        merchant.merchantId,
        "testnet",
        r.url,
      );
      await mainnet.services.webhooks.createEndpoint(merchant.merchantId, "mainnet", r.url);
      const disabled = await mainnet.services.webhooks.createEndpoint(
        merchant.merchantId,
        "testnet",
        `${r.url}?x`,
      );
      await mainnet.services.webhooks.deleteEndpoint(merchant.merchantId, disabled.id);
      const invoice = await mainnet.services.invoices.create(merchant.merchantId, "testnet", {
        amount_zec: "0.3",
      });
      const result = await mainnet.services.settlement.applyDetection({
        merchantId: merchant.merchantId,
        network: "testnet",
        invoiceId: invoice.id,
        txid: randomTxid(),
        pool: "ironwood",
        amountZat: 30_000_000n,
        memoHash: invoice.memo_hash,
        blockHeight: 1001,
        blockHash: "c".repeat(64),
        blockTime: new Date(),
        tipHeight: 1001,
        source: "shade_worker",
      });
      expect(result.deliveryIds).toHaveLength(1);
      mainnet.services.webhooks.kickDeliveries(result.deliveryIds);
      await mainnet.services.idle();
      expect(r.received).toHaveLength(1);
      const [row] = await mainnet.db<{ endpoint_id: string }>`
        select endpoint_id from webhook_deliveries where id = ${result.deliveryIds[0] ?? ""}`;
      expect(row?.endpoint_id).toBe(testnetEndpoint.id);
    } finally {
      await mainnet.close();
    }
  });

  it("deletes an endpoint: pending deliveries are cancelled and the secret is wiped", async () => {
    const { merchantId } = await createMerchant(h);
    const r = await receiver(() => ({ status: 500 }));
    const endpoint = await h.services.webhooks.createEndpoint(merchantId, "testnet", r.url);
    const sent = await h.services.webhooks.sendTest(merchantId, "testnet");
    await h.services.idle();
    await h.services.webhooks.deleteEndpoint(merchantId, endpoint.id);
    expect(await h.services.webhooks.listEndpoints(merchantId, "testnet")).toEqual([]);
    expect((await deliveriesOf(h, sent.event_id))[0]?.status).toBe("cancelled");
    const [row] = await h.db<{ secret_ciphertext: string | null }>`
      select secret_ciphertext from webhook_endpoints where id = ${endpoint.id}`;
    expect(row?.secret_ciphertext).toBeNull();
    const page = await h.services.webhooks.deliveries(merchantId, "testnet", {
      cursor: null,
      limit: 10,
    });
    expect(page.items[0]).toMatchObject({
      status: "cancelled",
      last_error: "http_500",
      next_attempt_at: null,
    });
    expect(
      (await rejects(h.services.webhooks.deleteEndpoint(merchantId, endpoint.id))).status,
    ).toBe(404);
    h.clock.advance(60_000);
    expect(await h.services.webhooks.deliverDue()).toBe(0);
  });
});
