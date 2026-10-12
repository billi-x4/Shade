import ipaddr from "ipaddr.js";
import type { Db } from "./db.ts";

/**
 * Fixed-window counter in one statement (atomic under concurrency on Postgres). Windows are aligned
 * to multiples of `windowSec` since the epoch. `retryAfterSec` is the time left in the window
 * (≥ 1) when the limit is exceeded, else 0.
 */
export async function consumeRateLimit(
  db: Db,
  bucket: string,
  limit: number,
  windowSec: number,
  now: Date,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  if (!Number.isInteger(windowSec) || windowSec < 1) {
    throw new RangeError("windowSec must be a positive integer");
  }
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const rows = await db.query<{ count: number }>(
    `insert into rate_limits (bucket, window_start, count) values ($1, $2, 1)
     on conflict (bucket, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [bucket, new Date(windowStart)],
  );
  const count = rows[0]?.count ?? 1;
  if (count <= limit) return { ok: true, retryAfterSec: 0 };
  const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - now.getTime()) / 1000));
  return { ok: false, retryAfterSec };
}

/**
 * Rate-limit key for a client address: IPv4 as-is (IPv4-mapped IPv6 unwrapped), IPv6 collapsed
 * to its /64 so one end site cannot rotate addresses to escape a limit. Unknown → "unknown".
 */
export function ipBucket(ip: string | null): string {
  if (!ip || !ipaddr.isValid(ip)) return "unknown";
  const parsed = ipaddr.process(ip);
  if (parsed.kind() === "ipv4") return parsed.toString();
  const parts = (parsed as ipaddr.IPv6).parts.slice(0, 4);
  const prefix = ipaddr.IPv6.parse(`${parts.map((part) => part.toString(16)).join(":")}::`);
  return `${prefix.toString()}/64`;
}
