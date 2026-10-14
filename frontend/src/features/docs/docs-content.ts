import type { ErrorCode } from "@shade/contract";

/** HTTP status for every contract error code (contract/errors.ts). Exhaustive by type. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  FORBIDDEN_ORIGIN: 403,
  EMAIL_UNVERIFIED: 403,
  SESSION_NOT_FRESH: 403,
  NETWORK_DISABLED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  IDEMPOTENCY_MISMATCH: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  NO_ADDRESS: 409,
  BAD_ADDRESS: 400,
  BAD_AMOUNT: 400,
  BAD_MEMO: 400,
  BAD_TAG: 400,
  BAD_EXPIRY: 400,
  BAD_LABEL: 400,
  BAD_SCOPE: 400,
  BAD_DURATION: 400,
  BAD_TXID: 400,
  BAD_MEMO_HASH: 400,
  BAD_POOL: 400,
  BAD_URL: 400,
  BAD_VIEWING_KEY: 400,
  ADDRESS_MANAGED_BY_KEY: 409,
  VIEWING_KEY_ADDRESS_MISMATCH: 422,
  NOT_OPEN: 409,
  PAYMENT_PENDING: 409,
  ALREADY_PAID: 409,
  EXPIRED: 409,
  CANCELLED: 409,
  TXID_IN_USE: 409,
  TX_NOT_FOUND: 404,
  TX_NOT_MINED: 409,
  TX_NOT_SHIELDED: 422,
  AMOUNT_MISMATCH: 422,
  MEMO_MISMATCH: 422,
  OUTSIDE_WINDOW: 422,
  JAR_EMPTY: 402,
  JAR_CLOSED: 409,
  GRANT_REVOKED: 410,
  GRANT_EXPIRED: 410,
  TAG_TAKEN: 409,
  TAG_LIMIT: 409,
  INVOICE_LIMIT: 409,
  JAR_LIMIT: 409,
  GRANT_LIMIT: 409,
  ENDPOINT_LIMIT: 409,
  NO_ENDPOINTS: 409,
  CHAIN_UNAVAILABLE: 503,
  HOSTED_DETECTION_DISABLED: 409,
  INTERNAL: 500,
};

export interface Endpoint {
  method: "GET" | "POST" | "DELETE";
  path: string;
  auth: string;
  body: string;
  success: string;
  errors: string;
}

/** The public /v1 surface (PRD §9, agents.md §4.10). */
export const ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/v1/invoices",
    auth: "sk",
    body: "{ amount_zec, memo?, expires_in_sec? = 3600 (60 to 604800), tag? }",
    success: "201 Invoice",
    errors:
      "BAD_AMOUNT, BAD_MEMO, BAD_TAG, BAD_EXPIRY, NO_ADDRESS, INVOICE_LIMIT (10,000 unpaid), IDEMPOTENCY_*",
  },
  {
    method: "GET",
    path: "/v1/invoices",
    auth: "sk",
    body: "?status=open,paid_unverified,expired&expires_after=<ISO date-time>&cursor=&limit= (1 to 100)",
    success: "200 Page<Invoice>",
    errors: "INVALID_REQUEST (bad status, expires_after, cursor or limit)",
  },
  {
    method: "GET",
    path: "/v1/invoices/:id",
    auth: "sk",
    body: "None",
    success: "200 Invoice",
    errors: "NOT_FOUND",
  },
  {
    method: "POST",
    path: "/v1/invoices/:id/cancel",
    auth: "sk",
    body: "None",
    success: "200 Invoice",
    errors: "NOT_FOUND, NOT_OPEN, PAYMENT_PENDING, JAR_CLOSED",
  },
  {
    method: "POST",
    path: "/v1/invoices/:id/detections",
    auth: "sk",
    body: "{ txid, amount_zec, memo_hash, pool, source? = merchant_device }",
    success: "200 Invoice",
    errors:
      "BAD_TXID, BAD_AMOUNT, BAD_MEMO_HASH, BAD_POOL, NOT_FOUND, NOT_OPEN, AMOUNT_MISMATCH, MEMO_MISMATCH, TX_NOT_FOUND (not seen yet, so retry later), TX_NOT_SHIELDED, OUTSIDE_WINDOW, TXID_IN_USE, CHAIN_UNAVAILABLE",
  },
  {
    method: "POST",
    path: "/v1/jars",
    auth: "sk",
    body: "{ cap_zec, label }",
    success: "201 Jar",
    errors: "BAD_AMOUNT, BAD_LABEL, NO_ADDRESS, JAR_LIMIT (100 open)",
  },
  {
    method: "GET",
    path: "/v1/jars/:id",
    auth: "sk or that jar's ag",
    body: "None",
    success: "200 Jar (cap_zec, spent_zec, remaining_zec, charge_count)",
    errors: "NOT_FOUND, FORBIDDEN (another jar's ag)",
  },
  {
    method: "POST",
    path: "/v1/jars/:id/charge",
    auth: "sk or that jar's ag",
    body: "{ amount_zec, memo? }",
    success: "201 JarChargeResult",
    errors:
      "402 JAR_EMPTY, 409 JAR_CLOSED (both with remaining_zec), BAD_AMOUNT, BAD_MEMO, NOT_FOUND, FORBIDDEN, IDEMPOTENCY_*",
  },
  {
    method: "POST",
    path: "/v1/jars/:id/kill",
    auth: "sk",
    body: "None",
    success: "200 Jar",
    errors: "NOT_FOUND",
  },
  {
    method: "POST",
    path: "/v1/grants",
    auth: "sk",
    body: "{ scope, days? = 7 (1 to 90) | expires_in_sec? (600 to 7776000) }",
    success: "201 GrantCreated",
    errors: "BAD_SCOPE, BAD_DURATION, GRANT_LIMIT (100 active)",
  },
  {
    method: "POST",
    path: "/v1/grants/:id/revoke",
    auth: "sk",
    body: "None",
    success: "200 Grant",
    errors: "NOT_FOUND",
  },
  {
    method: "POST",
    path: "/v1/webhooks",
    auth: "sk",
    body: "{ url }",
    success: "201 WebhookEndpointCreated",
    errors: "BAD_URL, ENDPOINT_LIMIT (5 per network)",
  },
  {
    method: "GET",
    path: "/v1/webhooks",
    auth: "sk",
    body: "None",
    success: "200 WebhookEndpoint[] (no secrets)",
    errors: "None",
  },
  {
    method: "DELETE",
    path: "/v1/webhooks/:id",
    auth: "sk",
    body: "None",
    success: "204 (queued deliveries cancelled)",
    errors: "NOT_FOUND",
  },
  {
    method: "POST",
    path: "/v1/tags",
    auth: "sk",
    body: "{ name }",
    success: "201 Tag",
    errors: "BAD_TAG, TAG_TAKEN, TAG_LIMIT (5), NO_ADDRESS",
  },
  {
    method: "GET",
    path: "/v1/tags/:name",
    auth: "none",
    body: "None",
    success: "200 TagResolution",
    errors: "NOT_FOUND",
  },
];

export const SDK_EXAMPLE = (origin: string) => `import { Shade } from "shade-zcash-sdk";

const shade = new Shade({ apiKey: process.env.SHADE_API_KEY!, baseUrl: "${origin}" });
const inv = await shade.invoices.create({ amountZec: "0.01", memo: "demo" });
// send user to inv.payUrl`;

export const CURL_INVOICE = (base: string) => `curl ${base}/invoices \\
  -H "Authorization: Bearer $SHADE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042" \\
  -d '{"amount_zec":"0.01","memo":"order_1042","expires_in_sec":3600}'`;

export const INVOICE_RESPONSE = `{
  "id": "inv_…",
  "status": "open",
  "amount_zec": "0.01",
  "memo": "order_1042",
  "chain_memo": "order_1042 (shade:7K2Q9MXA)",
  "memo_hash": "sha256:…",
  "address": "utest1…",
  "zip321": "zcash:utest1…?amount=0.01&memo=…",
  "pay_url": "https://shade-zcash.vercel.app/pay/inv_…",
  "expires_at": "2026-10-10T13:00:00.000Z",
  …
}`;

export const JAR_EXAMPLE = `const jar = await shade.jars.create({ capZec: "0.006", label: "research-agent" });

// In the agent (its ag_… key): one idempotency key per paid call, so a retry never charges twice.
await agent.jars.charge(jar.id, { amountZec: "0.002", memo: "api:search" }, { idempotencyKey: callId });
// over the cap → 402 { "error": "JAR_EMPTY", "remaining_zec": "0" }

const { remainingZec } = await agent.jars.get(jar.id); // the budget left, without spending`;

export const GRANT_EXAMPLE = `const grant = await shade.grants.create({ scope: "payroll", days: 7 });
// grant.viewUrl is shown once: https://shade-zcash.vercel.app/view#gv_…`;

export const WEBHOOK_BODY = `{
  "id": "evt_…",
  "type": "invoice.paid",
  "created_at": "2026-10-10T12:00:03.000Z",
  "network": "testnet",
  "invoice_id": "inv_…",
  "amount_zec": "0.01",
  "memo_hash": "sha256:…",
  "txid": "…",
  "paid_at": "2026-10-10T12:00:00.000Z",
  "verification": "ivk_scan"
}`;

export const WEBHOOK_VERIFY_SDK = `import { verifyWebhook } from "shade-zcash-sdk";

// rawBody: the exact bytes Shade sent. Throws WebhookVerificationError when the signature is wrong or stale.
const event = await verifyWebhook(rawBody, request.headers, process.env.SHADE_WEBHOOK_SECRET);`;

export const WEBHOOK_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the exact bytes Shade sent (do not re-serialize the JSON).
// header: the X-Shade-Signature-V2 value, "t=<unix seconds>,v1=<hex>".
export function verifyShadeWebhook(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof header !== "string") return false;
  const parts = new Map(header.split(",").map((part) => part.trim().split("=", 2)));
  const t = parts.get("t") ?? "";
  if (!/^\\d+$/.test(t) || Math.abs(nowSec - Number(t)) > 300) return false;
  // Signed over the header's t exactly as sent.
  const expected = createHmac("sha256", secret).update(\`\${t}.\`).update(rawBody).digest();
  const given = Buffer.from(parts.get("v1") ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// verifyShadeWebhook(raw, req.headers["x-shade-signature-v2"], process.env.SHADE_WEBHOOK_SECRET)
// Then dedupe by body.id and treat invoice.paid idempotently per invoice_id.`;

export const WEBHOOK_VERIFY_PYTHON = `import hashlib, hmac, re, time

def verify_shade_webhook(raw_body: bytes, header: str | None, secret: str, now: int | None = None) -> bool:
    """raw_body: the exact request bytes. header: the X-Shade-Signature-V2 value."""
    if not header:
        return False
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    t = parts.get("t", "")
    if not re.fullmatch(r"\\d+", t) or abs((now or int(time.time())) - int(t)) > 300:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", "").lower())`;

export const WEBHOOK_VERIFY_GO = `import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// rawBody: the exact request bytes. header: the X-Shade-Signature-V2 value.
func VerifyShadeWebhook(rawBody []byte, header, secret string) bool {
	var t, v1 string
	for _, part := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch k {
		case "t":
			t = v
		case "v1":
			v1 = v
		}
	}
	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil || ts < 0 || time.Since(time.Unix(ts, 0)).Abs() > 300*time.Second {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "."))
	mac.Write(rawBody)
	given, err := hex.DecodeString(v1)
	return err == nil && hmac.Equal(given, mac.Sum(nil))
}`;

export const ERROR_BODY = `{
  "error": "JAR_EMPTY",
  "message": "Jar empty. The agent cannot spend.",
  "request_id": "req_…",
  "remaining_zec": "0"
}`;
