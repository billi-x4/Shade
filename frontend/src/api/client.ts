import { ERROR_CODES } from "@shade/contract";
import type { ApiErrorBody, ErrorCode } from "@shade/contract";
import { formatWait } from "@/lib/format";

/** Contract codes plus two client-side ones: the request never got an answer, or the answer was not ours. */
export type ClientErrorCode = ErrorCode | "NETWORK_ERROR" | "UNEXPECTED_RESPONSE";

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly remainingZec: string | null;
  readonly issues: ApiIssue[];

  constructor(init: {
    status: number;
    code: ClientErrorCode;
    message: string;
    requestId?: string | null;
    retryAfter?: number | null;
    remainingZec?: string | null;
    issues?: ApiIssue[];
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.remainingZec = init.remainingZec ?? null;
    this.issues = init.issues ?? [];
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

const FALLBACK: Record<number, { code: ClientErrorCode; message: string }> = {
  401: { code: "UNAUTHORIZED", message: "Sign in to continue." },
  403: { code: "FORBIDDEN", message: "You do not have access to that." },
  404: { code: "NOT_FOUND", message: "That was not found." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "That request is too large." },
  429: { code: "RATE_LIMITED", message: "Too many requests. Wait a moment and try again." },
};

export const NETWORK_MESSAGE = "Cannot reach Shade. Check your connection and try again.";
const UNEXPECTED_MESSAGE = "Shade sent an unexpected answer. Try again in a moment.";

function parseRetryAfter(value: unknown): number | null {
  const seconds = typeof value === "string" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : null;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.error === "string" &&
    KNOWN_CODES.has(body.error) &&
    typeof body.message === "string"
  );
}

function sanitizeIssues(value: unknown): ApiIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { path, message } = item as Record<string, unknown>;
    return typeof path === "string" && typeof message === "string" ? [{ path, message }] : [];
  });
}

/** Builds an ApiError from a non-2xx response. Never throws. */
export async function toApiError(response: Response): Promise<ApiError> {
  const headerRequestId = response.headers.get("x-request-id");
  const headerRetry = parseRetryAfter(response.headers.get("retry-after"));
  let body: unknown = null;
  if (response.headers.get("content-type")?.includes("json")) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  if (isErrorBody(body)) {
    return new ApiError({
      status: response.status,
      code: body.error,
      message: body.message,
      requestId: body.request_id ?? headerRequestId,
      retryAfter: parseRetryAfter(body.retry_after) ?? headerRetry,
      remainingZec: typeof body.remaining_zec === "string" ? body.remaining_zec : null,
      issues: sanitizeIssues(body.issues),
    });
  }
  const fallback = FALLBACK[response.status] ?? {
    code: "UNEXPECTED_RESPONSE" as const,
    message: UNEXPECTED_MESSAGE,
  };
  return new ApiError({
    status: response.status,
    code: fallback.code,
    message: fallback.message,
    requestId: headerRequestId,
    retryAfter: headerRetry,
  });
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Same-origin fetch: the session cookie rides along automatically and is never readable from JS.
 * Resolves only on 2xx; everything else becomes an ApiError.
 */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError({ status: 0, code: "NETWORK_ERROR", message: NETWORK_MESSAGE });
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError({
      status: response.status,
      code: "UNEXPECTED_RESPONSE",
      message: UNEXPECTED_MESSAGE,
      requestId: response.headers.get("x-request-id"),
    });
  }
}

export const api = {
  get: async <T>(path: string, signal?: AbortSignal): Promise<T> =>
    readJson<T>(await request(path, { signal })),
  post: async <T>(path: string, body?: unknown): Promise<T> =>
    readJson<T>(await request(path, { method: "POST", body })),
  put: async <T>(path: string, body: unknown): Promise<T> =>
    readJson<T>(await request(path, { method: "PUT", body })),
  delete: async (path: string): Promise<void> => {
    await request(path, { method: "DELETE" });
  },
};

/** `/api/desk/jars/<id>/kill` with every dynamic segment encoded. */
export function path(strings: TemplateStringsArray, ...segments: string[]): string {
  return strings.reduce(
    (out, part, index) =>
      out + part + (index < segments.length ? encodeURIComponent(segments[index] ?? "") : ""),
    "",
  );
}

export function withQuery(base: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

/** Plain-language message for any error thrown by the API layer. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  switch (error.code) {
    case "NETWORK_ERROR":
      return NETWORK_MESSAGE;
    case "RATE_LIMITED":
      return error.retryAfter
        ? `Too many tries. Wait ${formatWait(error.retryAfter)} and try again.`
        : "Too many tries. Wait a moment and try again.";
    case "INVALID_REQUEST": {
      const issue = error.issues[0];
      return issue ? `${error.message} ${issue.message}` : error.message;
    }
    case "INTERNAL":
      return error.requestId
        ? `Something went wrong on our side. Reference ${error.requestId}.`
        : "Something went wrong on our side. Try again.";
    default:
      return error.message;
  }
}
