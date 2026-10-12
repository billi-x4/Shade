/** Loaders for the committed Zcash fixtures (official zcash-test-vectors + recorded chain data). */
import { existsSync, readFileSync } from "node:fs";

const FIXTURES = new URL("../fixtures/zcash/", import.meta.url);

export type VectorRow = Record<string, string | number | null>;

/** Rows of a zcash-test-vectors JSON file (row 0 is the source, row 1 the column names). */
export function loadVectors(file: string): VectorRow[] {
  const rows = JSON.parse(
    readFileSync(new URL(`vectors/${file}`, FIXTURES), "utf8"),
  ) as unknown[][];
  const columns = String(rows[1]![0]).split(", ");
  return rows
    .slice(2)
    .map((row) =>
      Object.fromEntries(columns.map((column, i) => [column, row[i] as VectorRow[string]])),
    );
}

export function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

export function fixtureExists(name: string): boolean {
  return existsSync(new URL(name, FIXTURES));
}

export function hex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

export interface RecordedTransaction {
  network: "testnet" | "mainnet";
  txid: string;
  height: number;
  description: string;
  version: number;
  compact: {
    index: number;
    vin: number;
    vout: number;
    saplingSpends: number;
    saplingOutputs: number;
    orchardActions: number;
    ironwoodActions: number;
  };
  hex: string;
}

export function recordedTransactions(): RecordedTransaction[] {
  return readFixture<{ transactions: RecordedTransaction[] }>("transactions.json").transactions;
}

export function recordedTransaction(txid: string): RecordedTransaction {
  const tx = recordedTransactions().find((t) => t.txid === txid);
  if (!tx) throw new Error(`No recorded transaction ${txid}`);
  return tx;
}
