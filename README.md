# Shade

**The vendor layer on Zcash.** Create a private invoice, get a webhook when shielded ZEC lands, share or revoke a
time-boxed receipt view, and give an AI agent a jar it can empty but not overflow.

_Pay in the dark. Prove in the light. Keys stay yours._

Shade is not a wallet. It never holds seeds or spending keys. Payers use their own shielded wallet through
[ZIP-321](https://zips.z.cash/zip-0321) payment links. Default network is **testnet**; the asset is **ZEC**.

- Product requirements: [`prd.md`](prd.md)
- Engineering context (architecture, Zcash facts, security rules, deviations from the PRD): [`agents.md`](agents.md)
- 90-second demo script: [`docs/demo.md`](docs/demo.md)
- TypeScript SDK: [`backend/sdk/README.md`](backend/sdk/README.md)

## How it works

```
payer wallet ──ZIP-321──► shielded payment ─────────────► Zcash (Ironwood pool)
                                                              │
shade-zcash.vercel.app (SPA) ──/api,/v1──► Shade API ◄── worker ── lightwalletd (gRPC)
                                              │            │
                                              ▼            └── trial-decrypts with the merchant's viewing key,
                                           Postgres            matches amount + memo hash, waits for confirmations
                                              │
                                              └──► signed invoice.paid webhook ──► merchant server
```

1. A merchant creates an invoice (desk or `POST /v1/invoices`). Shade returns a pay link and a ZIP-321 URI whose memo
   is unique to the invoice.
2. The payer opens the pay page and pays from a shielded wallet (QR or _Open in wallet_).
3. Shade's worker scans the chain with the merchant's viewing key (sealed so the API cannot read it), or the merchant
   runs the same scanner on their own machine. A match with enough confirmations marks the invoice **paid** and sends a
   signed `invoice.paid` webhook. If detection is off, the payer can paste the transaction id and the merchant confirms
   it after checking their wallet.
4. Grants share a receipt view for 10 minutes to 90 days; revoking stops the view and the CSV export immediately.
5. Jars give an agent a spending limit: charges succeed until the cap, then `402 JAR_EMPTY`.

## Repository

```
frontend/      Vite + React SPA: landing, merchant desk, pay page, grant view, API docs
backend/       Hono API, background worker, Postgres migrations, Zcash integration
backend/sdk/   @shade/sdk — TypeScript client, webhook verification, demo scripts
docs/          demo script
agents.md      engineering context for humans and AI agents
prd.md         product requirements
```

## Run it locally

Requirements: **Node 24+** (`.nvmrc`; older versions cannot run the TypeScript sources) and npm. No Postgres and no Zcash node
are needed: the backend uses an embedded Postgres (PGlite) under `backend/.data/` and public testnet light servers.

```bash
npm install
npm run dev
```

- Web app: <http://localhost:5173> (Vite proxies `/api` and `/v1` to the backend, so everything is same-origin)
- API: <http://localhost:8787> (`/healthz`, `/readyz`)

On first boot the backend generates development secrets into `backend/.data/dev-secrets.json`. Email is printed to the
backend console (verification links included), and the worker runs inside the server process. If your shell exports
`PORT`, the backend listens there instead of 8787; unset it, or point the web app at it with `VITE_API_PROXY_TARGET`.

### Try the loop in ten minutes

1. Create an account at <http://localhost:5173/signup> and sign in.
2. **Settings → Receive addresses & network:** paste a testnet Unified Address. Without a wallet, use the public test
   address below. It belongs to the BIP-39 test mnemonic (`abandon … about`), so **anyone can spend what it holds:
   never send real funds to it**. It is only good for creating invoices and looking at pay pages.

   ```text
   utest16gxxqp2n35ze6p2qzlxx2sd0e9s6favez0spnxe6f8useeew37hkm5zrk90373268u70e3l6en9dav8ytzp2q5lnj4gvjcprkg63xcxc
   ```

   To pay for real, install [Zingo](https://zingolabs.org) on testnet, take free TAZ from the
   [faucet](https://zcashfaucet.jinolabs.xyz), and use your own address (or upload that wallet's full viewing key under
   **Settings → Detection** so Shade finds payments by itself).

3. **Invoices → New invoice** → **Open pay page**: the QR, **Open in wallet**, and **Pay by hand** (address, amount
   and the exact memo) for wallets that cannot open the link.
4. **Webhooks:** add `SHADE_WEBHOOK_ALLOW_PRIVATE=true` to `backend/.env` (development only) and restart, run
   `npm run demo:receiver -w @shade/backend` with the secret Shade shows once (`SHADE_WEBHOOK_SECRET`, see below),
   register `http://127.0.0.1:8790/` and press **Send test**.
5. A payment that detection cannot see (no viewing key, or the scanner issue below): **Record payment** on the
   invoice row with the transaction id from your wallet marks it paid and fires `invoice.paid`
   (`verification: merchant_accept`).
6. **Grants → New grant**, open the view link in a private window, download the CSV, then **Revoke**.
7. **Jars → New jar** (cap `0.006`), **Agent key**, then
   `npm run demo:agent -w @shade/backend -- --jar <jar_id> --times 4` with `SHADE_AGENT_KEY` set: three charges, then
   `402 JAR_EMPTY`.

On Windows the `VAR=value command` form below does not work in cmd or PowerShell. Put the variables in
`backend/.env` (the demo scripts and `scan:local` load it) or set them first (PowerShell: `$env:SHADE_AGENT_KEY = "ag_…"`).

### Useful commands

```bash
npm run typecheck          # all workspaces
npm run lint
npm test                   # backend, sdk and frontend unit/integration tests
npm run build              # SDK + frontend production build
npm run test:e2e           # Playwright (first: npx playwright install chromium; stop npm run dev, see below)

npm run demo:receiver -w @shade/backend                         # local webhook receiver (SHADE_WEBHOOK_SECRET=whsec_…)
SHADE_AGENT_KEY=ag_… npm run demo:agent -w @shade/backend -- --jar <jar_id> --times 4
npm run scan:local -w @shade/backend -- --network testnet       # scan on your own machine (SHADE_API_KEY, SHADE_UFVK)
npm run -s keys:seal -w @shade/backend                          # X25519 keypair for sealing viewing keys
```

The demo scripts and `scan:local` read their keys from the environment (or `backend/.env`) and talk to
`SHADE_API_URL`, default <http://localhost:5173>. For webhooks to reach the local receiver on
`http://127.0.0.1:8790/`, set `SHADE_WEBHOOK_ALLOW_PRIVATE=true` in `backend/.env` (development only). Outside CI,
`npm run test:e2e` reuses servers already listening on :8787 and :5173, so with `npm run dev` running it writes to the
development database; stop it first to get the isolated in-memory test backend.

Chain-touching tests use a deterministic fake chain. Live checks against testnet light servers run with
`SHADE_LIVE_TESTS=1 npx vitest run --project backend test/zcash/live`. Race tests run against real Postgres when
`TEST_DATABASE_URL` is set (CI provides one).

## API in one minute

```ts
import { Shade } from "@shade/sdk";

// baseUrl: your Shade's origin (http://localhost:5173 in development)
const shade = new Shade({ apiKey: process.env.SHADE_API_KEY!, baseUrl: "http://localhost:5173" });
const inv = await shade.invoices.create({ amountZec: "0.01", memo: "order_1042" });
// send the payer to inv.payUrl; fulfil on the signed invoice.paid webhook
```

The SDK lives in `backend/sdk` and is not on npm yet: `npm run build -w @shade/sdk`, or `npm pack -w @shade/sdk` and
install the tarball. Other languages call the JSON API directly; `/docs` has webhook verification in Node, Python and
Go.

| Endpoint                                                                                     | Purpose                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `POST /v1/invoices` · `GET /v1/invoices[/:id]` · `POST /v1/invoices/:id/cancel`              | invoices                                                                   |
| `POST /v1/invoices/:id/detections`                                                           | report a payment found by your own scanner                                 |
| `POST /v1/jars` · `GET /v1/jars/:id` · `POST /v1/jars/:id/charge` · `POST /v1/jars/:id/kill` | agent jars (`402 JAR_EMPTY` at the cap; an agent key can read its own jar) |
| `POST /v1/grants` · `POST /v1/grants/:id/revoke`                                             | receipt views                                                              |
| `POST /v1/webhooks` · `GET /v1/webhooks` · `DELETE /v1/webhooks/:id`                         | signed webhook endpoints (`X-Shade-Signature`, `X-Shade-Signature-V2`)     |
| `POST /v1/tags` · `GET /v1/tags/:name`                                                       | `name.shade` handles                                                       |

Authentication: `Authorization: Bearer sk_test_…` (testnet) or `sk_live_…` (mainnet); agent keys `ag_…` may only charge
their jar and read it. `Idempotency-Key` is honoured on invoice, jar and charge creation. Full reference: `/docs` in the web app.

## Deploy

Reference setup, all driven from the CLIs at the repository root (step by step in `agents.md` §12):

| Piece          | Where                                 | Notes                                                                         |
| -------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| Website        | **Vercel** (project root `frontend/`) | static build; proxies `/api/*` and `/v1/*` to the API                         |
| API and worker | **Railway**, two services, one image  | `backend/Dockerfile`; migrations run as the pre-deploy command                |
| Database       | **Neon** Postgres 17                  | pooled `DATABASE_URL` + direct `DATABASE_URL_UNPOOLED`, `sslmode=verify-full` |
| Email          | **Resend**                            | a verified sending domain; `MAIL_FROM` on it                                  |

- **Install the CLIs** (Node 24): `npm i -g @railway/cli vercel neon resend-cli`, then `railway login`,
  `vercel login`, `neon login` and `resend login` (with a key from the Resend dashboard).
- **Railway has no committed config file:** new services cannot use `railway.json` any more. Both services are set up
  with one `railway environment edit` patch (Dockerfile path, the worker's start command, the API's healthcheck and
  pre-deploy migrations); see `agents.md` §12.5.
- **Secrets stay out of uploads and history.** `railway up` skips `.gitignore`d files; `vercel deploy` does not read
  `.gitignore`, so the root `.vercelignore` allowlists only what the frontend build needs. Values go into
  `railway variable set … --stdin` and `vercel env add …` through pipes, never on a command line.
- **Production refuses to start** without `DATABASE_URL`, `APP_ORIGIN`, `BETTER_AUTH_SECRET`, `SHADE_ENCRYPTION_KEY`
  and a mail transport that can deliver verification email (`MAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `MAIL_FROM` on
  a domain verified in Resend). The Docker image sets `NODE_ENV=production`; outside it, set it yourself.
- **Viewing-key seal keys** (hosted detection only): `npm run -s keys:seal -w @shade/backend` prints the pair. The
  public key goes on the API service, the private key on the worker service only, because it opens every uploaded
  viewing key.
- **Client IPs behind Vercel → Railway:** Railway's edge overwrites `X-Forwarded-For` and `X-Real-IP` with the
  connecting address (Vercel's, for proxied requests). The API service uses `TRUST_PROXY_DIRECT=x-real-ip` (right for
  direct `/v1` callers) and `EDGE_SHARED_SECRET` (the value Vercel sends as `x-shade-edge` from its
  `SHADE_EDGE_SECRET` variable). `TRUST_PROXY=x-vercel-forwarded-for` is switched on only after a live check shows
  Vercel sends that header and overwrites a client's value (`agents.md` §12.8); until then proxied users share a
  per-IP bucket per Vercel address. Set the Vercel variable and redeploy the frontend first: once the API has the
  secret, `/api/*` without the header is 403.
- **One machine instead:** `backend/docker-compose.yml` runs Postgres, a one-shot migration, the API and the worker
  (`docker compose -f backend/docker-compose.yml up --build` after creating `backend/.env` and `backend/.env.worker`
  from their `.example` files); add a TLS proxy and backups yourself.

See `agents.md` §10 for the full checklist.

## Known issue: testnet detection after NU7 (October 2026)

Testnet activated NU7 at height 4,465,026 on 2026-10-04. The scanner library Shade pins (`@ledgerhq/zcash-utils`
2.5.0, still the newest release on 2026-10-06) rejects every transaction made since then ("invalid consensus branch id
0x77190ad9"). Scanning blocks still works, but as soon as a payment to the viewing key arrives, the scan fails and
Settings → Detection says the scanner needs an update. Shade fails closed: nothing is marked paid by mistake. Until a
new scanner release is out and re-verified with a real payment, confirm testnet payments with **Record payment** or
the payer's pasted txid. Mainnet detection is unaffected until mainnet NU7 (planned for about 2026-11-05).

## Honest limits

- Kill stops new jar charges. It does not move ZEC: move leftover ZEC in your wallet.
- Revoke stops Shade from serving a grant. It cannot erase a file the auditor already downloaded.
- Hosted detection needs a full viewing key, which also reveals outgoing payments. Use a receive-only account, or run
  `scan:local` on your own machine.
- The public light server Shade asks can see which transactions Shade looks up. Run your own for mainnet.
- A pasted transaction id is never settlement: the invoice stays _unverified_ until a scan matches it or the merchant
  confirms it.
- Payments use Zcash's shielded pool today. When Zcash upgrades keys, Shade follows. Shade does not claim to be
  quantum-safe.
