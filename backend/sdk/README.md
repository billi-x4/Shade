# @shade/sdk

TypeScript client for the [Shade](https://shade-zcash.vercel.app) API: private Zcash invoices, agent jars, viewing grants,
webhooks and tags. Zero runtime dependencies. Runs on Node 20+, modern browsers and edge runtimes (it uses `fetch`
and WebCrypto).

The wire API is snake_case (`pay_url`); everything the SDK returns is camelCase (`payUrl`). Amounts are decimal ZEC
strings such as `"0.01"`, never floats.

## Install

Inside this repository the package is an npm workspace. Build it once:

```bash
npm run build -w @shade/sdk     # emits backend/sdk/dist (ESM + .d.ts)
```

Other workspaces can then depend on `"@shade/sdk": "*"`. Outside the repo, `npm pack -w @shade/sdk` produces a
tarball you can `npm install`.

## Quick start

```ts
import { Shade } from "@shade/sdk";

const shade = new Shade({
  apiKey: process.env.SHADE_API_KEY!, // sk_test_… or sk_live_…
  baseUrl: "http://localhost:5173", // your Shade's origin; the dev web app proxies /v1
});
const inv = await shade.invoices.create({ amountZec: "0.01", memo: "demo" });
// send the payer to inv.payUrl (or hand their wallet inv.zip321)
```

Shade is self-hosted: set `baseUrl` to the origin your Shade API answers on. The default,
`https://shade-zcash.vercel.app`, is only for the hosted service; a `NETWORK_ERROR` on every call usually means `baseUrl`
is wrong. A `sk_test_` key works on testnet and a `sk_live_` key on mainnet. Resources on the other network are
invisible (404).

Never ship an `sk_…` or `ag_…` key to a browser: `/v1` allows any origin (CORS `*`), so anyone who reads the page
can use the key. Call Shade from your server or your agent's runtime.

### Options

| Option       | Default                          | Notes                                                                       |
| ------------ | -------------------------------- | --------------------------------------------------------------------------- |
| `apiKey`     | required                         | Merchant key (`sk_test_…`, `sk_live_…`) or agent key (`ag_…`, charges only) |
| `baseUrl`    | `https://shade-zcash.vercel.app` | Your API origin without `/v1`. Local dev: `http://localhost:5173`           |
| `timeoutMs`  | `10000`                          | Per attempt, covering the request and the response body                     |
| `maxRetries` | `1`                              | Extra attempts for retryable calls (see Idempotency and retries)            |
| `fetch`      | `globalThis.fetch`               | Any fetch-compatible function                                               |

## Methods

| Call                                                                          | HTTP                               | Returns                  |
| ----------------------------------------------------------------------------- | ---------------------------------- | ------------------------ |
| `invoices.create({ amountZec, memo?, expiresInSec?, tag? })`                  | `POST /v1/invoices`                | `PayableInvoice`         |
| `invoices.get(id)`                                                            | `GET /v1/invoices/:id`             | `Invoice`                |
| `invoices.list({ status?, expiresAfter?, cursor?, limit? })`                  | `GET /v1/invoices`                 | `Page<PayableInvoice>`   |
| `invoices.cancel(id)`                                                         | `POST /v1/invoices/:id/cancel`     | `Invoice`                |
| `invoices.reportDetection(id, { txid, amountZec, memoHash, pool, source? })`  | `POST /v1/invoices/:id/detections` | `Invoice`                |
| `jars.create({ capZec, label })`                                              | `POST /v1/jars`                    | `Jar`                    |
| `jars.get(jarId)`                                                             | `GET /v1/jars/:id`                 | `Jar`                    |
| `jars.charge(jarId, { amountZec, memo? })`                                    | `POST /v1/jars/:id/charge`         | `JarChargeResult`        |
| `jars.kill(jarId)`                                                            | `POST /v1/jars/:id/kill`           | `Jar`                    |
| `grants.create({ scope, days? })` or `grants.create({ scope, expiresInSec })` | `POST /v1/grants`                  | `GrantCreated`           |
| `grants.revoke(id)`                                                           | `POST /v1/grants/:id/revoke`       | `Grant`                  |
| `webhooks.create({ url })`                                                    | `POST /v1/webhooks`                | `WebhookEndpointCreated` |
| `webhooks.list()`                                                             | `GET /v1/webhooks`                 | `WebhookEndpoint[]`      |
| `webhooks.delete(id)`                                                         | `DELETE /v1/webhooks/:id`          | `void`                   |
| `tags.create({ name })`                                                       | `POST /v1/tags`                    | `Tag`                    |
| `tags.resolve(name)`                                                          | `GET /v1/tags/:name` (public)      | `TagResolution`          |

Notes:

- Every method takes a last, optional options argument: `{ signal }` to abort the call (`ShadeConnectionError` code
  `ABORTED`), plus `{ idempotencyKey }` on `invoices.create`, `jars.create` and `jars.charge` (see below).
- `invoices.list` pages newest first: pass `page.nextCursor` back as `cursor` until it is `null`. `status` takes one
  status or an array (`["open", "paid_unverified"]`); `expiresAfter` (a `Date` or ISO string) keeps only invoices
  expiring later.
- `jars.get` works with the jar's own agent key too, so an agent can read `remainingZec` before it spends.
- `webhooks.list` and `webhooks.delete` let a setup script replace an endpoint instead of adding one per deploy (at
  most 5 per network; the secret is never listed).
- A jar is a spending limit that Shade records. No ZEC moves when you create or charge it. `jars.kill` stops new
  charges; move leftover ZEC in your own wallet.
- `grants.create` returns `token` and `viewUrl` once. Revoking stops new access from Shade; a file the viewer already
  exported stays on their machine.
- `webhooks.create` returns the `whsec_…` signing `secret` once. Store it; you need it to verify deliveries.
- `tags.resolve` sends no API key and accepts `"asharib"` or `"asharib.shade"`.
- `invoices.reportDetection` is for your own viewing-key scanner. Shade looks the transaction up on chain itself; the
  amount and memo hash must equal the invoice's.

## Errors

Every non-2xx response throws a `ShadeError`:

```ts
import { ShadeError } from "@shade/sdk";

try {
  const charge = await shade.jars.charge(jarId, { amountZec: "0.002", memo: "api:search" });
  console.log(`authorized ${charge.amountZec} · left ${charge.remainingZec}`);
} catch (err) {
  if (err instanceof ShadeError && err.code === "JAR_EMPTY") {
    // 402: the cap is reached. err.message is "Jar empty. The agent cannot spend."
    console.log(`left ${err.remainingZec}`);
  } else {
    throw err;
  }
}
```

| Field          | Meaning                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `status`       | HTTP status, or `0` when no response arrived                                     |
| `code`         | Stable machine code such as `JAR_EMPTY`, `JAR_CLOSED`, `NOT_FOUND`, `BAD_AMOUNT` |
| `message`      | Human-readable text from the server                                              |
| `requestId`    | Quote it when you report a problem                                               |
| `remainingZec` | On `JAR_EMPTY` (402) and `JAR_CLOSED` (409)                                      |
| `retryAfter`   | Seconds, on `RATE_LIMITED` (429) and `CHAIN_UNAVAILABLE` (503)                   |
| `issues`       | On `INVALID_REQUEST` (400): `{ path, message }[]`, never your input values       |

`ShadeConnectionError` (a subclass, `status` 0) means no HTTP response arrived: `code` is `TIMEOUT`,
`NETWORK_ERROR` or `ABORTED` (your `signal`), and `cause` holds the underlying error. `UNEXPECTED_RESPONSE` means the reply was not a Shade JSON
body, for example a proxy error page.

## Idempotency and retries

`invoices.create`, `jars.create` and `jars.charge` send an `Idempotency-Key` (a random UUID) that is fresh for each
call and identical on that call's retries. If the first attempt reached the server but its response was lost, the
retry replays the stored result, so an agent never spends the cap twice for one call.

A random key only covers retries inside one call. If your process can crash or restart between a charge and
recording it, pass your own key derived from the work being paid for, and reuse it when you retry that work:

```ts
await shade.jars.charge(
  jarId,
  { amountZec: "0.002", memo: "api:search" },
  { idempotencyKey: `search-${requestId}` },
);
```

Shade keeps a key for 24 hours per API key. The same key with a different body is refused with 422
`IDEMPOTENCY_MISMATCH`.

| Calls                                                                      | Retried on network error, timeout, 5xx    |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| `invoices.create`, `jars.create`, `jars.charge`                            | yes, with the same key and the same bytes |
| `invoices.get`, `invoices.list`, `tags.resolve` (reads)                    | yes                                       |
| everything else (cancel, kill, revoke, grants, webhooks, tags, detections) | never                                     |

A 4xx is never retried. Retries use exponential backoff with jitter (from 150–300 ms) and honour a `Retry-After` of
up to 5 s. A longer `Retry-After` is not waited out: the error is thrown with `retryAfter` set. Set
`maxRetries: 0` to turn retries off.

## Verifying webhooks

Shade POSTs JSON events to your endpoint and signs each attempt:

- `X-Shade-Signature-V2: t=<unix seconds of this attempt>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`
- `X-Shade-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`

The HMAC key is the UTF-8 bytes of the whole `whsec_…` string. `verifyWebhook` requires V2 and checks its signature,
then `|now − t| ≤ 300 s`. Shade sends V2 on every attempt; the body-only signature never expires, so a delivery
without V2 is refused (`missing_signature`) unless you pass `{ allowLegacySignature: true }`, e.g. behind a proxy
that drops the header. It compares in constant time and returns the camelCase event, or throws
`WebhookVerificationError` with a `reason`: `missing_signature`, `malformed_signature`, `signature_mismatch`,
`timestamp_out_of_tolerance` or `invalid_payload`.

Pass the **raw** body, exactly as received. Re-serialized JSON (`JSON.stringify(req.body)`) will not verify.

```ts
import { createServer } from "node:http";
import { verifyWebhook, WebhookVerificationError } from "@shade/sdk";

const seen = new Set<string>(); // in production, a unique constraint on event.id in your database

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const event = await verifyWebhook(
      Buffer.concat(chunks),
      req.headers,
      process.env.SHADE_WEBHOOK_SECRET!,
    );
    if (!seen.has(event.id)) {
      seen.add(event.id);
      if (event.type === "invoice.paid") {
        // fulfil event.invoiceId; treat it idempotently per invoice
      }
    }
    res.writeHead(200).end();
  } catch (err) {
    res.writeHead(err instanceof WebhookVerificationError ? 400 : 500).end();
  }
}).listen(8790);
```

With fetch-style frameworks (Hono, Next.js route handlers, Workers):
`await verifyWebhook(await request.text(), request.headers, secret)`.

Delivery is at least once and retried for about three days, so dedupe by `event.id` (also `X-Shade-Event-Id`).
Events carry no payer address and no plaintext memo: `memoHash` identifies the memo instead. Answer 2xx quickly.

`signWebhook(secret, rawBody, timestampSec)` returns both headers exactly as Shade sends them, for testing your
receiver.

## Examples

Two runnable scripts live in `examples/` and run as native TypeScript from the backend workspace. Both read
`backend/.env` when it exists and never print keys, secrets or memos.

**Agent** (`examples/agent.ts`) charges a jar with its agent key until the cap:

```bash
SHADE_AGENT_KEY=ag_… npm run demo:agent -w @shade/backend -- --jar <jar_id> --times 4 --amount 0.002 --memo api:search
```

On Windows (cmd or PowerShell) the `VAR=value command` form does not work: put the variable in `backend/.env`, which
both scripts load, or set it first (PowerShell: `$env:SHADE_AGENT_KEY = "ag_…"`).

```
authorized 0.002 · left 0.004
authorized 0.002 · left 0.002
authorized 0.002 · left 0
402 JAR_EMPTY · Jar empty. The agent cannot spend.
```

`SHADE_API_URL` defaults to `http://localhost:5173` (the dev web app proxies `/v1`). Point it at the API origin for a
deployed Shade. The script exits 0 when every call succeeded or the run ended on `JAR_EMPTY`, 1 on any other error and
2 on bad usage.

**Webhook receiver** (`examples/receiver.ts`) verifies deliveries, dedupes by event id and prints one line per event:

```bash
SHADE_WEBHOOK_SECRET=whsec_… npm run demo:receiver -w @shade/backend -- --port 8790
```

```
listening on http://127.0.0.1:8790
invoice.paid inv_… 0.01 verification=ivk_scan
```

It answers 200 for verified events (including duplicates) and 400 when verification fails.

- **Local backend:** start Shade with `SHADE_WEBHOOK_ALLOW_PRIVATE=1` (allows http and loopback targets; refused in
  production) and register `http://127.0.0.1:8790/` as the endpoint.
- **Deployed Shade:** deliveries only go to public `https` URLs on port 443 or 8443. Expose the receiver through a
  public HTTPS tunnel (for example `cloudflared tunnel --url http://127.0.0.1:8790`) and register the tunnel URL.
  Use `--host 0.0.0.0` if the tunnel or a container reaches the receiver from another interface.

## Development

```bash
npx vitest run --project sdk           # unit tests (fake fetch) + example scripts against loopback servers
npx tsc -p backend/sdk/tsconfig.json --noEmit
npm run build -w @shade/sdk
```

The SDK declares its own types and imports nothing from `backend/`. Its wire types mirror
`backend/src/contract`; keep them in sync when the contract changes.
