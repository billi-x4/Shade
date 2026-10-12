import { randomUuid } from "./crypto.ts";
import { ShadeConnectionError, ShadeError } from "./errors.ts";
import type { WireErrorBody } from "./wire.ts";

/** Any WHATWG-fetch-compatible function, e.g. globalThis.fetch or a Hono app's `app.request`. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response> | Response;

/**
 * - read: GET; retried on network errors, timeouts and 5xx.
 * - idempotent_write: POST with a fresh Idempotency-Key per logical call, reused on each retry; retried like reads.
 * - write: POST that is never retried.
 */
export type RequestKind = "read" | "idempotent_write" | "write";

export interface RequestSpec {
  method: "GET" | "POST" | "DELETE";
  /** Path below the base URL with segments already encoded, e.g. "/v1/invoices/inv_1". */
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  /** false for public endpoints, which never receive the API key. */
  auth: boolean;
  kind: RequestKind;
  /** The caller's Idempotency-Key for an idempotent_write; a fresh UUID when absent. */
  idempotencyKey?: string;
  /** Aborts the call: the request in flight and any wait before a retry. */
  signal?: AbortSignal;
}

/** Per-call options of the client methods. */
export interface RequestOptions {
  /** Aborts the call (ShadeConnectionError code ABORTED). */
  signal?: AbortSignal;
}

/**
 * Per-call options of creates and charges. Pass your own `idempotencyKey` (e.g. derived from your job
 * or request id) so a retry after a crash or restart replays the first answer instead of acting twice.
 */
export interface IdempotentRequestOptions extends RequestOptions {
  /** 1–255 printable ASCII characters, no spaces. Shade keeps it for 24 h per API key. */
  idempotencyKey?: string;
}

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: FetchLike;
  userAgent: string | null;
}

const BASE_RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 5_000;

type Attempt =
  | { kind: "response"; status: number; headers: Headers; text: string }
  | { kind: "failure"; error: ShadeConnectionError };

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

function abortedError(cause?: unknown): ShadeConnectionError {
  return new ShadeConnectionError("ABORTED", "The Shade API call was aborted", cause);
}

export class Transport {
  readonly #opts: TransportOptions;

  constructor(opts: TransportOptions) {
    this.#opts = opts;
  }

  async request<T>(spec: RequestSpec): Promise<T> {
    const query = spec.query?.toString() ?? "";
    const url = `${this.#opts.baseUrl}${spec.path}${query === "" ? "" : `?${query}`}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (spec.auth) headers.authorization = `Bearer ${this.#opts.apiKey}`;
    if (this.#opts.userAgent !== null) headers["user-agent"] = this.#opts.userAgent;
    // Serialized once: retries must send byte-identical bodies, since the server hashes them per Idempotency-Key.
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    if (body !== undefined) headers["content-type"] = "application/json";
    if (spec.kind === "idempotent_write") {
      const key = spec.idempotencyKey ?? randomUuid();
      if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
        throw new TypeError("idempotencyKey must be 1–255 printable ASCII characters, no spaces");
      }
      headers["idempotency-key"] = key;
    }
    const maxAttempts = spec.kind === "write" ? 1 : this.#opts.maxRetries + 1;

    for (let attempt = 1; ; attempt++) {
      if (spec.signal?.aborted) throw abortedError(spec.signal.reason);
      const result = await this.#attempt(spec.method, url, headers, body, spec.signal);
      const canRetry = attempt < maxAttempts && !spec.signal?.aborted;
      if (result.kind === "failure") {
        if (!canRetry) throw result.error;
        await sleep(backoffMs(attempt), spec.signal);
        continue;
      }
      if (result.status >= 200 && result.status < 300) return parseSuccess<T>(result);
      const error = toShadeError(result);
      const delay =
        result.status >= 500 && canRetry ? serverRetryDelayMs(attempt, error.retryAfter) : null;
      if (delay === null) throw error;
      await sleep(delay, spec.signal);
    }
  }

  async #attempt(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#opts.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const fetchFn = this.#opts.fetch;
      const res = await fetchFn(url, { method, headers, body, signal: controller.signal });
      // The body read stays under the same deadline as the request.
      const text = await res.text();
      return { kind: "response", status: res.status, headers: res.headers, text };
    } catch (err) {
      if (signal?.aborted) return { kind: "failure", error: abortedError(err) };
      if (controller.signal.aborted) {
        const error = new ShadeConnectionError(
          "TIMEOUT",
          `Shade API did not respond within ${this.#opts.timeoutMs} ms`,
          err,
        );
        return { kind: "failure", error };
      }
      const error = new ShadeConnectionError(
        "NETWORK_ERROR",
        `Could not reach the Shade API at ${new URL(url).origin}`,
        err,
      );
      return { kind: "failure", error };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function parseSuccess<T>(res: { status: number; headers: Headers; text: string }): T {
  // 204 No Content (a DELETE) has no body.
  if (res.status === 204) return undefined as T;
  const data = parseJson(res.text);
  if (data === null || typeof data !== "object") {
    throw new ShadeError({
      status: res.status,
      code: "UNEXPECTED_RESPONSE",
      message: `Shade API returned HTTP ${res.status} without a JSON body`,
      requestId: res.headers.get("x-request-id"),
    });
  }
  return data as T;
}

function toShadeError(res: { status: number; headers: Headers; text: string }): ShadeError {
  const headerRequestId = res.headers.get("x-request-id");
  const headerRetryAfter = parseRetryAfter(res.headers.get("retry-after"));
  const body = parseJson(res.text);
  if (!isErrorBody(body)) {
    return new ShadeError({
      status: res.status,
      code: "UNEXPECTED_RESPONSE",
      message: `Shade API returned HTTP ${res.status} without an error body`,
      requestId: headerRequestId,
      retryAfter: headerRetryAfter,
    });
  }
  return new ShadeError({
    status: res.status,
    code: body.error,
    message: body.message,
    requestId: typeof body.request_id === "string" ? body.request_id : headerRequestId,
    remainingZec: typeof body.remaining_zec === "string" ? body.remaining_zec : undefined,
    retryAfter: typeof body.retry_after === "number" ? body.retry_after : headerRetryAfter,
    issues: Array.isArray(body.issues) ? body.issues : undefined,
  });
}

function isErrorBody(value: unknown): value is WireErrorBody {
  if (value === null || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.error === "string" && typeof body.message === "string";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Delta-seconds form only; Shade never sends an HTTP-date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** Exponential backoff with jitter: attempt 1 waits 150–300 ms, doubling up to MAX_RETRY_DELAY_MS. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/**
 * A server Retry-After is honoured. One longer than MAX_RETRY_DELAY_MS means "not now": null tells the caller
 * to surface the error (carrying retryAfter) instead of blocking.
 */
function serverRetryDelayMs(attempt: number, retryAfterSec: number | undefined): number | null {
  if (retryAfterSec === undefined) return backoffMs(attempt);
  const ms = retryAfterSec * 1000;
  return ms <= MAX_RETRY_DELAY_MS ? ms : null;
}

/** Waits `ms`; an abort ends the wait early with ShadeConnectionError ABORTED. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
