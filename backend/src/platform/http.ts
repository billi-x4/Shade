import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import type { ApiErrorBody, ErrorCode, Network } from "../contract/index.ts";
import { type Auth, CLIENT_IP_HEADER } from "./auth.ts";
import { type Config, configWarnings } from "./config.ts";
import { randomToken, sha256Hex, timingSafeEqualStr } from "./crypto.ts";
import type { Db, Sql } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { consumeRateLimit } from "./rate-limit.ts";

export type Principal =
  | { kind: "merchant"; keyId: string; merchantId: string; network: Network; jarId: null }
  | { kind: "agent"; keyId: string; merchantId: string; network: Network; jarId: string };

export type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
    clientIp: string | null;
    user?: { id: string; email: string; name: string; emailVerified: boolean };
    session?: { id: string; createdAt: Date };
    principal?: Principal;
    rawBody?: string;
  };
};

const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
const API_TOKEN_PATTERN = /^(?:sk_test_|sk_live_|ag_)[A-Za-z0-9_-]{1,240}$/;
const EDGE_HEADER = "x-shade-edge";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const JSON_CONTENT_TYPE = "application/json; charset=UTF-8";

const HTTP_EXCEPTION_CODES: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: "INVALID_REQUEST", message: "The request could not be understood." },
  401: { code: "UNAUTHORIZED", message: "Sign in or send a valid API key." },
  403: { code: "FORBIDDEN", message: "You are not allowed to do that." },
  404: { code: "NOT_FOUND", message: "Not found." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "The request body is larger than 16 KB." },
  415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the request body as application/json." },
  429: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function errorBody(
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> | undefined,
  requestId: string | undefined,
): ApiErrorBody {
  return {
    ...extra,
    error: code,
    message,
    ...(requestId ? { request_id: requestId } : {}),
  };
}

function jsonResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  if (status === 204 || status === 304) return new Response(null, { status, headers });
  return new Response(text, { status, headers: { "content-type": JSON_CONTENT_TYPE, ...headers } });
}

function errorResponse(c: Context<AppEnv>, err: AppError): Response {
  const body = errorBody(err.code, err.message, err.extra, c.get("requestId"));
  const headers: Record<string, string> = {};
  const retryAfter = err.extra?.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    headers["retry-after"] = String(Math.max(0, Math.ceil(retryAfter)));
  }
  return jsonResponse(err.status, JSON.stringify(body), headers);
}

/** Sets a header even when the response's headers are immutable (e.g. Response.redirect()). */
function setResponseHeader(c: Context<AppEnv>, name: string, value: string): void {
  try {
    c.res.headers.set(name, value);
  } catch {
    const copy = new Response(c.res.body, c.res);
    copy.headers.set(name, value);
    c.res = copy;
  }
}

/** Replaces one request header in place (falls back to a rebuilt Request when headers are immutable). */
function setRequestHeader(c: Context<AppEnv>, name: string, value: string | null): void {
  const headers = c.req.raw.headers;
  try {
    headers.delete(name);
    if (value !== null) headers.set(name, value);
    if (headers.get(name) === value) return;
  } catch {
    // Immutable headers: rebuild below.
  }
  const replaced = new Headers(headers);
  replaced.delete(name);
  if (value !== null) replaced.set(name, value);
  c.req.raw = new Request(c.req.raw, { headers: replaced });
}

/** zod issues as `{ path, message }` only: the submitted value is never echoed. */
export function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

export function invalidRequest(error: z.ZodError): AppError {
  return new AppError(400, "INVALID_REQUEST", "Some fields are missing or invalid.", {
    issues: zodIssues(error),
  });
}

export function rateLimitedError(retryAfterSec: number): AppError {
  const seconds = Math.max(1, Math.ceil(retryAfterSec));
  return new AppError(
    429,
    "RATE_LIMITED",
    `Too many requests. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
    { retry_after: seconds },
  );
}

// ---------------------------------------------------------------------------
// Request context, logging, errors
// ---------------------------------------------------------------------------

function socketAddress(c: Context<AppEnv>): string | null {
  type Incoming = { incoming?: { socket?: { remoteAddress?: string } } };
  const env = c.env as (Incoming & { server?: Incoming }) | undefined;
  return (env?.server ?? env)?.incoming?.socket?.remoteAddress ?? null;
}

function normalizeIp(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text || !ipaddr.isValid(text)) return null;
  return ipaddr.process(text).toString();
}

function edgeHeaderValid(c: Context<AppEnv>, secret: string): boolean {
  const presented = c.req.header(EDGE_HEADER);
  return presented !== undefined && timingSafeEqualStr(presented, secret);
}

/**
 * The client's address from a trusted header. Only X-Forwarded-For is a list (leftmost = client);
 * every other header must hold exactly one address, so a value a hop appended to (for example a
 * client-sent x-vercel-forwarded-for kept and extended) does not parse and the next source is used.
 */
function headerIp(c: Context<AppEnv>, header: string): string | null {
  const value = c.req.header(header);
  return normalizeIp(header === "x-forwarded-for" ? value?.split(",")[0] : value);
}

/**
 * Client IP (agents.md §10), first that yields an address:
 * 1. TRUST_PROXY, the SPA proxy's header, when no EDGE_SHARED_SECRET is configured or the request
 *    carries the matching edge header (behind Vercel → Railway: x-vercel-forwarded-for, since
 *    Railway's edge overwrites X-Forwarded-For and X-Real-IP with Vercel's address);
 * 2. TRUST_PROXY_DIRECT, the backend host's own edge header (direct callers, or the proxy's header
 *    missing);
 * 3. the socket address.
 */
/** The client-IP sources {@link clientIpOf} tries, in order (header names only), for the boot log. */
export function clientIpSources(config: Config): string[] {
  const sources: string[] = [];
  if (config.trustProxy !== "none") {
    sources.push(
      config.edgeSharedSecret === null ? config.trustProxy : `${config.trustProxy} (edge secret)`,
    );
  }
  if (config.trustProxyDirect !== "none") sources.push(config.trustProxyDirect);
  sources.push("socket");
  return sources;
}

function clientIpOf(c: Context<AppEnv>, config: Config): string | null {
  const viaEdge = config.edgeSharedSecret === null || edgeHeaderValid(c, config.edgeSharedSecret);
  if (config.trustProxy !== "none" && viaEdge) {
    const ip = headerIp(c, config.trustProxy);
    if (ip !== null) return ip;
  }
  if (config.trustProxyDirect !== "none") {
    const ip = headerIp(c, config.trustProxyDirect);
    if (ip !== null) return ip;
  }
  return normalizeIp(socketAddress(c));
}

/**
 * First middleware: request id (inbound X-Request-Id only when it matches /^[A-Za-z0-9._:-]{1,64}$/),
 * client IP (also written to `x-shade-client-ip` for Better Auth, replacing any inbound value), a
 * request-scoped logger, the `x-request-id` response header and one access-log line carrying only
 * method, route pattern, status, duration, request id and principal id.
 *
 * Built once per app, it also logs {@link configWarnings} (production proxy settings that would
 * collapse or expose per-IP rate limits) so a misconfigured deploy says so at boot.
 */
export function requestContext(deps: {
  logger: Logger;
  config: Config;
}): MiddlewareHandler<AppEnv> {
  for (const warning of configWarnings(deps.config)) {
    deps.logger.warn({ component: "http" }, warning);
  }
  deps.logger.info(
    { component: "http", client_ip_sources: clientIpSources(deps.config) },
    "client IP sources",
  );
  return async (c, next) => {
    const started = performance.now();
    const inbound = c.req.header("x-request-id");
    const requestId =
      inbound !== undefined && REQUEST_ID_PATTERN.test(inbound)
        ? inbound
        : `req_${randomToken(12)}`;
    const clientIp = clientIpOf(c, deps.config);
    setRequestHeader(c, CLIENT_IP_HEADER, clientIp);
    const logger = deps.logger.child({ request_id: requestId });
    c.set("requestId", requestId);
    c.set("clientIp", clientIp);
    c.set("logger", logger);

    await next();

    setResponseHeader(c, "x-request-id", requestId);
    logger.info(
      {
        method: c.req.method,
        route: routePath(c, -1),
        status: c.res.status,
        duration_ms: Math.round(performance.now() - started),
        principal: c.get("principal")?.keyId ?? c.get("user")?.id ?? null,
      },
      "request",
    );
  };
}

/** Maps AppError, zod errors and Hono HTTP exceptions to ApiErrorBody; anything else is a 500. */
export function errorHandler(): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof AppError) return errorResponse(c, err);
    if (err instanceof z.ZodError) return errorResponse(c, invalidRequest(err));
    if (err instanceof HTTPException) {
      const mapped = HTTP_EXCEPTION_CODES[err.status];
      if (mapped) return errorResponse(c, new AppError(err.status, mapped.code, mapped.message));
    }
    const logger = c.get("logger") as Logger | undefined;
    logger?.error({ err }, "unhandled error");
    return errorResponse(
      c,
      new AppError(500, "INTERNAL", "Something went wrong on our side. Try again in a moment."),
    );
  };
}

export function notFoundHandler(): NotFoundHandler<AppEnv> {
  return (c) => errorResponse(c, new AppError(404, "NOT_FOUND", "Not found."));
}

/** `cache-control: no-store` on every response, errors included. */
export function noStore(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    setResponseHeader(c, "cache-control", "no-store");
  };
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function readRawBody(c: Context<AppEnv>): Promise<string> {
  const tooLarge = () =>
    new AppError(413, "PAYLOAD_TOO_LARGE", "The request body is larger than 16 KB.");
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) throw tooLarge();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = c.req.raw.body;
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  if (total === 0) return "";
  if (!isJsonContentType(c.req.header("content-type"))) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new AppError(400, "INVALID_REQUEST", "The request body is not valid UTF-8.");
  }
}

/**
 * Reads and validates a JSON body: a non-empty body must be `application/json` (415) and at most
 * 16 KB (413); an empty body validates as `{}`. The raw text is kept in `c.var.rawBody` for
 * idempotency hashing. Validation failures are 400 INVALID_REQUEST with path/message issues.
 */
export async function jsonBody<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.infer<S>> {
  let raw = c.get("rawBody");
  if (raw === undefined) {
    raw = await readRawBody(c);
    c.set("rawBody", raw);
  }
  let data: unknown = {};
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new AppError(400, "INVALID_REQUEST", "The request body is not valid JSON.");
    }
  }
  const result = schema.safeParse(data);
  if (!result.success) throw invalidRequest(result.error);
  return result.data;
}

// ---------------------------------------------------------------------------
// Origin and edge checks
// ---------------------------------------------------------------------------

/** When EDGE_SHARED_SECRET is set, requests must carry the matching `x-shade-edge` header. */
export function edgeGuard(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (config.edgeSharedSecret !== null && !edgeHeaderValid(c, config.edgeSharedSecret)) {
      throw new AppError(403, "FORBIDDEN_ORIGIN", "Requests must come through the Shade web app.");
    }
    await next();
  };
}

/**
 * CSRF defence for cookie routes: unsafe methods need `Origin` ∈ {APP_ORIGIN, dev twin} or, when
 * the browser sent no Origin, `Sec-Fetch-Site: same-origin`.
 */
export function requireSameOrigin(config: Config): MiddlewareHandler<AppEnv> {
  const allowed = new Set([config.appOrigin, ...config.devOrigins]);
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      const sameOrigin =
        origin !== undefined
          ? allowed.has(origin)
          : c.req.header("sec-fetch-site") === "same-origin";
      if (!sameOrigin) {
        throw new AppError(403, "FORBIDDEN_ORIGIN", "This request must come from the Shade app.");
      }
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Fixed-window limit on bucket `${name}:${key(c)}` (e.g. name "pub:inv:ip" with key
 * `ipBucket(c.var.clientIp)`). A null key skips the limit. Over the limit: 429 RATE_LIMITED with
 * `retry-after` and `retry_after`.
 */
export function rateLimit(
  db: Db,
  opts: {
    name: string;
    limit: number;
    windowSec: number;
    key: (c: Context<AppEnv>) => string | null;
    now?: () => Date;
  },
): MiddlewareHandler<AppEnv> {
  const now = opts.now ?? (() => new Date());
  return async (c, next) => {
    const key = opts.key(c);
    if (key !== null) {
      const result = await consumeRateLimit(
        db,
        `${opts.name}:${key}`,
        opts.limit,
        opts.windowSec,
        now(),
      );
      if (!result.ok) throw rateLimitedError(result.retryAfterSec);
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Desk session from the Better Auth cookie, always read from the database (no cookie cache). */
export function sessionAuth(
  auth: Auth,
  opts: { requireVerifiedEmail: boolean },
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    });
    if (!result) throw new AppError(401, "UNAUTHORIZED", "Sign in to continue.");
    const { user, session } = result;
    if (opts.requireVerifiedEmail && !user.emailVerified) {
      throw new AppError(403, "EMAIL_UNVERIFIED", "Confirm your email address to continue.");
    }
    c.set("user", {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
    });
    c.set("session", { id: session.id, createdAt: new Date(session.createdAt) });
    await next();
  };
}

/** Sensitive desk actions need a session created within `maxAgeSec` (default 15 min). */
export function requireFreshSession(
  maxAgeSec = 900,
  now: () => Date = () => new Date(),
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get("session");
    if (!session) throw new AppError(401, "UNAUTHORIZED", "Sign in to continue.");
    if (now().getTime() - session.createdAt.getTime() > maxAgeSec * 1000) {
      throw new AppError(403, "SESSION_NOT_FRESH", "For your security, sign in again to do this.");
    }
    await next();
  };
}

/**
 * `/v1` bearer auth: `Authorization: Bearer <sk_test_|sk_live_|ag_ token>`. Cookies are ignored.
 * `resolve` maps a well-formed token to its principal (or null → 401). A key whose network is not
 * enabled gets 403 NETWORK_DISABLED. `onFailure` runs before each 401 and may throw instead (a
 * per-IP limit on failed attempts), so requests without a valid key are limited too.
 */
export function apiKeyAuth(
  resolve: (token: string) => Promise<Principal | null>,
  config: Config,
  onFailure?: (c: Context<AppEnv>) => Promise<void>,
): MiddlewareHandler<AppEnv> {
  const unauthorized = async (c: Context<AppEnv>) => {
    await onFailure?.(c);
    return new AppError(401, "UNAUTHORIZED", "Missing or invalid API key.");
  };
  return async (c, next) => {
    const header = c.req.header("authorization")?.trim();
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const token = match?.[1];
    if (!token || !API_TOKEN_PATTERN.test(token)) throw await unauthorized(c);
    const principal = await resolve(token);
    if (!principal) throw await unauthorized(c);
    if (!config.networks.includes(principal.network)) {
      throw new AppError(
        403,
        "NETWORK_DISABLED",
        `This key is for ${principal.network}, which is not enabled on this Shade server.`,
      );
    }
    c.set("principal", principal);
    await next();
  };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** A 5xx outcome: rolls the transaction back (no stored row) and is answered unstored. */
class UnstoredOutcome {
  readonly status: number;
  readonly text: string;

  constructor(status: number, text: string) {
    this.status = status;
    this.text = text;
  }
}

/** Business outcomes worth replaying. 400 (validation) and 429 are transient or pre-execution. */
function storableErrorStatus(status: number): boolean {
  return status >= 401 && status < 500 && status !== 429;
}

function serializeBody(body: unknown): string {
  return body === undefined ? "" : JSON.stringify(body);
}

/** Error bodies carry the id of the request being answered, including on replay. */
function withRequestId(status: number, text: string, requestId: string | undefined): string {
  if (status < 400 || !requestId || text === "") return text;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text;
  return JSON.stringify({ ...parsed, request_id: requestId });
}

/**
 * Stripe-style `Idempotency-Key` for POST /v1 mutations (agents.md §4.10). Validate the body with
 * {@link jsonBody} and do external reads before calling `run`. In ONE transaction: claim
 * (api key, Idempotency-Key) with `insert … on conflict do nothing`; a concurrent duplicate waits on
 * that row and then sees the conflict. On conflict: a different request hash (method, path, raw
 * body) is 422 IDEMPOTENCY_MISMATCH, the same hash replays the stored status and body with
 * `idempotent-replayed: true`. Otherwise `fn` runs in the same transaction and its 2xx or business
 * 4xx outcome (returned, or thrown as AppError) is stored before commit. 5xx outcomes and other
 * errors roll back, leaving no row, so a retry runs again. Rows older than 24 h are treated as
 * absent (the sweeper deletes them).
 */
export function idempotency(
  db: Db,
  now: () => Date = () => new Date(),
): {
  run(
    c: Context<AppEnv>,
    fn: (sql: Sql) => Promise<{ status: number; body: unknown }>,
  ): Promise<Response>;
} {
  return {
    async run(c, fn) {
      const idemKey = c.req.header("idempotency-key");
      if (idemKey === undefined) {
        const result = await db.tx(fn);
        return jsonResponse(result.status, serializeBody(result.body));
      }
      if (!IDEMPOTENCY_KEY_PATTERN.test(idemKey)) {
        throw new AppError(
          400,
          "INVALID_REQUEST",
          "Idempotency-Key must be 1 to 255 printable ASCII characters.",
        );
      }
      const principal = c.get("principal");
      if (!principal) throw new AppError(401, "UNAUTHORIZED", "Missing or invalid API key.");

      const requestId = c.get("requestId");
      const requestHash = sha256Hex(`${c.req.method}\n${c.req.path}\n${c.get("rawBody") ?? ""}`);
      const at = now();
      const expiredBefore = new Date(at.getTime() - IDEMPOTENCY_RETENTION_MS);

      try {
        const outcome = await db.tx(async (sql) => {
          const claimed = await sql`
            insert into idempotency_keys
              (api_key_id, idem_key, request_hash, response_status, response_body, created_at)
            values (${principal.keyId}, ${idemKey}, ${requestHash}, 0, '', ${at})
            on conflict (api_key_id, idem_key) do update
              set request_hash = excluded.request_hash, response_status = 0, response_body = '',
                  created_at = excluded.created_at
              where idempotency_keys.created_at <= ${expiredBefore}
            returning api_key_id`;

          if (claimed.length === 0) {
            const [stored] = await sql<{
              request_hash: string;
              response_status: number;
              response_body: string;
            }>`
              select request_hash, response_status, response_body from idempotency_keys
              where api_key_id = ${principal.keyId} and idem_key = ${idemKey}`;
            if (!stored) throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "Retry this request.");
            if (stored.request_hash !== requestHash) {
              throw new AppError(
                422,
                "IDEMPOTENCY_MISMATCH",
                "This Idempotency-Key was already used for a different request.",
              );
            }
            if (stored.response_status === 0) {
              throw new AppError(
                409,
                "IDEMPOTENCY_IN_PROGRESS",
                "A request with this Idempotency-Key is still running. Retry shortly.",
              );
            }
            return { status: stored.response_status, text: stored.response_body, replayed: true };
          }

          await sql.query("savepoint shade_idempotency");
          let status: number;
          let text: string;
          try {
            const result = await fn(sql);
            status = result.status;
            text = serializeBody(result.body);
          } catch (err) {
            if (!(err instanceof AppError) || !storableErrorStatus(err.status)) throw err;
            // Keep the claim but drop whatever the failed mutation wrote.
            await sql.query("rollback to savepoint shade_idempotency");
            status = err.status;
            text = JSON.stringify(errorBody(err.code, err.message, err.extra, undefined));
          }
          if (status >= 500) throw new UnstoredOutcome(status, text);
          await sql`
            update idempotency_keys set response_status = ${status}, response_body = ${text}
            where api_key_id = ${principal.keyId} and idem_key = ${idemKey}`;
          return { status, text, replayed: false };
        });
        const headers: Record<string, string> = outcome.replayed
          ? { "idempotent-replayed": "true" }
          : {};
        return jsonResponse(
          outcome.status,
          withRequestId(outcome.status, outcome.text, requestId),
          headers,
        );
      } catch (err) {
        if (err instanceof UnstoredOutcome) return jsonResponse(err.status, err.text);
        throw err;
      }
    },
  };
}
