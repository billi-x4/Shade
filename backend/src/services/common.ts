/**
 * Small helpers shared by the domain services: timestamps, ZEC formatting, keyset pagination and
 * the common errors. Nothing here touches the network.
 */
import type { Network, Page } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { AppError } from "../platform/errors.ts";
import { formatZat, zatFromNumeric } from "../zcash/money.ts";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

/** Desk labels (jar names, key labels, display names): short, single line. */
export const LABEL_MAX_CHARS = 48;

export function iso(date: Date): string {
  return date.toISOString();
}

export function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/** Postgres numeric(20,8) text → canonical ZEC string for DTOs ("0.01000000" → "0.01"). */
export function zecText(numeric: string): string {
  return formatZat(zatFromNumeric(numeric));
}

/** Zatoshis → the decimal text passed as a numeric SQL parameter. */
export function zatParam(zat: bigint): string {
  return formatZat(zat);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function notFound(what: string): AppError {
  return new AppError(404, "NOT_FOUND", `No such ${what}.`);
}

/** True when the text has C0/C1 control characters (line breaks and tabs included). */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** 403 NETWORK_DISABLED unless the network is listed in SHADE_NETWORKS. */
export function assertNetworkEnabled(config: Pick<Config, "networks">, network: Network): void {
  if (!config.networks.includes(network)) {
    throw new AppError(
      403,
      "NETWORK_DISABLED",
      `${network === "mainnet" ? "Mainnet" : "Testnet"} is not enabled on this Shade server.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Keyset pagination: newest first by (created_at, id); the cursor is opaque base64url JSON.
// ---------------------------------------------------------------------------

export interface PageCursor {
  createdAt: Date;
  id: string;
}

export interface PageRequest {
  cursor: PageCursor | null;
  limit: number;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

/** Decodes a cursor from a query string; anything malformed is 400 INVALID_REQUEST. */
export function decodeCursor(raw: string | undefined): PageCursor | null {
  if (raw === undefined || raw === "") return null;
  const invalid = () => new AppError(400, "INVALID_REQUEST", "That page cursor is not valid.");
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
  const [at, id] = parsed as unknown[];
  if (typeof at !== "string" || typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw invalid();
  }
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, id };
}

/**
 * For rows fetched with `limit + 1`: the extra row only signals that another page exists, and the
 * cursor points at the last row returned.
 */
export function nextCursor(rows: { created_at: Date; id: string }[], limit: number): string | null {
  const last = rows[limit - 1];
  return rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null;
}

export function toPage<R extends { created_at: Date; id: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): Page<T> {
  return { items: rows.slice(0, limit).map(map), next_cursor: nextCursor(rows, limit) };
}
