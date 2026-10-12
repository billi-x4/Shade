import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, loadConfig } from "../../src/platform/config.ts";
import { createLogger } from "../../src/platform/logger.ts";
import { MailError, createMailer } from "../../src/platform/mailer.ts";

const MESSAGE = {
  to: "owner@example.com",
  subject: "Confirm your email for Shade",
  text: "Open http://localhost:5173/api/auth/verify-email?token=tok_123",
};

function capture(env: Config["env"]) {
  const lines: string[] = [];
  const logger = createLogger(
    { logLevel: "debug", env },
    { write: (line: string) => void lines.push(line) },
  );
  return {
    logger,
    text: () => lines.join("\n"),
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function config(env: Record<string, string>): Config {
  return loadConfig({ NODE_ENV: "test", ...env });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("console transport", () => {
  it("logs the subject and link-bearing text outside production", async () => {
    const { logger, records } = capture("test");
    await createMailer(config({}), logger).send(MESSAGE);
    expect(records()[0]).toMatchObject({ level: "info", component: "mailer", mail: MESSAGE });
  });

  it("never logs the body in production", async () => {
    const { logger, text, records } = capture("production");
    const prod: Config = { ...config({}), env: "production" };
    await createMailer(prod, logger).send(MESSAGE);
    expect(records()[0]).toMatchObject({ level: "warn", mail: { subject: MESSAGE.subject } });
    expect(text()).not.toContain("tok_123");
    expect(text()).not.toContain("owner@example.com");
  });
});

describe("resend transport", () => {
  const resend = () =>
    config({
      MAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_test_123",
      MAIL_FROM: "Shade <hi@shade-zcash.vercel.app>",
    });

  it("POSTs the message to the Resend API with a bearer key", async () => {
    const fetchMock = vi.fn(async () => new Response('{"id":"email_1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { logger } = capture("test");
    await createMailer(resend(), logger).send({ ...MESSAGE, html: "<p>hi</p>" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_test_123",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Shade <hi@shade-zcash.vercel.app>",
      to: ["owner@example.com"],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: "<p>hi</p>",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws MailError and logs only the status when the provider refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"message":"bad key re_test_123 for owner@example.com"}', { status: 403 }),
      ),
    );
    const { logger, text } = capture("test");
    const error = await createMailer(resend(), logger)
      .send(MESSAGE)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).status).toBe(403);
    expect(text()).toContain('"status":403');
    expect(text()).not.toContain("re_test_123");
    expect(text()).not.toContain("tok_123");
  });

  it("throws MailError when the provider is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { logger } = capture("test");
    const error = await createMailer(resend(), logger)
      .send(MESSAGE)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).status).toBeNull();
  });
});
