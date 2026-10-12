import { Transport } from "./http.ts";
import type { FetchLike, IdempotentRequestOptions, RequestOptions } from "./http.ts";
import {
  mapGrant,
  mapGrantCreated,
  mapInvoice,
  mapJar,
  mapJarChargeResult,
  mapPage,
  mapPayableInvoice,
  mapTag,
  mapTagResolution,
  mapWebhookEndpoint,
  mapWebhookEndpointCreated,
} from "./mappers.ts";
import type {
  ChargeJarParams,
  CreateGrantParams,
  CreateInvoiceParams,
  CreateJarParams,
  CreateTagParams,
  CreateWebhookParams,
  Grant,
  GrantCreated,
  Invoice,
  Jar,
  JarChargeResult,
  ListInvoicesParams,
  Page,
  PayableInvoice,
  ReportDetectionParams,
  Tag,
  TagResolution,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from "./types.ts";
import { VERSION } from "./version.ts";
import type {
  WireGrant,
  WireGrantCreated,
  WireInvoice,
  WireJar,
  WireJarChargeResult,
  WirePage,
  WireTag,
  WireTagResolution,
  WireWebhookEndpoint,
  WireWebhookEndpointCreated,
} from "./wire.ts";

export const DEFAULT_BASE_URL = "https://shade-zcash.vercel.app";

export interface ShadeOptions {
  /** sk_test_… / sk_live_… merchant key, or an ag_… agent key (jar charges only). */
  apiKey: string;
  /**
   * Your Shade API origin, without /v1 (Shade is self-hosted: e.g. https://shade.example.com, or
   * http://localhost:5173 in development). Default https://shade-zcash.vercel.app.
   */
  baseUrl?: string;
  /** Per-attempt deadline covering the request and the response body. Default 10000. */
  timeoutMs?: number;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Extra attempts for reads and idempotent creates/charges on network errors, timeouts and 5xx. Default 1. */
  maxRetries?: number;
}

/** Shade API client. Wire JSON is snake_case; everything this client returns is camelCase. */
export class Shade {
  readonly invoices: Invoices;
  readonly jars: Jars;
  readonly grants: Grants;
  readonly webhooks: Webhooks;
  readonly tags: Tags;

  constructor(options: ShadeOptions) {
    const transport = new Transport({
      apiKey: checkApiKey(options.apiKey),
      baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
      timeoutMs: checkInteger("timeoutMs", options.timeoutMs ?? 10_000, 1),
      maxRetries: checkInteger("maxRetries", options.maxRetries ?? 1, 0),
      // Wrapped so a browser's fetch is never invoked with this client as its receiver ("Illegal invocation").
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      userAgent: isBrowser() ? null : `shade-sdk/${VERSION}`,
    });
    this.invoices = new Invoices(transport);
    this.jars = new Jars(transport);
    this.grants = new Grants(transport);
    this.webhooks = new Webhooks(transport);
    this.tags = new Tags(transport);
  }
}

export class Invoices {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** POST /v1/invoices. Send the payer to `payUrl`, or hand their wallet `zip321`. */
  async create(
    params: CreateInvoiceParams,
    opts: IdempotentRequestOptions = {},
  ): Promise<PayableInvoice> {
    const body = {
      amount_zec: params.amountZec,
      memo: params.memo,
      expires_in_sec: params.expiresInSec,
      tag: params.tag,
    };
    const inv = await this.#t.request<WireInvoice>({
      method: "POST",
      path: "/v1/invoices",
      body,
      auth: true,
      kind: "idempotent_write",
      ...idempotent(opts),
    });
    return mapPayableInvoice(inv);
  }

  /** GET /v1/invoices/:id. Works for jar charges too (they have no payUrl). */
  async get(id: string, opts: RequestOptions = {}): Promise<Invoice> {
    const inv = await this.#t.request<WireInvoice>({
      method: "GET",
      path: `/v1/invoices/${segment("id", id)}`,
      auth: true,
      kind: "read",
      signal: opts.signal,
    });
    return mapInvoice(inv);
  }

  /** GET /v1/invoices, newest first. Jar charges are not listed. */
  async list(
    params: ListInvoicesParams = {},
    opts: RequestOptions = {},
  ): Promise<Page<PayableInvoice>> {
    const query = new URLSearchParams();
    if (params.status !== undefined) {
      const statuses = Array.isArray(params.status) ? params.status : [params.status];
      if (statuses.length > 0) query.set("status", statuses.join(","));
    }
    if (params.expiresAfter !== undefined) {
      const after =
        params.expiresAfter instanceof Date
          ? params.expiresAfter.toISOString()
          : params.expiresAfter;
      query.set("expires_after", after);
    }
    if (params.cursor !== undefined) query.set("cursor", params.cursor);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    const page = await this.#t.request<WirePage<WireInvoice>>({
      method: "GET",
      path: "/v1/invoices",
      query,
      auth: true,
      kind: "read",
      signal: opts.signal,
    });
    return mapPage(page, mapPayableInvoice);
  }

  /** POST /v1/invoices/:id/cancel. Cancelling an open jar charge refunds the jar. */
  async cancel(id: string, opts: RequestOptions = {}): Promise<Invoice> {
    const inv = await this.#t.request<WireInvoice>({
      method: "POST",
      path: `/v1/invoices/${segment("id", id)}/cancel`,
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
    return mapInvoice(inv);
  }

  /**
   * POST /v1/invoices/:id/detections: report a payment your own viewing-key scanner found. Shade looks the
   * transaction up on chain itself; amount and memo hash must equal the invoice's.
   */
  async reportDetection(
    id: string,
    params: ReportDetectionParams,
    opts: RequestOptions = {},
  ): Promise<Invoice> {
    const body = {
      txid: params.txid,
      amount_zec: params.amountZec,
      memo_hash: params.memoHash,
      pool: params.pool,
      source: params.source,
    };
    const inv = await this.#t.request<WireInvoice>({
      method: "POST",
      path: `/v1/invoices/${segment("id", id)}/detections`,
      body,
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
    return mapInvoice(inv);
  }
}

export class Jars {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** POST /v1/jars. A jar is a spending limit; the ZEC stays in your wallet. */
  async create(params: CreateJarParams, opts: IdempotentRequestOptions = {}): Promise<Jar> {
    const jar = await this.#t.request<WireJar>({
      method: "POST",
      path: "/v1/jars",
      body: { cap_zec: params.capZec, label: params.label },
      auth: true,
      kind: "idempotent_write",
      ...idempotent(opts),
    });
    return mapJar(jar);
  }

  /**
   * GET /v1/jars/:id: the jar's cap, spend and remaining budget. An agent key may read its own jar, so
   * an agent can check what it has left before it spends.
   */
  async get(jarId: string, opts: RequestOptions = {}): Promise<Jar> {
    const jar = await this.#t.request<WireJar>({
      method: "GET",
      path: `/v1/jars/${segment("jarId", jarId)}`,
      auth: true,
      kind: "read",
      signal: opts.signal,
    });
    return mapJar(jar);
  }

  /**
   * POST /v1/jars/:id/charge. Over the cap throws ShadeError code JAR_EMPTY (402) with `remainingZec`;
   * a killed jar throws JAR_CLOSED (409). Pass your own `idempotencyKey` so a retry after a crash never
   * charges twice.
   */
  async charge(
    jarId: string,
    params: ChargeJarParams,
    opts: IdempotentRequestOptions = {},
  ): Promise<JarChargeResult> {
    const charge = await this.#t.request<WireJarChargeResult>({
      method: "POST",
      path: `/v1/jars/${segment("jarId", jarId)}/charge`,
      body: { amount_zec: params.amountZec, memo: params.memo },
      auth: true,
      kind: "idempotent_write",
      ...idempotent(opts),
    });
    return mapJarChargeResult(charge);
  }

  /** POST /v1/jars/:id/kill. Stops new charges; move leftover ZEC in your wallet. */
  async kill(jarId: string, opts: RequestOptions = {}): Promise<Jar> {
    const jar = await this.#t.request<WireJar>({
      method: "POST",
      path: `/v1/jars/${segment("jarId", jarId)}/kill`,
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
    return mapJar(jar);
  }
}

export class Grants {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** POST /v1/grants. The token and viewUrl are returned once. */
  async create(params: CreateGrantParams, opts: RequestOptions = {}): Promise<GrantCreated> {
    if (params.days !== undefined && params.expiresInSec !== undefined) {
      throw new TypeError("grants.create: pass days or expiresInSec, not both");
    }
    const body =
      params.expiresInSec !== undefined
        ? { scope: params.scope, expires_in_sec: params.expiresInSec }
        : { scope: params.scope, days: params.days };
    const grant = await this.#t.request<WireGrantCreated>({
      method: "POST",
      path: "/v1/grants",
      body,
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
    return mapGrantCreated(grant);
  }

  /** POST /v1/grants/:id/revoke. Stops new access from Shade; copies already exported stay where they are. */
  async revoke(id: string, opts: RequestOptions = {}): Promise<Grant> {
    const grant = await this.#t.request<WireGrant>({
      method: "POST",
      path: `/v1/grants/${segment("id", id)}/revoke`,
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
    return mapGrant(grant);
  }
}

export class Webhooks {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** POST /v1/webhooks. The whsec_ signing secret is returned once. At most 5 per network. */
  async create(
    params: CreateWebhookParams,
    opts: RequestOptions = {},
  ): Promise<WebhookEndpointCreated> {
    const endpoint = await this.#t.request<WireWebhookEndpointCreated>({
      method: "POST",
      path: "/v1/webhooks",
      body: { url: params.url },
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
    return mapWebhookEndpointCreated(endpoint);
  }

  /** GET /v1/webhooks: the key network's endpoints, newest first (no secrets). */
  async list(opts: RequestOptions = {}): Promise<WebhookEndpoint[]> {
    const endpoints = await this.#t.request<WireWebhookEndpoint[]>({
      method: "GET",
      path: "/v1/webhooks",
      auth: true,
      kind: "read",
      signal: opts.signal,
    });
    return endpoints.map(mapWebhookEndpoint);
  }

  /** DELETE /v1/webhooks/:id. Stops deliveries to the endpoint, queued ones included. */
  async delete(id: string, opts: RequestOptions = {}): Promise<void> {
    await this.#t.request<undefined>({
      method: "DELETE",
      path: `/v1/webhooks/${segment("id", id)}`,
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
  }
}

export class Tags {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** POST /v1/tags: claim `<name>.shade` for your receive address on the key's network. */
  async create(params: CreateTagParams, opts: RequestOptions = {}): Promise<Tag> {
    const tag = await this.#t.request<WireTag>({
      method: "POST",
      path: "/v1/tags",
      body: { name: params.name },
      auth: true,
      kind: "write",
      signal: opts.signal,
    });
    return mapTag(tag);
  }

  /** GET /v1/tags/:name (public; the API key is not sent). Accepts "asharib" or "asharib.shade". */
  async resolve(name: string, opts: RequestOptions = {}): Promise<TagResolution> {
    const bare = name.endsWith(".shade") ? name.slice(0, -".shade".length) : name;
    const tag = await this.#t.request<WireTagResolution>({
      method: "GET",
      path: `/v1/tags/${segment("name", bare)}`,
      auth: false,
      kind: "read",
      signal: opts.signal,
    });
    return mapTagResolution(tag);
  }
}

/** The spec fields of an idempotent create or charge. */
function idempotent(opts: IdempotentRequestOptions): {
  idempotencyKey?: string;
  signal?: AbortSignal;
} {
  return { idempotencyKey: opts.idempotencyKey, signal: opts.signal };
}

function segment(name: string, value: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${name} must be a non-empty string`);
  return encodeURIComponent(value);
}

function checkApiKey(apiKey: unknown): string {
  // Printable ASCII without spaces: anything else cannot travel in an Authorization header.
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new TypeError("Shade: apiKey must be a non-empty API key (sk_test_…, sk_live_… or ag_…)");
  }
  return apiKey;
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("Shade: baseUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Shade: baseUrl must be an absolute http(s) URL");
  }
  if (url.search !== "" || url.hash !== "")
    throw new TypeError("Shade: baseUrl must not have a query or fragment");
  return url.href.replace(/\/+$/, "");
}

function checkInteger(name: string, value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`Shade: ${name} must be an integer ≥ ${min}`);
  }
  return value;
}

/**
 * Browsers forbid or preflight a custom User-Agent (Firefox sends it, and /v1 CORS does not allow it), so the
 * header is only set in server and edge runtimes.
 */
function isBrowser(): boolean {
  const g = globalThis as { document?: unknown; WorkerGlobalScope?: unknown };
  return g.document !== undefined || g.WorkerGlobalScope !== undefined;
}
