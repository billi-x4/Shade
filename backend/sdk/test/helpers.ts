import type { FetchLike } from "../src/index.ts";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

/** One scripted reply: a Response, an Error to reject with, or "hang" (settles only when the request aborts). */
export type Reply = Response | Error | "hang";

export function fakeFetch(replies: Reply[]): { fetch: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const signal = init.signal ?? undefined;
    calls.push({
      url: input,
      method: init.method ?? "GET",
      headers,
      body: init.body as string | undefined,
      signal,
    });
    const reply = replies.shift();
    if (reply === undefined)
      return Promise.reject(new Error(`unexpected request #${calls.length}`));
    if (reply === "hang") {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  };
  return { fetch, calls };
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Mechanical snake_case → camelCase of every key, to prove the explicit mappers drop nothing. */
export function camelizeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      camelizeDeep(v),
    ]),
  );
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Captures the outcome without an unhandled rejection while fake timers are advanced. */
export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export function errorOf<T>(result: Settled<T>): unknown {
  if (result.ok) throw new Error("expected the call to fail");
  return result.error;
}
