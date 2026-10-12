import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { type LookupFunction, isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "./errors.ts";

export type WebhookFailure =
  | "timeout"
  | "dns_failed"
  | "blocked_address"
  | "tls_error"
  | "connection_failed"
  | "redirect"
  | "body_too_large";

export type SafePostResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: WebhookFailure | `http_${number}` };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 2048;
const ALLOWED_PORTS = new Set(["", "443", "8443"]);
const MAX_RETRY_AFTER_SEC = 7 * 86_400;
const GLOBAL_UNICAST = ipaddr.parseCIDR("2000::/3");
const NAT64_WELL_KNOWN = ipaddr.parseCIDR("64:ff9b::/96");
const TLS_ERROR_CODES = new Set([
  "EPROTO",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "HOSTNAME_MISMATCH",
]);

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * True only for globally routable unicast addresses. IPv4-mapped (::ffff:a.b.c.d) and NAT64
 * (64:ff9b::/96) addresses are judged by the IPv4 address they embed. Any other IPv6 address must
 * be in 2000::/3 and outside every special range, which also rejects 6to4 (2002::/16), Teredo
 * (2001::/32), IPv4-compatible (::a.b.c.d), unique-local, link-local and multicast addresses.
 */
export function isPublicAddress(ip: string): boolean {
  const text = stripBrackets(ip.trim());
  if (!ipaddr.isValid(text)) return false;
  const parsed = ipaddr.parse(text);
  if (parsed.kind() === "ipv4") return parsed.range() === "unicast";
  const v6 = parsed as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() === "unicast";
  if (v6.match(NAT64_WELL_KNOWN)) {
    const bytes = v6.toByteArray().slice(12);
    return new ipaddr.IPv4(bytes).range() === "unicast";
  }
  return v6.match(GLOBAL_UNICAST) && v6.range() === "unicast";
}

/** A human reason the URL is not an acceptable webhook target, or null. Never echoes the URL. */
function urlPolicyProblem(url: URL, allowPrivate: boolean): string | null {
  const httpAllowed = allowPrivate && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpAllowed) return "Webhook URLs must use https://.";
  if (url.username || url.password) return "Webhook URLs cannot contain a username or password.";
  if (!url.hostname) return "Enter a valid URL, e.g. https://example.com/webhooks/shade.";
  if (!allowPrivate && !ALLOWED_PORTS.has(url.port)) {
    return "Webhook URLs must use port 443 or 8443.";
  }
  const literal = stripBrackets(url.hostname);
  if (!allowPrivate && isIP(literal) !== 0 && !isPublicAddress(literal)) {
    return "That URL points to a private or reserved network address.";
  }
  return null;
}

export type HostResolution =
  { ok: true; addresses: LookupAddress[] } | { ok: false; error: "dns_failed" | "blocked_address" };

/**
 * Resolves every A/AAAA record (or takes an IP literal as is) and rejects the host if ANY address
 * is not public, unless `allowPrivate` (development receivers on loopback or LAN).
 */
export async function resolveWebhookHost(
  hostname: string,
  allowPrivate: boolean,
): Promise<HostResolution> {
  const literal = stripBrackets(hostname);
  let addresses: LookupAddress[];
  const family = isIP(literal);
  if (family !== 0) {
    addresses = [{ address: literal, family }];
  } else {
    try {
      addresses = await dnsLookup(literal, { all: true, order: "verbatim" });
    } catch {
      return { ok: false, error: "dns_failed" };
    }
  }
  if (addresses.length === 0) return { ok: false, error: "dns_failed" };
  if (!allowPrivate && addresses.some((entry) => !isPublicAddress(entry.address))) {
    return { ok: false, error: "blocked_address" };
  }
  return { ok: true, addresses };
}

/**
 * A `lookup` for node:http(s) that answers only with pre-vetted addresses, so the connection goes
 * exactly where validation looked (no DNS rebinding). Honours `options.all` (used by
 * happy-eyeballs connects) and an explicit `family` hint.
 */
export function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const usable = addresses.filter((entry) => family === 0 || entry.family === family);
    const first = usable[0];
    if (!first) {
      const err: NodeJS.ErrnoException = new Error("no vetted address for the requested family");
      err.code = "ENOTFOUND";
      callback(err, "", 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        usable.map((entry) => ({ ...entry })),
      );
    } else {
      callback(null, first.address, first.family);
    }
  };
}

/** `Retry-After` as delta-seconds or HTTP-date → whole seconds from now (capped at 7 days). */
export function parseRetryAfter(
  value: string | string[] | undefined,
  nowMs: number,
): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Math.min(Number(raw), MAX_RETRY_AFTER_SEC);
  // HTTP-dates always name a month; this keeps Date.parse from reading "-5" as a year.
  if (!/[A-Za-z]{3}/.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), MAX_RETRY_AFTER_SEC);
}

function classifyNetworkError(err: unknown): WebhookFailure {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
  if (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) {
    return "tls_error";
  }
  return "connection_failed";
}

function badUrl(message: string): AppError {
  return new AppError(400, "BAD_URL", message);
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Validates a webhook endpoint URL at registration: https (http too when `allowPrivate`), port
 * 443/8443, no credentials, and a host whose every address is public. Returns the URL without a
 * fragment. Throws AppError 400 BAD_URL with a reason.
 */
export async function assertWebhookUrl(raw: string, opts: { allowPrivate: boolean }): Promise<URL> {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
    throw badUrl(`Enter a URL of at most ${MAX_URL_LENGTH} characters.`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw badUrl("Enter a valid URL, e.g. https://example.com/webhooks/shade.");
  }
  const problem = urlPolicyProblem(url, opts.allowPrivate);
  if (problem) throw badUrl(problem);
  const resolution = await withDeadline(
    resolveWebhookHost(url.hostname, opts.allowPrivate),
    DEFAULT_TIMEOUT_MS,
  );
  if (resolution === "timeout" || (!resolution.ok && resolution.error === "dns_failed")) {
    throw badUrl("We could not resolve that host name.");
  }
  if (!resolution.ok) throw badUrl("That URL points to a private or reserved network address.");
  url.hash = "";
  return url;
}

interface SendOptions {
  target: URL;
  body: Buffer;
  headers: Record<string, string>;
  addresses: LookupAddress[];
  remainingMs: number;
  maxResponseBytes: number;
}

type SendResult = SafePostResult & { retryAfterSec?: number };

function send(opts: SendOptions): Promise<SendResult> {
  const { target } = opts;
  const secure = target.protocol === "https:";
  const literal = isIP(stripBrackets(target.hostname)) !== 0;
  return new Promise<SendResult>((resolve) => {
    const request = (secure ? https : http).request({
      protocol: target.protocol,
      hostname: stripBrackets(target.hostname),
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: { ...opts.headers, "content-length": String(opts.body.length) },
      lookup: pinnedLookup(opts.addresses),
      // SNI and certificate checks use the hostname (never an IP literal), not the pinned address.
      ...(secure && !literal ? { servername: target.hostname } : {}),
      agent: false,
    });
    let settled = false;
    const finish = (result: SendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      request.destroy();
    };
    const timer = setTimeout(
      () => finish({ ok: false, status: null, error: "timeout" }),
      Math.max(0, opts.remainingMs),
    );

    request.on("error", (err) =>
      finish({ ok: false, status: null, error: classifyNetworkError(err) }),
    );
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        finish({ ok: false, status, error: "redirect" });
        return;
      }
      const retryAfterSec =
        status === 429 || status === 503
          ? parseRetryAfter(response.headers["retry-after"], Date.now())
          : undefined;
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > opts.maxResponseBytes) {
          finish({ ok: false, status, error: "body_too_large" });
        }
      });
      response.on("error", (err) =>
        finish({ ok: false, status, error: classifyNetworkError(err) }),
      );
      response.on("end", () => {
        if (status >= 200 && status < 300) {
          finish({ ok: true, status });
        } else {
          finish({
            ok: false,
            status,
            error: `http_${status}`,
            ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
          });
        }
      });
    });
    request.end(opts.body);
  });
}

/**
 * POSTs `body` to a webhook URL under the egress policy: the URL is re-validated and the host
 * re-resolved on every call, the connection is pinned to a vetted address, redirects are failures,
 * the whole exchange is bounded by `timeoutMs` (10 s) and at most `maxResponseBytes` (64 KB) of the
 * response is read. Never throws for network problems: failures come back as opaque codes.
 * `retryAfterSec` is set for 429/503 responses carrying Retry-After.
 */
export async function safePost(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { allowPrivate: boolean; timeoutMs?: number; maxResponseBytes?: number },
): Promise<SafePostResult & { retryAfterSec?: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, status: null, error: "blocked_address" };
  }
  if (urlPolicyProblem(target, opts.allowPrivate)) {
    return { ok: false, status: null, error: "blocked_address" };
  }
  const resolution = await withDeadline(
    resolveWebhookHost(target.hostname, opts.allowPrivate),
    deadline - Date.now(),
  );
  if (resolution === "timeout") return { ok: false, status: null, error: "timeout" };
  if (!resolution.ok) return { ok: false, status: null, error: resolution.error };
  return send({
    target,
    body: Buffer.from(body, "utf8"),
    headers,
    addresses: resolution.addresses,
    remainingMs: deadline - Date.now(),
    maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  });
}
