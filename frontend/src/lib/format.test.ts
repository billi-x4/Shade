import { describe, expect, it } from "vitest";
import { formatDuration, formatSpan, formatWait } from "@/lib/format";

describe("formatWait", () => {
  it("keeps exact seconds under a minute", () => {
    expect(formatWait(1)).toBe("1 second");
    expect(formatWait(12)).toBe("12 seconds");
    expect(formatWait(58.2)).toBe("59 seconds");
  });

  it("rounds longer waits to the unit a person would use", () => {
    expect(formatWait(60)).toBe("about 1 minute");
    expect(formatWait(3_412)).toBe("about 57 minutes");
    expect(formatWait(3_600)).toBe("about 1 hour");
    expect(formatWait(5_400)).toBe("about 2 hours");
    expect(formatWait(86_400 * 3)).toBe("about 3 days");
  });

  it("never goes negative", () => {
    expect(formatWait(-5)).toBe("0 seconds");
  });
});

describe("formatSpan and formatDuration", () => {
  it("stay as they were", () => {
    expect(formatSpan(42 * 60_000)).toBe("42 min");
    expect(formatSpan(3 * 3_600_000 + 5 * 60_000)).toBe("3 h 5 min");
    expect(formatDuration(600)).toBe("10 minutes");
    expect(formatDuration(604_800)).toBe("7 days");
  });
});
