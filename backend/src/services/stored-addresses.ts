/**
 * One-off repair of receive addresses stored before v1 validated them. v0 accepted any u/utest
 * string, so merchants.ua_* and jars.address can still hold a Unified Address with a transparent
 * receiver (or none with Orchard). SQL cannot re-encode a Unified Address (F4Jumble), so this runs
 * in JS after the SQL migrations: `db:migrate`, and a PGlite server before it listens.
 *
 * Each address becomes what saving it today would store. A merchant address that cannot be paid
 * privately is cleared, so the desk asks for it again; a jar keeps it (charges never pay it). Every
 * write is a compare-and-set on the old value, so a concurrent save wins and reruns are no-ops.
 * The readers normalize too (merchants.ts shieldedAddressOrNull): this only makes the stored rows
 * match what the API already serves.
 */
import type { Network } from "../contract/index.ts";
import type { Sql } from "../platform/db.ts";
import type { Logger } from "../platform/logger.ts";
import { addressColumn, shieldedAddressOrNull } from "./merchants.ts";

const BATCH = 500;
const NETWORKS: readonly Network[] = ["testnet", "mainnet"];

export interface StoredAddressRepair {
  /** Merchant addresses rewritten to their shielded-only form. */
  merchantsRewritten: number;
  /** Merchant addresses cleared because they cannot be paid privately. */
  merchantsCleared: number;
  /** Jar addresses rewritten to their shielded-only form. */
  jarsRewritten: number;
}

export async function repairStoredAddresses(
  sql: Sql,
  logger?: Logger,
): Promise<StoredAddressRepair> {
  const result: StoredAddressRepair = {
    merchantsRewritten: 0,
    merchantsCleared: 0,
    jarsRewritten: 0,
  };

  let after = "";
  for (;;) {
    const merchants = await sql<{
      id: string;
      ua_testnet: string | null;
      ua_mainnet: string | null;
    }>`
      select id, ua_testnet, ua_mainnet from merchants
      where id > ${after} and (ua_testnet is not null or ua_mainnet is not null)
      order by id limit ${BATCH}`;
    for (const row of merchants) {
      for (const network of NETWORKS) {
        const column = addressColumn(network);
        const stored = row[column];
        if (stored === null) continue;
        const next = shieldedAddressOrNull(stored, network);
        if (next === stored) continue;
        const updated = await sql.query(
          `update merchants set ${column} = $1 where id = $2 and ${column} = $3 returning id`,
          [next, row.id, stored],
        );
        if (updated.length === 0) continue;
        if (next === null) result.merchantsCleared += 1;
        else result.merchantsRewritten += 1;
      }
    }
    const last = merchants.at(-1);
    if (!last || merchants.length < BATCH) break;
    after = last.id;
  }

  after = "";
  for (;;) {
    const jars = await sql<{ id: string; network: Network; address: string }>`
      select id, network, address from jars where id > ${after} order by id limit ${BATCH}`;
    for (const row of jars) {
      const next = shieldedAddressOrNull(row.address, row.network);
      if (next === null || next === row.address) continue;
      const updated = await sql`
        update jars set address = ${next} where id = ${row.id} and address = ${row.address}
        returning id`;
      result.jarsRewritten += updated.length;
    }
    const last = jars.at(-1);
    if (!last || jars.length < BATCH) break;
    after = last.id;
  }

  if (result.merchantsRewritten + result.merchantsCleared + result.jarsRewritten > 0) {
    logger?.info(
      {
        merchants_rewritten: result.merchantsRewritten,
        merchants_cleared: result.merchantsCleared,
        jars_rewritten: result.jarsRewritten,
      },
      "stored receive addresses repaired",
    );
  }
  return result;
}
