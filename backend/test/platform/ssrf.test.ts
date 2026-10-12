import type { LookupAddress } from "node:dns";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/platform/errors.ts";
import {
  assertWebhookUrl,
  isPublicAddress,
  parseRetryAfter,
  pinnedLookup,
  resolveWebhookHost,
  safePost,
} from "../../src/platform/ssrf.ts";

describe("isPublicAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "198.18.0.1",
    "192.0.2.1",
    "203.0.113.5",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::",
    "::1",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::8.8.8.8",
    "2002:7f00:1::",
    "2002:808:808::1",
    "2001::1",
    "2001:db8::1",
    "fe80::1",
    "fe90::1",
    "febf::1",
    "fec0::1",
    "fe80::1%eth0",
    "ff02::1",
    "fd00::1",
    "fc00::1",
    "100::1",
    "not-an-ip",
    "",
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "[2606:4700:4700::1111]",
  ];

  it.each(blocked)("rejects %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(allowed)("accepts %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

async function badUrlMessage(raw: string, allowPrivate = false): Promise<string> {
  try {
    await assertWebhookUrl(raw, { allowPrivate });
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
    expect((err as AppError).code).toBe("BAD_URL");
    return (err as AppError).message;
  }
  throw new Error(`expected ${raw} to be rejected`);
}

describe("assertWebhookUrl", () => {
  it("accepts public https targets on 443 or 8443 and strips fragments", async () => {
    const url = await assertWebhookUrl("https://8.8.8.8:8443/hooks/shade?x=1#frag", {
      allowPrivate: false,
    });
    expect(url.toString()).toBe("https://8.8.8.8:8443/hooks/shade?x=1");
    expect(
      (await assertWebhookUrl("https://[2606:4700:4700::1111]/h", { allowPrivate: false })).host,
    ).toBe("[2606:4700:4700::1111]");
  });

  it("rejects schemes, credentials, ports and malformed input", async () => {
    expect(await badUrlMessage("http://8.8.8.8/hook")).toMatch(/https/);
    expect(await badUrlMessage("ftp://8.8.8.8/hook")).toMatch(/https/);
    expect(await badUrlMessage("https://user:pw@8.8.8.8/hook")).toMatch(/username or password/);
    expect(await badUrlMessage("https://8.8.8.8:22/hook")).toMatch(/port 443 or 8443/);
    expect(await badUrlMessage("https://8.8.8.8:80/hook")).toMatch(/port 443 or 8443/);
    expect(await badUrlMessage("not a url")).toMatch(/valid URL/);
    expect(await badUrlMessage("")).toMatch(/at most 2048/);
    expect(await badUrlMessage(`https://8.8.8.8/${"a".repeat(2050)}`)).toMatch(/at most 2048/);
  });

  it("rejects private and reserved IP literals in every spelling", async () => {
    for (const raw of [
      "https://127.0.0.1/hook",
      "https://2130706433/hook",
      "https://0x7f.1/hook",
      "https://[::ffff:7f00:1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::]/hook",
      "https://[::1]/hook",
      "https://[64:ff9b::10.0.0.1]/hook",
      "https://[2002:7f00:1::]/hook",
      "https://[fd00::1]/hook",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(await badUrlMessage(raw)).toMatch(/private or reserved/);
    }
  });

  it("rejects hosts that resolve to private addresses", async () => {
    expect(await badUrlMessage("https://localhost/hook")).toMatch(/private or reserved/);
  });

  it("does not treat hostnames that merely start with fc/fd as IPv6", async () => {
    // .invalid never resolves (RFC 6761): the failure must be DNS, not an address-range guess.
    expect(await badUrlMessage("https://fdic-example.invalid/hook")).toMatch(/could not resolve/);
    expect(await badUrlMessage("https://fcbarcelona-example.invalid/hook")).toMatch(
      /could not resolve/,
    );
  });

  it("allows http and loopback targets on any port in allowPrivate mode", async () => {
    const url = await assertWebhookUrl("http://127.0.0.1:8790/hook", { allowPrivate: true });
    expect(url.toString()).toBe("http://127.0.0.1:8790/hook");
    expect(
      (await assertWebhookUrl("http://localhost:8790/", { allowPrivate: true })).hostname,
    ).toBe("localhost");
    expect(await badUrlMessage("ftp://127.0.0.1/hook", true)).toMatch(/https/);
  });
});

describe("resolveWebhookHost", () => {
  it("blocks a name if any resolved address is private", async () => {
    expect(await resolveWebhookHost("localhost", false)).toEqual({
      ok: false,
      error: "blocked_address",
    });
    const dev = await resolveWebhookHost("localhost", true);
    expect(dev.ok).toBe(true);
  });

  it("passes IP literals through without DNS", async () => {
    expect(await resolveWebhookHost("[2606:4700:4700::1111]", false)).toEqual({
      ok: true,
      addresses: [{ address: "2606:4700:4700::1111", family: 6 }],
    });
    expect(await resolveWebhookHost("nonexistent-host.invalid", false)).toEqual({
      ok: false,
      error: "dns_failed",
    });
  });
});

describe("pinnedLookup", () => {
  const vetted: LookupAddress[] = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];

  function lookup(options: { all?: boolean; family?: number }) {
    return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>(
      (resolve) => {
        pinnedLookup(vetted)("attacker-rebinds.example", options, (err, address, family) =>
          resolve({ err, address, family }),
        );
      },
    );
  }

  it("answers only with the vetted addresses, whatever the hostname", async () => {
    expect(await lookup({ all: true })).toEqual({ err: null, address: vetted, family: undefined });
    expect(await lookup({})).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    expect(await lookup({ family: 6 })).toEqual({
      err: null,
      address: "2606:2800:220:1:248:1893:25c8:1946",
      family: 6,
    });
    expect(await lookup({ all: true, family: 4 })).toEqual({
      err: null,
      address: [vetted[0]],
      family: undefined,
    });
  });

  it("fails with ENOTFOUND when no vetted address has the requested family", async () => {
    const result = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      pinnedLookup([{ address: "93.184.216.34", family: 4 }])("x", { family: 6 }, (err) =>
        resolve(err),
      );
    });
    expect(result?.code).toBe("ENOTFOUND");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");

  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Fri, 02 Oct 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Fri, 02 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(["15", "20"], now)).toBe(15);
  });

  it("ignores garbage and caps huge values", () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
    expect(parseRetryAfter("999999999999", now)).toBe(7 * 86_400);
  });
});

describe("safePost", () => {
  type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
  let server: Server;
  let base: string;
  let handler: Handler = (_req, res) => res.end();
  const received: { headers: IncomingMessage["headers"]; body: string; url: string | undefined }[] =
    [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body, url: req.url });
        handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const dev = { allowPrivate: true } as const;

  it("delivers the exact body and headers and reports 2xx", async () => {
    handler = (_req, res) => {
      res.statusCode = 204;
      res.end();
    };
    received.length = 0;
    const body = JSON.stringify({ id: "evt_1", amount_zec: "0.01" });
    const result = await safePost(
      `${base}/hook?x=1`,
      body,
      {
        "content-type": "application/json",
        "x-shade-event-id": "evt_1",
      },
      dev,
    );
    expect(result).toEqual({ ok: true, status: 204 });
    expect(received[0]?.url).toBe("/hook?x=1");
    expect(received[0]?.body).toBe(body);
    expect(received[0]?.headers["x-shade-event-id"]).toBe("evt_1");
    expect(received[0]?.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
  });

  it("connects through the pinned lookup for named hosts", async () => {
    handler = (_req, res) => res.end("ok");
    const port = (server.address() as AddressInfo).port;
    expect(await safePost(`http://localhost:${port}/`, "{}", {}, dev)).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("maps non-2xx statuses, honouring Retry-After on 429 and 503", async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end("internal detail that must not leak");
    };
    expect(await safePost(base, "{}", {}, dev)).toEqual({
      ok: false,
      status: 500,
      error: "http_500",
    });

    handler = (_req, res) => {
      res.statusCode = 429;
      res.setHeader("retry-after", "7");
      res.end();
    };
    expect(await safePost(base, "{}", {}, dev)).toEqual({
      ok: false,
      status: 429,
      error: "http_429",
      retryAfterSec: 7,
    });

    handler = (_req, res) => {
      res.statusCode = 410;
      res.setHeader("retry-after", "7");
      res.end();
    };
    expect(await safePost(base, "{}", {}, dev)).toEqual({
      ok: false,
      status: 410,
      error: "http_410",
    });
  });

  it("never follows redirects", async () => {
    let hits = 0;
    handler = (req, res) => {
      hits += 1;
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/elsewhere");
      }
      res.end();
    };
    expect(await safePost(`${base}/start`, "{}", {}, dev)).toEqual({
      ok: false,
      status: 302,
      error: "redirect",
    });
    expect(hits).toBe(1);
  });

  it("stops reading oversized responses", async () => {
    handler = (_req, res) => res.end("x".repeat(70 * 1024));
    expect(await safePost(base, "{}", {}, dev)).toEqual({
      ok: false,
      status: 200,
      error: "body_too_large",
    });
    handler = (_req, res) => res.end("x".repeat(1000));
    expect(await safePost(base, "{}", {}, { ...dev, maxResponseBytes: 100 })).toEqual({
      ok: false,
      status: 200,
      error: "body_too_large",
    });
  });

  it("times out slow receivers", async () => {
    handler = () => {
      // Never respond.
    };
    expect(await safePost(base, "{}", {}, { ...dev, timeoutMs: 200 })).toEqual({
      ok: false,
      status: null,
      error: "timeout",
    });
  });

  it("reports refused connections and DNS failures opaquely", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await safePost(`http://127.0.0.1:${port}/`, "{}", {}, dev)).toEqual({
      ok: false,
      status: null,
      error: "connection_failed",
    });
    expect(
      await safePost("https://nonexistent-host.invalid/", "{}", {}, { allowPrivate: false }),
    ).toEqual({
      ok: false,
      status: null,
      error: "dns_failed",
    });
  });

  it("blocks private targets and non-https URLs outside allowPrivate mode", async () => {
    handler = (_req, res) => res.end();
    received.length = 0;
    const blocked = { ok: false, status: null, error: "blocked_address" };
    expect(await safePost(base, "{}", {}, { allowPrivate: false })).toEqual(blocked);
    expect(await safePost("https://127.0.0.1/", "{}", {}, { allowPrivate: false })).toEqual(
      blocked,
    );
    expect(await safePost("https://localhost/", "{}", {}, { allowPrivate: false })).toEqual(
      blocked,
    );
    expect(await safePost("https://[::ffff:7f00:1]/", "{}", {}, { allowPrivate: false })).toEqual(
      blocked,
    );
    expect(await safePost("not a url", "{}", {}, { allowPrivate: false })).toEqual(blocked);
    expect(received).toHaveLength(0);
  });
});
