/**
 * Runs the worker-owned command-line entry points as real processes (native TypeScript on Node 24)
 * to check their output, exit codes and key hygiene. No network: every case stops before any call.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/platform/config.ts";
import { decodeBase64Key, sealPublicKeyFromPrivate } from "../../src/platform/crypto.ts";
import { UFVK } from "./support.ts";

const GEN_SEAL_KEY = fileURLToPath(new URL("../../src/bin/gen-seal-key.ts", import.meta.url));
const SCAN_LOCAL = fileURLToPath(new URL("../../src/bin/scan-local.ts", import.meta.url));
const WORKER = fileURLToPath(new URL("../../src/bin/worker.ts", import.meta.url));
const MERCHANT_KEY = "sk_test_secret_value_never_printed_1";
const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SCAN_ENV = [
  "SHADE_API_KEY",
  "SHADE_UFVK",
  "SHADE_API_URL",
  "LIGHTWALLETD_TESTNET_URL",
  "LIGHTWALLETD_MAINNET_URL",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  script: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of SCAN_ENV) if (!(key in extra)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("gen-seal-key", () => {
  it("prints a matching keypair as env lines and warns to keep the private key on the worker", async () => {
    const result = await run(GEN_SEAL_KEY, []);

    expect(result.code).toBe(0);
    const values = Object.fromEntries(
      result.stdout
        .split(/\r?\n/)
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(Object.keys(values)).toEqual([
      "VIEWING_KEY_SEAL_PUBLIC_KEY",
      "VIEWING_KEY_SEAL_PRIVATE_KEYS",
    ]);
    const publicKey = decodeBase64Key(values.VIEWING_KEY_SEAL_PUBLIC_KEY!);
    const privateKey = decodeBase64Key(values.VIEWING_KEY_SEAL_PRIVATE_KEYS!);
    expect(publicKey).not.toBeNull();
    expect(privateKey).not.toBeNull();
    expect(Buffer.from(sealPublicKeyFromPrivate(privateKey!))).toEqual(Buffer.from(publicKey!));
    // The output is accepted by the backend configuration as is.
    const config = loadConfig({ NODE_ENV: "test", ...values });
    expect(config.sealPrivateKeys).toHaveLength(1);
    expect(result.stderr).toContain("only in the worker's environment");
  });

  it("generates a different keypair every run", async () => {
    const [first, second] = await Promise.all([run(GEN_SEAL_KEY, []), run(GEN_SEAL_KEY, [])]);
    expect(first.stdout).not.toBe(second.stdout);
  });
});

describe("scan-local", () => {
  it("prints usage with --help", async () => {
    const result = await run(SCAN_LOCAL, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: npm run scan:local");
  });

  it.each([
    ["no API key", [], {}, "SHADE_API_KEY is not set."],
    ["an agent key", [], { SHADE_API_KEY: "ag_secret_agent_key" }, "must be a merchant key"],
    [
      "a key for another network",
      ["--network", "mainnet"],
      { SHADE_API_KEY: MERCHANT_KEY },
      "is a testnet key; it cannot scan mainnet",
    ],
    ["no viewing key", [], { SHADE_API_KEY: MERCHANT_KEY }, "SHADE_UFVK:"],
    [
      "a seed phrase instead of a viewing key",
      [],
      { SHADE_API_KEY: MERCHANT_KEY, SHADE_UFVK: SEED },
      "looks like a seed phrase",
    ],
    [
      "a bad API origin",
      [],
      { SHADE_API_KEY: MERCHANT_KEY, SHADE_UFVK: UFVK, SHADE_API_URL: "ftp://shade" },
      "SHADE_API_URL must be an http(s) origin.",
    ],
    ["conflicting modes", ["--once", "--watch"], {}, "Use either --once or --watch"],
    ["a short interval", ["--watch", "--interval", "1"], {}, "--interval must be"],
    ["an unknown flag", ["--fast"], {}, "Unknown option"],
  ])("exits 2 for %s without echoing secrets", async (_name, args, env, message) => {
    const result = await run(SCAN_LOCAL, args, env);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(MERCHANT_KEY);
    expect(output).not.toContain(UFVK);
    expect(output).not.toContain("abandon");
  });
});

describe("worker", () => {
  it("refuses to run without Postgres and points to the inline worker", async () => {
    const result = await run(WORKER, [], { NODE_ENV: "test" });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("set DATABASE_URL");
    expect(result.stderr).toContain("SHADE_WORKER=inline");
  });
});
