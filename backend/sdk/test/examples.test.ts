/**
 * Runs the example scripts as real processes (native TypeScript on Node 24) against loopback servers on
 * 127.0.0.1, so exit codes, output lines and key hygiene are checked as a user would see them.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { signWebhook } from "../src/index.ts";
import { wireEvent } from "./fixtures.ts";

const AGENT = fileURLToPath(new URL("../examples/agent.ts", import.meta.url));
const RECEIVER = fileURLToPath(new URL("../examples/receiver.ts", import.meta.url));
const AGENT_KEY = "ag_live_secret_value_do_not_print_42";
const WEBHOOK_SECRET = "whsec_receiver_test_secret_value_77";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ["SHADE_AGENT_KEY", "SHADE_API_URL", "SHADE_WEBHOOK_SECRET"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function run(script: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: childEnv(env), stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l !== "");
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_test" });
  res.end(JSON.stringify(body));
}

describe("examples/agent.ts", () => {
  it("charges until JAR_EMPTY, prints the PRD lines, exits 0 and never prints the key", async () => {
    const seen: {
      auth: string | undefined;
      key: string | undefined;
      path: string | undefined;
      body: string;
    }[] = [];
    const remaining = ["0.004", "0.002", "0"];
    const url = await listen((req, res) => {
      let body = "";
      req.setEncoding("utf8").on("data", (d: string) => (body += d));
      req.on("end", () => {
        seen.push({
          auth: req.headers.authorization,
          key: req.headers["idempotency-key"] as string,
          path: req.url,
          body,
        });
        const left = remaining.shift();
        if (left === undefined) {
          sendJson(res, 402, {
            error: "JAR_EMPTY",
            message: "Jar empty. The agent cannot spend.",
            remaining_zec: "0",
          });
          return;
        }
        sendJson(res, 201, {
          invoice_id: `inv_${seen.length}`,
          jar_id: "jar_demo",
          amount_zec: "0.002",
          memo_hash: "sha256:" + "e".repeat(64),
          remaining_zec: left,
          status: "authorized",
          created_at: "2026-10-02T12:00:00.000Z",
        });
      });
    });

    const result = await run(
      AGENT,
      ["--jar", "jar_demo", "--times", "4", "--amount", "0.002", "--memo", "api:search"],
      {
        SHADE_API_URL: url,
        SHADE_AGENT_KEY: AGENT_KEY,
      },
    );

    expect(result.code).toBe(0);
    expect(lines(result.stdout)).toEqual([
      "authorized 0.002 · left 0.004",
      "authorized 0.002 · left 0.002",
      "authorized 0.002 · left 0",
      "402 JAR_EMPTY · Jar empty. The agent cannot spend.",
    ]);
    expect(result.stdout + result.stderr).not.toContain(AGENT_KEY);
    expect(seen).toHaveLength(4);
    for (const r of seen) {
      expect(r.auth).toBe(`Bearer ${AGENT_KEY}`);
      expect(r.path).toBe("/v1/jars/jar_demo/charge");
      expect(JSON.parse(r.body)).toEqual({ amount_zec: "0.002", memo: "api:search" });
    }
    expect(new Set(seen.map((r) => r.key)).size).toBe(4);
  });

  it("exits 0 when every call succeeds", async () => {
    const url = await listen((_req, res) =>
      sendJson(res, 201, {
        invoice_id: "inv_1",
        jar_id: "jar_demo",
        amount_zec: "0.001",
        memo_hash: "sha256:" + "e".repeat(64),
        remaining_zec: "0.005",
        status: "authorized",
        created_at: "2026-10-02T12:00:00.000Z",
      }),
    );
    const result = await run(AGENT, ["--jar", "jar_demo", "--times", "2", "--amount", "0.001"], {
      SHADE_API_URL: url,
      SHADE_AGENT_KEY: AGENT_KEY,
    });
    expect(result.code).toBe(0);
    expect(lines(result.stdout)).toEqual([
      "authorized 0.001 · left 0.005",
      "authorized 0.001 · left 0.005",
    ]);
  });

  it("exits 1 on any other API error", async () => {
    const url = await listen((_req, res) =>
      sendJson(res, 409, {
        error: "JAR_CLOSED",
        message: "Jar closed. The agent cannot spend.",
        remaining_zec: "0.004",
      }),
    );
    const result = await run(AGENT, ["--jar", "jar_demo"], {
      SHADE_API_URL: url,
      SHADE_AGENT_KEY: AGENT_KEY,
    });
    expect(result.code).toBe(1);
    expect(lines(result.stderr)).toContain("409 JAR_CLOSED · Jar closed. The agent cannot spend.");
    expect(result.stdout + result.stderr).not.toContain(AGENT_KEY);
  });

  const usageCases: { name: string; args: string[]; env: Record<string, string> }[] = [
    { name: "missing --jar", args: [], env: { SHADE_AGENT_KEY: AGENT_KEY } },
    { name: "missing key", args: ["--jar", "jar_demo"], env: {} },
    {
      name: "bad --times",
      args: ["--jar", "jar_demo", "--times", "0"],
      env: { SHADE_AGENT_KEY: AGENT_KEY },
    },
    {
      name: "unknown flag",
      args: ["--jar", "jar_demo", "--cap", "1"],
      env: { SHADE_AGENT_KEY: AGENT_KEY },
    },
  ];

  it.each(usageCases)("exits 2 with usage on $name", async ({ args, env }) => {
    const result = await run(AGENT, args, env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: npm run demo:agent");
  });
});

describe("examples/receiver.ts", () => {
  function startReceiver(): Promise<{
    url: string;
    child: ChildProcess;
    output: () => { stdout: string; stderr: string };
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RECEIVER, "--port", "0"], {
        env: childEnv({ SHADE_WEBHOOK_SECRET: WEBHOOK_SECRET }),
        stdio: "pipe",
      });
      cleanup.push(() => child.kill());
      let stdout = "";
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        stdout += d;
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
        if (match) resolve({ url: match[1]!, child, output: () => ({ stdout, stderr }) });
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`receiver exited early (${code}): ${stderr}`)));
    });
  }

  async function post(url: string, body: string, headers: Record<string, string>): Promise<number> {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
    await res.arrayBuffer();
    return res.status;
  }

  async function waitForLines(read: () => string, count: number): Promise<string[]> {
    for (let i = 0; i < 100; i++) {
      const out = lines(read());
      if (out.length >= count) return out;
      await new Promise((r) => setTimeout(r, 20));
    }
    return lines(read());
  }

  it("verifies, prints the event line, dedupes by id and rejects bad signatures", async () => {
    const receiver = await startReceiver();
    const body = JSON.stringify(wireEvent);
    const signed = await signWebhook(WEBHOOK_SECRET, body, Math.floor(Date.now() / 1000));

    expect(await post(receiver.url, body, { ...signed })).toBe(200);
    expect(await post(receiver.url, body, { ...signed })).toBe(200);
    const forged = await signWebhook("whsec_wrong", body, Math.floor(Date.now() / 1000));
    expect(await post(receiver.url, body, { ...forged })).toBe(400);
    expect(await post(receiver.url, body, {})).toBe(400);

    const stdout = await waitForLines(() => receiver.output().stdout, 3);
    expect(stdout.slice(1)).toEqual([
      "invoice.paid inv_1 0.01 verification=ivk_scan",
      "duplicate evt_1 ignored",
    ]);
    const stderr = await waitForLines(() => receiver.output().stderr, 2);
    expect(stderr).toEqual(
      expect.arrayContaining(["rejected · signature_mismatch", "rejected · missing_signature"]),
    );
    const all = receiver.output().stdout + receiver.output().stderr;
    expect(all).not.toContain(WEBHOOK_SECRET);
    expect(all).not.toContain(wireEvent.memo_hash);
  });

  it("answers 405 to non-POST requests and 413 to oversized bodies", async () => {
    const receiver = await startReceiver();
    expect((await fetch(receiver.url)).status).toBe(405);
    expect(await post(receiver.url, "x".repeat(70 * 1024), {})).toBe(413);
  });

  it("exits 2 without SHADE_WEBHOOK_SECRET", async () => {
    const result = await run(RECEIVER, [], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SHADE_WEBHOOK_SECRET is not set.");
  });
});
