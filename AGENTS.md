# agents.md — Shade engineering context

This is the primary operating guide for AI coding agents and engineers working on Shade. Read it fully before changing
code. **`prd.md` is the product source of truth.** This file records how the product is engineered, which PRD wording is
superseded by protocol reality, and the rules that keep Shade safe. When this file and the code disagree, fix one of them
in the same change.

---

## 1. Product

**Shade is a curtain in front of Zcash.** Zcash already hides the money; Shade hides the _work of using it_ from vendors
and agents. It is the vendor layer on Zcash: create a private invoice, get a webhook when shielded ZEC lands, share or
revoke a time-boxed receipt view, and give an AI agent a jar it can empty but not overflow.

Tagline: _Pay in the dark. Prove in the light. Keys stay yours._ Site copy default: _Your tools spend. Your ledger should
not narrate._

**Shade is not** a wallet, a mixer, a rollup, a new coin, multi-chain, or "privacy invented here". It never holds seeds or
spending keys. Payers use their own shielded wallet (Zingo, Zodl, …) through ZIP-321 payment URIs.

### 1.1 Goals (PRD §0, §16)

- A working pay loop on Zcash testnet: create invoice → shielded pay → webhook `invoice.paid` → viewing grant → revoke →
  agent jar empty fails.
- One real shielded testnet payment detected. `@shade/sdk` with the PRD calls. A README a stranger can run.
- Honesty over theatre: _a demo that lies about "on-chain" is a failed build_ (PRD §0.8).

### 1.2 The four objects (PRD §4)

| Object      | Meaning                                                            | Implementation                                             |
| ----------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Tag**     | `name.shade` → a merchant Unified Address                          | `tags` table, network-bound; `GET /v1/tags/:name` resolves |
| **Invoice** | "Pay this much ZEC for this memo" → ZIP-321 URI + pay page         | `invoices`; status machine in §6.1                         |
| **Jar**     | A capped spending allowance an agent draws from; owner can kill it | `jars` + authorized child invoices                         |
| **Grant**   | Time-boxed, revocable receipt view for an auditor                  | `grants`; Shade-served view + CSV export                   |

Receipt = invoice marked paid + txid + memo hash.

### 1.3 Users (PRD §6)

| Who             | Job                                                         | Surface                                 |
| --------------- | ----------------------------------------------------------- | --------------------------------------- |
| Merchant / SaaS | Invoice → webhook `invoice.paid` → fulfil                   | Desk + `/v1` API + SDK                  |
| Agent runtime   | Jar with a cap, charge per call, fail closed                | `/v1/jars/:id/charge` with an `ag_` key |
| Human owner     | Set caps, read activity, revoke grants, kill jars           | Desk                                    |
| Auditor         | Open a grant, export receipts, lose access at expiry/revoke | `/view#<token>`                         |
| Payer           | Pay privately from their own wallet                         | `/pay/:id`                              |
| Fair judge      | Understand the loop in 90 seconds                           | Landing page, `docs/demo.md`            |

### 1.4 Journeys

1. **Invoice:** merchant creates an invoice (desk or `POST /v1/invoices`) → payer opens `/pay/:id`, taps _Open in wallet_
   or scans the QR → wallet sends a shielded payment with the invoice's on-chain memo → Shade's detector (or the
   merchant's own scanner) decrypts the note with the merchant's viewing key, matches amount + memo hash, waits for the
   configured confirmations → invoice `paid` (`ivk_scan`) → signed `invoice.paid` webhook.
   Fallback: payer pastes the txid (`paid_unverified`) → merchant checks their wallet and presses _Confirm_
   (`merchant_accept`).
2. **Jar:** owner creates a jar (cap) and an agent key for it → agent calls `charge` per paid API call → over the cap the
   API returns `402 JAR_EMPTY` (_Jar empty. The agent cannot spend._) → owner kills the jar (_Stops new charges. Move
   leftover ZEC in your wallet._).
3. **Grant:** owner creates a grant for a tag (`payroll`) or `all`, for 10 minutes–90 days → shares the view link once →
   auditor sees receipts and downloads CSV → owner revokes → view shows the revoked notice and export returns 410.

---

## 2. Intentional PRD deviations (this table wins over prd.md wording)

| PRD item                                                         | Shade v1                                                                                                                                                                                            | Reason                                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js `apps/web` + `apps/api`                                  | Vite SPA `frontend/` + Hono `backend/` (one API for SPA, SDK and worker)                                                                                                                            | Clear separation; same-origin cookie topology                                                                                                                              |
| "Chain: Orchard / Unified Addresses"                             | UA **with an Orchard receiver**; payments land in the **Ironwood** pool                                                                                                                             | NU6.3 (live on mainnet since 2026-07-28) sealed the Orchard pool; Orchard receivers now receive into Ironwood                                                              |
| §15 "We use Zcash Orchard today…"                                | `COPY.quantum`: "Payments use Zcash's shielded pool today. When Zcash upgrades keys, Shade follows."                                                                                                | Factual accuracy; never claim quantum-safe                                                                                                                                 |
| IVK only on merchant device / vault (§0, §11.1)                  | Opt-in **hosted detection** with a UFVK sealed to the worker, **plus** a merchant-device scanner CLI (`scan:local`)                                                                                 | The only maintained Node scanner needs a UFVK; PRD §11 allows an encrypted upload. UI discloses that a UFVK also reveals outgoing payments                                 |
| §8.3 "exported UFVK/IVK slice"                                   | Shade-served receipt view + CSV export; revoke ⇒ 410                                                                                                                                                | No protocol-level scoped or time-boxed viewing key exists                                                                                                                  |
| Grant `days`                                                     | `days` or `expires_in_sec` (10 min – 90 days)                                                                                                                                                       | PRD §12.4 demo uses a 10-minute grant                                                                                                                                      |
| Jar "fund" / "Kill returns the rest to you" (§7)                 | A jar is a spending limit (`COPY.jarIsLimit`) and kill uses the §15 line                                                                                                                            | PRD §8.2/§15: no spending key, no fake clawback                                                                                                                            |
| `sk_live_` only                                                  | `sk_test_` (testnet), `sk_live_` (mainnet); `ag_` keys take their jar's network                                                                                                                     | Network binding prevents test keys acting on mainnet                                                                                                                       |
| `X-Shade-Signature` = HMAC of raw body                           | Kept verbatim (`sha256=<hex>`) **plus** `X-Shade-Signature-V2: t=…,v1=…` signed per attempt and `X-Shade-Event-Id`                                                                                  | Replay protection without breaking the PRD shape. The SDK's `verifyWebhook` requires V2 unless `allowLegacySignature` (the body-only one never expires)                    |
| §17.1 fake-paid mock (`DEMO_FAKE_PAID`)                          | Never built. No rehearse, no "charge four times" button                                                                                                                                             | §17.6 says delete before submit. The demo uses a real agent script and a real webhook receiver                                                                             |
| Optional memo                                                    | Every invoice carries a unique on-chain memo: `<memo> (shade:<REF>)` or `shade:<REF>`                                                                                                               | Scanner matching must be unambiguous; memo hashes become unguessable                                                                                                       |
| Payer wallets Zodl / Zucchini (§0, §10)                          | Testnet demo payer: Zingo. Zodl on mainnet.                                                                                                                                                         | Zodl store builds are mainnet-only; Zucchini is a desktop extension                                                                                                        |
| `/demo` page, packages/agent MCP tools, Zucchini dapp-sdk button | Deferred (not in §9/§16)                                                                                                                                                                            | Scope discipline (PRD: "If a task is not in §9, do not build it")                                                                                                          |
| `GET /v1/invoices` (§9 lists create, get and cancel only)        | `GET /v1/invoices?status=<comma list>&expires_after=<ISO>&cursor=&limit=` (1–100): non-jar invoices of the key's network                                                                            | `scan:local` pages its candidates through it (unpaid ones, then expired ones still in the candidate window); the SDK exposes it as `invoices.list`                         |
| §11.1 "Merchant … scans" (no §9 endpoint)                        | `POST /v1/invoices/:id/detections` (`txid`, `amount_zec`, `memo_hash`, `pool`): Shade checks the tx, then settles                                                                                   | Keeps the viewing key on the merchant's device (PRD §0 stack, §11.1); `scan:local` and external scanners report matches through it                                         |
| §9 "Charge creates a child invoice" (no charge list or cancel)   | Desk `GET /api/desk/jars/:id/charges` and `POST …/charges/:chargeId/cancel`; `/v1/invoices/:id/cancel` on a charge                                                                                  | PRD §6 owner reads activity. A charge is an invoice, so cancel applies; it refunds the cap while the jar is open                                                           |
| §9 webhooks: `POST /v1/webhooks` only                            | `GET /v1/webhooks`, `DELETE /v1/webhooks/:id`; desk list, delete, `POST …/webhooks/test` (`webhook.test`) and `GET …/webhooks/deliveries`                                                           | At most 5 endpoints per network (`ENDPOINT_LIMIT`: delete one first), so a setup script must be able to find and replace one. The demo checks setup with Send test (§12.3) |
| §9 jars: create, charge, kill                                    | Plus `GET /v1/jars/:id`, which the jar's own `ag_` key may call                                                                                                                                     | An agent reads its remaining budget before it spends, instead of learning it from a 402                                                                                    |
| §11 fallback: payer pastes a txid, merchant confirms             | Plus desk **Record payment**: `POST /api/desk/invoices/:id/accept` with `{ txid }` from the merchant's own wallet, on an open or claimed invoice, or past expiry when mined within the grace window | Detection can be off or unable to read the chain (testnet after NU7, §3) while the payer never pastes. Same checks as a paste, then `merchant_accept`                      |
| §7 grant dialog "Scope: invoices tagged payroll"                 | "Scope: invoices labelled payroll" (`grantDialogCopy`)                                                                                                                                              | Invoices carry a label; a tag is a `name.shade` handle (§1.2), shown under Settings → Tags                                                                                 |
| §9 `sk_live_…` and `ag_…` keys (no way to issue them)            | Desk `GET/POST /api/desk/keys`, `POST /api/desk/keys/:id/revoke`; issuing needs a fresh session, 10 per hour                                                                                        | §9 names the keys but not how they are made. Tokens are shown once (§5.4); an agent key binds to one open jar and takes its network                                        |
| §0.3 "testnet until mainnet is a checkbox"                       | `PUT /api/desk/settings/network` switches the desk network; mainnet needs a fresh session and `SHADE_NETWORKS`                                                                                      | This is the checkbox. A network the server does not enable is 403 `NETWORK_DISABLED`; keys stay bound to their own network                                                 |
| §8.1 webhook body (`type`, `invoice_id`, …, `txid`, `paid_at`)   | Adds `id`, `created_at`, `network`, `verification`; `webhook.test` has the same shape with null invoice fields                                                                                      | Delivery is at-least-once, so receivers need `id` to dedupe; `verification` tells `ivk_scan` from `merchant_accept`                                                        |
| Not in the PRD                                                   | `Idempotency-Key` on `POST /v1/invoices`, `/v1/jars`, `/v1/jars/:id/charge` (per API key, kept 24 h)                                                                                                | Agent retries must not charge a jar twice (§6.2). 2xx and business 4xx answers replay; 400, 429 and 5xx are not stored                                                     |

---

## 3. Zcash facts Shade depends on (verified 2026-10-02, NU7 and endpoints 2026-10-06 — re-verify before upgrading anything)

- **Network upgrades.** NU6.3 _Ironwood_: mainnet height 3,428,143 (2026-07-28), testnet 4,134,000. New shielded payments
  to Orchard receivers land in the Ironwood pool (v6 transactions, version group `0xD884B698`); the same Orchard IVK
  decrypts both pools; UAs do not change. **NU7** (ZIP 218, 259, 235): active on testnet since height 4,465,026
  (2026-10-04); mainnet planned for about 2026-11-05 (height decided about 2026-10-20). Branch id `0x77190AD9`; no new
  transaction format (v5/v6 stay valid, v4 does not); 25-second target spacing (testnet ran about 9 s per block on
  2026-10-06); the consensus reorg limit rises from 99 to 600 blocks, so the detector rescans 600 blocks after a reorg
  (`REORG_RESCAN_BLOCKS`); default transaction expiry 40 → 120 blocks; 60% of fees burned at block level (senders pay
  the same). ZSAs and memo bundles are not in NU7. Never hard-code block time. zcashd is end-of-life; the network runs
  Zebra/Zakura.
- **Chain access** is lightwalletd gRPC (`cash.z.wallet.sdk.rpc.CompactTxStreamer`, lightwallet-protocol v0.5.0) — no
  full node (PRD §0.6). Public endpoints: testnet `testnet.zec.rocks:443` (fallback `zaino.testnet.unsafe.zec.rocks:443`,
  which answered HTTP 503 on 2026-10-06: testnet then had no working fallback), mainnet `zec.rocks:443` (fallback
  `zec-node.cakewallet.com:443`; `na.zec.rocks` and `eu.zec.rocks` also answered). The Zaino testnet fallback (ZainoD 0.6.0) answers
  an unknown txid with gRPC `INTERNAL`, the same status as a backing-node failure, so during a primary outage an unknown
  txid returns 503 `CHAIN_UNAVAILABLE`, never not-found (fail closed). ZainoD 0.6.0 also answers a **mempool**
  transaction with the current tip as its height, so `RawTransaction.height` alone is not proof of mining: Shade counts
  a transaction as mined only when it is listed in the compact block at that height (`GetBlock`), asks the next server
  when one lacks the block, and fails closed when none has it. Blockchair has **no** Zcash testnet API and its
  JSON heuristic misclassified transparent transactions; it is not used.
- **Byte order.** Shade stores and accepts txids and block hashes as lowercase **display-order** hex. lightwalletd's
  `TxFilter.hash`, `BlockID.hash` and `CompactBlock.hash` are protocol (little-endian) order — the client reverses them.
  `RawTransaction.height`: `0` = mempool, `2^64−1` = mined on a non-main chain.
- **Unified Addresses (ZIP-316 Rev 0).** Bech32m (no 90-char limit) over F4Jumble(TLV items ‖ 16-byte HRP padding);
  HRPs `u` / `utest`; viewing keys `uview`/`uviewtest` (full) and `uivk`/`uivktest` (incoming). Shade requires an Orchard
  receiver (typecode `0x03`), strips transparent receivers by re-encoding, and rejects t-addresses, TEX (`tex`/`textest`,
  ZIP-320), Sapling-only `zs…`, spending keys and seed phrases with plain messages. Rev 2 (`zu`, `uvf`, …) is Draft.
- **ZIP-321.** Shade emits exactly `zcash:<shielded UA>?amount=<canonical>&memo=<base64url, no padding>`. No `message`
  or `label` (Zucchini rejects them; duplicating the memo bloats QR codes).
- **ZIP-302 memos.** 512 bytes; text memos are UTF-8 zero-padded; an empty memo is `0xF6` + 511 zero bytes.
  `memo_hash = "sha256:" + hex(SHA-256(memo_field))`. Vectors: `""` → `fe079fdd…643d`, `"order_1042"` → `c8c635ab…7b20`.
- **Viewing keys.** A UFVK reveals incoming **and outgoing** activity; a UIVK reveals incoming only; both cover every
  diversified address of the account. Memo contents are sender-controlled and unverified (ZIP-310).
- **Compact blocks** carry only a 52-byte ciphertext prefix per action: trial decryption gives the value, not the memo; the
  memo needs the full transaction (`GetTransaction`), which tells the lightwalletd operator which txid Shade cares about.
- **Confirmations.** ZIP-315 recommends 10 confirmations for untrusted incoming funds. Shade defaults to 1 on testnet
  (demo) and 10 on mainnet. Paid is final: there is no un-pay after a reorg.
- **Fees** (ZIP-317) are paid by the sender on top of the invoice amount; a 2-action payment costs 0.0001 ZEC.
- **Scanner library** `@ledgerhq/zcash-utils` **2.5.0** (exact pin; still the newest release on 2026-10-06): napi addon
  (win32/darwin/linux-gnu, glibc ≥ 2.34, no musl), UFVK only, decrypts Sapling/Orchard/Ironwood, reads the system CA
  bundle. **It cannot read NU7 transactions**: verified 2026-10-06 against real post-activation testnet transactions,
  its parser fails with "invalid consensus branch id 0x77190ad9". Compact-block trial decryption still completes, so a
  pass without matches succeeds; the first payment to the key fails the pass (`scanner_unsupported_upgrade`, cursor
  kept). Testnet detection is therefore down until a release built on `zcash_protocol` ≥ 0.11 ships; merchants settle
  with Record payment or the payer's paste (§4.8). Mainnet breaks the same way at mainnet NU7 unless it is bumped
  first. Shade's own `tx.ts` treats the branch id as opaque and keeps working. Re-verify with a real payment after
  every network upgrade before changing the pin. The adapter skips a memo group whose memo cannot be a ZIP-302 text
  memo (no Shade invoice can carry one) instead of failing every later pass on it.

---

## 4. Architecture

```
 Browser ──► https://shade-zcash.vercel.app  (static SPA; /api/* and /v1/* rewritten to the backend)
                │
                ▼
          backend server (Hono on Node 24) ──► Postgres
            /api/auth/*   Better Auth (sessions)
            /api/desk/*   merchant desk (cookie session)
            /api/public/* pay page, payer txid, grant view/export
            /v1/*         public API (sk_/ag_ bearer keys)
                │                         ▲
                ▼                         │
          lightwalletd (gRPC) ◄──── backend worker (detector · webhook outbox · sweeper)
                                          │
                                          ▼
                                 merchant webhook endpoints (signed, SSRF-safe)
```

### 4.1 Repository layout

```
frontend/                @shade/frontend — Vite 8 + React 19 SPA (TanStack Router + Query, Tailwind v4)
backend/                 @shade/backend  — Hono API, worker, migrations, Zcash integration
  migrations/            plain SQL applied in filename order (0001–0013; applied files are never edited, §4.5)
  src/contract/          wire contract: DTO types, error codes, product COPY (imported by the frontend as @shade/contract)
  src/zcash/             protocol code: ZIP-316/321/302, tx parser, lightwalletd client, scanner adapter
  src/platform/          config, logger, db, migrations runner, crypto, SSRF-safe egress, rate limit, idempotency, auth, HTTP middleware
  src/services/          domain services (merchants, invoices, settlement, jars, grants, webhooks, tags, keys, viewing keys)
  src/http/              Hono routes and the app factory
  src/worker/            detector, promotion, outbox drainer, sweeper; matching (shared with scan:local), local-scan, repo
  src/bin/               server, worker, migrate, scan-local, gen-seal-key entry points
  test/                  integration + HTTP contract tests, fixtures, support (harness, fake chain, test db)
  sdk/                   @shade/sdk — public TypeScript client + webhook verification + demo scripts
docs/demo.md             the 90-second demo script
agents.md, prd.md, README.md
```

### 4.2 Dependency direction

`contract` ← `zcash` ← `platform` ← `services` ← `http` / `worker` ← `bin`. The frontend depends only on `contract`
(types and constants). The SDK depends on nothing (it declares its own camelCase types). Never import upward.

### 4.3 Frontend

SPA served as static files. TanStack Router file routes; TanStack Query owns all server state (no other store). Same
origin as the API (Vite dev proxy; `vercel.json` routes in production), so the Better Auth session cookie is
first-party and host-only. Routes: `/`, `/login`, `/signup`, `/verify-email`, `/reset-password`, `/desk/*` (primary
nav **Invoices · Jars · Grants · Webhooks**, plus Settings: receive addresses & network, profile, detection, tags, API
keys), `/pay/$id`, `/view` (token in the URL fragment only), `/docs`. Fonts are self-hosted; no third-party requests at
runtime. Route guards and headers read the session with a plain `GET /api/auth/get-session` (`api/session.ts`); only
the auth and desk pages import the Better Auth client (`api/auth.ts`), so the pay page a payer opens never loads it.
After client-side navigation focus moves to the page's h1 (`components/page-focus.ts`).

### 4.4 Backend

Hono on `@hono/node-server`, TypeScript executed natively by Node 24 (type stripping — **erasable syntax only**).
Services receive `{ db, config, logger, chain, scanner, mailer, clock }` by injection. All input is validated with zod at
the HTTP boundary. Errors are `AppError(status, code, message)` mapped to `{ error, message, request_id }`.

### 4.5 Database

Postgres (Neon or any Postgres 15+). Local development without `DATABASE_URL` uses PGlite under `backend/.data/pglite`
(single process — the worker runs inline). Tests use in-memory PGlite; race tests use real Postgres when
`TEST_DATABASE_URL` is set. Migrations are plain SQL in `backend/migrations`, recorded by bare filename in `_migrations`
with checksums; applied files are never edited — add a new file. The one exception is the header comment of 0001 (Grok
template text), rewritten before the first v1 deployment: v0 databases recorded no checksums, and a database the v1
runner opened before the edit holds the old checksum, which `platform/migrate.ts` accepts and replaces
(`SUPERSEDED_CHECKSUMS`). New CHECK/FK constraints on existing tables are added `NOT VALID` after backfilling. On
Postgres the server and the worker refuse to start while a migration is pending (run `npm run db:migrate`); on PGlite
the server migrates itself. After the SQL files the runner repairs receive addresses stored before v1 validated them
(`services/stored-addresses.ts`: transparent receivers stripped by re-encoding; a merchant address without an Orchard
receiver is cleared so the desk asks again). It is idempotent and compare-and-set.

| Migration | Contents                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------- |
| 0001–0004 | v0 history (auth tables, v0 domain schema, detections, txid uniqueness)                                   |
| 0005      | v1 domain schema                                                                                          |
| 0006      | Better Auth 1.7.7 delta (rate-limit table)                                                                |
| 0007      | Legacy cleanup: v0 `paid` rows without a txid cancelled; `paid_at` only on settled rows (CHECK)           |
| 0008      | `merchant_viewing_keys.cursor_time` (chain time reached by the last successful scan, §4.8)                |
| 0009      | Memo-group uniqueness: settled txids and detections unique per (merchant, network, txid, memo hash), §4.8 |
| 0010      | Partial indexes for the detector's candidate queries (memo-hash lookup, expired window)                   |
| 0011      | `merchant_viewing_keys.scan_from` (first upload of a key that has not completed a scan, §6.5)             |
| 0012      | `jars.charge_count` (live charges; backfilled)                                                            |
| 0013      | Triggers on `invoices` keep `jars.charge_count` (any code that writes a charge); re-backfilled            |

Driver contract: `int8 → number` (throws if unsafe), `numeric → string`, `timestamptz → Date`. Amounts are
`numeric(20,8)` ZEC in SQL and `bigint` zatoshis in code. Business time is the injected clock passed as a SQL parameter.

### 4.6 Authentication and authorization

| Principal       | Credential                                                                                            | Scope                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Merchant (desk) | Better Auth 1.7.7 email + password session cookie (`shade.*`, HttpOnly, SameSite=Lax, Secure in prod) | own merchant; email verified when required; sensitive actions need a session < 15 min old |
| Merchant (API)  | `sk_test_…` / `sk_live_…` bearer key (SHA-256 at rest, shown once)                                    | own merchant, one network                                                                 |
| Agent           | `ag_…` bearer key bound to one jar                                                                    | `POST /v1/jars/<jar>/charge` and `GET /v1/jars/<jar>` only                                |
| Auditor         | `gv_…` grant token (SHA-256 at rest, shown once, in the URL fragment)                                 | one grant's receipts until expiry/revoke                                                  |
| Payer           | possession of the pay link                                                                            | public invoice view, txid claim                                                           |

`/api/auth/*` bodies are capped at 16 KB (413 `PAYLOAD_TOO_LARGE`); a user name is at most 128 characters and profile
images are refused. Auth emails (verification, password reset) are sent in the background after the response, so
response timing does not reveal whether an account exists; a failed send is logged, never returned.

- **Verification never signs anyone in** (`autoSignInAfterVerification: false`). The mailed link confirms the email and
  lands on `/desk?verified=1`, which sends a signed-out visitor to `/login` with "Email confirmed. Sign in to open your
  desk."; a bad link adds `error=…` and lands on `/verify-email`.
- **Contested sign-up.** A sign-up for an email whose account was never confirmed deletes that account's password and
  sessions, clears the name it chose (pay pages show it as the shop name) and mails the address a set-password link
  ("Finish setting up Shade"); a sign-up for a confirmed account changes nothing and says the same thing. This stops a
  pre-registered account takeover (an attacker parks a password, the owner later confirms the email). Completing any
  password reset also confirms the email, since only the mailbox receives the link.
- **Residual risk (accepted):** if the owner clicks the confirmation email triggered by an attacker's sign-up before
  signing up themselves, the attacker's password becomes valid. The mail says to ignore unexpected sign-ups. Closing it
  fully needs the first confirmation to be a set-password step.

CSRF: `/api/*` has no CORS. The guard is the origin check: unsafe methods require `Origin` = `APP_ORIGIN` (outside
production also its `localhost` ⇄ `127.0.0.1` twin) or, with no `Origin`, `Sec-Fetch-Site: same-origin`; the SameSite
cookie backs it up. A non-empty body must be `application/json` (415); bodiless POSTs accept any content type.
`/v1/*` ignores cookies and allows CORS `*` without credentials.

### 4.7 Zcash integration (backend/src/zcash)

- `address.ts` — full ZIP-316 codec + merchant address policy; `parseUfvk`.
- `zip321.ts`, `memo.ts`, `money.ts`, `txid.ts` — URIs, memo fields/hashes, zatoshi math, byte order.
- `tx.ts` — structural v4/v5/v6 parser (counts transparent ins/outs, Sapling, Orchard and Ironwood actions; branch id
  opaque).
- `lightwalletd.ts` — pure-TypeScript gRPC client over `node:http2` with failover across endpoints.
- `scanner.ts` — the only importer of `@ledgerhq/zcash-utils`; reduces each transaction to incoming payments
  `{txid, block, pool, amountZat, memoHash}` and drops memo text before it leaves the module.

### 4.8 Payment detection and settlement

- **Settlement seam:** `services/settlement.ts` (`applyDetection`, `acceptClaim`) is the only code that moves an invoice
  to `paid`. The hosted worker, `POST /v1/invoices/:id/detections` (merchant-device or external scanners) and desk
  _Confirm_ all go through it. Settling enqueues exactly one `invoice.paid` event in the same transaction. Both paths
  first take a per-(merchant, network, txid) transaction advisory lock, so Confirm and a scanner match of the same txid
  serialise; the loser gets the outcome `txid_in_use` (hosted worker) or 409 `TXID_IN_USE` (`/v1` detections,
  Confirm), never a 500.
- **One transaction, several invoices:** the scanner reports one payment per memo group of a transaction, and
  detections and settled txids are unique per (merchant, network, txid, memo hash) (migration 0009). A transaction
  that pays two invoices with their own memos settles both; one memo group settles at most one invoice. A scanner match
  whose txid already settled another invoice with the same memo hash, or that the merchant confirmed elsewhere, gets
  `txid_in_use`, and this invoice's still-`seen` detection of that payment becomes `late`. Confirm checks neither
  amount nor memo, so it stays txid-wide: it refuses a txid used by any other invoice or `seen`/`settled` detection.
- **Hosted detector:** per merchant/network with an uploaded viewing key and candidate invoices, scan from the cursor
  (minus a reorg window) to the tip under a lease; match exact amount + memo hash + block window; record `seen` until
  confirmations reach the network minimum; promotion and orphan checks run every tick. A failed pass leaves the cursor
  unchanged. The merchant sees problems as `last_error` (`ScanErrorCode`: `chain_unavailable`, `scan_failed`,
  `key_unavailable`, `scanner_unsupported_upgrade`, `ambiguous_match`, `txid_in_use`). A pass covers at most 20,000
  blocks; one that times out (60 s, and never past its lease minus 15 s however long planning took) halves that key's
  pass size for the next try, down to 1,000 blocks, and completed passes double it back (`scanChunks`, kept per worker
  process), so a backlog the scanner cannot cover in one timeout still advances. After a reorg the pass restarts 600
  blocks behind the cursor.
- **Scan start height:** the lowest `created_height` of the candidates; for an invoice without one (light server down at
  creation), the last block whose timestamp is at or before `created_at` − 120 s, found by a search over block times and
  lowered by 12 blocks (timestamps are not monotonic); then 2 blocks lower. Never a block-spacing estimate. A failed
  block lookup fails the pass instead of guessing. `scan:local` plans its range the same way and uses the recorded
  `created_height` from `/v1` invoices.
- **Candidates:** non-jar invoices that are `open` or `paid_unverified`, or `expired` with `expires_at` later than the
  chain time the scan has reached minus 70 minutes. That chain time is `cursor_time` (block time of the last successful
  scan's end block), before its first successful scan the time this key was first uploaded (`scan_from`, else the
  row's `created_at`), or unknown (every expired invoice stays a candidate)
  when a cursor has no recorded time. The current wall-clock time is never used, so a detector that lags behind still
  matches a payment mined before expiry. `scan:local` uses the block time at its local cursor (now on a first run),
  and fetches only what can match: unpaid invoices, then expired ones with `expires_after` = that time − 70 minutes.
  It fails rather than scan for a partial list (over 200 pages), and a report answered `404 TX_NOT_FOUND` (Shade's
  light server has not seen the transaction yet) fails the pass so the cursor stays and the next pass reports it again.
- **Payer paste:** `POST /api/public/invoices/:id/txid` checks the tx exists on the invoice's network, can pay a shielded
  receiver (Ironwood actions or Sapling outputs) and is inside the window, then sets `claimed_txid` and `paid_unverified`.
  A paste never reserves a txid and never fires a webhook.
- **Confirm and Record payment** (`acceptClaim`, `merchant_accept`): Confirm settles the payer's claimed txid. Record
  payment (`{ txid }` in the body) settles an `open` or `paid_unverified` invoice with a txid the merchant found in
  their own wallet, for when detection is off or cannot read the chain: the txid first passes the paste checks, and a
  claimed txid it replaces is cleared. Past expiry it applies the scanner's rule: the tx's block time must be within 60
  minutes of `expires_at` (else 409 `EXPIRED`), checked again under the row lock. Both need the tx mined with the network's minimum
  confirmations and unused by any other invoice (`TXID_IN_USE`); other invoices' claims of that txid go back to
  `open`. Shade cannot see the amount or the memo of either, so the desk asks the merchant to check them.

### 4.9 Webhooks

Transactional outbox (`webhook_events` + leased `webhook_deliveries`), delivered right after commit and retried by the
worker for ~3 days with jitter (10 attempts). `Retry-After` on 429/503 can only lengthen a wait, to at most twice the
scheduled step. An endpoint is turned off (`failing`) after at least 20 consecutive failed attempts spanning 3 days
without a success; turning off stops new events only, and deliveries already queued keep retrying. A `410 Gone` turns it
off at once and cancels what is queued. Per-endpoint `whsec_` secrets, AES-256-GCM at rest, shown once. Body never
contains a payer address or plaintext memo. Delivery is at-least-once: receivers dedupe by `id`. Egress is SSRF-safe:
HTTPS, ports 443/8443, every resolved address must be public unicast, the connection is pinned to the vetted IP, no
redirects, 10 s timeout, 64 KB response cap.

### 4.10 API surface

Source of truth: `backend/src/http/{app,public,desk,v1}.ts`, bodies in `http/support.ts`, shapes in
`backend/src/contract/types.ts`. Public reference for integrators: `/docs`
(`frontend/src/features/docs/docs-content.ts`) and `backend/sdk/README.md`; keep both in step with `/v1`.

| Prefix                         | Principal                       | Guards                                           |
| ------------------------------ | ------------------------------- | ------------------------------------------------ |
| `/healthz`, `/readyz`          | none                            | none                                             |
| `/api/auth/*` (GET, POST)      | Better Auth                     | edge, origin, 16 KB body cap, Better Auth limits |
| `/api/config`, `/api/public/*` | anyone (pay link, grant token)  | edge, origin, per-IP limits                      |
| `/api/desk/*`                  | desk session cookie¹            | edge, origin, session, per-shop limits           |
| `/v1/*`                        | `sk_test_` / `sk_live_` / `ag_` | CORS `*` without credentials, key, per-key limit |

¹ With a verified email when `AUTH_REQUIRE_EMAIL_VERIFICATION` is on (the production default).

Edge: when `EDGE_SHARED_SECRET` is set, `x-shade-edge` must match (else 403 `FORBIDDEN_ORIGIN`). Origin: unsafe
methods need `Origin` = `APP_ORIGIN` (outside production also its `localhost` ⇄ `127.0.0.1` twin) or, with no
`Origin`, `Sec-Fetch-Site: same-origin`. Per shop: `desk:req` 600/min, `desk:mut` 120/min. Per key: `v1:key`
600/min. Per IP: `v1:auth:ip` 60 failed `/v1` authentications a minute (then 429; valid keys never count).

Every response carries `cache-control: no-store`, `x-request-id` (an inbound `X-Request-Id` matching
`^[A-Za-z0-9._:-]{1,64}$` is kept) and Hono's secure headers. Request bodies: at most 16 KB (413); a non-empty body
must be `application/json` (415); an empty body validates as `{}`. Lists are `Page<T> = { items, next_cursor }` with
`?cursor=&limit=` (default 25, 1–100). A `/v1` key sees only its own network: other resources are 404.

**Health.** `GET /healthz` → `{ ok: true }` (the Docker `HEALTHCHECK`). `GET /readyz` →
`{ ok, database, pending_migrations, workers: { <loop>: { last_seen_at, age_sec } } }` for the loops `detector`,
`promotion`, `outbox` and `sweeper`; 503 when the database is down or a migration is pending. Worker age is reported,
not judged.

**`/api/auth/*`** is Better Auth's own handler and error shape: `/sign-up/email` (5 per hour per IP), `/sign-in/email`
(5/min), `/sign-out`, `/get-session`, `/verify-email` (mailed link), `/request-password-reset` (3/h), `/reset-password`,
`/send-verification-email` (3/h); other paths 100/min.

**Public (`/api`)**

| Method | Path                        | Purpose                                        | Limit                       |
| ------ | --------------------------- | ---------------------------------------------- | --------------------------- |
| GET    | `/config`                   | `AppConfig` for the SPA                        | none                        |
| GET    | `/public/invoices/:id`      | `PublicInvoice` for the pay page               | 120/min per IP              |
| POST   | `/public/invoices/:id/txid` | payer pastes a txid → `paid_unverified` (§4.8) | 10/min/IP; 5/10 min/invoice |
| POST   | `/public/grants/view`       | `{ token }` → `GrantView`                      | 30/min per IP (shared)      |
| POST   | `/public/grants/export`     | `{ token }` → CSV; 410 once revoked or expired | 30/min per IP (shared)      |

**Desk (`/api/desk`).** F = fresh session (created within 15 min, else 403 `SESSION_NOT_FRESH`). List routes take
`?network=`, defaulting to the shop's current network; tags and keys default to every network.

| Method | Path                                 | Purpose                                                                              | Notes             |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------ | ----------------- |
| GET    | `/me`                                | `Me`: user, shop, networks, hosted detection                                         |                   |
| PUT    | `/settings/profile`                  | shop display name                                                                    |                   |
| PUT    | `/settings/address`                  | receive address per network (§6.5)                                                   | F                 |
| PUT    | `/settings/network`                  | desk network                                                                         | F for mainnet     |
| GET    | `/invoices`                          | non-jar invoices (`?status=`, paged)                                                 |                   |
| POST   | `/invoices`                          | create on the desk network                                                           | 201               |
| POST   | `/invoices/:id/cancel`               | cancel an open invoice, or a jar charge                                              |                   |
| POST   | `/invoices/:id/accept`               | Confirm a payer claim, or with `{ txid }` record a payment (`merchant_accept`, §4.8) |                   |
| POST   | `/invoices/:id/reject`               | reject a payer claim (back to `open`)                                                |                   |
| GET    | `/jars`                              | jars: open first, at most 200                                                        |                   |
| POST   | `/jars`                              | create                                                                               | 201               |
| POST   | `/jars/:id/kill`                     | kill                                                                                 |                   |
| GET    | `/jars/:id/charges`                  | charges (paged)                                                                      |                   |
| POST   | `/jars/:id/charges/:chargeId/cancel` | refund a charge to the cap; returns the jar                                          | open jars only    |
| GET    | `/grants`                            | grants: active first, at most 200                                                    |                   |
| POST   | `/grants`                            | create; `token` and `view_url` shown once                                            | 201; F if > 1 day |
| POST   | `/grants/:id/revoke`                 | revoke                                                                               |                   |
| GET    | `/webhooks`                          | endpoints (deleted ones hidden)                                                      |                   |
| POST   | `/webhooks`                          | add an endpoint; `secret` shown once                                                 | 201; F            |
| POST   | `/webhooks/test`                     | send `webhook.test` to enabled endpoints                                             | 5/min             |
| GET    | `/webhooks/deliveries`               | delivery log (paged)                                                                 |                   |
| DELETE | `/webhooks/:id`                      | delete; cancels its queued deliveries                                                | 204               |
| GET    | `/tags`                              | claimed `name.shade` handles                                                         |                   |
| POST   | `/tags`                              | claim a name on the desk network                                                     | 201               |
| GET    | `/keys`                              | API keys (no tokens): live first, at most 200                                        |                   |
| POST   | `/keys`                              | issue a key; `token` shown once                                                      | 201; F; 10/h      |
| POST   | `/keys/:id/revoke`                   | revoke                                                                               |                   |
| GET    | `/viewing-keys`                      | `ViewingKeyStatus` per network                                                       |                   |
| PUT    | `/viewing-keys/:network`             | upload a UFVK, sealed to the worker                                                  | F                 |
| DELETE | `/viewing-keys/:network`             | delete (sealed key wiped)                                                            | 204               |

**`/v1`.** CORS allows `GET, POST, DELETE, OPTIONS`, request headers `authorization, content-type, idempotency-key,
accept`, exposes `x-request-id, retry-after, idempotent-replayed`, max-age 600. Agent keys get 403 `FORBIDDEN` on
everything except `POST /v1/jars/<their jar>/charge` and `GET /v1/jars/<their jar>`; merchant keys may charge too. I =
`Idempotency-Key` honoured.

| Method | Path                          | Purpose                                                      | Notes                   |
| ------ | ----------------------------- | ------------------------------------------------------------ | ----------------------- |
| GET    | `/v1/tags/:name`              | resolve `name.shade` (no key needed)                         | 60/min per IP           |
| POST   | `/v1/invoices`                | create                                                       | 201; I                  |
| GET    | `/v1/invoices`                | list non-jar invoices (`?status=`, `?expires_after=`, paged) |                         |
| GET    | `/v1/invoices/:id`            | get                                                          |                         |
| POST   | `/v1/invoices/:id/cancel`     | cancel an open invoice, or a jar charge                      |                         |
| POST   | `/v1/invoices/:id/detections` | report a match from the merchant's own scanner               | settles through §4.8    |
| POST   | `/v1/jars`                    | create                                                       | 201; I                  |
| GET    | `/v1/jars/:id`                | one jar (its own agent key may read it)                      |                         |
| POST   | `/v1/jars/:id/charge`         | charge against the cap → `JarChargeResult`                   | 201; I; 402 `JAR_EMPTY` |
| POST   | `/v1/jars/:id/kill`           | kill                                                         |                         |
| POST   | `/v1/grants`                  | create; `token` and `view_url` shown once                    | 201                     |
| POST   | `/v1/grants/:id/revoke`       | revoke                                                       |                         |
| POST   | `/v1/webhooks`                | add an endpoint; `secret` shown once                         | 201                     |
| GET    | `/v1/webhooks`                | the key network's endpoints (no secrets)                     |                         |
| DELETE | `/v1/webhooks/:id`            | delete; cancels its queued deliveries                        | 204                     |
| POST   | `/v1/tags`                    | claim a name                                                 | 201                     |

#### Webhook events

Types (`WebhookEventType`): `invoice.paid`, enqueued by `services/settlement.ts` in the transaction that settles the
invoice (a unique index keeps it to one per invoice), and `webhook.test`, enqueued by the desk Send test. Body
(`WebhookEvent`, stored once and re-sent byte for byte on every attempt):

`id` (`evt_…`), `type`, `created_at`, `network`, `invoice_id`, `amount_zec`, `memo_hash`, `txid`, `paid_at`,
`verification` (`ivk_scan` or `merchant_accept`). On `webhook.test` every field from `invoice_id` on is null.

Request headers: `content-type: application/json`, `user-agent: Shade-Webhooks/1`, `X-Shade-Event-Id`,
`X-Shade-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>` and
`X-Shade-Signature-V2: t=<unix seconds of this attempt>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`. The HMAC
key is the UTF-8 encoding of the whole `whsec_…` string (`platform/webhook-signing.ts`). Any 2xx is delivered; a
redirect is a failure; 410 turns the endpoint off. The SDK's `verifyWebhook` requires V2 (default tolerance 300 s) and
accepts the body-only signature only with `allowLegacySignature` when V2 is absent: that signature never expires.

#### API errors

Every non-2xx JSON answer outside `/api/auth/*` is `ApiErrorBody`:
`{ error, message, request_id, issues?, remaining_zec?, retry_after? }`. `issues` (on `INVALID_REQUEST`) holds field
paths and messages, never the submitted value; `remaining_zec` comes with `JAR_EMPTY` and `JAR_CLOSED`; `retry_after`
and a `retry-after` header come with 429 and 503. The catalogue is `backend/src/contract/errors.ts` (each code's status
is in its comment; the code throws exactly those). The frontend adds `NETWORK_ERROR` and `UNEXPECTED_RESPONSE`
client-side (`frontend/src/api/client.ts`); the SDK has its own client codes (`backend/sdk/src/errors.ts`).

| Status | Codes                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`, `BAD_ADDRESS`, `BAD_AMOUNT`, `BAD_MEMO`, `BAD_TAG`, `BAD_EXPIRY`, `BAD_LABEL`,  |
|        | `BAD_SCOPE`, `BAD_DURATION`, `BAD_TXID`, `BAD_MEMO_HASH`, `BAD_POOL`, `BAD_URL`, `BAD_VIEWING_KEY` |
| 401    | `UNAUTHORIZED`                                                                                     |
| 402    | `JAR_EMPTY`                                                                                        |
| 403    | `FORBIDDEN`, `FORBIDDEN_ORIGIN`, `EMAIL_UNVERIFIED`, `SESSION_NOT_FRESH`, `NETWORK_DISABLED`       |
| 404    | `NOT_FOUND`, `TX_NOT_FOUND`                                                                        |
| 409    | `IDEMPOTENCY_IN_PROGRESS`, `NO_ADDRESS`, `ADDRESS_MANAGED_BY_KEY`, `NOT_OPEN`, `PAYMENT_PENDING`,  |
|        | `ALREADY_PAID`, `EXPIRED`, `CANCELLED`, `TXID_IN_USE`, `TX_NOT_MINED`, `JAR_CLOSED`, `TAG_TAKEN`,  |
|        | `TAG_LIMIT`, `INVOICE_LIMIT`, `JAR_LIMIT`, `GRANT_LIMIT`, `ENDPOINT_LIMIT`, `NO_ENDPOINTS`,        |
|        | `HOSTED_DETECTION_DISABLED`                                                                        |
| 410    | `GRANT_REVOKED`, `GRANT_EXPIRED`                                                                   |
| 413    | `PAYLOAD_TOO_LARGE`                                                                                |
| 415    | `UNSUPPORTED_MEDIA_TYPE`                                                                           |
| 422    | `IDEMPOTENCY_MISMATCH`, `VIEWING_KEY_ADDRESS_MISMATCH`, `TX_NOT_SHIELDED`, `AMOUNT_MISMATCH`,      |
|        | `MEMO_MISMATCH`, `OUTSIDE_WINDOW`                                                                  |
| 429    | `RATE_LIMITED`                                                                                     |
| 500    | `INTERNAL`                                                                                         |
| 503    | `CHAIN_UNAVAILABLE`                                                                                |

---

## 5. Security and privacy rules (non-negotiable)

1. Never store seeds or spending keys. Reject them on input with a plain message; never echo or log them.
2. Never log memos, tokens, API keys, grant tokens, webhook secrets, viewing keys, passwords or request bodies. Never log
   txids, amounts or memo hashes together with merchant or invoice ids.
3. Viewing keys: sealed to the worker's X25519 key (the API tier cannot decrypt), wiped on delete, UI discloses what a
   UFVK reveals. Decrypted memos stay inside `zcash/scanner.ts`.
4. Secrets shown once: API keys, grant tokens, webhook secrets. Tokens are high-entropy and stored as SHA-256.
5. Webhooks: no payer address, no memo plaintext; SSRF-safe egress only through `platform/ssrf.ts`.
6. Public pay data is minimal (`PublicInvoice`): no tag, jar, txid, claim or memo hash.
7. Grant tokens travel in the URL fragment and request bodies, never paths or query strings. Pay and view pages get
   `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow` from `frontend/vercel.json` (the Vite dev
   server and the API send neither, so another static host must add them); `robots.txt` disallows them too.
8. Production refuses to boot without `DATABASE_URL`, `APP_ORIGIN`, `BETTER_AUTH_SECRET`, `SHADE_ENCRYPTION_KEY`; refuses
   private webhook targets; refuses a console mail transport when email verification is required. In any environment,
   `MAIL_TRANSPORT=resend` refuses to boot without `RESEND_API_KEY` and a `MAIL_FROM` on a public domain (localhost,
   reserved and IP domains are refused).
9. Rate limits on every public and authenticated surface (Postgres fixed windows; Better Auth database storage).
10. Copy: never show Groth16, Halo, nullifier, proving key, note commitment, "generating proof", "syncing sapling tree",
    or raw enum values. Use `backend/src/contract/copy.ts`.
11. Privacy limits to state honestly: the lightwalletd operator sees which txids Shade looks up; pool-crossing payments
    reveal the crossing amount; one static UA links a merchant's pay pages for anyone who compares them.

---

## 6. Domain rules

### 6.1 Invoice state machine

`open → paid_unverified` (payer paste) · `open | paid_unverified → paid` (`ivk_scan` via scanner, or `merchant_accept`:
Confirm of the claimed tx, or Record payment with the merchant's own txid, once mined) · `paid_unverified → open`
(reject) · `open → cancelled` (refused while a payment is being confirmed) · `open → expired` (time) ·
`expired → paid` via scanner or Record payment, only when the block time is within 60 minutes of expiry. `paid` and `cancelled` are terminal. Jar charges are `authorized` (`jar_ledger`) and never payable.

### 6.2 Jars

Atomic debit (`spent + amount ≤ cap` and `status = open` in one statement). Over cap ⇒ `402 JAR_EMPTY`; killed ⇒
`409 JAR_CLOSED`. Agent retries are safe with `Idempotency-Key`.

### 6.3 Grants

Scope `all` or an invoice tag; only verified receipts and jar charges; 10 minutes – 90 days; revoke is immediate for
everything Shade serves (_Revoke stops new access from us. Delete the file on their machine too._). The view and the
CSV export return at most the newest 500 receipts (`RECEIPT_LIMIT`, `services/grants.ts`).

### 6.4 Per-merchant limits

Soft caps per merchant and network keep one account from growing shared work without bound (409, message shown as-is):
10,000 unpaid non-jar invoices (`open` and not yet past expiry, or `paid_unverified`) ⇒ `INVOICE_LIMIT`; 100 open jars ⇒
`JAR_LIMIT`; 100 active grants ⇒ `GRANT_LIMIT`. The counts run before the insert without a lock, so a concurrent burst
can pass a cap by a few rows. Two caps are exact (counted under the merchant row lock): 5 tag names per merchant across
networks ⇒ `TAG_LIMIT`, and 5 enabled webhook endpoints per network ⇒ `ENDPOINT_LIMIT`. Jar and grant lists return
at most 200 rows: every open jar or active grant first, then the newest ended ones, so a live row can always be killed
or revoked. The API-key list returns every live key, then at most 200 revoked ones. Desk requests are rate limited per merchant: `desk:req` 600/min for every request, `desk:mut` 120/min for
mutations, `desk:whtest` 5/min for Send test and `desk:keys` 10/h for issuing API keys. Desk polling is sized for it:
the Jars page polls only the jar list and refetches a jar's charges when its spend or charge count changes.

### 6.5 Receive addresses and viewing keys

Shade can only compare an address's Orchard receiver with the key's own address (`key_address`). It cannot tell
another diversified address of the same account from an address of another wallet.

- With _Use this key's address_ on (`use_key_address`, the upload default), the network's receive address is the
  key's address; `PUT /api/desk/settings/address` answers 409 `ADDRESS_MANAGED_BY_KEY`.
- Otherwise any shielded address is saved. When an active key exists and the address is not the key's own, the save
  succeeds with a `notice` that Shade cannot confirm the address belongs to the key (payments to another account's
  address are not detected).
- Uploading a key with the option off is refused with 422 `VIEWING_KEY_ADDRESS_MISMATCH` (the previous key and address
  stay) when an address is on file, it is not this key's own, and the key is not the one already active. Re-uploading
  the active key keeps its address.
- Re-uploading the **same** key (same fingerprint) keeps its scan progress (cursor height, hash and chain time), also
  after a delete within 90 days, so invoices that expired while the key was unusable are still matched. A key that
  never completed a scan keeps the time of its first upload instead (`scan_from`). This is the fix for
  `key_unavailable`. A different key uploaded in between starts fresh.

---

## 7. Configuration

See `backend/.env.example` for the full list with defaults. Key variables: `NODE_ENV`, `HOST`, `PORT`, `APP_ORIGIN`,
`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_SECRET`, `SHADE_ENCRYPTION_KEY`, `VIEWING_KEY_SEAL_PUBLIC_KEY`,
`VIEWING_KEY_SEAL_PRIVATE_KEYS`, `SHADE_NETWORKS`, `LIGHTWALLETD_TESTNET_URL`, `LIGHTWALLETD_MAINNET_URL`,
`SHADE_MIN_CONFIRMATIONS_TESTNET`, `SHADE_MIN_CONFIRMATIONS_MAINNET`, `SHADE_SCAN_INTERVAL_SEC`, `SHADE_WORKER`,
`MAIL_TRANSPORT`, `MAIL_FROM`, `RESEND_API_KEY`, `AUTH_REQUIRE_EMAIL_VERIFICATION`, `TRUST_PROXY`, `TRUST_PROXY_DIRECT`,
`EDGE_SHARED_SECRET`,
`SHADE_WEBHOOK_ALLOW_PRIVATE` (dev only), `EXPLORER_TX_URL_TESTNET`, `EXPLORER_TX_URL_MAINNET`, `LOG_LEVEL`. In
development, secrets and the seal keypair are generated into `backend/.data/dev-secrets.json`. `NODE_ENV` defaults to
`development`; only the Docker image sets `production`. `VIEWING_KEY_SEAL_PRIVATE_KEYS` belongs in the worker's
environment alone (docker compose reads it from `backend/.env.worker`, which only the worker service loads). The
frontend has no runtime configuration (only the dev-server `VITE_API_PROXY_TARGET` below); on Vercel, `vercel.json`
reads the `SHADE_EDGE_SECRET` project variable at the edge (§10).

Read outside `loadConfig`:

- `VITE_API_PROXY_TARGET` (`frontend/vite.config.ts`): dev-server proxy target for `/api` and `/v1`; default
  `http://127.0.0.1:8787`.
- `SHADE_API_URL` (`backend/src/bin/scan-local.ts`, `backend/sdk/examples/agent.ts`): Shade API origin; default
  `http://localhost:5173`, the dev proxy.
- `SHADE_API_KEY` (`scan-local.ts`): merchant key `sk_test_…` or `sk_live_…`; required, never printed.
- `SHADE_UFVK` (`scan-local.ts`): full viewing key of the receiving account; required, never printed or sent.
- `LIGHTWALLETD_TESTNET_URL`, `LIGHTWALLETD_MAINNET_URL` (`scan-local.ts`, read directly, not through `loadConfig`):
  light servers for the local scan; defaults as in §3.
- `SHADE_AGENT_KEY` (`backend/sdk/examples/agent.ts`, `demo:agent`): the jar's `ag_…` key; required, never printed.
- `SHADE_WEBHOOK_SECRET` (`backend/sdk/examples/receiver.ts`, `demo:receiver`): the endpoint's `whsec_…` secret.
- `POSTGRES_PASSWORD` (`backend/docker-compose.yml`, interpolation): bundled Postgres password, from the shell or
  `backend/.env`; default `shade`. The backend never reads it.
- `SHADE_EDGE_SECRET` (`frontend/vercel.json`, Vercel project variable): sent as `x-shade-edge`; the same value as the
  backend's `EDGE_SHARED_SECRET`.
- `TEST_DATABASE_URL` (the four `backend/test/**/*.pg.test.ts` suites): disposable Postgres for race tests; CI points
  it at a `postgres:17` service.
- `SHADE_LIVE_TESTS` (`backend/test/zcash/live.test.ts`): `1` runs the live checks against public light servers.
- `CI` (`frontend/playwright.config.ts`, set by GitHub Actions): no server reuse, one retry, HTML report.

The `npm` scripts for `scan:local`, `demo:agent` and `demo:receiver` load `backend/.env` when it exists
(`--env-file-if-exists`); a variable already in the environment wins. `NODE_ENV=test` (used by the e2e backend) means
an in-memory PGlite when `DATABASE_URL` is empty, secrets generated per process, worker off and no email verification
by default.

---

## 8. Development workflow

```bash
npm install                     # Node ≥ 24
npm run dev                     # backend :8787 (PGlite, inline worker) + frontend :5173 (proxying /api and /v1)
npm run typecheck && npm run lint && npm test
npm run build
npm run db:migrate              # against DATABASE_URL_UNPOOLED, else DATABASE_URL (else the dev PGlite)
npm run demo:agent -w @shade/backend -- --jar <jar_id>     # PRD §12 step 5 (SHADE_AGENT_KEY)
npm run demo:receiver -w @shade/backend                     # local webhook receiver (SHADE_WEBHOOK_SECRET)
npm run scan:local -w @shade/backend -- --network testnet   # merchant-device scanner (SHADE_API_KEY, SHADE_UFVK)
npm run -s keys:seal -w @shade/backend                      # seal keypair (-s keeps npm's banner out of redirects)
```

Rules for agents:

- Read this file, `prd.md`, and the module you touch. Keep changes inside the module's ownership; respect §4.2.
- The wire contract lives in `backend/src/contract`. Change it deliberately and update backend, frontend, SDK and docs
  together.
- Backend TypeScript must be erasable (no enums, parameter properties, namespaces); relative imports end in `.ts`.
- Never add a dependency without a reason recorded in the PR/commit message. Never add `console.*` to `backend/src`
  outside `bin/`.
- Tests are required for behavior changes. Chain-touching tests use the fake chain/scanner; live tests run only with
  `SHADE_LIVE_TESTS=1`.
- Commit messages follow the PRD prefixes where they fit: `inv: …`, `jar: …`, `grant: …`, `pay: …`, plus `chore:`,
  `docs:`, `test:`, `sec:`, `ci:`, `contract:`, `feat(<area>):` and `fix(<area>):`.
- **Formatting.** Prettier (`.prettierrc`): `printWidth: 100`, double quotes, semicolons, `trailingComma: "all"`.
  Markdown keeps its line breaks (prose is not rewrapped); `agents.md` and `README.md` wrap prose at 120 by hand.
  `.prettierignore` skips `prd.md`, `package-lock.json`, `frontend/src/routeTree.gen.ts`, build output and reports.
  Run `npm run format` before committing; CI fails on `format:check`.
- **Lint** (`eslint.config.mjs`, flat config): `@eslint/js` and typescript-eslint recommended, then
  `eslint-config-prettier` last. `@typescript-eslint/consistent-type-imports` is an error (with `verbatimModuleSyntax`,
  type-only imports must say `import type`). Unused variables are errors unless prefixed `_`; `eqeqeq` always, except
  `== null`. `no-console` is an error in `backend/src/**` except `bin/**` and tests; elsewhere it is off. In
  `frontend/src` the React Hooks rules apply and `react-refresh/only-export-components` warns.
- **TypeScript** (`tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `isolatedModules`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noEmit`, ES2023.
  Backend and SDK use `NodeNext` resolution: relative imports end in `.ts` (the SDK build rewrites them to `.js`). The
  frontend uses `Bundler` resolution and imports without extensions.
- **Aliases.** `@/` is `frontend/src`; frontend code imports through it, not `../`. `@shade/contract` is not a package:
  it resolves to `backend/src/contract/index.ts` through the same alias in `frontend/vite.config.ts`,
  `frontend/vitest.config.ts` and the `paths` of `frontend/tsconfig.json`. Change all three together. The contract is
  bundled into the browser, so it stays pure: types and constants, no imports from other layers or Node built-ins.
- **Generated routes.** `frontend/src/routeTree.gen.ts` is generated by `@tanstack/router-plugin` when Vite runs and is
  committed; never edit it. After adding or renaming a route file, run `npm run dev` or the frontend build so
  `typecheck` sees the new tree.
- **Files.** kebab-case file names everywhere. Frontend routes are flat dot-separated files (`desk.settings.keys.tsx`,
  `pay.$id.tsx`) that render pages from `src/features/<area>/<name>-page.tsx`; shared UI in `src/components`, helpers
  in `src/lib`, API calls and query options in `src/api`. Frontend tests sit next to their file (`*.test.ts(x)`);
  backend tests live in `backend/test/<layer>/`, real-Postgres suites are `*.pg.test.ts`. Each source file opens with
  a `/** … */` comment saying what it owns.
- **Names.** Services are `createXService(deps)` returning an `XService` interface. Ids are `newId(prefix)`:
  `<prefix>_` + 12 random bytes base64url (`inv`, `jar`, `grn`, `key`, `mer`, `tag`, `vk`, `det`, `evt`, `whd`, `whe`).
  Secrets carry their kind: `sk_test_`, `sk_live_`, `ag_`, `gv_`, `whsec_`. Wire JSON is snake_case, SDK results
  camelCase, error codes SCREAMING_SNAKE from `contract/errors.ts`, user-facing strings from `contract/copy.ts`.
  Rate-limit buckets are `<surface>:<what>[:<key>]` (`pub:inv:ip`, `v1:key`, `desk:mut`).

## 9. Validation requirements (definition of done for any change)

`npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass; new behavior has tests (happy and failure
paths); UI changes are checked at 390 px and desktop with keyboard navigation; no secrets, memos or keys in logs;
`agents.md`/README/docs updated when architecture, API, env vars or workflows change.

## 10. Production readiness checklist

- [ ] `NODE_ENV=production` in the process environment of the API and the worker. The Docker image sets it;
      `npm start -w @shade/backend`, `npm run worker -w @shade/backend` and `backend/.env.example` do not. Without
      it the backend boots in development mode (no email verification, cookies without `Secure`, inline worker,
      generated secrets in `backend/.data/`).
- [ ] `DATABASE_URL` (pooled) + `DATABASE_URL_UNPOOLED` set; `npm run db:migrate` run as a release step.
- [ ] `APP_ORIGIN`, `BETTER_AUTH_SECRET`, `SHADE_ENCRYPTION_KEY` set.
- [ ] Seal keypair generated with `npm run -s keys:seal -w @shade/backend` (`-s` keeps npm's banner out of a
      redirected env file). `VIEWING_KEY_SEAL_PUBLIC_KEY` on the API; `VIEWING_KEY_SEAL_PRIVATE_KEYS` only in the
      worker's environment (docker compose: `backend/.env.worker`, never the shared `backend/.env`).
- [ ] Mail: `MAIL_TRANSPORT=resend` with `RESEND_API_KEY` and a `MAIL_FROM` on a domain verified in Resend (boot
      refuses a missing sender and localhost, reserved or IP domains). Production refuses `console` while email
      verification is on, so the `.env.example` value does not boot; `AUTH_REQUIRE_EMAIL_VERIFICATION=false` is for a
      local trial only.
- [ ] Worker running as its own process with the seal private key in its environment only: a separate Railway service
      (§12.5), the compose `worker` service with `backend/.env.worker`, or from `backend/`
      `node --env-file=.env --env-file=.env.worker src/bin/worker.ts` (`npm run worker -w @shade/backend` loads only
      `backend/.env`); heartbeat visible in `/readyz`.
- [ ] Frontend proxies `/api/*` and `/v1/*` to the backend (`dest` of the `vercel.json` routes); CSP and security
      headers active.
- [ ] Client IPs behind the Vercel proxy: `EDGE_SHARED_SECRET` (16+ chars) on the API, with the same value in the
      Vercel project variable `SHADE_EDGE_SECRET` that `vercel.json` sends as `x-shade-edge` (never commit the value;
      deploy the frontend first, since the backend then refuses `/api/*` without the header), plus the client-IP
      header for the backend host. On Railway: `TRUST_PROXY_DIRECT=x-real-ip` (Railway's edge overwrites
      `X-Forwarded-For` and `X-Real-IP` with the connecting address: Vercel's egress for proxied requests, the real
      caller for direct `/v1` ones), and `TRUST_PROXY=x-vercel-forwarded-for` only once the §12.8 check shows Vercel
      sends that header and overwrites a client's value; until then `TRUST_PROXY=none` (proxied users share a bucket
      per Vercel egress address). On a host that passes Vercel's headers through, `TRUST_PROXY=x-forwarded-for`.
      `TRUST_PROXY` without the edge secret lets direct callers forge the header. The API logs a boot warning in
      production for a collapsed or forgeable setup, and its client-IP sources at every boot.
- [ ] Mainnet only after `SHADE_NETWORKS=testnet,mainnet` is set deliberately; confirmations reviewed.
- [ ] Own lightwalletd/Zaino for mainnet privacy (public operators see looked-up txids).

---

## 11. Testing and CI

### 11.1 Layout

| Path                                | Project    | Covers                                                            |
| ----------------------------------- | ---------- | ----------------------------------------------------------------- |
| `backend/test/http`                 | `backend`  | HTTP contract through the real app: `app`, `desk`, `public`, `v1` |
| `backend/test/services`             | `backend`  | domain services: settlement, jars, grants, limits, webhooks, …    |
| `backend/test/platform`             | `backend`  | config, crypto, db, migrations, middleware, SSRF, auth, …         |
| `backend/test/worker`               | `backend`  | detector, matching, promotion, outbox, sweeper, local scan, CLIs  |
| `backend/test/zcash`                | `backend`  | codecs vs test vectors, tx parser, light-server client, scanner   |
| `backend/**/*.pg.test.ts`           | `backend`  | races on real Postgres; skipped without `TEST_DATABASE_URL`       |
| `backend/test/sdk-contract.test.ts` | `backend`  | the real SDK against the real app, every field vs the wire body   |
| `backend/sdk/test`                  | `sdk`      | client, webhook verification, example scripts run as processes    |
| `frontend/src/**/*.test.ts(x)`      | `frontend` | components and pages (Testing Library on happy-dom)               |
| `frontend/e2e`                      | Playwright | merchant-loop smoke; pay page at 320, 390 and 1280 px             |

Support code: `backend/test/support/harness.ts` builds in-memory PGlite with every migration (`test-db.ts` clones one
migrated image per process), the fake chain and scanner (`fake-chain.ts`; it refuses `NODE_ENV=production`), a
capturing mailer, real services, real Better Auth and the real Hono app, and a clock tests can advance.
`backend/test/zcash/grpc-replay.ts` is a local HTTP/2 server replaying recorded lightwalletd answers. Fixtures live in
`backend/test/fixtures/zcash` (`vectors/`, recorded lightwalletd responses, transactions, Ironwood notes).
`test/platform/postgres-path.test.ts` drives the production `pg` Pool over the wire protocol into PGlite.
`scanner-native.test.ts` loads the real `@ledgerhq/zcash-utils` binary and skips where it cannot load.
`frontend/src/index-html.test.ts` checks `index.html` (no third-party URLs), `robots.txt`, the `vercel.json` routes
(for whatever https backend origin they point at) and the root `.vercelignore` allowlist.
`frontend/src/features/docs/docs-content.test.ts` fails when the `/docs` endpoint table and the routes registered in
`backend/src/http/v1.ts` differ.
`frontend/e2e/smoke.spec.ts` signs up, sets an address, creates an invoice, then opens the pay page and a grant view;
`pay-layout.spec.ts` mocks the API in the browser and needs only the Vite server.

### 11.2 Running

- `npm test` runs `vitest run` at the root; `vitest.config.ts` has `projects: ["backend", "backend/sdk", "frontend"]`,
  named `backend`, `sdk` and `frontend`. One project: `npx vitest run --project backend [filter]`.
- Backend and SDK run in `node`, backend with 30 s test and 60 s hook timeouts. The frontend runs in `happy-dom` with
  `src/test/setup.ts` (no Vitest globals, so it registers Testing Library cleanup and restores mocks, stubbed globals
  and the URL after each test).
- Real Postgres: set `TEST_DATABASE_URL` to a disposable database. The four `*.pg.test.ts` suites (`test/pg/server`,
  `test/pg/services`, `test/platform/platform`, `test/worker/worker`) each create their own schema through
  `options=-c search_path=<schema>`, migrate it and drop it; `test/pg/services` pauses transactions at chosen
  statements to force interleavings.
- Live testnet checks: `SHADE_LIVE_TESTS=1 npx vitest run --project backend test/zcash/live` (network required; keys
  come from the library's test-only derivation of the public BIP-39 test mnemonic).
- `npm run test:e2e` (first `npx playwright install chromium`): Chromium, one worker, 90 s per test. Playwright starts
  the backend with `node src/bin/server.ts` in `backend/` (not `npm run dev`, which would load `backend/.env`) with
  `NODE_ENV=test`, empty `DATABASE_URL` (in-memory PGlite), `SHADE_WORKER=off`, no email verification and console
  mail, then the Vite dev server. Outside CI `reuseExistingServer` is on: with `npm run dev` running, the tests use it
  and write to the development database, so stop it first. In CI: no reuse, one retry, an HTML report.
- `npm run format:check` (`prettier --check .`) is the first CI gate after `npm ci`; `npm run format` rewrites.

### 11.3 CI (`.github/workflows/ci.yml`)

Runs on pushes to `main` and on pull requests; read-only token; one run per ref (older runs cancelled); actions pinned
by commit SHA; 20 min per job; Node 24 with the npm cache.

| Job      | Needs   | Steps (each one guards something)                                                       |
| -------- | ------- | --------------------------------------------------------------------------------------- |
| `check`  |         | `npm ci`, `format:check`, `lint`, `typecheck`, `test`, `build`; a `postgres:17` service |
|          |         | provides `TEST_DATABASE_URL`, so the race suites run                                    |
| `docker` | `check` | secret env files are gitignored and the `.example` files are not; compose gives the     |
|          |         | seal private key to the worker only (below); `docker build`; the native scanner reaches |
|          |         | `testnet.zec.rocks` from inside the image (glibc, CA bundle) and sees a tip above       |
|          |         | 4,000,000; the image refuses to boot with no configuration                              |
| `e2e`    | `check` | `npm ci`, `npx playwright install --with-deps chromium`, `npm run test:e2e`; on failure |
|          |         | uploads `frontend/playwright-report` (kept 7 days)                                      |

`.github/workflows/live.yml` runs the live light-server and scanner checks (`SHADE_LIVE_TESTS=1`) daily and on demand:
the chain changes without a commit (a network upgrade the pinned scanner cannot parse, a light server that stops
answering). On 2026-10-06 it fails on the Zaino testnet fallback (HTTP 503, §3) until that server returns or is
replaced in `DEFAULT_LIGHTWALLETD_URLS`.

`.github/scripts/check-compose-env.mjs` reads `docker compose config --format json` after CI copies `.env.example` to
`.env`, plants `VIEWING_KEY_SEAL_PRIVATE_KEYS` in that shared file and writes a different value to `.env.worker`. It
fails unless `migrate` and `api` receive no seal private key, `worker` receives the `.env.worker` value, and all three
point `DATABASE_URL` and `DATABASE_URL_UNPOOLED` at the bundled Postgres. The `ci` workflow never sets
`SHADE_LIVE_TESTS`; its one live network call is the docker job's scanner check.

---

## 12. Deployment

The procedure; §10 is the checklist it must satisfy. Topology: a static SPA host that proxies `/api/*` and `/v1/*`, one
backend image run as two processes (API and worker), and Postgres. Reference deploy: **Vercel** (SPA), **Railway**
(API and worker, two services from `backend/Dockerfile`), **Neon** (Postgres) and **Resend** (mail), all driven from
their CLIs (`vercel`, `railway`, `neon`, `resend`) at the repository root. Railway and Vercel CLI facts below were
checked against their docs and CLI sources on 2026-10-06 (`@railway/cli` 5.63.3, `vercel` 62.4.0, `neon` 8.0.11,
`resend-cli` 2.23.0); re-check before relying on a flag.

**Order.** (1) Fix the public web origin (`APP_ORIGIN`): every backend process, the pre-deploy migration included,
refuses to boot without it. Use the custom domain, or create the Vercel project first (§12.7 steps 1-2) and read its
production domain; project names on `vercel.app` are first come, first served. (2) Neon (§12.1). (3) Resend (§12.4).
(4) Railway: create, configure, set variables, deploy the API then the worker (§12.5). (5) Vercel: point `vercel.json`
at the API, deploy (§12.7). (6) Edge secret: Vercel first, then the Railway API, then redeploy the API (§12.7 step 4).
(7) Checks (§12.8). Changing `APP_ORIGIN` later needs a redeploy of both Railway services.

### 12.1 Database (Neon)

- Any Postgres 15+. `DATABASE_URL` is the pooled URL the API and worker use (`pg` pool, 10 connections per process).
  `DATABASE_URL_UNPOOLED` is the direct URL; `db:migrate` prefers it and then holds a session advisory lock for the
  whole run. Without it each migration file takes a transaction-scoped lock instead (a transaction-mode pooler would
  pin a session lock to a random server connection). Nothing else in Shade needs session state, so Neon's PgBouncer
  pooler (transaction mode) is fine for `DATABASE_URL`.
- Neon: `neon projects create --name shade --region-id aws-us-east-1 --pg-version 17 --org-id <org> --no-secrets
--output json` (pg 17 matches CI; aws-us-east-1 pairs with Railway `us-east4-eqdc4a`; `neon orgs list` gives the
  org). URLs: `neon cs --project-id <id> --pooled --ssl verify-full` (pooled) and
  `neon cs --project-id <id> --ssl verify-full` (direct), piped straight into `railway variable set … --stdin`. Use
  `sslmode=verify-full`: `pg` treats `require` as verify-full anyway but prints a warning; `channel_binding=require` is
  ignored by `pg`; never add `sslrootcert=system` (`pg` would read a file named `system`). Do not run
  `neon set-context` or `neon link` in the repo (they write `.neon` and edit `.gitignore`).
- The worker queries every 20 s, so the compute never scales to zero: the Free plan's 100 CU-hours last about 16
  days at 0.25 CU, then the database is suspended until the next month. Launch (about $20/month at 0.25 CU) for
  anything longer.
- Release step, before new API or worker processes start: `node src/bin/migrate.ts` (the Railway pre-deploy command,
  §12.5) or `npm run db:migrate`. It loads the full production config. It applies pending files, then repairs pre-v1
  receive addresses. Exit 0 up to date, 1 failed, 2 bad config. On Postgres the API and the worker refuse to start
  while a migration is pending; concurrent runners are serialised.

### 12.2 Secrets and variables

| Variable                                | API | Worker | Value                                                                   |
| --------------------------------------- | --- | ------ | ----------------------------------------------------------------------- |
| `APP_ORIGIN`                            | ✓   | ✓      | the public web origin exactly (`https://host`, no path), decided first  |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | ✓   | ✓      | Neon pooled / direct, `sslmode=verify-full`                             |
| `BETTER_AUTH_SECRET`                    | ✓   | ✓      | 32+ chars (`.env.example` one-liner)                                    |
| `SHADE_ENCRYPTION_KEY`                  | ✓   | ✓      | 32 bytes base64 (`.env.example` one-liner); encrypts webhook secrets    |
| `MAIL_TRANSPORT`, `MAIL_FROM`           | ✓   | ✓      | `resend`; `Shade <no-reply@<verified domain>>` (never `resend.dev`)     |
| `RESEND_API_KEY`                        | ✓   | ✓      | a `sending_access` key for that domain (§12.4)                          |
| `SHADE_NETWORKS`                        | ✓   | ✓      | `testnet` (mainnet only deliberately)                                   |
| `PORT`                                  | ✓   |        | `8787` (Railway injects its own otherwise)                              |
| `TRUST_PROXY_DIRECT`                    | ✓   |        | `x-real-ip` on Railway, from the start (Railway's edge sets it)         |
| `EDGE_SHARED_SECRET`                    | ✓   |        | the Vercel `SHADE_EDGE_SECRET` value, after the frontend has it (§12.7) |
| `TRUST_PROXY`                           | ✓   |        | `none`; `x-vercel-forwarded-for` only after the §12.8 check passes      |
| `VIEWING_KEY_SEAL_PUBLIC_KEY`           | ✓   | (opt.) | hosted detection only (`npm run -s keys:seal -w @shade/backend`)        |
| `VIEWING_KEY_SEAL_PRIVATE_KEYS`         |     | ✓      | hosted detection only; **never** on the API or as a shared variable     |

`NODE_ENV=production` comes from the image. The worker reads no proxy settings and needs no seal public key (when both
halves are set, boot checks that they match). Keep `BETTER_AUTH_SECRET`, `SHADE_ENCRYPTION_KEY`, the edge secret and
the seal private key in a password manager: losing the encryption key makes every webhook secret unreadable, losing
the seal private key every uploaded viewing key. Seal rotation: new public key on the API, new private key first in
the worker's comma list, old keys kept while viewing keys sealed to them remain. Without a public key in production,
hosted detection is off (`features.hosted_detection: false`, upload is 409 `HOSTED_DETECTION_DISABLED`). For
`docker run` and compose the same values live in `backend/.env` and (worker only) `backend/.env.worker`; never an empty
`NODE_ENV=` line.

Secrets never go on a command line: pipe them (`printf %s "$V" | railway variable set KEY --stdin --service <svc>
--skip-deploys`, `printf %s "$V" | vercel env add KEY production --sensitive --force --yes`). Never run
`railway variable list` (it prints values), `railway run env` or `printenv` against these services; list keys only.

### 12.3 Backend image (`backend/Dockerfile`)

- Build from the repository root: `docker build -f backend/Dockerfile -t shade-backend .`. `.dockerignore` sends only
  the workspace manifests, the lockfile, `backend/src` and `backend/migrations` (never `.env*`, `.data` or tests).
- `node:24-bookworm-slim` plus `ca-certificates` (the native scanner reads the system CA bundle; glibc ≥ 2.34),
  `NODE_ENV=production`, `npm ci --omit=dev --omit=optional --workspace=@shade/backend --ignore-scripts`, user `node`,
  `WORKDIR /app/backend`, port 8787, `HEALTHCHECK` on `/healthz` (for the API; the worker serves no HTTP). No build
  step: Node 24 runs the TypeScript sources.
- API: `node src/bin/server.ts` (the default CMD; binds 0.0.0.0 in production). Worker: `node src/bin/worker.ts`.
  Migrations: `node src/bin/migrate.ts`. The worker requires `DATABASE_URL` (exit 2 without it). On SIGTERM the API
  stops within 15 s and the worker within 30 s. Worker loops claim work under leases (a scan lease per viewing key, a
  lease per webhook delivery) and start after a jittered delay that spreads replicas (`worker/index.ts`), so an old
  and a new worker overlapping during a deploy is safe.
- Plain Docker: `docker run --env-file backend/.env -p 8787:8787 shade-backend` (API) and
  `docker run --no-healthcheck --env-file backend/.env --env-file backend/.env.worker shade-backend node src/bin/worker.ts`
  (worker). Outside Docker, set `NODE_ENV=production` in both processes and start the worker from `backend/` with
  `node --env-file=.env --env-file=.env.worker src/bin/worker.ts` (`npm run worker` loads only `backend/.env`).

### 12.4 Mail (Resend)

Both Railway services refuse to boot without `MAIL_TRANSPORT=resend`, `RESEND_API_KEY` and a `MAIL_FROM` on a public
domain, so this comes before §12.5. Boot cannot tell whether Resend verified the domain, and auth mail errors are only
logged, so verify before sign-ups matter.

1. The user creates a first `full_access` key in the Resend dashboard and runs `resend login` (the CLI cannot mint
   its own first key).
2. `resend domains create --name <mail domain> --region us-east-1` (a subdomain such as `mail.<domain>` keeps the
   apex's mail records separate). Add the printed records (DKIM `TXT resend._domainkey…`, `MX send…` to
   `feedback-smtp.us-east-1.amazonses.com` priority 10, `TXT send…` `v=spf1 include:amazonses.com ~all`, and a
   `_dmarc` TXT) at the DNS host; with Vercel DNS, `vercel dns add <zone> <name> <type> <value> [priority]`.
3. `resend domains verify <id>`, then poll `resend domains get <id> --json` until `verified`. Turn tracking off (auth
   mail in a privacy product): `resend domains update <id> --no-open-tracking --no-click-tracking`.
4. Shade's key: `resend api-keys create --name shade-prod --permission sending_access --domain-id <id> --json`, piped
   into `railway variable set RESEND_API_KEY --stdin` for both services (the token is shown once). `MAIL_FROM` is
   `Shade <no-reply@<mail domain>>`. Free plan: 100 emails a day, 3,000 a month.

### 12.5 Railway (API and worker)

Two services in one project, `api` and `worker`, both built from `backend/Dockerfile` with the repository root as the
Docker context and deployed from the local tree with `railway up`. Plan: Hobby (two always-on processes; the Free plan's
limits do not fit). Region: `us-east4-eqdc4a`, next to Neon aws-us-east-1.

- **No `railway.json`/`railway.toml`.** Railway closed Config as Code to new services (files stop being read on
  2026-12-01); a committed file would be ignored. Service settings are an environment patch applied with the CLI.
- **Create** (from the repo root): `railway init --name shade --workspace <id> --json`, `railway add --service api
--json`, `railway add --service worker --json`, then `railway status --json` for the environment and service ids.
  `railway add` re-links the directory to the newest service, so every later command passes `--service`.
- **Configure** with a JSON patch on stdin, keyed by service **id** (the `--service-config` flag form is ignored when
  stdin is not a terminal, i.e. from scripts and agents):

  ```bash
  railway environment edit --json -m "shade services" <<'JSON'
  {"services":{
    "<API_ID>":{"build":{"builder":"DOCKERFILE","dockerfilePath":"backend/Dockerfile"},
      "deploy":{"preDeployCommand":["node /app/backend/src/bin/migrate.ts"],"healthcheckPath":"/healthz",
        "healthcheckTimeout":120,"restartPolicyType":"ON_FAILURE","restartPolicyMaxRetries":10,
        "sleepApplication":false,"drainingSeconds":20}},
    "<WORKER_ID>":{"build":{"builder":"DOCKERFILE","dockerfilePath":"backend/Dockerfile"},
      "deploy":{"startCommand":"node /app/backend/src/bin/worker.ts",
        "preDeployCommand":["node /app/backend/src/bin/migrate.ts"],"restartPolicyType":"ALWAYS",
        "sleepApplication":false,"drainingSeconds":35}}}}
  JSON
  ```

  Then verify with `railway environment config --json` (unknown keys are dropped silently). The API keeps the image
  CMD; the worker's start command is exec form (no shell). The healthcheck runs on the API only: the worker has no
  HTTP server, and a healthcheck path would fail its deploy. `drainingSeconds` covers the 15 s / 30 s shutdowns
  (Railway's default grace is 0). Both services run the migrator as their pre-deploy command (idempotent and
  serialised); a failing migration stops that deploy and the old version keeps running. Region:
  `railway scale --service api us-east=1` and the same for `worker`, removing any other region (`<region>=0`).

- **Variables** per service (§12.2) with `railway variable set … --service <svc> --skip-deploys`, secrets through
  `--stdin`; leave `EDGE_SHARED_SECRET` and `TRUST_PROXY` for §12.7. Also `RAILWAY_DOCKERFILE_PATH=backend/Dockerfile`
  on both as a fallback for the build setting.
- **Deploy** the API, then the worker: `railway up --service api --ci`, then `railway up --service worker --ci`.
  `--ci` waits for the result (exit 0 on SUCCESS); without it a non-terminal run returns right after the upload.
  `railway up` uploads the repository root minus `.gitignore`d paths (`.env*`, `.data`, `.claude` stay local). Check
  `railway status --json` first: an unlinked `railway up` started by an agent creates a new project.
- **Domain**: `railway domain --service api --port 8787 --json` gives `https://<name>.up.railway.app`, the `dest`
  origin for `frontend/vercel.json`. The worker gets no domain. Logs: `railway logs --service api -n 200`,
  `railway logs --service api --build --latest`, `railway logs --service api --http --json`. Redeploy without an
  upload: `railway redeploy --service api --yes`.
- Railway's edge overwrites `X-Forwarded-For` and `X-Real-IP` with the connecting address (staff, 2026-10; "current
  behaviour, not a versioned guarantee"): Vercel's egress for proxied requests, the real caller for direct ones.
  Hence `TRUST_PROXY_DIRECT=x-real-ip`, and `TRUST_PROXY` only after §12.8.

### 12.6 Docker compose (`backend/docker-compose.yml`, project `shade`) — one-machine alternative

`cp backend/.env.example backend/.env`, `cp backend/.env.worker.example backend/.env.worker` (it must exist, empty
value without hosted detection), then `docker compose -f backend/docker-compose.yml up --build`. It serves plain HTTP
on 8787 with its own Postgres: put a TLS proxy in front and back the volume up yourself.

| Service    | Runs                      | Env files             | Notes                                             |
| ---------- | ------------------------- | --------------------- | ------------------------------------------------- |
| `postgres` | `postgres:17`             | none                  | volume `pgdata`; password `POSTGRES_PASSWORD`     |
| `migrate`  | `node src/bin/migrate.ts` | `.env`                | one-shot once Postgres is healthy; no seal key    |
| `api`      | image default (server)    | `.env`                | `8787:8787` after `migrate` succeeds; no seal key |
| `worker`   | `node src/bin/worker.ts`  | `.env`, `.env.worker` | after `migrate`; no health check; 40 s grace      |

All three backend services get `DATABASE_URL` and `DATABASE_URL_UNPOOLED` forced to the bundled Postgres
(`environment:` wins over `env_file:`); CI checks this and the seal-key split (§11.3).

### 12.7 Frontend (Vercel)

1. Run every `vercel` command from the repository root, never from `frontend/`. The build reads `backend/src/contract`
   through the `@shade/contract` alias, so it needs files outside `frontend/`. `vercel deploy` uploads the working
   tree and does **not** read `.gitignore`; the root `.vercelignore` is an allowlist (the root `package.json`,
   `package-lock.json` and `tsconfig.base.json`, the workspace manifests, `backend/tsconfig.json`, `frontend/` and
   `backend/src/contract`) that keeps `backend/.data`, `.env*` and `.claude` out (a frontend test pins it).
2. Project settings: `vercel project add shade`, then `vercel api /v9/projects/shade -X PATCH -F rootDirectory=frontend
-F nodeVersion=24.x -F framework=vite -F sourceFilesOutsideRootDirectory=true` (`vercel link --yes` never sets a
   root directory), then `vercel link --yes --project shade` (writes the gitignored `.vercel/`). `frontend/vercel.json`
   supplies `framework: vite`, `npm run build` and output `dist`. The production domain is the custom domain or the
   one Vercel assigns (`vercel project inspect shade`); that is `APP_ORIGIN`.
3. Replace the backend origin in the `dest` of both the `/api/(.*)` and `/v1/(.*)` routes (shipped as the placeholder
   `https://api.example.com`) with the Railway domain, then `vercel deploy --prod`. Both routes set `x-shade-edge`
   from the project variable `SHADE_EDGE_SECRET` (never a literal; a frontend test enforces it and accepts any https
   origin).
4. Edge secret: generate once (`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"`),
   pipe it to `vercel env add SHADE_EDGE_SECRET production --sensitive --force --yes`, and redeploy the frontend
   (variables reach only new deployments). Then set the same value as `EDGE_SHARED_SECRET` on the Railway API and
   `railway redeploy --service api --yes`. From then on `/api/*` without the header is 403 `FORBIDDEN_ORIGIN`. `/v1/*`
   stays reachable directly: SDK users set `baseUrl` to the Railway API origin (direct) or to `APP_ORIGIN` (through
   Vercel).
5. Domain: `vercel domains add <domain> shade`; DNS on Vercel: `vercel dns add …`; elsewhere the records from
   `vercel domains verify <domain> --project shade`.

`vercel.json` uses Vercel's legacy `routes` array (a test asserts no `rewrites`/`headers`/`redirects` beside it): CSP
and security headers on every path, immutable caching for `/assets/*`, `no-referrer` and `noindex, nofollow` on
`/pay/*` and `/view`, `noindex` on `/desk*`, the two proxy routes, the filesystem, 404 for a missing asset, then the SPA
fallback to `/index.html`. Another static host must reproduce all of it; the Vite dev server and the API send none of
these page headers. Shade answers `cache-control: no-store`, so Vercel's external-rewrite caching keeps nothing.

### 12.8 After deploy

- `https://<api>.up.railway.app/healthz` is 200; `/readyz` is 200 with `pending_migrations: []` and fresh `age_sec`
  for `detector`, `promotion`, `outbox` and `sweeper`. The API boot log lists its `client IP sources`.
- `https://<APP_ORIGIN>/api/config` is 200 (the edge header arrives); `https://<api>.up.railway.app/api/config` is 403.
- **Client-IP check** (it decides `TRUST_PROXY`; the rate limiter writes the address it used into
  `rate_limits.bucket`). Set `TRUST_PROXY=x-vercel-forwarded-for` on the API and redeploy, then:
  (a) `curl https://<APP_ORIGIN>/api/public/invoices/inv_iptest0000000000000`;
  (b) the same with `-H "x-vercel-forwarded-for: 203.0.113.77"`;
  (c) `curl -H "x-real-ip: 203.0.113.78" https://<api>.up.railway.app/v1/tags/iptestdirect`;
  then read `select bucket from rate_limits where window_start > now() - interval '15 minutes'` on the direct URL.
  **Keep** `TRUST_PROXY=x-vercel-forwarded-for` only if (a) recorded your own public IP and (b) recorded your own IP
  too, never `203.0.113.77`. Otherwise (Vercel sends no such header, or passes a client's value through) set
  `TRUST_PROXY=none` again and redeploy: proxied users then share a bucket per Vercel egress address, which is
  bounded, while a header a client can choose is not. (c) must record your own IP (Railway's `X-Real-IP`), never
  `203.0.113.78` or a `100.64.` address. Repeat after any change at Vercel or Railway.
- A real sign-up on `APP_ORIGIN` receives its verification email. Mainnet stays off until `SHADE_NETWORKS` includes it
  deliberately, preferably with your own light server.

---

## 13. Dependencies

Node ≥ 24 (root and backend `engines`; the published SDK targets Node ≥ 20). npm workspaces with one committed
`package-lock.json` (lockfile v3). Every caret range below resolves to its floor version in the lockfile today.

### 13.1 Runtime

| Package                  | In       | Range       | Role                                                     |
| ------------------------ | -------- | ----------- | -------------------------------------------------------- |
| `hono`                   | backend  | `^4.13.12`  | routing, middleware, CORS, secure headers, body limit    |
| `@hono/node-server`      | backend  | `^2.1.3`    | Node HTTP adapter (`bin/server.ts`)                      |
| `better-auth`            | both     | `1.7.7`     | desk sessions; `better-auth/react` client in the SPA     |
| `pg`                     | backend  | `^8.23.1`   | Postgres pool and migration connection                   |
| `@electric-sql/pglite`   | backend  | `^0.5.8`    | embedded Postgres for development and tests              |
| `kysely`                 | backend  | `^0.29.6`   | only Better Auth's PGlite dialect (`pglite-dialect.ts`)  |
| `zod`                    | backend  | `^4.6.5`    | env config and HTTP body validation                      |
| `pino`                   | backend  | `^10.3.1`   | JSON logs with key redaction                             |
| `ipaddr.js`              | backend  | `^2.5.0`    | client IPs, IPv6 /64 rate-limit buckets, SSRF checks     |
| `@noble/hashes`          | backend  | `^2.4.0`    | BLAKE2b for F4Jumble (`zcash/f4jumble.ts`)               |
| `@ledgerhq/zcash-utils`  | backend  | `2.5.0`     | native UFVK scanner; imported only by `zcash/scanner.ts` |
| `react`, `react-dom`     | frontend | `^19.3.0`   | UI                                                       |
| `@tanstack/react-router` | frontend | `^1.170.41` | file routes                                              |
| `@tanstack/react-query`  | frontend | `^5.104.1`  | all server state                                         |
| `qrcode`                 | frontend | `^1.5.4`    | QR code of the ZIP-321 URI (`lib/qr.ts`)                 |
| `lucide-react`           | frontend | `^1.50.0`   | icons                                                    |
| `clsx`                   | frontend | `^2.1.1`    | conditional class names in `cn()` (`lib/cn.ts`)          |
| `tailwind-merge`         | frontend | `^3.7.0`    | resolves conflicting Tailwind classes in `cn()`          |
| `@fontsource-variable/*` | frontend | `^5.3.0`    | self-hosted Figtree and Newsreader                       |

`@shade/sdk` has no runtime dependencies (`fetch` and WebCrypto). Shade calls Resend's HTTP API with `fetch` and
lightwalletd over `node:http2`, so neither has a client library.

### 13.2 Toolchain (devDependencies)

- Root: TypeScript `~6.0.3` (`typecheck` in every workspace, the SDK build), Vitest `^5.0.3`, Prettier `^3.9.9`,
  concurrently `^10.0.5` (`npm run dev`), `@types/node` `^24.19.1`, and ESLint `^10.11.0` with `@eslint/js`
  `^10.0.1`, `typescript-eslint` `^8.71.0`, `eslint-plugin-react-hooks` `^7.1.1`, `eslint-plugin-react-refresh`
  `^0.5.7`, `eslint-config-prettier` `^10.1.8` and `globals` `^17.13.0`.
- Backend: `@types/pg` `^8.23.1` only; the backend has no build tool.
- Frontend: Vite `^8.3.2`, `@vitejs/plugin-react` `^6.1.1`, `@tanstack/router-plugin` `^1.168.42`, Tailwind CSS and
  `@tailwindcss/vite` `^4.3.3`, Playwright `^1.63.0`, happy-dom `^20.14.5`, Testing Library (`dom` `^10.4.2`, `react`
  `^16.3.3`, `user-event` `^14.6.7`), `@types/react` and `@types/react-dom` `^19.3.0`, `@types/qrcode` `^1.5.6`.

### 13.3 Version policy (as practised)

- Caret ranges, with the lockfile as the source of what runs: CI and the Docker image install with `npm ci`.
- Exact: `@ledgerhq/zcash-utils` `2.5.0`. Its native binaries decide which network upgrades decrypt (the NU7 branch id
  is missing, §3), so it moves only after a real payment re-verifies the new version. The package ships every
  platform's `.node` file itself, which is why the image can install with `--omit=optional --ignore-scripts`.
- Tilde: `typescript` `~6.0.3` (patch updates only). No reason is recorded.
- Exact: `better-auth` `1.7.7` in both workspaces. Its schema is tied to the version: `0006` was derived with
  `better-auth/db/migration` `getMigrations()` against a database migrated through 0005. Bump it deliberately:
  re-derive against the latest schema and add a migration for any delta.
- A new dependency needs a reason in the commit message (§8). Backend runtime packages must not need install scripts
  or optional dependencies (the image skips both).

---

## 14. Key decisions

1. **Hono API + Vite SPA, kept same-origin by a proxy.** _Why:_ one API serves the SPA, the SDK and the worker, and
   the Better Auth cookie stays first-party and host-only (§2, §4.3); Vite proxies `/api` and `/v1` in development and
   `vercel.json` routes them in production. _Consequence:_ `/api/*` has no CORS and checks `Origin`; every host must
   proxy both prefixes; behind the proxy, per-IP limits need `TRUST_PROXY` with `EDGE_SHARED_SECRET` (§10).
2. **PGlite for development and tests.** _Why:_ `npm install && npm run dev` needs no Postgres, node or wallet
   (README); each test harness gets a fresh in-memory database. _Consequence:_ one process per data directory (lock
   file), so the worker runs inline and the standalone worker refuses PGlite; Better Auth runs without transactions on
   PGlite; concurrency is only tested on real Postgres (`TEST_DATABASE_URL`), and both engines share one driver
   contract (§4.5).
3. **Viewing keys sealed to the worker's X25519 key.** _Why:_ the API tier must not be able to decrypt viewing keys
   (§5.3). _Consequence:_ the API holds only the public key (ephemeral-static ECDH, HKDF-SHA256, AES-256-GCM, bound
   to merchant and network, key id for rotation); the private key lives only in the worker's environment, which
   compose and a CI check enforce; without a public key, hosted detection is off.
4. **Pure-TypeScript gRPC over `node:http2`.** _Why:_ Shade needs four unary calls (`GetLightdInfo`,
   `GetLatestBlock`, `GetBlock`, `GetTransaction`) and a few messages, so a minimal protobuf codec suffices; no other
   reason is recorded. _Consequence:_ Shade owns failover across URLs, the per-session `chainName` check, byte-order
   reversal, fixed error codes that never carry URLs or txids, and server quirks (Zaino `INTERNAL`, mempool heights,
   §3); tests replay recorded answers from a local HTTP/2 server.
5. **`@ledgerhq/zcash-utils` as the only scanner.** _Why:_ the only maintained Node scanner; it takes a UFVK (§2).
   _Consequence:_ hosted detection needs a key that also reveals outgoing payments, so the UI says so and `scan:local`
   keeps the key on the merchant's machine; exact pin, glibc ≥ 2.34 (Debian image, no Alpine), lazy loading so the
   server boots where the binary cannot load, memo text never leaves `zcash/scanner.ts`, and NU7 needs a re-verified
   bump (§3).
6. **Transactional outbox for webhooks.** _Why:_ the `invoice.paid` event commits in the transaction that settles
   the invoice (§4.8), and a unique index keeps it to one event per invoice. _Consequence:_ delivery is
   at-least-once (receivers dedupe by `id`); the stored body is re-sent byte for byte with a fresh V2 signature per
   attempt; leased deliveries run right after commit and are retried by the worker for about three days (§4.9).
7. **Rate limits as fixed windows in Postgres.** _Why:_ one upsert per check, atomic under concurrency on Postgres
   (`platform/rate-limit.ts`), and no store besides Postgres; Better Auth uses database storage too.
   _Consequence:_ every API process shares the counters; each limited request costs a write; the sweeper purges
   windows older than an hour; IPv6 is bucketed per /64; buckets are only as good as the client IP (§10).
8. **Better Auth for the desk.** _Why:_ email + password with verification, reset and rate limits, configured in one
   place (`platform/auth.ts`). _Consequence:_ its tables (camelCase, quoted) come from `0001` and the 1.7.7 delta
   `0006`, so a version bump needs a schema check; sessions are read from the database on every desk request (no
   cookie cache), so revocation is immediate; Shade adds its own hardening (no sign-in on verification, reclaiming
   unconfirmed accounts, background mail).
9. **TypeScript run directly by Node 24.** _Why:_ type stripping removes the backend build step (`backend/Dockerfile`).
   _Consequence:_ erasable syntax only and `.ts` relative imports (§8); the image copies sources as they are; the SDK
   is the one package compiled to `dist`, for Node ≥ 20 consumers.
