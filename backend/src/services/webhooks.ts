/**
 * Webhooks: per-endpoint signing secrets (AES-256-GCM at rest), a transactional outbox
 * (webhook_events + leased webhook_deliveries) and the delivery attempt loop shared by the
 * post-commit kick and the worker. Egress goes only through platform/ssrf.ts.
 */
import type {
  DeliveryStatus,
  Network,
  Page,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
  WebhookEvent,
  WebhookEventType,
} from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { decryptSecret, encryptSecret, newId, randomToken } from "../platform/crypto.ts";
import type { Db, Sql } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import type { Logger } from "../platform/logger.ts";
import { assertWebhookUrl, safePost } from "../platform/ssrf.ts";
import { signWebhook } from "../platform/webhook-signing.ts";
import type { Background } from "./background.ts";
import { type PageRequest, addSeconds, iso, isoOrNull, notFound, toPage } from "./common.ts";
import { requireMerchant } from "./merchants.ts";

export const MAX_ENDPOINTS_PER_NETWORK = 5;
/** Attempt n (1-based) that fails waits SCHEDULE_SEC[n − 1] (±10 %); attempt 10 failing is final. */
export const RETRY_SCHEDULE_SEC = [5, 300, 1800, 7200, 18_000, 36_000, 50_400, 72_000, 86_400];
export const MAX_ATTEMPTS = 10;
/**
 * An endpoint is turned off (reason "failing") after ENDPOINT_FAILURE_LIMIT consecutive failed
 * attempts that span at least ENDPOINT_FAILING_WINDOW_SEC, the ~3-day retry horizon of one
 * delivery. Counting attempts alone would let a one-minute outage with ten deliveries in flight
 * turn it off. Turning off only stops fan-out of new events: deliveries already queued keep their
 * own schedule, so no invoice.paid is cancelled by it.
 */
export const ENDPOINT_FAILURE_LIMIT = 20;
export const ENDPOINT_FAILING_WINDOW_SEC = 3 * 86_400;
const LEASE_SEC = 60;
const DEFAULT_BATCH = 20;
const USER_AGENT = "Shade-Webhooks/1";

export interface EnqueueInput {
  merchantId: string;
  network: Network;
  type: WebhookEventType;
  invoiceId: string | null;
  fields: Omit<WebhookEvent, "id" | "type" | "created_at" | "network">;
}

export interface WebhookService {
  /** Inside the business transaction: the event row plus one pending delivery per enabled endpoint. */
  enqueueEvent(sql: Sql, e: EnqueueInput): Promise<{ eventId: string; deliveryIds: string[] }>;
  /** After commit: attempts those deliveries now (same lease claim as the worker). Never throws. */
  kickDeliveries(deliveryIds: string[]): void;
  /** Worker: claims due deliveries and attempts them; returns the number of attempts made. */
  deliverDue(limit?: number): Promise<number>;
  createEndpoint(
    merchantId: string,
    network: Network,
    url: string,
  ): Promise<WebhookEndpointCreated>;
  listEndpoints(merchantId: string, network: Network): Promise<WebhookEndpoint[]>;
  /** Soft-deletes an endpoint and cancels its queued deliveries; `network` scopes a /v1 key. */
  deleteEndpoint(merchantId: string, endpointId: string, network?: Network | null): Promise<void>;
  sendTest(merchantId: string, network: Network): Promise<{ event_id: string; endpoints: number }>;
  deliveries(
    merchantId: string,
    network: Network,
    page: PageRequest,
  ): Promise<Page<WebhookDelivery>>;
}

interface EndpointRow {
  id: string;
  url: string;
  network: Network;
  secret_hint: string;
  created_at: Date;
  disabled_at: Date | null;
  disabled_reason: string | null;
  failure_count: number;
  last_delivery_at: Date | null;
}

const ENDPOINT_COLUMNS =
  "id, url, network, secret_hint, created_at, disabled_at, disabled_reason, failure_count, last_delivery_at";

interface AttemptRow {
  id: string;
  attempt: number;
  lease_id: string;
  event_id: string;
  payload: string;
  endpoint_id: string;
  url: string;
  secret_ciphertext: string | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: WebhookDelivery["event_type"];
  endpoint_id: string;
  endpoint_url: string;
  invoice_id: string | null;
  status: DeliveryStatus;
  attempt: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
}

/** safePost's outcome, plus the one failure Shade itself can cause (an undecryptable secret). */
type AttemptResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; retryAfterSec?: number };

function endpointDto(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    network: row.network,
    secret_hint: row.secret_hint,
    created_at: iso(row.created_at),
    disabled_at: isoOrNull(row.disabled_at),
    disabled_reason: row.disabled_reason,
    failure_count: row.failure_count,
    last_delivery_at: isoOrNull(row.last_delivery_at),
  };
}

function deliveryDto(row: DeliveryRow): WebhookDelivery {
  const status = row.status;
  return {
    id: row.id,
    event_id: row.event_id,
    event_type: row.event_type,
    endpoint_id: row.endpoint_id,
    endpoint_url: row.endpoint_url,
    invoice_id: row.invoice_id,
    status,
    attempt: row.attempt,
    last_status_code: row.last_status_code,
    last_error: row.last_error,
    next_attempt_at:
      status === "pending" || status === "failed" ? isoOrNull(row.next_attempt_at) : null,
    delivered_at: isoOrNull(row.delivered_at),
    created_at: iso(row.created_at),
  };
}

/**
 * Seconds until the next attempt after failed attempt `attempt`: the scheduled step with jitter.
 * Retry-After (429/503) can only lengthen it, up to twice the step. It never brings a retry
 * forward, or a receiver answering "Retry-After: 1" would burn all ten attempts in seconds.
 */
export function retryDelaySec(
  attempt: number,
  retryAfterSec: number | undefined,
  random: () => number = Math.random,
): number {
  const step = RETRY_SCHEDULE_SEC[Math.min(attempt, RETRY_SCHEDULE_SEC.length) - 1] ?? 5;
  const scheduled = step * (0.9 + 0.2 * random());
  if (retryAfterSec === undefined) return scheduled;
  return Math.max(scheduled, Math.min(Math.max(1, retryAfterSec), 2 * step));
}

export function createWebhookService(deps: {
  db: Db;
  config: Config;
  logger: Logger;
  clock: () => Date;
  background: Background;
}): WebhookService {
  const { db, config, logger, clock, background } = deps;
  const log = logger.child({ component: "webhooks" });

  const cancelEndpointDeliveries = (sql: Sql, endpointId: string, now: Date) => sql`
    update webhook_deliveries
    set status = 'cancelled', locked_until = null, lease_id = null, next_attempt_at = null,
        updated_at = ${now}
    where endpoint_id = ${endpointId} and status in ('pending', 'failed', 'in_flight')`;

  /** Stops fan-out of new events to the endpoint (enqueueEvent skips disabled ones). */
  const disableEndpoint = (sql: Sql, endpointId: string, reason: string, now: Date) => sql`
    update webhook_endpoints
    set disabled_at = coalesce(disabled_at, ${now}), disabled_reason = coalesce(disabled_reason, ${reason})
    where id = ${endpointId}`;

  /**
   * True once the endpoint has gone ENDPOINT_FAILING_WINDOW_SEC without a success. The failure
   * streak began no later than the first attempt of the oldest delivery created after the last
   * success that has failed every attempt so far, and a delivery is first attempted as it is
   * created (post-commit kick, else the worker's next poll). One walk of
   * webhook_deliveries_endpoint_idx, and only once failure_count has reached the limit.
   */
  const failingLongEnough = async (
    sql: Sql,
    endpoint: { id: string; lastDeliveryAt: Date | null },
    now: Date,
  ) => {
    const [oldest] = await sql<{ created_at: Date }>`
      select created_at from webhook_deliveries
      where endpoint_id = ${endpoint.id} and created_at > ${endpoint.lastDeliveryAt ?? new Date(0)}
        and attempt >= 1 and status in ('failed', 'dead')
      order by created_at
      limit 1`;
    return (
      oldest !== undefined &&
      now.getTime() - oldest.created_at.getTime() >= ENDPOINT_FAILING_WINDOW_SEC * 1000
    );
  };

  /** Lease claim (agents.md §4.9); `ids` restricts it to just-enqueued deliveries (the post-commit kick). */
  const claim = async (limit: number, ids: string[] | null): Promise<AttemptRow[]> => {
    const now = clock();
    const lease = newId("lease");
    const params: unknown[] = [addSeconds(now, LEASE_SEC), lease, now, limit];
    if (ids) params.push(ids);
    const claimed = await db.query<{ id: string }>(
      `update webhook_deliveries
       set status = 'in_flight', locked_until = $1, lease_id = $2, attempt = attempt + 1,
           updated_at = $3
       where id in (
         select id from webhook_deliveries
         where ((status in ('pending', 'failed') and next_attempt_at <= $3)
                or (status = 'in_flight' and locked_until < $3))
           ${ids ? "and id = any($5::text[])" : ""}
         order by next_attempt_at
         limit $4
         for update skip locked)
       returning id`,
      params,
    );
    if (claimed.length === 0) return [];
    return db<AttemptRow>`
      select d.id, d.attempt, d.lease_id, e.id as event_id, e.payload,
             p.id as endpoint_id, p.url, p.secret_ciphertext, p.disabled_at, p.disabled_reason
      from webhook_deliveries d
      join webhook_events e on e.id = d.event_id
      join webhook_endpoints p on p.id = d.endpoint_id
      where d.id = any(${claimed.map((row) => row.id)}::text[]) and d.lease_id = ${lease}`;
  };

  /** Writes one attempt's outcome; every write is guarded by the lease that claimed the row. */
  const record = (row: AttemptRow, result: AttemptResult) =>
    db.tx(async (sql) => {
      const now = clock();
      if (result.ok) {
        const updated = await sql`
          update webhook_deliveries
          set status = 'delivered', delivered_at = ${now}, last_status_code = ${result.status},
              last_error = null, locked_until = null, lease_id = null, next_attempt_at = null,
              updated_at = ${now}
          where id = ${row.id} and lease_id = ${row.lease_id}
          returning id`;
        if (updated.length > 0) {
          await sql`
            update webhook_endpoints set failure_count = 0, last_delivery_at = ${now}
            where id = ${row.endpoint_id}`;
        }
        return;
      }

      const gone = result.status === 410;
      const dead = gone || row.attempt >= MAX_ATTEMPTS;
      const retryAfter =
        result.status === 429 || result.status === 503 ? result.retryAfterSec : undefined;
      const nextAttempt = dead ? null : addSeconds(now, retryDelaySec(row.attempt, retryAfter));
      const updated = await sql`
        update webhook_deliveries
        set status = ${dead ? "dead" : "failed"}, last_status_code = ${result.status},
            last_error = ${result.error}, next_attempt_at = ${nextAttempt}, locked_until = null,
            lease_id = null, updated_at = ${now}
        where id = ${row.id} and lease_id = ${row.lease_id}
        returning id`;
      if (updated.length === 0) return;
      if (gone) {
        // The receiver says the URL is gone for good: nothing queued for it can be delivered.
        await disableEndpoint(sql, row.endpoint_id, "gone_410", now);
        await cancelEndpointDeliveries(sql, row.endpoint_id, now);
        return;
      }
      const [endpoint] = await sql<{
        failure_count: number;
        disabled_at: Date | null;
        last_delivery_at: Date | null;
      }>`
        update webhook_endpoints set failure_count = failure_count + 1
        where id = ${row.endpoint_id}
        returning failure_count, disabled_at, last_delivery_at`;
      if (
        endpoint &&
        endpoint.disabled_at === null &&
        endpoint.failure_count >= ENDPOINT_FAILURE_LIMIT &&
        (await failingLongEnough(
          sql,
          { id: row.endpoint_id, lastDeliveryAt: endpoint.last_delivery_at },
          now,
        ))
      ) {
        await disableEndpoint(sql, row.endpoint_id, "failing", now);
      }
    });

  const attempt = async (row: AttemptRow): Promise<void> => {
    // Deleted, legacy-secret and 410 endpoints take nothing more; one turned off for failing
    // still retries what was queued before (it only gets no new events).
    if (
      row.secret_ciphertext === null ||
      (row.disabled_at !== null && row.disabled_reason !== "failing")
    ) {
      await db`
        update webhook_deliveries
        set status = 'cancelled', locked_until = null, lease_id = null, next_attempt_at = null,
            updated_at = ${clock()}
        where id = ${row.id} and lease_id = ${row.lease_id}`;
      return;
    }
    let secret: string;
    try {
      secret = decryptSecret(
        config.encryptionKey,
        row.secret_ciphertext,
        `whsec|${row.endpoint_id}`,
      );
    } catch (err) {
      log.error({ err, endpoint_id: row.endpoint_id }, "webhook secret could not be decrypted");
      await record(row, { ok: false, status: null, error: "secret_unavailable" });
      return;
    }
    const headers = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "x-shade-event-id": row.event_id,
      ...signWebhook(secret, row.payload, Math.floor(clock().getTime() / 1000)),
    };
    const result = await safePost(row.url, row.payload, headers, {
      allowPrivate: config.webhookAllowPrivate,
    });
    await record(row, result);
  };

  const deliver = async (limit: number, ids: string[] | null): Promise<number> => {
    const rows = await claim(limit, ids);
    await Promise.all(rows.map((row) => attempt(row)));
    return rows.length;
  };

  const enqueueEvent: WebhookService["enqueueEvent"] = async (sql, e) => {
    const now = clock();
    const event: WebhookEvent = {
      id: newId("evt"),
      type: e.type,
      created_at: iso(now),
      network: e.network,
      invoice_id: e.fields.invoice_id,
      amount_zec: e.fields.amount_zec,
      memo_hash: e.fields.memo_hash,
      txid: e.fields.txid,
      paid_at: e.fields.paid_at,
      verification: e.fields.verification,
    };
    // The unique index on invoice.paid events makes "exactly one event per paid invoice" hold.
    const inserted = await sql<{ id: string }>`
      insert into webhook_events (id, merchant_id, network, type, invoice_id, payload, created_at)
      values (${event.id}, ${e.merchantId}, ${e.network}, ${e.type}, ${e.invoiceId},
              ${JSON.stringify(event)}, ${now})
      on conflict do nothing
      returning id`;
    if (inserted.length === 0) {
      const [existing] = await sql<{ id: string }>`
        select id from webhook_events where invoice_id = ${e.invoiceId} and type = ${e.type}`;
      return { eventId: existing?.id ?? event.id, deliveryIds: [] };
    }
    const endpoints = await sql<{ id: string }>`
      select id from webhook_endpoints
      where merchant_id = ${e.merchantId} and network = ${e.network} and disabled_at is null
      order by created_at`;
    const deliveryIds: string[] = [];
    for (const endpoint of endpoints) {
      const id = newId("whd");
      await sql`
        insert into webhook_deliveries
          (id, merchant_id, endpoint_id, invoice_id, event_type, event_id, status, attempt,
           next_attempt_at, created_at, updated_at)
        values (${id}, ${e.merchantId}, ${endpoint.id}, ${e.invoiceId}, ${e.type}, ${event.id},
                'pending', 0, ${now}, ${now}, ${now})`;
      deliveryIds.push(id);
    }
    return { eventId: event.id, deliveryIds };
  };

  const kickDeliveries: WebhookService["kickDeliveries"] = (deliveryIds) => {
    if (deliveryIds.length === 0) return;
    background.run("webhooks.kick", () => deliver(deliveryIds.length, deliveryIds));
  };

  return {
    enqueueEvent,
    kickDeliveries,

    deliverDue(limit = DEFAULT_BATCH) {
      return deliver(limit, null);
    },

    async createEndpoint(merchantId, network, rawUrl) {
      const url = await assertWebhookUrl(rawUrl, { allowPrivate: config.webhookAllowPrivate });
      const secret = `whsec_${randomToken(32)}`;
      const row = await db.tx(async (sql) => {
        // The merchant row lock serialises concurrent creates against the per-network cap.
        await requireMerchant(sql, merchantId, { forUpdate: true });
        const [count] = await sql<{ n: number }>`
          select count(*)::int as n from webhook_endpoints
          where merchant_id = ${merchantId} and network = ${network} and disabled_at is null`;
        if ((count?.n ?? 0) >= MAX_ENDPOINTS_PER_NETWORK) {
          throw new AppError(
            409,
            "ENDPOINT_LIMIT",
            `You can have up to ${MAX_ENDPOINTS_PER_NETWORK} webhook endpoints per network. Delete one first.`,
          );
        }
        const id = newId("whe");
        const [created] = await sql.query<EndpointRow>(
          `insert into webhook_endpoints
             (id, merchant_id, url, network, secret_ciphertext, secret_hint, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning ${ENDPOINT_COLUMNS}`,
          [
            id,
            merchantId,
            url.toString(),
            network,
            encryptSecret(config.encryptionKey, secret, `whsec|${id}`),
            secret.slice(-4),
            clock(),
          ],
        );
        if (!created) throw new Error("webhook endpoint insert returned no row");
        return created;
      });
      return { ...endpointDto(row), secret };
    },

    async listEndpoints(merchantId, network) {
      const rows = await db.query<EndpointRow>(
        `select ${ENDPOINT_COLUMNS} from webhook_endpoints
         where merchant_id = $1 and network = $2 and disabled_reason is distinct from 'deleted'
         order by created_at desc, id desc`,
        [merchantId, network],
      );
      return rows.map(endpointDto);
    },

    async deleteEndpoint(merchantId, endpointId, network = null) {
      await db.tx(async (sql) => {
        const now = clock();
        const deleted = await sql`
          update webhook_endpoints
          set disabled_at = coalesce(disabled_at, ${now}), disabled_reason = 'deleted',
              secret_ciphertext = null
          where id = ${endpointId} and merchant_id = ${merchantId}
            and (${network}::text is null or network = ${network})
            and disabled_reason is distinct from 'deleted'
          returning id`;
        if (deleted.length === 0) throw notFound("webhook endpoint");
        await cancelEndpointDeliveries(sql, endpointId, now);
      });
    },

    async sendTest(merchantId, network) {
      const outcome = await db.tx(async (sql) => {
        const [count] = await sql<{ n: number }>`
          select count(*)::int as n from webhook_endpoints
          where merchant_id = ${merchantId} and network = ${network} and disabled_at is null`;
        if ((count?.n ?? 0) === 0) {
          throw new AppError(409, "NO_ENDPOINTS", `Add a ${network} webhook endpoint first.`);
        }
        return enqueueEvent(sql, {
          merchantId,
          network,
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
        });
      });
      kickDeliveries(outcome.deliveryIds);
      return { event_id: outcome.eventId, endpoints: outcome.deliveryIds.length };
    },

    async deliveries(merchantId, network, page) {
      const params: unknown[] = [merchantId, network, page.limit + 1];
      let cursor = "";
      if (page.cursor) {
        params.push(page.cursor.createdAt, page.cursor.id);
        cursor = "and (d.created_at, d.id) < ($4::timestamptz, $5)";
      }
      const rows = await db.query<DeliveryRow>(
        `select d.id, d.event_id, d.event_type, d.endpoint_id, p.url as endpoint_url, d.invoice_id,
                d.status, d.attempt, d.last_status_code, d.last_error, d.next_attempt_at,
                d.delivered_at, d.created_at
         from webhook_deliveries d
         join webhook_events e on e.id = d.event_id
         join webhook_endpoints p on p.id = d.endpoint_id
         where d.merchant_id = $1 and e.network = $2 ${cursor}
         order by d.created_at desc, d.id desc
         limit $3`,
        params,
      );
      return toPage(rows, page.limit, deliveryDto);
    },
  };
}
