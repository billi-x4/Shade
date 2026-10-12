import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/platform/db.ts";
import { createTestDb } from "../support/test-db.ts";
import { consumeRateLimit, ipBucket } from "../../src/platform/rate-limit.ts";

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("consumeRateLimit", () => {
  const windowStart = Date.parse("2026-10-02T12:00:00Z");
  const at = (offsetMs: number) => new Date(windowStart + offsetMs);

  it("allows `limit` hits per window, then reports the time left in the window", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await consumeRateLimit(db, "t:a", 3, 60, at(i * 1000))).toEqual({
        ok: true,
        retryAfterSec: 0,
      });
    }
    expect(await consumeRateLimit(db, "t:a", 3, 60, at(15_000))).toEqual({
      ok: false,
      retryAfterSec: 45,
    });
    expect(await consumeRateLimit(db, "t:a", 3, 60, at(59_500))).toEqual({
      ok: false,
      retryAfterSec: 1,
    });
    expect(await consumeRateLimit(db, "t:a", 3, 60, at(60_000))).toEqual({
      ok: true,
      retryAfterSec: 0,
    });
  });

  it("keeps one row per bucket and aligned window", async () => {
    await consumeRateLimit(db, "t:rows", 10, 600, at(1000));
    await consumeRateLimit(db, "t:rows", 10, 600, at(2000));
    const rows = await db<{ window_start: Date; count: number }>`
      select window_start, count from rate_limits where bucket = ${"t:rows"}`;
    expect(rows).toEqual([{ window_start: new Date(windowStart), count: 2 }]);
  });

  it("isolates buckets", async () => {
    expect((await consumeRateLimit(db, "t:b", 1, 60, at(0))).ok).toBe(true);
    expect((await consumeRateLimit(db, "t:b", 1, 60, at(1))).ok).toBe(false);
    expect((await consumeRateLimit(db, "t:c", 1, 60, at(2))).ok).toBe(true);
  });

  it("rejects nonsensical limits", async () => {
    await expect(consumeRateLimit(db, "t:x", 0, 60, at(0))).rejects.toThrow(RangeError);
    await expect(consumeRateLimit(db, "t:x", 1, 0.5, at(0))).rejects.toThrow(RangeError);
  });
});

describe("ipBucket", () => {
  it("keeps IPv4, unwraps IPv4-mapped IPv6 and collapses IPv6 to /64", () => {
    expect(ipBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:2:ffff::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(ipBucket("::1")).toBe("::/64");
  });

  it("buckets unknown or invalid addresses together", () => {
    expect(ipBucket(null)).toBe("unknown");
    expect(ipBucket("")).toBe("unknown");
    expect(ipBucket("not-an-ip")).toBe("unknown");
  });
});
