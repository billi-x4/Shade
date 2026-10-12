import type { GrantView, PublicInvoice } from "@shade/contract";
import { api, path, request } from "@/api/client";

/* Public API (/api/public): pay page and grant view. No session. */

export const getPublicInvoice = (id: string, signal?: AbortSignal) =>
  api.get<PublicInvoice>(path`/api/public/invoices/${id}`, signal);

export const submitPayerTxid = (id: string, txid: string) =>
  api.post<PublicInvoice>(path`/api/public/invoices/${id}/txid`, { txid });

/** The grant token travels in the request body only — never in a path or query string. */
export const viewGrant = (token: string) =>
  api.post<GrantView>("/api/public/grants/view", { token });

export async function exportGrant(
  token: string,
): Promise<{ blob: Blob; disposition: string | null }> {
  const response = await request("/api/public/grants/export", { method: "POST", body: { token } });
  return { blob: await response.blob(), disposition: response.headers.get("content-disposition") };
}
