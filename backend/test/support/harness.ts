/**
 * Test harness: in-memory PGlite with every migration, the fake chain and scanner, a capturing
 * mailer, real services, real Better Auth and the real Hono app. The clock tracks real time (Better
 * Auth stamps sessions with it) plus an offset that tests advance.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import type { Network } from "../../src/contract/index.ts";
import { createApp } from "../../src/http/app.ts";
import { type Auth, createAuth } from "../../src/platform/auth.ts";
import { type Config, loadConfig } from "../../src/platform/config.ts";
import type { Db } from "../../src/platform/db.ts";
import type { AppEnv } from "../../src/platform/http.ts";
import { createLogger } from "../../src/platform/logger.ts";
import type { MailMessage } from "../../src/platform/mailer.ts";
import { createTestDb } from "./test-db.ts";
import { createBackground } from "../../src/services/background.ts";
import { type Services, createServices } from "../../src/services/index.ts";
import { encodeUnified } from "../../src/zcash/address.ts";
import type { TxSummary } from "../../src/zcash/tx.ts";
import { createFakeChain, createFakeScanner } from "./fake-chain.ts";

export const ORIGIN = "http://localhost:5173";
export const PASSWORD = "correct horse battery staple";

export type FakeChain = ReturnType<typeof createFakeChain>;
export type FakeScanner = ReturnType<typeof createFakeScanner>;

export interface TestClock {
  (): Date;
  advance(ms: number): void;
}

export interface Harness {
  db: Db;
  config: Config;
  clock: TestClock;
  chain: Record<Network, FakeChain>;
  scanner: FakeScanner;
  mail: MailMessage[];
  services: Services;
  auth: Auth;
  app: Hono<AppEnv>;
  close(): Promise<void>;
}

export function createClock(): TestClock {
  let offset = 0;
  const clock = (() => new Date(Date.now() + offset)) as TestClock;
  clock.advance = (ms) => {
    offset += ms;
  };
  return clock;
}

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const db = await createTestDb();
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    APP_ORIGIN: ORIGIN,
    SHADE_WEBHOOK_ALLOW_PRIVATE: "true",
    ...env,
  });
  const logger = createLogger({ logLevel: "silent", env: "test" });
  const clock = createClock();
  const chain = { testnet: createFakeChain("testnet"), mainnet: createFakeChain("mainnet") };
  const scanner = createFakeScanner();
  const mail: MailMessage[] = [];
  const mailer = {
    send: async (msg: MailMessage) => {
      mail.push(msg);
    },
  };
  const services = createServices({ db, config, logger, chain, scanner, mailer, clock });
  // As in bin/server.ts: auth mail and Better Auth's deferred work, drained by close().
  const authBackground = createBackground(logger);
  const auth = createAuth({
    config,
    db,
    mailer,
    logger,
    background: authBackground,
    onUserCreated: async (user) => {
      await services.merchants.ensure(user);
    },
  });
  const app = createApp({ config, logger, db, auth, services });
  for (const network of ["testnet", "mainnet"] as const) syncChain({ chain, clock }, network, 1000);
  return {
    db,
    config,
    clock,
    chain,
    scanner,
    mail,
    services,
    auth,
    app,
    async close() {
      await Promise.all([services.idle(), authBackground.idle()]);
      await db.close();
    },
  };
}

/** Moves the fake tip to `height` and dates the recent blocks up to it on the harness clock. */
export function syncChain(
  h: { chain: Record<Network, FakeChain>; clock: TestClock },
  network: Network,
  height: number,
): void {
  const now = Math.floor(h.clock().getTime() / 1000);
  h.chain[network].setTip(height);
  for (let back = 0; back < 20 && height - back >= 1; back += 1) {
    h.chain[network].setBlock(height - back, {
      hash: `${network === "testnet" ? "a" : "b"}${String(height - back).padStart(63, "0")}`,
      time: now - back * 75,
    });
  }
}

export function randomTxid(): string {
  return randomBytes(32).toString("hex");
}

/** A structurally valid Unified Address with an Orchard receiver (and optional extras). */
export function testAddress(
  network: Network,
  opts: { transparent?: boolean; sapling?: boolean } = {},
): string {
  const items = [];
  if (opts.transparent) items.push({ typecode: 0x00, data: randomBytes(20) });
  if (opts.sapling) items.push({ typecode: 0x02, data: randomBytes(43) });
  items.push({ typecode: 0x03, data: randomBytes(43) });
  return encodeUnified(
    "address",
    network,
    items.map((item) => ({ typecode: item.typecode, data: new Uint8Array(item.data) })),
  );
}

/** A structurally valid UFVK with an Orchard FVK item (the fake scanner derives its address). */
export function testUfvk(network: Network): string {
  return encodeUnified("ufvk", network, [
    { typecode: 0x03, data: new Uint8Array(randomBytes(96)) },
  ]);
}

/** A shielded (Ironwood) transaction mined at `height` on the fake chain. */
export function putShieldedTx(
  chain: FakeChain,
  txid: string,
  where: { height: number } | "mempool",
  summary: Partial<TxSummary> = { ironwoodActions: 2 },
): void {
  if (where === "mempool") chain.putTransaction(txid, { kind: "mempool", summary });
  else chain.putTransaction(txid, { kind: "mined", summary, height: where.height });
}

let userCounter = 0;

/** A Better Auth user (no HTTP, not rate limited) whose merchant the sign-up hook created. */
export async function createUser(
  h: Harness,
  opts: { name?: string } = {},
): Promise<{ userId: string; email: string; merchantId: string }> {
  userCounter += 1;
  const email = `merchant${userCounter}-${randomBytes(4).toString("hex")}@example.com`;
  const result = await h.auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: opts.name ?? "Test Shop" },
  });
  const merchant = await h.services.merchants.ensure({
    id: result.user.id,
    name: result.user.name,
  });
  return { userId: result.user.id, email, merchantId: merchant.id };
}

/** A merchant with a receive address on each listed network. */
export async function createMerchant(
  h: Harness,
  opts: { name?: string; networks?: Network[] } = {},
): Promise<{
  userId: string;
  email: string;
  merchantId: string;
  addresses: Record<string, string>;
}> {
  const user = await createUser(h, opts);
  const addresses: Record<string, string> = {};
  for (const network of opts.networks ?? ["testnet"]) {
    const address = testAddress(network);
    const column = network === "mainnet" ? "ua_mainnet" : "ua_testnet";
    await h.db.query(`update merchants set ${column} = $1 where id = $2`, [
      address,
      user.merchantId,
    ]);
    addresses[network] = address;
  }
  return { ...user, addresses };
}

/** A merchant API key token for `network`. */
export async function merchantKey(h: Harness, merchantId: string, network: Network = "testnet") {
  return h.services.keys.issue(merchantId, { kind: "merchant", label: "test", network });
}

let ipCounter = 0;

/** A distinct client address per call, so Better Auth's per-IP limits never interfere. */
export function nextIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export interface CallOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  token?: string;
  origin?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

/** app.request with JSON, an Origin header (APP_ORIGIN unless null) and a socket address. */
export async function call(
  h: Pick<Harness, "app">,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.origin !== null && path.startsWith("/api")) headers.origin = opts.origin ?? ORIGIN;
  else if (typeof opts.origin === "string") headers.origin = opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  return h.app.request(
    path,
    { method, headers, body },
    { incoming: { socket: { remoteAddress: opts.ip ?? "203.0.113.7" } } },
  );
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((raw) => raw.split(";")[0] ?? "")
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

/** A signed-in desk session cookie for a new merchant (sign-up via the API, sign-in over HTTP). */
export async function deskSession(
  h: Harness,
  opts: { name?: string; networks?: Network[] } = {},
): Promise<{
  cookie: string;
  merchantId: string;
  userId: string;
  email: string;
  addresses: Record<string, string>;
}> {
  const merchant = await createMerchant(h, opts);
  const res = await call(h, "POST", "/api/auth/sign-in/email", {
    body: { email: merchant.email, password: PASSWORD },
    ip: nextIp(),
  });
  if (res.status !== 200) throw new Error(`sign-in failed with ${res.status}`);
  return { ...merchant, cookie: cookieHeader(res) };
}

export interface ReceivedHook {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A local webhook receiver (allowed via SHADE_WEBHOOK_ALLOW_PRIVATE in tests). */
export async function webhookReceiver(
  respond: (n: number) => { status: number; headers?: Record<string, string> } = () => ({
    status: 200,
  }),
) {
  const received: ReceivedHook[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const reply = respond(received.length);
      res.writeHead(reply.status, reply.headers ?? {});
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/shade`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
