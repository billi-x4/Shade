/**
 * Reading Shade's own ZIP-321 payment URIs on the pay page. The server emits exactly
 * `zcash:<address>?amount=<zec>&memo=<base64url UTF-8, no padding>` (agents.md §3).
 */

/**
 * The memo text inside a payment URI: what the payer's wallet must write on chain. Null when the
 * URI carries no memo or it is not base64url-encoded UTF-8.
 */
export function paymentMemo(uri: string): string | null {
  const query = uri.indexOf("?");
  if (query < 0) return null;
  const raw = new URLSearchParams(uri.slice(query + 1)).get("memo");
  if (raw === null || raw === "" || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
