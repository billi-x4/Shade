import { describe, expect, it } from "vitest";
import { createLogger, errorSerializer } from "../../src/platform/logger.ts";

function capture(env: "development" | "test" | "production" = "test") {
  const lines: string[] = [];
  const logger = createLogger(
    { logLevel: "debug", env },
    { write: (line: string) => void lines.push(line) },
  );
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, records };
}

describe("createLogger", () => {
  it("writes JSON lines with string levels and ISO timestamps", () => {
    const { logger, records } = capture();
    logger.child({ request_id: "r1" }).info({ route: "/v1/invoices/:id", status: 200 }, "request");
    const [record] = records();
    expect(record).toMatchObject({
      level: "info",
      request_id: "r1",
      route: "/v1/invoices/:id",
      msg: "request",
    });
    expect(new Date(record?.time as string).toISOString()).toBe(record?.time);
  });

  it("redacts sensitive fields at the top level and up to two levels deep", () => {
    const { logger, records } = capture();
    logger.info(
      {
        password: "hunter2hunter2",
        token: "gv_secret",
        memo: "order_1042",
        txid: "a".repeat(64),
        headers: {
          authorization: "Bearer sk_test_x",
          cookie: "shade.session_token=y",
          "set-cookie": "z",
        },
        row: { ufvk: "uviewtest1secret", nested: { secret: "whsec_x", amount_zec: "0.01" } },
        route: "/v1/jars/:id/charge",
      },
      "row",
    );
    const text = JSON.stringify(records()[0]);
    for (const leaked of [
      "hunter2",
      "gv_secret",
      "order_1042",
      "aaaa",
      "sk_test_x",
      "session_token",
      "uviewtest1secret",
      "whsec_x",
      "0.01",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("/v1/jars/:id/charge");
    expect(text).toContain("[redacted]");
  });

  it("serializes errors without driver detail, and without messages in production", () => {
    const pgError = Object.assign(new Error('invalid input syntax for type numeric: "secret"'), {
      code: "22P02",
      detail: "Key (email)=(owner@example.com) already exists.",
      constraint: "user_email_key",
      query: "select $1",
      params: ["secret"],
    });
    const dev = capture("development");
    dev.logger.error({ err: pgError }, "failed");
    const devErr = dev.records()[0]?.err as Record<string, unknown>;
    expect(devErr).toMatchObject({ type: "Error", code: "22P02", constraint: "user_email_key" });
    expect(devErr.message).toContain("invalid input syntax");
    expect(JSON.stringify(devErr)).not.toContain("owner@example.com");
    expect(JSON.stringify(devErr)).not.toContain("params");

    const prod = capture("production");
    prod.logger.error({ err: pgError }, "failed");
    const prodText = JSON.stringify(prod.records()[0]);
    expect(prodText).not.toContain("secret");
    expect(prodText).not.toContain("owner@example.com");
    expect((prod.records()[0]?.err as Record<string, unknown>).stack).toMatch(/^\s*at /);
  });

  it("handles non-error values", () => {
    expect(errorSerializer(true)("boom")).toEqual({ type: "string" });
    expect(errorSerializer(true)(null)).toEqual({ type: "object" });
  });
});
