/**
 * Merchant-device scanning (bin/scan-local.ts): the same scanner and matcher as the hosted worker,
 * run on the merchant's machine with their own viewing key. Candidates come from the merchant's
 * /v1 API, the block cursor lives in a local file, and only matching payments are reported to
 * POST /v1/invoices/:id/detections. The viewing key and memo text never leave this process and are
 * never printed; the cursor file holds a height, a block hash and the key's short fingerprint.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import type { ApiErrorBody, Invoice, Network, Page } from "../contract/index.ts";
import { fingerprint } from "../platform/crypto.ts";
import { type ChainClient, ChainUnavailableError } from "../zcash/lightwalletd.ts";
import { formatZat, parseZec } from "../zcash/money.ts";
import type { ScannedPayment, Scanner } from "../zcash/scanner.ts";
import {
  CANDIDATE_RETENTION_MS,
  type MatchCandidate,
  candidateBounds,
  chainBlockTime,
  isCandidate,
  lowestScanHeight,
  matchPayment,
  planScanRange,
  resumeHeight,
} from "./matching.ts";

/** The server's confirmation threshold is unknown here; cover mainnet's default (10) + 2. */
export const LOCAL_RESCAN_BLOCKS = 12;
/** Blocks per scan call; the cursor is saved after each chunk. */
export const LOCAL_CHUNK_BLOCKS = 20_000;
const PAGE_LIMIT = 100;
/**
 * Pages per candidate list. Unpaid invoices are capped at 10,000 per merchant and network
 * (INVOICE_LIMIT), so 200 pages of 100 cover them; past that the pass fails instead of silently
 * scanning for only some of them while the cursor moves on.
 */
const MAX_PAGES = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const CURSOR_VERSION = 1;

export interface LocalScanDeps {
  /** Shade API origin, e.g. https://shade-zcash.vercel.app. */
  apiUrl: string;
  /** sk_test_… / sk_live_… merchant key for `network`. */
  apiKey: string;
  ufvk: string;
  network: Network;
  chain: ChainClient;
  scanner: Scanner;
  fetch: typeof fetch;
  cursorFile: string;
  clock: () => Date;
  print: (line: string) => void;
  signal?: AbortSignal;
}

export interface LocalScanResult {
  candidates: number;
  blocksScanned: number;
  payments: number;
  reported: number;
  rejected: number;
  ambiguous: number;
}

/** A Shade API answer the pass cannot continue past (auth, rate limit, server or network error). */
export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  readonly status: number | null;
  readonly code: string;

  constructor(status: number | null, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface LocalCursor {
  height: number;
  hash: string;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Maps /v1 invoices to scan candidates, keeping only those a payment can still settle: open and
 * claimed invoices, and expired ones not yet covered by a scan up to `scannedThrough` (matching.ts
 * `isCandidate`; null keeps every expired invoice).
 */
export function candidatesFromInvoices(
  invoices: readonly Invoice[],
  network: Network,
  scannedThrough: Date | null,
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (const invoice of invoices) {
    if (invoice.jar_id !== null || invoice.network !== network) continue;
    if (
      invoice.status !== "open" &&
      invoice.status !== "paid_unverified" &&
      invoice.status !== "expired"
    ) {
      continue;
    }
    const amountZat = parseZec(invoice.amount_zec);
    if (amountZat === null) continue;
    const candidate: MatchCandidate = {
      id: invoice.id,
      status: invoice.status,
      amountZat,
      memoHash: invoice.memo_hash,
      createdAt: new Date(invoice.created_at),
      expiresAt: new Date(invoice.expires_at),
      // The tip recorded at creation; null when the light server was unreachable then (or the server
      // predates the field), and lowestScanHeight then finds the start from block times.
      createdHeight: invoice.created_height ?? null,
    };
    if (isCandidate(candidate, scannedThrough)) candidates.push(candidate);
  }
  return candidates;
}

/** Reads the cursor file; null when absent, unreadable, or written for another network or key. */
export async function readCursor(
  path: string,
  network: Network,
  keyFingerprint: string,
): Promise<LocalCursor | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { height, hash } = record;
  if (
    record.version !== CURSOR_VERSION ||
    record.network !== network ||
    record.key !== keyFingerprint ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    typeof hash !== "string" ||
    !HASH.test(hash)
  ) {
    return null;
  }
  return { height, hash };
}

/** Replaces the cursor file atomically (write a sibling, then rename over it). */
export async function writeCursor(
  path: string,
  network: Network,
  keyFingerprint: string,
  cursor: LocalCursor,
  now: Date,
): Promise<void> {
  const body = {
    version: CURSOR_VERSION,
    network,
    key: keyFingerprint,
    height: cursor.height,
    hash: cursor.hash,
    updated_at: now.toISOString(),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function requestSignal(deps: LocalScanDeps): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
}

async function apiError(response: Response): Promise<ApiRequestError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await response.json()) as Partial<ApiErrorBody>;
  } catch {
    // Not a Shade error body (e.g. a proxy page): report the status alone.
  }
  return new ApiRequestError(
    response.status,
    typeof body.error === "string" ? body.error : `HTTP_${response.status}`,
    typeof body.message === "string" ? body.message : `Shade answered HTTP ${response.status}.`,
  );
}

async function request(
  deps: LocalScanDeps,
  method: "GET" | "POST",
  path: string,
  json?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${deps.apiKey}`,
  };
  if (json !== undefined) headers["content-type"] = "application/json";
  try {
    return await deps.fetch(new URL(path, deps.apiUrl), {
      method,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: requestSignal(deps),
    });
  } catch {
    throw new ApiRequestError(null, "NETWORK_ERROR", "Shade could not be reached.");
  }
}

/** Every page of `GET /v1/invoices` for `filter`; fails rather than return a partial list. */
async function fetchAllInvoices(
  deps: LocalScanDeps,
  filter: Record<string, string>,
): Promise<Invoice[]> {
  const invoices: Invoice[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ ...filter, limit: String(PAGE_LIMIT) });
    if (cursor !== null) query.set("cursor", cursor);
    const response = await request(deps, "GET", `/v1/invoices?${query.toString()}`);
    if (!response.ok) throw await apiError(response);
    const body = (await response.json()) as Page<Invoice>;
    invoices.push(...body.items);
    cursor = body.next_cursor;
    if (cursor === null) return invoices;
  }
  throw new ApiRequestError(
    null,
    "TOO_MANY_INVOICES",
    `More than ${(MAX_PAGES * PAGE_LIMIT).toLocaleString("en-US")} invoices to look for; nothing was scanned and the cursor did not move. If many are still open, cancel the stale ones in the desk. If the light server is behind your last scan, every expired invoice is fetched: run the scan again later.`,
  );
}

/**
 * The key network's open and payer-claimed invoices, plus expired ones still inside the candidate
 * window: those expiring after `scannedThrough` − {@link CANDIDATE_RETENTION_MS} (every expired one
 * when that time is unknown). Old expired invoices are never fetched.
 */
export async function fetchCandidateInvoices(
  deps: LocalScanDeps,
  scannedThrough: Date | null,
): Promise<Invoice[]> {
  const live = await fetchAllInvoices(deps, { status: "open,paid_unverified" });
  const expired = await fetchAllInvoices(deps, {
    status: "expired",
    ...(scannedThrough === null
      ? {}
      : {
          expires_after: new Date(scannedThrough.getTime() - CANDIDATE_RETENTION_MS).toISOString(),
        }),
  });
  // An invoice that expires between the two fetches is in both: keep its later (expired) copy, or
  // matching would see one invoice twice and call its payment ambiguous.
  return [...new Map([...live, ...expired].map((invoice) => [invoice.id, invoice])).values()];
}

type Report = { kind: "reported"; invoice: Invoice } | { kind: "rejected"; error: ApiRequestError };

/**
 * Posts one match. Business refusals (4xx other than 401/403/408/429) are answers, not failures,
 * except TX_NOT_FOUND: Shade's light server has not seen the transaction yet, so the pass fails and
 * keeps the cursor, and the next pass reports it again.
 */
async function reportDetection(
  deps: LocalScanDeps,
  invoiceId: string,
  payment: ScannedPayment,
): Promise<Report> {
  const response = await request(
    deps,
    "POST",
    `/v1/invoices/${encodeURIComponent(invoiceId)}/detections`,
    {
      txid: payment.txid,
      amount_zec: formatZat(payment.amountZat),
      memo_hash: payment.memoHash,
      pool: payment.pool,
      source: "merchant_device",
    },
  );
  if (response.ok) return { kind: "reported", invoice: (await response.json()) as Invoice };
  const error = await apiError(response);
  const definitive =
    response.status >= 400 &&
    response.status < 500 &&
    ![401, 403, 408, 429].includes(response.status) &&
    error.code !== "TX_NOT_FOUND";
  if (!definitive) throw error;
  return { kind: "rejected", error };
}

function describe(invoice: Invoice): string {
  const detection = invoice.detection;
  if (invoice.status === "paid") return "paid";
  if (detection?.state === "seen") {
    const confirmations = detection.confirmations ?? 0;
    return `payment seen, waiting for confirmations (${confirmations}/${detection.required_confirmations})`;
  }
  return detection ? `${invoice.status}, detection ${detection.state}` : invoice.status;
}

const formatHeight = (height: number): string => height.toLocaleString("en-US");

/**
 * One pass: fetch candidates, scan from the cursor (minus the rescan window, or from the earliest
 * candidate on the first run) to the tip in chunks, report matches, and save the cursor after each
 * chunk. Nothing to look for ⇒ no scan and the cursor stays as it is.
 *
 * Expired invoices stay candidates until the scan has covered their grace window, measured at the
 * cursor block's time (a first run starts from now), so a pass that runs hours after the last one
 * still matches a payment mined before expiry.
 */
export async function runLocalScanPass(deps: LocalScanDeps): Promise<LocalScanResult> {
  const result: LocalScanResult = {
    candidates: 0,
    blocksScanned: 0,
    payments: 0,
    reported: 0,
    rejected: 0,
    ambiguous: 0,
  };
  const startedAt = deps.clock();
  const keyFingerprint = fingerprint(deps.ufvk);
  let cursor = await readCursor(deps.cursorFile, deps.network, keyFingerprint);
  let reorged = false;
  let scannedThrough: Date | null = startedAt;
  if (cursor !== null) {
    const block = await deps.chain.getBlock(cursor.height);
    reorged = block === null || block.hash !== cursor.hash;
    // The block now at the cursor height; none (the light server is behind) ⇒ unknown.
    scannedThrough = block === null ? null : new Date(block.time * 1000);
  }
  const payable = candidatesFromInvoices(
    await fetchCandidateInvoices(deps, scannedThrough),
    deps.network,
    null,
  );
  const candidates = payable.filter((candidate) => isCandidate(candidate, scannedThrough));
  result.candidates = candidates.length;
  if (candidates.length === 0) {
    deps.print("No open invoices to look for.");
    return result;
  }
  if (reorged) deps.print("The chain changed since the last scan; rescanning recent blocks.");

  const tip = await deps.chain.getTip();
  const lo = await lowestScanHeight({
    bounds: candidateBounds(candidates),
    tipHeight: tip.height,
    resumeFrom: resumeHeight({
      cursorHeight: cursor?.height ?? null,
      reorged,
      rescanBlocks: LOCAL_RESCAN_BLOCKS,
    }),
    blockTime: chainBlockTime(deps.chain),
  });

  for (;;) {
    const range = planScanRange({
      lo,
      cursorHeight: cursor?.height ?? null,
      reorged,
      tipHeight: tip.height,
      rescanBlocks: LOCAL_RESCAN_BLOCKS,
      maxBlocks: LOCAL_CHUNK_BLOCKS,
    });
    if (range === null) break;
    reorged = false;
    const end = range.to === tip.height ? tip : await deps.chain.getBlock(range.to);
    if (end === null) throw new ChainUnavailableError(undefined, "bad_response");
    deps.print(
      `Scanning ${deps.network} blocks ${formatHeight(range.from)}–${formatHeight(range.to)} for ${candidates.length} open invoice${candidates.length === 1 ? "" : "s"}…`,
    );

    const payments: ScannedPayment[] = [];
    for await (const payment of deps.scanner.scan({
      network: deps.network,
      ufvk: deps.ufvk,
      fromHeight: range.from,
      toHeight: range.to,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })) {
      payments.push(payment);
    }
    result.blocksScanned += range.to - range.from + 1;
    result.payments += payments.length;

    const now = deps.clock();
    for (const payment of payments.sort((a, b) => a.blockHeight - b.blockHeight)) {
      const match = matchPayment(payment, candidates, now);
      if (match.kind === "ambiguous") {
        result.ambiguous += 1;
        deps.print(
          `A payment matches more than one invoice (${match.invoiceIds.join(", ")}); none was reported. Confirm the right one in the desk.`,
        );
        continue;
      }
      if (match.kind !== "match") continue;
      const report = await reportDetection(deps, match.invoiceId, payment);
      if (report.kind === "reported") {
        result.reported += 1;
        deps.print(`${match.invoiceId}: ${describe(report.invoice)}`);
      } else {
        result.rejected += 1;
        deps.print(`${match.invoiceId}: ${report.error.code} · ${report.error.message}`);
      }
    }

    cursor = { height: range.to, hash: end.hash };
    await writeCursor(deps.cursorFile, deps.network, keyFingerprint, cursor, now);
    if (range.to >= tip.height) break;
  }
  return result;
}
