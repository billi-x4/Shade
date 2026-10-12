import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Invoice, Page } from "../../src/contract/index.ts";
import { fingerprint } from "../../src/platform/crypto.ts";
import {
  ApiRequestError,
  type LocalScanDeps,
  candidatesFromInvoices,
  runLocalScanPass,
} from "../../src/worker/local-scan.ts";
import { memoHash } from "../../src/zcash/memo.ts";
import { createFakeChain, createFakeScanner } from "../support/fake-chain.ts";
import {
  type FakeChain,
  type FakeScanner,
  NOW,
  TIP,
  UFVK,
  hash,
  payment,
  recordingScanner,
  txid,
} from "./support.ts";

const MIN = 60_000;
const API_KEY = "sk_test_local_scanner_key";
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
function invoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  return {
    status: "open",
    verification: null,
    network: "testnet",
    amount_zec: "0.01",
    memo: "order",
    chain_memo: `order (shade:${overrides.id.slice(-8).toUpperCase()})`,
    memo_hash: memoHash(`order (shade:${overrides.id})`),
    tag: null,
    address: "utest1merchant",
    zip321: "zcash:utest1merchant",
    pay_url: `https://shade.example/pay/${overrides.id}`,
    txid: null,
    claimed_txid: null,
    // No recorded creation height (the light server was down); tests add one.
    created_height: null,
    jar_id: null,
    created_at: at(-10 * MIN).toISOString(),
    expires_at: at(50 * MIN).toISOString(),
    paid_at: null,
    detection: null,
    ...overrides,
  };
}

async function writeCursorFile(height: number, blockHash: string): Promise<void> {
  await writeFile(
    join(dir, ".shade-scan-testnet.json"),
    JSON.stringify({
      version: 1,
      network: "testnet",
      key: fingerprint(UFVK),
      height,
      hash: blockHash,
    }),
  );
}

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

let dir: string;
let chain: FakeChain;
let fakeScanner: FakeScanner;
let scanner: ReturnType<typeof recordingScanner>;
let pages: Array<Page<Invoice>>;
let detectionResponse: (invoiceId: string) => { status: number; body: unknown };
let listResponse: { status: number; body: unknown } | null;
let requests: Recorded[];
let printed: string[];

function deps(overrides: Partial<LocalScanDeps> = {}): LocalScanDeps {
  return {
    apiUrl: "https://api.shade.example",
    apiKey: API_KEY,
    ufvk: UFVK,
    network: "testnet",
    chain,
    scanner,
    cursorFile: join(dir, ".shade-scan-testnet.json"),
    clock: () => NOW,
    print: (line) => printed.push(line),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method: init?.method ?? "GET", url, headers, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/v1/invoices") {
        if (listResponse) return json(listResponse.status, listResponse.body);
        const cursor = url.searchParams.get("cursor");
        const page = cursor === null ? pages[0] : pages[Number(cursor)];
        if (!page) return json(200, { items: [], next_cursor: null });
        // Filters like the server: effective status (open past expiry reads expired), expires_after.
        const statuses = (url.searchParams.get("status") ?? "").split(",");
        const after = url.searchParams.get("expires_after");
        const effective = (inv: Invoice) =>
          inv.status === "open" && Date.parse(inv.expires_at) <= NOW.getTime()
            ? "expired"
            : inv.status;
        const items = page.items.filter(
          (inv) =>
            statuses.includes(effective(inv)) &&
            (after === null || Date.parse(inv.expires_at) > Date.parse(after)),
        );
        return json(200, { ...page, items });
      }
      const match = /^\/v1\/invoices\/([^/]+)\/detections$/.exec(url.pathname);
      if (match) {
        const response = detectionResponse(decodeURIComponent(match[1]!));
        return json(response.status, response.body);
      }
      return json(404, { error: "NOT_FOUND", message: "Not found." });
    },
    ...overrides,
  };
}

async function readCursorFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, ".shade-scan-testnet.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function tipHash(): Promise<string> {
  return (await chain.getTip()).hash;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "shade-scan-local-"));
  chain = createFakeChain("testnet");
  chain.setTip(TIP);
  fakeScanner = createFakeScanner();
  scanner = recordingScanner(fakeScanner);
  pages = [];
  listResponse = null;
  requests = [];
  printed = [];
  detectionResponse = (invoiceId) => ({
    status: 200,
    body: invoice({ id: invoiceId, status: "paid", verification: "ivk_scan" }),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runLocalScanPass", () => {
  it("reports a matching payment and saves the cursor at the tip", async () => {
    const inv = invoice({ id: "inv_1" });
    pages = [{ items: [inv], next_cursor: null }];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, {
        txid: txid(1),
        height: TIP - 1,
        memoHash: inv.memo_hash,
        amountZat: 1_000_000n,
      }),
    );

    const result = await runLocalScanPass(deps());

    // No cursor yet: start at the last block before created_at − 120 s (TIP − 10 at 75 s per
    // block), lowered by the timestamp margin (12) and lo's margin (2).
    expect(scanner.scans).toEqual([
      { network: "testnet", ufvk: UFVK, fromHeight: TIP - 24, toHeight: TIP },
    ]);
    expect(result).toEqual({
      candidates: 1,
      blocksScanned: 25,
      payments: 1,
      reported: 1,
      rejected: 0,
      ambiguous: 0,
    });
    const [live, expired] = requests;
    expect(live!.method).toBe("GET");
    expect(live!.url.searchParams.get("status")).toBe("open,paid_unverified");
    expect(live!.url.searchParams.has("expires_after")).toBe(false);
    expect(live!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    // First run: the candidate window is measured from now, so only recent expiries are fetched.
    expect(expired!.url.searchParams.get("status")).toBe("expired");
    expect(expired!.url.searchParams.get("expires_after")).toBe(at(-70 * MIN).toISOString());
    const post = requests[2]!;
    expect(post).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: {
        txid: txid(1),
        amount_zec: "0.01",
        memo_hash: inv.memo_hash,
        pool: "ironwood",
        source: "merchant_device",
      },
    });
    expect(post.url.pathname).toBe("/v1/invoices/inv_1/detections");
    expect(printed).toContain("inv_1: paid");
    expect(await readCursorFile()).toEqual({
      version: 1,
      network: "testnet",
      key: fingerprint(UFVK),
      height: TIP,
      hash: await tipHash(),
      updated_at: NOW.toISOString(),
    });
  });

  it("resumes from the cursor minus the rescan window", async () => {
    pages = [
      {
        items: [invoice({ id: "inv_1", created_at: at(-180 * MIN).toISOString() })],
        next_cursor: null,
      },
    ];
    await runLocalScanPass(deps());
    chain.setTip(TIP + 40);

    await runLocalScanPass(deps());

    expect(scanner.scans[1]).toMatchObject({ fromHeight: TIP - 12, toHeight: TIP + 40 });
    expect((await readCursorFile()).height).toBe(TIP + 40);
  });

  it("re-scans 600 blocks when the block at the cursor changed", async () => {
    pages = [
      {
        items: [invoice({ id: "inv_1", created_at: at(-24 * 60 * MIN).toISOString() })],
        next_cursor: null,
      },
    ];
    await writeFile(
      join(dir, ".shade-scan-testnet.json"),
      JSON.stringify({
        version: 1,
        network: "testnet",
        key: fingerprint(UFVK),
        height: TIP - 40,
        hash: hash("stale"),
      }),
    );

    await runLocalScanPass(deps());

    expect(scanner.scans[0]).toMatchObject({ fromHeight: TIP - 640, toHeight: TIP });
    expect(printed).toContain("The chain changed since the last scan; rescanning recent blocks.");
  });

  it("ignores a cursor written for another viewing key", async () => {
    pages = [{ items: [invoice({ id: "inv_1" })], next_cursor: null }];
    await writeFile(
      join(dir, ".shade-scan-testnet.json"),
      JSON.stringify({
        version: 1,
        network: "testnet",
        key: "0123456789abcdef",
        height: TIP - 1,
        hash: await tipHash(),
      }),
    );

    await runLocalScanPass(deps());

    expect(scanner.scans[0]).toMatchObject({ fromHeight: TIP - 24 });
    expect((await readCursorFile()).key).toBe(fingerprint(UFVK));
  });

  it("matches a payment mined before expiry on a run hours after the last one", async () => {
    // The previous run (about 4 hours ago) left the cursor at TIP − 200. Since then the invoice was
    // created, paid, and expired 2 hours ago: well past 70 minutes by the clock, but the scan has
    // not covered its grace window yet.
    await writeCursorFile(TIP - 200, (await chain.getBlock(TIP - 200))!.hash);
    const inv = invoice({
      id: "inv_1",
      status: "expired",
      created_at: at(-180 * MIN).toISOString(),
      expires_at: at(-120 * MIN).toISOString(),
    });
    pages = [{ items: [inv], next_cursor: null }];
    // Mined 17 minutes after creation (block time NOW − 163 min).
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(1), height: TIP - 130, memoHash: inv.memo_hash }),
    );

    const result = await runLocalScanPass(deps());

    expect(result).toMatchObject({ candidates: 1, payments: 1, reported: 1 });
    expect(requests.at(-1)?.url.pathname).toBe("/v1/invoices/inv_1/detections");
    expect(scanner.scans[0]!.fromHeight).toBeLessThanOrEqual(TIP - 130);
    expect((await readCursorFile()).height).toBe(TIP);
  });

  it("starts low enough for an invoice created since the last run, however fast blocks come", async () => {
    // Blocks 15 s apart (testnet averages well under 25 s); an hourly job left the cursor at the
    // tip of an hour ago. The invoice was created 30 min ago and paid 2 min later, 110 blocks back.
    const tipTime = (await chain.getBlock(TIP))!.time;
    for (let height = TIP - 400; height <= TIP; height += 1) {
      chain.setBlock(height, { hash: hash(`fast-${height}`), time: tipTime - 15 * (TIP - height) });
    }
    await writeCursorFile(TIP - 240, (await chain.getBlock(TIP - 240))!.hash);
    const inv = invoice({ id: "inv_1", created_at: at(-30 * MIN).toISOString() });
    pages = [{ items: [inv], next_cursor: null }];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(1), height: TIP - 110, memoHash: inv.memo_hash }),
    );

    const result = await runLocalScanPass(deps());

    // created_at − 120 s falls on TIP − 126; lowered by 12 + 2. A 25 s/block estimate began at TIP − 79.
    expect(scanner.scans).toEqual([
      expect.objectContaining({ fromHeight: TIP - 140, toHeight: TIP }),
    ]);
    expect(result).toMatchObject({ reported: 1 });
  });

  it("starts from the creation height the API records", async () => {
    pages = [{ items: [invoice({ id: "inv_1", created_height: TIP - 5 })], next_cursor: null }];

    await runLocalScanPass(deps());

    expect(scanner.scans[0]).toMatchObject({ fromHeight: TIP - 7, toHeight: TIP });
  });

  it("follows every page of candidates", async () => {
    const second = invoice({ id: "inv_2" });
    pages = [
      { items: [invoice({ id: "inv_1" })], next_cursor: "1" },
      { items: [second], next_cursor: null },
    ];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(2), height: TIP, memoHash: second.memo_hash }),
    );

    const result = await runLocalScanPass(deps());

    expect(
      requests
        .filter((r) => r.method === "GET")
        .map((r) => [r.url.searchParams.get("status"), r.url.searchParams.get("cursor")]),
    ).toEqual([
      ["open,paid_unverified", null],
      ["open,paid_unverified", "1"],
      ["expired", null],
      ["expired", "1"],
    ]);
    expect(result).toMatchObject({ candidates: 2, reported: 1 });
    expect(requests.at(-1)?.url.pathname).toBe("/v1/invoices/inv_2/detections");
  });

  it("does nothing without open invoices", async () => {
    pages = [
      {
        items: [
          invoice({ id: "inv_paid", status: "paid" }),
          invoice({
            id: "inv_old",
            status: "expired",
            created_at: at(-300 * MIN).toISOString(),
            expires_at: at(-71 * MIN).toISOString(),
          }),
        ],
        next_cursor: null,
      },
    ];

    const result = await runLocalScanPass(deps());

    expect(result.candidates).toBe(0);
    expect(scanner.scans).toEqual([]);
    expect(printed).toEqual(["No open invoices to look for."]);
    await expect(readCursorFile()).rejects.toThrow();
  });

  it("prints a business refusal and still moves the cursor", async () => {
    const inv = invoice({ id: "inv_1" });
    pages = [{ items: [inv], next_cursor: null }];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(1), height: TIP, memoHash: inv.memo_hash }),
    );
    detectionResponse = () => ({
      status: 409,
      body: { error: "TXID_IN_USE", message: "That payment already settled another invoice." },
    });

    const result = await runLocalScanPass(deps());

    expect(result).toMatchObject({ reported: 0, rejected: 1 });
    expect(printed).toContain("inv_1: TXID_IN_USE · That payment already settled another invoice.");
    expect((await readCursorFile()).height).toBe(TIP);
  });

  it("keeps the cursor when Shade cannot take the report", async () => {
    const inv = invoice({ id: "inv_1" });
    pages = [{ items: [inv], next_cursor: null }];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(1), height: TIP, memoHash: inv.memo_hash }),
    );
    detectionResponse = () => ({
      status: 503,
      body: { error: "CHAIN_UNAVAILABLE", message: "Try again shortly.", retry_after: 30 },
    });

    const failure = await runLocalScanPass(deps()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({ status: 503, code: "CHAIN_UNAVAILABLE" });
    await expect(readCursorFile()).rejects.toThrow();
  });

  it("keeps the cursor when Shade's light server has not seen the transaction yet", async () => {
    const inv = invoice({ id: "inv_1" });
    pages = [{ items: [inv], next_cursor: null }];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(1), height: TIP, memoHash: inv.memo_hash }),
    );
    detectionResponse = () => ({
      status: 404,
      body: { error: "TX_NOT_FOUND", message: "That transaction is not on testnet yet." },
    });

    const failure = await runLocalScanPass(deps()).catch((err: unknown) => err);

    expect(failure).toMatchObject({ status: 404, code: "TX_NOT_FOUND" });
    await expect(readCursorFile()).rejects.toThrow();
  });

  it("reports a payment for an invoice that expired between the two candidate fetches", async () => {
    const open = invoice({ id: "inv_1", expires_at: at(1_000).toISOString() });
    const expired = { ...open, status: "expired" as const, expires_at: at(-1_000).toISOString() };
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(1), height: TIP, memoHash: open.memo_hash }),
    );
    const base = deps();
    const result = await runLocalScanPass({
      ...base,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/invoices") {
          const live = url.searchParams.get("status") === "open,paid_unverified";
          return new Response(
            JSON.stringify({ items: [live ? open : expired], next_cursor: null }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return base.fetch(input, init);
      },
    });

    expect(result).toMatchObject({ candidates: 1, reported: 1, ambiguous: 0 });
    expect(requests.at(-1)?.url.pathname).toBe("/v1/invoices/inv_1/detections");
  });

  it("fails instead of scanning for a partial candidate list", async () => {
    // Every page points at another: more pages than the scanner reads.
    pages = Array.from({ length: 300 }, (_, i) => ({
      items: [invoice({ id: `inv_${i}` })],
      next_cursor: String(i + 1),
    }));

    const failure = await runLocalScanPass(deps()).catch((err: unknown) => err);

    expect(failure).toMatchObject({ code: "TOO_MANY_INVOICES" });
    expect(scanner.scans).toEqual([]);
    await expect(readCursorFile()).rejects.toThrow();
  });

  it("fails on a rejected API key before scanning", async () => {
    listResponse = { status: 401, body: { error: "UNAUTHORIZED", message: "Invalid API key." } };

    await expect(runLocalScanPass(deps())).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(scanner.scans).toEqual([]);
  });

  it("reports nothing for a payment that matches two invoices", async () => {
    const memo = memoHash("rent");
    pages = [
      {
        items: [
          invoice({ id: "inv_1", memo_hash: memo }),
          invoice({ id: "inv_2", memo_hash: memo, status: "paid_unverified" }),
        ],
        next_cursor: null,
      },
    ];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(1), height: TIP, memoHash: memo }),
    );

    const result = await runLocalScanPass(deps());

    expect(result).toMatchObject({ reported: 0, ambiguous: 1 });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("never prints or stores the viewing key, txids or memo hashes", async () => {
    const inv = invoice({ id: "inv_1" });
    pages = [{ items: [inv], next_cursor: null }];
    fakeScanner.addPayment(
      "testnet",
      UFVK,
      await payment(chain, { txid: txid(5), height: TIP, memoHash: inv.memo_hash }),
    );

    await runLocalScanPass(deps());

    const output = `${printed.join("\n")}\n${JSON.stringify(await readCursorFile())}`;
    expect(output).not.toContain(UFVK);
    expect(output).not.toContain(txid(5));
    expect(output).not.toContain(inv.memo_hash);
  });
});

describe("candidatesFromInvoices", () => {
  it("keeps payable invoices of the network and maps amounts to zatoshis", () => {
    const candidates = candidatesFromInvoices(
      [
        invoice({ id: "inv_open" }),
        invoice({ id: "inv_claimed", status: "paid_unverified" }),
        invoice({ id: "inv_grace", status: "expired", expires_at: at(-30 * MIN).toISOString() }),
        invoice({ id: "inv_stale", status: "expired", expires_at: at(-71 * MIN).toISOString() }),
        invoice({ id: "inv_paid", status: "paid" }),
        invoice({ id: "inv_cancelled", status: "cancelled" }),
        invoice({ id: "inv_charge", status: "authorized", jar_id: "jar_1" }),
        invoice({ id: "inv_main", network: "mainnet" }),
        invoice({ id: "inv_bad", amount_zec: "1e-3" }),
      ],
      "testnet",
      NOW,
    );

    expect(candidates.map((c) => c.id)).toEqual(["inv_open", "inv_claimed", "inv_grace"]);
    expect(candidates[0]).toEqual({
      id: "inv_open",
      status: "open",
      amountZat: 1_000_000n,
      memoHash: memoHash("order (shade:inv_open)"),
      createdAt: at(-10 * MIN),
      expiresAt: at(50 * MIN),
      createdHeight: null,
    });
  });

  it("measures expired invoices against how far the scan got, not the clock", () => {
    const expired = invoice({
      id: "inv_x",
      status: "expired",
      expires_at: at(-200 * MIN).toISOString(),
    });
    expect(candidatesFromInvoices([expired], "testnet", NOW)).toEqual([]);
    // Kept while the cursor block is less than 70 minutes past expiry.
    expect(candidatesFromInvoices([expired], "testnet", at(-131 * MIN))).toHaveLength(1);
    expect(candidatesFromInvoices([expired], "testnet", at(-129 * MIN))).toEqual([]);
    expect(candidatesFromInvoices([expired], "testnet", null)).toHaveLength(1);
  });

  it("takes the recorded creation height; null or absent (an older server) means unknown", () => {
    const { created_height: _omitted, ...legacy } = invoice({ id: "inv_old" });
    const heights = candidatesFromInvoices(
      [
        invoice({ id: "inv_h", created_height: TIP - 5 }),
        invoice({ id: "inv_null", created_height: null }),
        legacy as Invoice,
      ],
      "testnet",
      NOW,
    ).map((candidate) => [candidate.id, candidate.createdHeight]);
    expect(heights).toEqual([
      ["inv_h", TIP - 5],
      ["inv_null", null],
      ["inv_old", null],
    ]);
  });
});
