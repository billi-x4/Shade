/**
 * Jars: a spending allowance Shade records for an agent (no ZEC moves). A charge is one atomic
 * statement that debits the jar and inserts an `authorized` child invoice, so concurrent charges
 * can never overflow the cap.
 */
import type { Invoice, Jar, JarCharge, JarChargeResult, Network, Page } from "../contract/index.ts";
import { COPY } from "../contract/index.ts";
import type { Config } from "../platform/config.ts";
import { newId } from "../platform/crypto.ts";
import type { Db, Sql } from "../platform/db.ts";
import { AppError } from "../platform/errors.ts";
import { MEMO_MAX_BYTES, checkMemoText, memoHash } from "../zcash/memo.ts";
import { formatZat, parseZec, zatFromNumeric } from "../zcash/money.ts";
import { buildPaymentUri } from "../zcash/zip321.ts";
import {
  LABEL_MAX_CHARS,
  type PageRequest,
  assertNetworkEnabled,
  hasControlChars,
  iso,
  isoOrNull,
  notFound,
  toPage,
  zatParam,
  zecText,
} from "./common.ts";
import { type InvoiceView, type Scope, badAmount } from "./invoices.ts";
import { requireMerchant, requireReceiveAddress, shieldedAddressOrNull } from "./merchants.ts";

interface JarRow {
  id: string;
  merchant_id: string;
  label: string;
  cap_zec: string;
  spent_zec: string;
  status: "open" | "killed";
  address: string;
  network: Network;
  created_at: Date;
  killed_at: Date | null;
  charge_count: number;
}

/** Soft cap on open jars per merchant and network, and the most jars a desk list returns. */
const OPEN_JAR_LIMIT = 100;
const LIST_LIMIT = 200;
/** charge_count is kept by triggers on invoices: live ('authorized') charges (migration 0013). */
const JAR_SELECT = `select j.id, j.merchant_id, j.label, j.cap_zec, j.spent_zec, j.status, j.address,
  j.network, j.created_at, j.killed_at, j.charge_count
  from jars j`;

interface ChargeRow {
  id: string;
  jar_id: string;
  amount_zec: string;
  memo: string;
  memo_hash: string;
  status: "authorized" | "cancelled";
  created_at: Date;
}

export interface JarInput {
  cap_zec: string;
  label: string;
}

export interface ChargeInput {
  amount_zec: string;
  memo?: string;
}

/** A validated charge for one jar within the caller's merchant and network. */
export interface ChargePlan {
  merchantId: string;
  network: Network;
  jarId: string;
  amountZat: bigint;
  memo: string;
}

export interface JarService {
  create(merchantId: string, network: Network, input: JarInput): Promise<Jar>;
  /** Prepared create for the idempotency transaction. */
  prepareCreate(merchantId: string, network: Network, input: JarInput): Promise<JarPlan>;
  insert(sql: Sql, plan: JarPlan): Promise<Jar>;
  list(merchantId: string, network: Network): Promise<Jar[]>;
  /** One jar within scope (an agent reads its own budget), or 404. */
  get(scope: Scope, jarId: string): Promise<Jar>;
  kill(scope: Scope, jarId: string): Promise<Jar>;
  prepareCharge(
    merchantId: string,
    network: Network,
    jarId: string,
    input: ChargeInput,
  ): ChargePlan;
  /** The atomic debit; 402 JAR_EMPTY over the cap, 409 JAR_CLOSED once killed (both with remaining_zec). */
  charge(sql: Sql, plan: ChargePlan): Promise<JarChargeResult>;
  charges(merchantId: string, jarId: string, page: PageRequest): Promise<Page<JarCharge>>;
  /** Cancels an authorized charge and refunds the cap; only while the jar is open. */
  cancelCharge(
    scope: Scope,
    jarId: string,
    chargeId: string,
  ): Promise<{ jar: Jar; invoice: Invoice }>;
}

export interface JarPlan {
  merchantId: string;
  network: Network;
  capZat: bigint;
  label: string;
  address: string;
}

function remainingOf(capZec: string, spentZec: string): string {
  return formatZat(zatFromNumeric(capZec) - zatFromNumeric(spentZec));
}

function jarDto(row: JarRow): Jar {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    network: row.network,
    cap_zec: zecText(row.cap_zec),
    spent_zec: zecText(row.spent_zec),
    remaining_zec: remainingOf(row.cap_zec, row.spent_zec),
    address: shieldedAddressOrNull(row.address, row.network) ?? row.address,
    charge_count: row.charge_count,
    created_at: iso(row.created_at),
    killed_at: isoOrNull(row.killed_at),
    note: COPY.killNote,
  };
}

function chargeDto(row: ChargeRow): JarCharge {
  return {
    id: row.id,
    jar_id: row.jar_id,
    amount_zec: zecText(row.amount_zec),
    memo: row.memo,
    memo_hash: row.memo_hash,
    status: row.status,
    created_at: iso(row.created_at),
  };
}

function jarClosed(remainingZec: string): AppError {
  return new AppError(409, "JAR_CLOSED", COPY.jarClosed, { remaining_zec: remainingZec });
}

export function createJarService(deps: {
  db: Db;
  config: Config;
  clock: () => Date;
  view: InvoiceView;
}): JarService {
  const { db, config, clock, view } = deps;

  const loadJar = async (sql: Sql, scope: Scope, jarId: string, lock = false) => {
    const params: unknown[] = [jarId, scope.merchantId];
    let where = "j.id = $1 and j.merchant_id = $2";
    if (scope.network !== null) {
      params.push(scope.network);
      where += " and j.network = $3";
    }
    const [row] = await sql.query<JarRow>(
      `${JAR_SELECT} where ${where}${lock ? " for update of j" : ""}`,
      params,
    );
    return row ?? null;
  };

  const prepareCreate: JarService["prepareCreate"] = async (merchantId, network, input) => {
    assertNetworkEnabled(config, network);
    const capZat = parseZec(input.cap_zec);
    if (capZat === null) throw badAmount("Cap");
    const label = input.label.trim();
    if (label.length === 0 || label.length > LABEL_MAX_CHARS || hasControlChars(label)) {
      throw new AppError(
        400,
        "BAD_LABEL",
        `Give the jar a short single-line name of at most ${LABEL_MAX_CHARS} characters.`,
      );
    }
    const merchant = await requireMerchant(db, merchantId);
    return {
      merchantId,
      network,
      capZat,
      label,
      address: requireReceiveAddress(merchant, network),
    };
  };

  const insert: JarService["insert"] = async (sql, plan) => {
    const [open] = await sql<{ count: number }>`
      select count(*)::int as count from jars
      where merchant_id = ${plan.merchantId} and network = ${plan.network} and status = 'open'`;
    if ((open?.count ?? 0) >= OPEN_JAR_LIMIT) {
      throw new AppError(
        409,
        "JAR_LIMIT",
        `This desk already has ${OPEN_JAR_LIMIT} open jars on ${plan.network}. Kill one you no longer use first.`,
      );
    }
    const id = newId("jar");
    await sql`
      insert into jars (id, merchant_id, label, cap_zec, spent_zec, status, address, network, created_at)
      values (${id}, ${plan.merchantId}, ${plan.label}, ${zatParam(plan.capZat)}, 0, 'open',
              ${plan.address}, ${plan.network}, ${clock()})`;
    const row = await loadJar(sql, { merchantId: plan.merchantId, network: plan.network }, id);
    if (!row) throw new Error("jar insert returned no row");
    return jarDto(row);
  };

  return {
    prepareCreate,
    insert,

    async create(merchantId, network, input) {
      const plan = await prepareCreate(merchantId, network, input);
      return db.tx((sql) => insert(sql, plan));
    },

    async list(merchantId, network) {
      const rows = await db.query<JarRow>(
        // Open jars first (at most OPEN_JAR_LIMIT), so none drops off the list and cannot be killed.
        `${JAR_SELECT} where j.merchant_id = $1 and j.network = $2
         order by (j.status = 'open') desc, j.created_at desc, j.id desc limit ${LIST_LIMIT}`,
        [merchantId, network],
      );
      return rows.map(jarDto);
    },

    async get(scope, jarId) {
      const jar = await loadJar(db, scope, jarId);
      if (!jar) throw notFound("jar");
      return jarDto(jar);
    },

    async kill(scope, jarId) {
      return db.tx(async (sql) => {
        const jar = await loadJar(sql, scope, jarId, true);
        if (!jar) throw notFound("jar");
        if (jar.status === "open") {
          await sql`update jars set status = 'killed', killed_at = ${clock()} where id = ${jar.id}`;
        }
        const killed = await loadJar(sql, scope, jarId);
        if (!killed) throw notFound("jar");
        return jarDto(killed);
      });
    },

    prepareCharge(merchantId, network, jarId, input) {
      const amountZat = parseZec(input.amount_zec);
      if (amountZat === null) throw badAmount();
      const memo = input.memo ?? "";
      const memoCheck = checkMemoText(memo, MEMO_MAX_BYTES);
      if (!memoCheck.ok) throw new AppError(400, "BAD_MEMO", memoCheck.message);
      return { merchantId, network, jarId, amountZat, memo };
    },

    async charge(sql, plan) {
      const [jar] = await sql<{ address: string }>`
        select address from jars
        where id = ${plan.jarId} and merchant_id = ${plan.merchantId} and network = ${plan.network}`;
      if (!jar) throw notFound("jar");
      const now = clock();
      const id = newId("inv");
      const amount = zatParam(plan.amountZat);
      const hash = memoHash(plan.memo);
      // Stored for completeness; jar charges are never payable, so DTOs return null for both. A
      // jar created before v1 may hold an address ZIP-321 refuses (a transparent receiver): the
      // charge stores its shielded-only form, or an empty URI when it has none, and never fails
      // on it, so the ledger still answers 201, 402 JAR_EMPTY or 409 JAR_CLOSED.
      const address = shieldedAddressOrNull(jar.address, plan.network);
      const zip321 =
        address === null
          ? ""
          : buildPaymentUri({ address, amountZat: plan.amountZat, chainMemo: plan.memo });
      const [charged] = await sql<{ cap_zec: string; spent_zec: string; created_at: Date }>`
        with debit as (
          update jars set spent_zec = spent_zec + ${amount}::numeric
          where id = ${plan.jarId} and status = 'open'
            and spent_zec + ${amount}::numeric <= cap_zec
          returning id, merchant_id, network, cap_zec, spent_zec
        ), charge as (
          insert into invoices (id, merchant_id, jar_id, amount_zec, memo, memo_hash, chain_memo,
            memo_ref, tag, network, address, zip321, status, verification, expires_at, created_at)
          select ${id}::text, d.merchant_id, d.id, ${amount}::numeric, ${plan.memo}::text,
                 ${hash}::text, ${plan.memo}::text, null, null, d.network,
                 ${address ?? jar.address}::text,
                 ${zip321}::text, 'authorized', 'jar_ledger', ${now}::timestamptz,
                 ${now}::timestamptz
          from debit d
          returning created_at
        )
        select d.cap_zec, d.spent_zec, c.created_at from debit d cross join charge c`;
      if (!charged) {
        const [state] = await sql<{ status: string; cap_zec: string; spent_zec: string }>`
          select status, cap_zec, spent_zec from jars where id = ${plan.jarId}`;
        if (!state) throw notFound("jar");
        const remaining = remainingOf(state.cap_zec, state.spent_zec);
        // Losing a race with kill reads the killed row here, so it is JAR_CLOSED, never 402.
        if (state.status !== "open") throw jarClosed(remaining);
        throw new AppError(402, "JAR_EMPTY", COPY.jarEmpty, { remaining_zec: remaining });
      }
      return {
        invoice_id: id,
        jar_id: plan.jarId,
        amount_zec: formatZat(plan.amountZat),
        memo_hash: hash,
        remaining_zec: remainingOf(charged.cap_zec, charged.spent_zec),
        status: "authorized",
        created_at: iso(charged.created_at),
      };
    },

    async charges(merchantId, jarId, page) {
      const jar = await loadJar(db, { merchantId, network: null }, jarId);
      if (!jar) throw notFound("jar");
      const params: unknown[] = [jarId, page.limit + 1];
      let cursor = "";
      if (page.cursor) {
        params.push(page.cursor.createdAt, page.cursor.id);
        cursor = "and (created_at, id) < ($3::timestamptz, $4)";
      }
      const rows = await db.query<ChargeRow>(
        `select id, jar_id, amount_zec, memo, memo_hash, status, created_at from invoices
         where jar_id = $1 ${cursor}
         order by created_at desc, id desc limit $2`,
        params,
      );
      return toPage(rows, page.limit, chargeDto);
    },

    async cancelCharge(scope, jarId, chargeId) {
      return db.tx(async (sql) => {
        // Lock order: jar row, then the invoice row.
        const jar = await loadJar(sql, scope, jarId, true);
        if (!jar) throw notFound("jar");
        const [charge] = await sql<{ id: string; status: string; amount_zec: string }>`
          select id, status, amount_zec from invoices
          where id = ${chargeId} and jar_id = ${jar.id}
          for update`;
        if (!charge) throw notFound("charge");
        if (jar.status !== "open") throw jarClosed(remainingOf(jar.cap_zec, jar.spent_zec));
        if (charge.status !== "authorized") {
          throw new AppError(409, "NOT_OPEN", "This charge is already cancelled.");
        }
        await sql`update invoices set status = 'cancelled' where id = ${charge.id}`;
        await sql`
          update jars set spent_zec = spent_zec - ${charge.amount_zec}::numeric where id = ${jar.id}`;
        const refunded = await loadJar(sql, scope, jar.id);
        const invoice = await view.load(sql, charge.id);
        if (!refunded || !invoice) throw notFound("jar");
        return { jar: jarDto(refunded), invoice };
      });
    },
  };
}
