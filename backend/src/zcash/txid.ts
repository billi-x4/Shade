/**
 * Transaction ids. Shade uses lowercase display-order hex everywhere (what wallets and explorers
 * show); the wire protocol (lightwalletd TxFilter.hash, CompactTx.txid) uses the byte-reversed order.
 */
import { bytesToHex, hexToBytes } from "./bytes.ts";

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Trims and validates a pasted txid; returns lowercase display-order hex or null. */
export function parseTxid(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return TXID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Reverses the byte order of a hex string (lowercase output). Throws on malformed hex. */
export function reverseHex(hex: string): string {
  return bytesToHex(hexToBytes(hex).reverse());
}

/** Display-order txid → 32 protocol-order bytes. Throws RangeError on a malformed txid. */
export function txidToProtocolBytes(txid: string): Uint8Array {
  if (typeof txid !== "string" || !TXID_PATTERN.test(txid)) throw new RangeError("Invalid txid");
  return hexToBytes(txid).reverse();
}
