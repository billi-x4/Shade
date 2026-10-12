# Shade — Product Requirements

**Website:** https://shade-zcash.vercel.app  
**Chain:** Zcash only (Orchard / Unified Addresses). No other L1.  
**Version:** 0.2  
**Date:** 2026-09-30  
**Status:** Build this. World’s Fair Zcash track. Submissions due 2026-10-12.  
**Who this file is for:** coding agents and humans shipping v0.

---

## Theme (use this everywhere)

**Shade is a curtain in front of Zcash.**  
Zcash already hides the money. Shade hides the *work of using it* from vendors and agents.

Voice:
- Short sentences.
- No “first private blockchain.”
- No “quantum-safe” claims in v0.
- Product words: invoice, jar, grant, kill, receipt, tag.
- Never show: Groth16, Halo, note commitment, nullifier, proving key.

Tagline: **Pay in the dark. Prove in the light. Keys stay yours.**

Site copy default: “Your tools spend. Your ledger should not narrate.”

---

## 0. Agent operating rules

Read this section before writing code.

1. Ship a **working pay loop**, not a wallet competitor.
2. Users pay with an existing shielded wallet (Zodl, Zucchini, Zingo) via **ZIP-321**. Shade does not hold seeds in v0.
3. Default network: **Zcash testnet** until mainnet is a checkbox.
4. Asset in v0: **ZEC only**. No USDC. No ZSA until the stack is real.
5. One happy path on camera: create invoice → shielded pay → webhook `paid` → viewing grant → revoke → agent jar empty fails.
6. If a feature needs a full node, a custom proving service, or a new consensus rule, **cut it**.
7. Do not scrape socials. Do not store seeds. Do not log memos in plaintext on the server.
8. Tests > slides. A demo that lies about “on-chain” is a failed build.

### Suggested repo

```
shade/
  PRD.md                 ← this file
  apps/web               ← shade-zcash.vercel.app (Next.js)
  apps/api               ← invoices, webhooks, grants (Node)
  packages/sdk           ← @shade/sdk (TypeScript)
  packages/zip321        ← payment URI helpers
  packages/agent         ← jar + MCP-shaped tools
  docs/demo.md           ← 90s script
```

### Stack (v0)

- Next.js + TypeScript
- Postgres (invoices, grants, webhook deliveries)
- ZIP-321 payment URIs
- Unified Address as merchant receive address
- Incoming view key (IVK) **only on merchant device or encrypted-at-rest vault they control**
- lightwalletd or a public testnet light wallet endpoint to detect payment
- Optional: Zucchini `@zucchinifi/dapp-sdk` for browser pay
- Deploy: Vercel + one small API box

---

## 1. One sentence

Shade is the **vendor layer** on Zcash: create a private invoice, get a webhook when shielded ZEC lands, share or revoke a viewing key, and give an AI agent a jar it can empty but not overflow.

Zcash hides sender, receiver, and amount.  
Shade hides integration pain.

---

## 2. Why this, why now

Public chains turned every payment into a press release. That was tolerable when humans clicked “send” once a week. It is not tolerable now.

**AI.** Agents pay APIs. A public ledger writes “this brain bought that model.” Prompts already leak strategy. The receipt should not also leak the budget.

**Cyber.** Payroll, retainers, incident fees, bug bounties — published amounts are a map of who matters and what they earn. Attackers read explorers the way they used to read leaked spreadsheets.

**Surveillance default.** Checkout on a glass chain glues a shopper’s whole history to a store. Companies glue treasury size to a ticker.

**Quantum (honest line).** People will ask. Answer: Zcash is on a multi-year path to post-quantum wallets. Shade v0 uses **today’s Orchard shielded payments**. We do not market Shade as quantum-proof. We market Shade as *private now, upgrade the curve when the chain does.*

**The hole:** wallets (Zodl, Zucchini) are good at *people* sending ZEC. Gateways exist. What is missing is a thin API a SaaS, an agent runtime, or a payroll tool can call without becoming a Zcash engineer.

---

## 3. What Shade is not

- Not a Zcash wallet.
- Not a mixer pitch.
- Not Aztec, not a rollup, not a new coin.
- Not “privacy invented here.”
- Not a portable-memory / soul product.
- Not multi-chain in v0.

If a judge can replace “Shade” with “Zodl” and the sentence still works, rewrite the sentence.

---

## 4. The four objects

Everything in the product is one of these.

| Object | Plain meaning | Lives |
|---|---|---|
| **Tag** | `asharib.shade` — human name that points at a Unified Address | Shade API |
| **Invoice** | “Pay this much ZEC for this memo.” Returns a ZIP-321 URI + pay page | API + web |
| **Jar** | Prepaid private pot with a cap. Agent spends from it. Owner can kill it. | API metadata + UA |
| **Grant** | Time-boxed viewing key share. Revoke = dark again. | API + merchant vault |

Receipt = invoice marked paid + txid + memo hash. Amount visible only to holder of the view key.

---

## 5. Privacy model (one grade in v0)

Zcash shielded Orchard **is** Grade A: explorer does not show who, whom, or how much. It shows that a shielded transaction happened.

Shade does not invent a second cryptography. Shade adds **policy on top**:

- Merchant can detect *their* payment with *their* incoming view key.
- Merchant can mint a **grant** so an accountant sees this month only.
- Owner can **kill** a jar so an agent stops paying.
- Server never needs a spending key.

Transparent ZEC addresses are **opt-in and discouraged**. Default receive = Unified Address, shielded.

---

## 6. Users

| Who | Job to be done |
|---|---|
| Merchant / SaaS | Invoice → webhook `invoice.paid` → fulfill |
| Agent runtime | Jar of N ZEC, spend per call, fail closed |
| Human owner | Fund jar, read activity, revoke grants, kill |
| Auditor | Open a grant, export receipts, lose access at expiry |
| Fair judge | Understand the loop in 90 seconds |

---

## 7. UX copy (ship this text)

**Pay page**  
“Private pay · Zcash. They will not see your history. We will not see your seed.”

**Merchant dashboard**  
Invoices · Jars · Grants · Webhooks

**Grant dialog**  
“Share view for 7 days. Scope: invoices tagged payroll. You can revoke anytime.”

**Jar**  
“Cap 0.05 ZEC. Spent 0.012. Kill returns the rest to you.”

**Error when jar empty**  
“Jar empty. The agent cannot spend.”

Never: “generating proof…,” “syncing sapling tree…,” “nullifier.”

---

## 8. Flows

### 8.1 Merchant invoice

```
Merchant                  Shade                     Payer wallet
   |                         |                            |
   |  POST /invoices         |                            |
   |  { amount_zec, memo }   |                            |
   |<-- pay_url, zip321 -----|                            |
   |                         |         open pay_url       |
   |                         |--------------------------->|
   |                         |     ZIP-321 shielded send  |
   |                         |<---------------------------|
   |                         |  detect via IVK / memo     |
   |  webhook invoice.paid   |                            |
   |<------------------------|                            |
```

Webhook body (no spending keys, no raw view key):

```json
{
  "type": "invoice.paid",
  "invoice_id": "inv_...",
  "amount_zec": "0.042",
  "memo_hash": "sha256:...",
  "txid": "...",
  "paid_at": "2026-10-10T12:00:00Z"
}
```

`amount_zec` is allowed in the webhook because the **merchant already knows the invoice amount**. Do not attach the payer Unified Address unless the payer opted in.

### 8.2 Agent jar

```
Human --fund--> jar (cap 0.05 ZEC) --> agent
Agent --pay invoice--> vendor API
3 pays succeed
4th pay --> 402 JAR_EMPTY
Human --kill--> remaining ZEC described as “returned”; v0 may be “stop + tell human to move funds in wallet”
```

v0 honesty: if Shade does not hold a spending key, **kill = freeze invoices + mark jar closed**. Sweeping ZEC back requires the human wallet. Do not fake a protocol-level clawback.

### 8.3 Grant and revoke

```
Merchant --grantView(auditor, 7d, scope=payroll)--> Grant
Auditor  --uses exported UFVK/IVK slice--> sees those memos
Merchant --revoke--> Grant.revoked_at set
Docs tell auditor to delete the key; Shade stops serving decrypted exports
```

v0 honesty: a viewing key, once copied, cannot be cryptographically erased from a laptop. Shade **stops issuing new data** and **expires the grant**. Say that in the UI.

---

## 9. API (v0 — implement these only)

Base: `https://shade-zcash.vercel.app/v1`  
Auth: `Authorization: Bearer sk_live_...` (merchant)  
Agent: `Authorization: Bearer ag_...` scoped to one jar.

### Invoices

`POST /v1/invoices`

```json
{
  "amount_zec": "0.01",
  "memo": "order_1042",
  "expires_in_sec": 3600
}
```

Response: `id`, `pay_url`, `zip321`, `address`, `expires_at`.

`GET /v1/invoices/:id`  
`POST /v1/invoices/:id/cancel`

### Jars

`POST /v1/jars` `{ "cap_zec": "0.05", "label": "research-agent" }`  
`POST /v1/jars/:id/charge` `{ "amount_zec": "0.002", "memo": "api:search" }`  
`POST /v1/jars/:id/kill`

Charge creates a child invoice counted against the cap. Over cap → `402` `{ "error": "JAR_EMPTY" }`.

### Grants

`POST /v1/grants` `{ "scope": "payroll", "days": 7 }`  
Response includes a **one-time** view payload the merchant already authorized.  
`POST /v1/grants/:id/revoke`

### Webhooks

`POST /v1/webhooks` `{ "url": "https://vendor/hooks/shade" }`  
Sign bodies with `X-Shade-Signature` (HMAC SHA-256 of raw body).

### Tags

`POST /v1/tags` `{ "name": "asharib" }` → `asharib.shade`  
Resolves to the merchant Unified Address.

SDK shape:

```ts
const shade = new Shade({ apiKey });
const inv = await shade.invoices.create({ amountZec: "0.01", memo: "demo" });
// send user to inv.payUrl
```

---

## 10. Pay page (shade-zcash.vercel.app/pay/:id)

Must work on a phone.

1. Show amount + memo + “Pay privately with Zcash.”
2. Big button: **Open in wallet** (ZIP-321 deep link).
3. QR of the same URI.
4. Status poll: unpaid → paid.
5. “Need a wallet?” link to Zodl / Zucchini. Shade does not onboard seeds.

ZIP-321 profile for v0: **one recipient, explicit ZEC amount, optional memo ≤ 512 bytes UTF-8.** No multi-output.

---

## 11. How we know it paid (v0)

Preferred order:

1. Merchant (or Shade on their behalf, if they uploaded an **encrypted** incoming view key) scans shielded receipts matching amount + memo + time window.
2. Fallback for demo: payer pastes txid; Shade checks it is a shielded tx in the window. Mark `paid_unverified` vs `paid` clearly.

Never require a transparent “marker” payment that doxes the payer.

---

## 12. Fair demo (do this first)

**Title:** Shade — private invoices and agent jars on Zcash  
**Track:** Zcash  
**Video ≤ 90s**

1. Merchant creates 0.01 ZEC invoice on shade-zcash.vercel.app.  
2. Payer pays from Zodl/Zucchini. Explorer: shielded, no amount.  
3. Webhook fires. Dashboard flips to Paid.  
4. Open a 10-minute grant. Show receipt list. Revoke. Export dies.  
5. Fund a jar 0.006 ZEC. Agent pays 3 × 0.002. Fourth call returns `JAR_EMPTY`.

Script last line: “Zcash hides the money. Shade is how a product uses that without becoming a cryptographer.”

---

## 13. World’s Fair constraints

- Deadline: **12 Oct 2026, 23:59 PT**
- Prize that matches: Zcash track $100k / 10 teams
- Do not claim Grand Prize as the plan
- Do not submit a Solana build to this product
- Workshops to steal language from: Zcash 101, Z3/RPC, FROST + payment URIs — **use ZIP-321 in the video**

---

## 14. Later (not v0)

- FROST threshold spend for company jars
- Encrypted memos as structured receipts
- ZSAs when production-ready
- Mainnet + production lightwalletd
- Hosted incoming-view-key HSM
- True on-chain clawback
- Post-quantum when Zcash ships it — then bump Shade, don’t fork

---

## 15. Risks and the honest line in the UI

| Risk | What we tell the user |
|---|---|
| View key copied | “Revoke stops new access from us. Delete the file on their machine too.” |
| Kill jar | “Stops new charges. Move leftover ZEC in your wallet.” |
| Detection lag | “Shielded confirmations can take a minute.” |
| Quantum question | “We use Zcash Orchard today. When Zcash upgrades keys, Shade follows.” |

---

## 16. Done when

- [ ] `shade-zcash.vercel.app` landing + pay page
- [ ] `POST /invoices` + ZIP-321 + webhook
- [ ] One real shielded testnet payment detected
- [ ] Grant create + revoke
- [ ] Jar cap + `JAR_EMPTY`
- [ ] `@shade/sdk` with those five calls
- [ ] 90s video
- [ ] README a stranger can run

Not done: a whitepaper, a token, a wallet, a quantum slide.

---

## 17. Coding-agent checklist

When implementing, prefer this order:

1. ZIP-321 helper + pay page mock (fake paid button for UI only, behind `DEMO_FAKE_PAID=1`)
2. Invoice table + webhook signer
3. Testnet detect loop
4. Jar + 402
5. Grant + revoke
6. Delete the fake-paid path before submit
7. Record the video

Commit messages: `inv: ...`, `jar: ...`, `grant: ...`, `pay: ...`.  
If a task is not in §9, do not build it.
