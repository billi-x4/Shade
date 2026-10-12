/**
 * Grants: time-boxed, revocable receipt views for an auditor. The `gv_` token is shown once and
 * stored as SHA-256; Shade serves the receipts (view + CSV) until the grant expires or is revoked.
 */
import type {
  Grant,
  GrantCreated,
  GrantState,
  GrantView,
  Network,
  Receipt,
  Verification,
} from "../contract/index.ts";
import { COPY } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { newId, randomToken, sha256Hex } from "../platform/crypto.ts";
import type { Db } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import { addSeconds, assertNetworkEnabled, iso, isoOrNull, notFound, zecText } from "./common.ts";
import { type Scope, normalizeLabel } from "./invoices.ts";

export const GRANT_MIN_SEC = 600;
export const GRANT_MAX_SEC = 90 * 86_400;
const DEFAULT_GRANT_DAYS = 7;
const RECEIPT_LIMIT = 500;
/** Soft cap on active grants per merchant and network, and the most grants a desk list returns. */
const ACTIVE_GRANT_LIMIT = 100;
const LIST_LIMIT = 200;
const TOKEN_PATTERN = /^gv_[A-Za-z0-9_-]{43}$/;
const EXPIRED_MESSAGE = "This grant expired. Shade no longer serves these receipts.";

export interface GrantInput {
  scope: string;
  days?: number;
  expires_in_sec?: number;
}

export interface GrantExport {
  grantId: string;
  filename: string;
  csv: string;
}

export interface GrantService {
  create(merchantId: string, network: Network, input: GrantInput): Promise<GrantCreated>;
  /** Seconds the grant would last; the desk asks for a fresh session above one day. */
  durationSec(input: GrantInput): number;
  list(merchantId: string, network: Network): Promise<Grant[]>;
  revoke(scope: Scope, grantId: string): Promise<Grant>;
  /** Any known token answers (active, revoked or expired); unknown tokens are 404. */
  view(token: string): Promise<GrantView>;
  /** CSV of the receipts; 410 once revoked or expired. */
  exportCsv(token: string): Promise<GrantExport>;
}

interface GrantRow {
  id: string;
  merchant_id: string;
  scope: string;
  network: Network;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_viewed_at: Date | null;
}

const GRANT_COLUMNS =
  "id, merchant_id, scope, network, created_at, expires_at, revoked_at, last_viewed_at";

interface ReceiptRow {
  id: string;
  jar_id: string | null;
  amount_zec: string;
  memo: string;
  memo_hash: string;
  tag: string | null;
  txid: string | null;
  verification: Verification;
  paid_at: Date | null;
  created_at: Date;
}

function badDuration(): AppError {
  return new AppError(400, "BAD_DURATION", "A grant lasts between 10 minutes and 90 days.");
}

function stateOf(row: GrantRow, now: Date): GrantState {
  if (row.revoked_at !== null) return "revoked";
  return row.expires_at.getTime() <= now.getTime() ? "expired" : "active";
}

function receiptDto(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    kind: row.jar_id === null ? "invoice" : "jar_charge",
    amount_zec: zecText(row.amount_zec),
    memo: row.memo,
    memo_hash: row.memo_hash,
    tag: row.tag,
    txid: row.txid,
    verification: row.verification,
    paid_at: isoOrNull(row.paid_at),
    created_at: iso(row.created_at),
  };
}

/**
 * One CSV cell (RFC 4180). Cells a spreadsheet would run as a formula (leading = + - @, or a
 * leading tab / carriage return) are prefixed with an apostrophe so they stay text.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

const CSV_HEADER = [
  "paid_at",
  "invoice_id",
  "kind",
  "amount_zec",
  "memo",
  "tag",
  "txid",
  "verification",
];

function receiptsCsv(receipts: Receipt[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of receipts) {
    lines.push(
      [
        // A jar charge has no chain payment; its time is when the charge was authorized.
        r.paid_at ?? r.created_at,
        r.id,
        r.kind,
        r.amount_zec,
        r.memo,
        r.tag ?? "",
        r.txid ?? "",
        r.verification,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function createGrantService(deps: {
  db: Db;
  config: Config;
  clock: () => Date;
}): GrantService {
  const { db, config, clock } = deps;

  const grantDto = (row: GrantRow): Grant => ({
    id: row.id,
    scope: row.scope,
    network: row.network,
    state: stateOf(row, clock()),
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    revoked_at: isoOrNull(row.revoked_at),
    last_viewed_at: isoOrNull(row.last_viewed_at),
    note: COPY.grantNote,
  });

  const durationSec: GrantService["durationSec"] = (input) => {
    if (input.days !== undefined && input.expires_in_sec !== undefined) {
      throw new AppError(400, "BAD_DURATION", "Send days or expires_in_sec, not both.");
    }
    if (input.expires_in_sec !== undefined) {
      const seconds = input.expires_in_sec;
      if (!Number.isInteger(seconds) || seconds < GRANT_MIN_SEC || seconds > GRANT_MAX_SEC) {
        throw badDuration();
      }
      return seconds;
    }
    const days = input.days ?? DEFAULT_GRANT_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > 90) throw badDuration();
    return days * 86_400;
  };

  /** Known token → its grant row (and the merchant's shop name); null when unknown. */
  const byToken = async (token: string) => {
    if (!TOKEN_PATTERN.test(token)) return null;
    const [row] = await db.query<GrantRow & { display_name: string }>(
      `select g.id, g.merchant_id, g.scope, g.network, g.created_at, g.expires_at, g.revoked_at,
              g.last_viewed_at, m.display_name
       from grants g join merchants m on m.id = g.merchant_id
       where g.token_hash = $1`,
      [sha256Hex(token)],
    );
    return row ?? null;
  };

  const touch = (grantId: string) =>
    db`update grants set last_viewed_at = ${clock()} where id = ${grantId}`;

  /** Verified receipts in scope and network, newest first (payer claims never count). */
  const receipts = async (grant: GrantRow): Promise<Receipt[]> => {
    const rows = await db<ReceiptRow>`
      select id, jar_id, amount_zec, memo, memo_hash, tag, txid, verification, paid_at, created_at
      from invoices
      where merchant_id = ${grant.merchant_id} and network = ${grant.network}
        and (
          (jar_id is null and status = 'paid' and verification in ('ivk_scan', 'merchant_accept'))
          or (jar_id is not null and status = 'authorized')
        )
        and (${grant.scope}::text = 'all' or tag = ${grant.scope}::text)
      order by created_at desc, id desc
      limit ${RECEIPT_LIMIT}`;
    return rows.map(receiptDto);
  };

  return {
    durationSec,

    async create(merchantId, network, input) {
      assertNetworkEnabled(config, network);
      const scope =
        input.scope.trim().toLowerCase() === "all" ? "all" : normalizeLabel(input.scope);
      if (scope === null) {
        throw new AppError(
          400,
          "BAD_SCOPE",
          "Scope must be all or an invoice label, like payroll.",
        );
      }
      const seconds = durationSec(input);
      const now = clock();
      const [active] = await db<{ count: number }>`
        select count(*)::int as count from grants
        where merchant_id = ${merchantId} and network = ${network}
          and revoked_at is null and expires_at > ${now}`;
      if ((active?.count ?? 0) >= ACTIVE_GRANT_LIMIT) {
        throw new AppError(
          409,
          "GRANT_LIMIT",
          `This desk already has ${ACTIVE_GRANT_LIMIT} active grants on ${network}. Revoke one you no longer need first.`,
        );
      }
      const token = `gv_${randomToken(32)}`;
      const [row] = await db.query<GrantRow>(
        `insert into grants (id, merchant_id, scope, network, days, duration_sec, token_hash,
           expires_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning ${GRANT_COLUMNS}`,
        [
          newId("grn"),
          merchantId,
          scope,
          network,
          seconds % 86_400 === 0 ? seconds / 86_400 : null,
          seconds,
          sha256Hex(token),
          addSeconds(now, seconds),
          now,
        ],
      );
      if (!row) throw new Error("grant insert returned no row");
      return { ...grantDto(row), token, view_url: `${config.appOrigin}/view#${token}` };
    },

    async list(merchantId, network) {
      // Active grants first (at most ACTIVE_GRANT_LIMIT), so none drops off the list and cannot be
      // revoked; the newest ended ones fill the rest.
      const rows = await db.query<GrantRow>(
        `select ${GRANT_COLUMNS} from grants where merchant_id = $1 and network = $2
         order by (revoked_at is null and expires_at > $3) desc, created_at desc, id desc
         limit ${LIST_LIMIT}`,
        [merchantId, network, clock()],
      );
      return rows.map(grantDto);
    },

    async revoke(scope, grantId) {
      const params: unknown[] = [grantId, scope.merchantId, clock()];
      const network = scope.network === null ? "" : " and network = $4";
      if (scope.network !== null) params.push(scope.network);
      const [row] = await db.query<GrantRow>(
        `update grants set revoked_at = coalesce(revoked_at, $3)
         where id = $1 and merchant_id = $2${network}
         returning ${GRANT_COLUMNS}`,
        params,
      );
      if (!row) throw notFound("grant");
      return grantDto(row);
    },

    async view(token) {
      const grant = await byToken(token);
      if (!grant) throw notFound("grant");
      await touch(grant.id);
      const state = stateOf(grant, clock());
      if (state === "revoked") {
        return { state: "revoked", scope: grant.scope, message: COPY.grantNote };
      }
      if (state === "expired") {
        return {
          state: "expired",
          scope: grant.scope,
          expires_at: iso(grant.expires_at),
          message: EXPIRED_MESSAGE,
        };
      }
      return {
        state: "active",
        scope: grant.scope,
        network: grant.network,
        merchant_name: grant.display_name === "" ? null : grant.display_name,
        expires_at: iso(grant.expires_at),
        message: COPY.grantNote,
        receipts: await receipts(grant),
      };
    },

    async exportCsv(token) {
      const grant = await byToken(token);
      if (!grant) throw notFound("grant");
      const state = stateOf(grant, clock());
      if (state === "revoked") throw new AppError(410, "GRANT_REVOKED", COPY.grantNote);
      if (state === "expired") throw new AppError(410, "GRANT_EXPIRED", EXPIRED_MESSAGE);
      await touch(grant.id);
      return {
        grantId: grant.id,
        filename: `shade-receipts-${grant.id}.csv`,
        csv: receiptsCsv(await receipts(grant)),
      };
    },
  };
}
