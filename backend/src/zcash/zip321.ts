/** ZIP-321 payment URIs, single-recipient profile: `zcash:<UA>?amount=<ZEC>&memo=<base64url>`. */
import { decodeUnified } from "./address.ts";
import { MEMO_MAX_BYTES, checkMemoText } from "./memo.ts";
import { formatZat } from "./money.ts";

export class Zip321Error extends Error {
  override name = "Zip321Error";
}

function shieldedOnlyAddress(address: string): string {
  let decoded;
  try {
    decoded = decodeUnified(address);
  } catch {
    throw new Zip321Error("Payment address is not a valid Unified Address");
  }
  const transparent = decoded.items.some(
    (item) => item.typecode === 0x00 || item.typecode === 0x01,
  );
  // A memo sent to a transparent receiver invalidates the whole URI (ZIP-321).
  if (decoded.kind !== "address" || decoded.revision !== 0 || transparent) {
    throw new Zip321Error("Payment address must be a shielded-only Unified Address");
  }
  return address.toLowerCase();
}

/**
 * Builds the URI a payer's wallet scans. The memo is the exact on-chain memo (UTF-8, base64url
 * without padding); an empty memo omits the parameter, so the wallet writes ZIP-302 "no memo".
 * No `message` or `label`: wallets would show the memo twice and the QR code grows.
 */
export function buildPaymentUri(input: {
  address: string;
  amountZat: bigint;
  chainMemo: string;
}): string {
  const address = shieldedOnlyAddress(input.address);
  if (typeof input.amountZat !== "bigint" || input.amountZat <= 0n) {
    throw new Zip321Error("Payment amount must be positive");
  }
  let amount: string;
  try {
    amount = formatZat(input.amountZat);
  } catch {
    throw new Zip321Error("Payment amount is out of range");
  }
  const memo = checkMemoText(input.chainMemo, MEMO_MAX_BYTES);
  if (!memo.ok) throw new Zip321Error(memo.message);
  const uri = `zcash:${address}?amount=${amount}`;
  return input.chainMemo === ""
    ? uri
    : `${uri}&memo=${Buffer.from(input.chainMemo, "utf8").toString("base64url")}`;
}
