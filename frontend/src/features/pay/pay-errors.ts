import { ApiError, errorMessage } from "@/api/client";
import { formatWait } from "@/lib/format";

/** Shown when the pasted text is not 64 hex characters (checked before anything is sent). */
export const TXID_FORMAT_MESSAGE =
  "A transaction id is 64 characters, 0–9 and a–f. Copy it again from your wallet.";

/** Payer-facing copy for the "already paid" txid check. Plain words; no protocol jargon. */
export function txidErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return errorMessage(error);
  const wait = error.retryAfter ? formatWait(error.retryAfter) : "a minute";
  switch (error.code) {
    case "BAD_TXID":
      // The page only sends well-formed ids (normalizeTxid), so the server's reason is the useful
      // one, e.g. the byte-reversed hint for an id copied from an explorer in protocol order.
      return error.message || TXID_FORMAT_MESSAGE;
    case "TX_NOT_FOUND":
      return "We cannot find that transaction yet. If you just sent it, wait a minute and try again.";
    case "TX_NOT_SHIELDED":
      return "That transaction is not a shielded payment. Pay from the shielded part of your wallet, then paste the new id.";
    case "OUTSIDE_WINDOW":
      return "That transaction is older than this invoice. Paste the id of the payment you made for it.";
    case "CHAIN_UNAVAILABLE":
      return `We cannot reach the Zcash network right now. Try again in ${wait}.`;
    case "RATE_LIMITED":
      return `Too many tries. Wait ${wait} and try again.`;
    case "NOT_FOUND":
      return "This invoice no longer exists.";
    case "NOT_OPEN":
    case "EXPIRED":
    case "CANCELLED":
    case "ALREADY_PAID":
      return "This invoice is no longer open, so it cannot take a transaction id.";
    default:
      return errorMessage(error);
  }
}
