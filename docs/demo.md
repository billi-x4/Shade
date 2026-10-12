# Shade — the 90-second demo

**Title:** Shade — private invoices and agent jars on Zcash · **Track:** Zcash · **Network:** testnet

Every step below is real: real shielded testnet payments, real viewing-key detection, real signed webhooks, a real
agent hitting the jar API. Nothing is simulated.

## Pre-roll (off camera)

1. Backend and worker running with `SHADE_MIN_CONFIRMATIONS_TESTNET=1` and `SHADE_SCAN_INTERVAL_SEC=5`. Frontend on the
   public origin.
2. Merchant account signed in **less than 15 minutes ago** (sensitive settings need a fresh session).
3. **Settings → Detection:** upload the full viewing key (`uviewtest1…`) of a dedicated, receive-only testnet account with
   "Use this key's address" on. The receive address is now that key's shielded address and the scan status reads
   "Watching for payments".
4. **Webhooks:** expose the receiver's port through a public HTTPS tunnel (e.g.
   `cloudflared tunnel --url http://127.0.0.1:8790`) and add the tunnel URL under **New endpoint**. Start the receiver
   with the signing secret Shade shows once: `SHADE_WEBHOOK_SECRET=whsec_… npm run demo:receiver -w @shade/backend`.
   Press **Send test** and see `webhook.test - - verification=-` in the receiver terminal.
5. Payer: Zingo (mobile or PC) on testnet, synced, holding at least 0.02 TAZ that is already shielded
   (faucet: <https://zcashfaucet.jinolabs.xyz>).
6. **NU7 (read before recording).** Testnet NU7 activated at height 4,465,026 on 2026-10-04. The pinned scanner
   (`@ledgerhq/zcash-utils` 2.5.0, the latest release on 2026-10-06) rejects every post-NU7 transaction ("invalid
   consensus branch id 0x77190ad9"), so on testnet step 3 does **not** flip by itself: once the payment arrives,
   Settings → Detection shows that the scanner needs an update. Pick one, and narrate it truthfully:
   - **Live detection on mainnet** (NU7 there is planned for about Nov 5, 2026): record steps 1–3 as in "Mainnet
     contingency" below.
   - **Testnet with the shop's confirmation:** record step 3 with the fallback below (`verification=merchant_accept`).
   - Re-check first: if a newer scanner release has shipped, bump it, send one fresh testnet payment and confirm it
     flips to Paid (`agents.md` §3).

## Script

| Time      | Step           | What the viewer sees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:10 | **1. Invoice** | Desk → Invoices → **New invoice**: amount `0.01`, memo `order_1042`, label `payroll` → **Create invoice** → **Open pay page**: "Pay privately with Zcash.", the amount, the QR, **Open in wallet**. **Copy payment link** copies the `zcash:` ZIP-321 URI.                                                                                                                                                                                                                                                                                                      |
| 0:10–0:28 | **2. Pay**     | Zingo scans the QR and sends. Cut ("about 30 seconds later"). Open the transaction on a testnet explorer: shielded, no amount, no addresses.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 0:28–0:40 | **3. Paid**    | The pay page has flipped to **Paid.** by itself. The desk row reads "Paid · found by wallet scan". Webhooks → Deliveries shows `invoice.paid` · Delivered (last answer HTTP 200), and the receiver terminal prints the verified event (`invoice.paid inv_… 0.01 verification=ivk_scan`; no memo ever leaves Shade).                                                                                                                                                                                                                                             |
| 0:40–1:02 | **4. Grant**   | Grants → **New grant**: Only invoices with a label, `payroll`, share for **10 minutes** → **Create grant**. Copy the view link from the dialog and open it in a private window: the 0.01 receipt is listed and **Download receipts (CSV)** works. Back on the desk: **Revoke**. Within 10 seconds the auditor window reads "Access revoked." and "The shop ended this view."; the CSV export now answers 410. On the desk the grant notes "Revoke stops new access from us. Delete the file on their machine too."                                              |
| 1:02–1:24 | **5. Jar**     | Jars → **New jar**: cap `0.006`, label `research-agent` → **Create jar**. **Agent key** → copy the key. In a terminal: `SHADE_AGENT_KEY=ag_… SHADE_API_URL=<web app origin> npm run demo:agent -w @shade/backend -- --jar <jar_id> --times 4` (on Windows, put both variables in `backend/.env`). Three lines `authorized 0.002 · left …` (0.004, 0.002, 0), then `402 JAR_EMPTY · Jar empty. The agent cannot spend.` The jar card reads "Cap 0.006 ZEC. Spent 0.006. Left 0." **Kill** → **Kill jar**: "Stops new charges. Move leftover ZEC in your wallet." |
| 1:24–1:30 | **Close**      | "Zcash hides the money. Shade is how a product uses that without becoming a cryptographer."                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Fallback (step 3 has not flipped within two minutes, or testnet after NU7)

Either path ends at "Paid · confirmed by shop" and a webhook with `verification=merchant_accept`. Narrate it as exactly
that: the shop confirmed it, Shade did not scan it.

- **The payer reports it:** paste the txid on the pay page (**Send transaction id**) → the pay page says "Payment
  reported. The shop is checking it." and the desk row reads "Unverified — payer reported a transaction" → on the
  desk press **Confirm**, then **Confirm payment**.
- **The shop records it:** on the desk row press **Record payment**, paste the txid from the merchant wallet's
  history, then **Mark paid**.

Either way, only after the merchant wallet shows the amount and the memo. Shade checks the transaction is shielded,
newer than the invoice and has the minimum confirmations; it cannot see the amount or the memo.

## Mainnet contingency

If testnet infrastructure breaks after NU7, record steps 1–3 on mainnet (`SHADE_NETWORKS=testnet,mainnet`, Zodl store
build, 0.01 ZEC, mainnet minimum confirmations as configured) and keep the pre-NU7 testnet detection as the "one real
shielded testnet payment detected" evidence.
