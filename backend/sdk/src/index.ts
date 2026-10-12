/**
 * @shade/sdk: TypeScript client for the Shade API (private Zcash invoices, agent jars, viewing grants,
 * webhooks, tags). Zero runtime dependencies; runs on Node ≥ 20, browsers and edge runtimes.
 *
 *   const shade = new Shade({ apiKey: process.env.SHADE_API_KEY! });
 *   const inv = await shade.invoices.create({ amountZec: "0.01", memo: "demo" });
 *   // send the payer to inv.payUrl
 */
export { DEFAULT_BASE_URL, Grants, Invoices, Jars, Shade, Tags, Webhooks } from "./client.ts";
export type { ShadeOptions } from "./client.ts";
export { ShadeConnectionError, ShadeError } from "./errors.ts";
export type { ShadeApiErrorCode, ShadeClientErrorCode, ShadeErrorCode } from "./errors.ts";
export type { FetchLike, IdempotentRequestOptions, RequestOptions } from "./http.ts";
export { signWebhook, verifyWebhook, WebhookVerificationError } from "./webhooks.ts";
export type {
  VerifyWebhookOptions,
  WebhookHeaders,
  WebhookSignatureHeaders,
  WebhookVerificationReason,
} from "./webhooks.ts";
export { VERSION } from "./version.ts";
export type * from "./types.ts";
