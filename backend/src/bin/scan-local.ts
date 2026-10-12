/**
 * Merchant-device scanner: finds payments to your open Shade invoices with your own viewing key,
 * on your own machine, and reports only the matches to Shade.
 *
 *   SHADE_API_KEY=sk_test_… SHADE_UFVK=uviewtest1… npm run scan:local -w @shade/backend -- --watch
 *
 * Environment (backend/.env is loaded when present):
 *   SHADE_API_KEY   sk_test_… (testnet) or sk_live_… (mainnet) merchant key (required; never printed)
 *   SHADE_UFVK      full viewing key of the receiving account (required; never printed or sent)
 *   SHADE_API_URL   Shade API origin, default http://localhost:5173 (the dev web app proxies /v1)
 *   LIGHTWALLETD_TESTNET_URL / LIGHTWALLETD_MAINNET_URL   comma lists of light servers
 *
 * Progress state: .shade-scan-<network>.json in the current directory (a block height and hash and
 * the key's fingerprint; no key, no memos). Exit status: 0 done (or stopped with Ctrl-C in --watch
 * mode), 1 a scan or Shade request failed, 2 bad usage or configuration.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Network } from "../contract/index.ts";
import { ApiRequestError, runLocalScanPass } from "../worker/local-scan.ts";
import type { LocalScanDeps } from "../worker/local-scan.ts";
import { parseUfvk } from "../zcash/address.ts";
import {
  ChainUnavailableError,
  DEFAULT_LIGHTWALLETD_URLS,
  createLightwalletdClient,
} from "../zcash/lightwalletd.ts";
import { ScannerError, createLedgerScanner } from "../zcash/scanner.ts";

const USAGE = `Usage: npm run scan:local -w @shade/backend -- [--network testnet|mainnet] [--watch [--interval 60]]

Scans the chain on this machine with your full viewing key and reports payments that match
your open invoices to Shade. Runs once unless --watch is given.

Options:
  --network   testnet or mainnet (default: the network of SHADE_API_KEY)
  --once      scan once and exit (default)
  --watch     keep scanning every --interval seconds until Ctrl-C
  --interval  seconds between scans in --watch mode (default 60, minimum 5)

Environment:
  SHADE_API_KEY   sk_test_… or sk_live_… merchant key (required)
  SHADE_UFVK      full viewing key of the receiving account (required)
  SHADE_API_URL   Shade API origin (default http://localhost:5173)
  LIGHTWALLETD_TESTNET_URL, LIGHTWALLETD_MAINNET_URL   light servers (comma lists)`;

const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 5;

function usage(problem: string): number {
  console.error(`${problem}\n\n${USAGE}`);
  return 2;
}

function explain(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return `Shade request failed: ${err.status === null ? "" : `${err.status} `}${err.code} · ${err.message}`;
  }
  if (err instanceof ScannerError) return `Scan failed (${err.code}): ${err.message}`;
  if (err instanceof ChainUnavailableError)
    return "Scan failed: the Zcash light server is unavailable.";
  return `Scan failed: ${err instanceof Error ? err.name : "unknown error"}`;
}

interface Flags {
  network?: string;
  once: boolean;
  watch: boolean;
  interval?: string;
  help: boolean;
}

function parseFlags(): Flags | string {
  try {
    return parseArgs({
      options: {
        network: { type: "string" },
        once: { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        interval: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function keyNetwork(apiKey: string): Network | null {
  if (apiKey.startsWith("sk_test_")) return "testnet";
  if (apiKey.startsWith("sk_live_")) return "mainnet";
  return null;
}

function apiOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function main(): Promise<number> {
  const flags = parseFlags();
  if (typeof flags === "string") return usage(flags);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.once && flags.watch) return usage("Use either --once or --watch, not both.");
  if (flags.interval !== undefined && !flags.watch) return usage("--interval needs --watch.");
  const intervalSec = Number(flags.interval ?? DEFAULT_INTERVAL_SEC);
  if (!Number.isInteger(intervalSec) || intervalSec < MIN_INTERVAL_SEC) {
    return usage(`--interval must be a whole number of seconds, at least ${MIN_INTERVAL_SEC}.`);
  }

  const apiKey = process.env.SHADE_API_KEY?.trim() ?? "";
  if (apiKey === "") return usage("SHADE_API_KEY is not set.");
  const fromKey = keyNetwork(apiKey);
  if (fromKey === null) {
    return usage("SHADE_API_KEY must be a merchant key (sk_test_… or sk_live_…).");
  }
  if (flags.network !== undefined && flags.network !== "testnet" && flags.network !== "mainnet") {
    return usage("--network must be testnet or mainnet.");
  }
  const network: Network = flags.network ?? fromKey;
  if (network !== fromKey) {
    return usage(`SHADE_API_KEY is a ${fromKey} key; it cannot scan ${network}.`);
  }
  const ufvk = parseUfvk(process.env.SHADE_UFVK ?? "", network);
  if (!ufvk.ok) return usage(`SHADE_UFVK: ${ufvk.message}`);
  const origin = apiOrigin(process.env.SHADE_API_URL?.trim() || "http://localhost:5173");
  if (origin === null) return usage("SHADE_API_URL must be an http(s) origin.");

  const envName = network === "testnet" ? "LIGHTWALLETD_TESTNET_URL" : "LIGHTWALLETD_MAINNET_URL";
  const configured = process.env[envName]?.trim();
  const urls = configured
    ? configured
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean)
    : [...DEFAULT_LIGHTWALLETD_URLS[network]];
  let chain: LocalScanDeps["chain"];
  try {
    chain = createLightwalletdClient({ urls, network });
  } catch {
    return usage(`${envName} must be a comma list of http(s) URLs.`);
  }
  const scanner = createLedgerScanner({ urls: () => urls });
  if (!(await scanner.available())) {
    console.error(
      "The viewing-key scanner cannot load on this machine (it needs Windows, macOS, or Linux with glibc 2.34 or newer).",
    );
    return 1;
  }

  const controller = new AbortController();
  if (flags.watch) {
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
  }
  const deps: LocalScanDeps = {
    apiUrl: origin,
    apiKey,
    ufvk: ufvk.ufvk,
    network,
    chain,
    scanner,
    fetch: globalThis.fetch,
    cursorFile: resolve(`.shade-scan-${network}.json`),
    clock: () => new Date(),
    print: (line) => console.log(line),
    signal: controller.signal,
  };

  for (;;) {
    try {
      const result = await runLocalScanPass(deps);
      if (result.blocksScanned > 0) {
        console.log(
          `Done: ${result.reported} match${result.reported === 1 ? "" : "es"} reported, ${result.rejected} refused, ${result.ambiguous} ambiguous.`,
        );
      }
      if (!flags.watch) return 0;
    } catch (err) {
      if (controller.signal.aborted) return 0;
      console.error(explain(err));
      if (!flags.watch) return 1;
    }
    await wait(intervalSec * 1000, controller.signal);
    if (controller.signal.aborted) return 0;
  }
}

process.exitCode = await main();
