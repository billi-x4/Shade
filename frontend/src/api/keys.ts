/**
 * Query keys. Everything under ["desk"] belongs to the signed-in merchant and is cleared on sign-out;
 * public keys never include tokens (the grant token lives only in component memory).
 */
export const qk = {
  config: ["config"] as const,
  session: ["session"] as const,
  desk: ["desk"] as const,
  me: ["desk", "me"] as const,
  invoices: ["desk", "invoices"] as const,
  invoiceList: (status: string) => ["desk", "invoices", { status }] as const,
  jars: ["desk", "jars"] as const,
  jarCharges: (jarId: string) => ["desk", "jar-charges", jarId] as const,
  grants: ["desk", "grants"] as const,
  webhooks: ["desk", "webhooks"] as const,
  deliveries: ["desk", "deliveries"] as const,
  tags: ["desk", "tags"] as const,
  apiKeys: ["desk", "api-keys"] as const,
  viewingKeys: ["desk", "viewing-keys"] as const,
  publicInvoice: (id: string) => ["public", "invoice", id] as const,
  grantView: ["public", "grant-view"] as const,
};
