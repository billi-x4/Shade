/**
 * Product copy shared by the API and the web app. Strings marked PRD are shipped verbatim from
 * prd.md (§7, §10, §12, §15). Never surface protocol jargon (Groth16, Halo, nullifier, proving key,
 * note commitment, "generating proof", "syncing sapling tree") or raw enum values in UI copy.
 *
 * PRD §7's jar line "Kill returns the rest to you." is intentionally never used: Shade holds no
 * spending key, so PRD §8.2/§15 honesty wins (see agents.md, "Intentional PRD deviations").
 */
export const COPY = {
  /** PRD theme */
  tagline: "Pay in the dark. Prove in the light. Keys stay yours.",
  /** PRD theme: site copy default */
  siteDefault: "Your tools spend. Your ledger should not narrate.",
  /** PRD §10.1 */
  payHeading: "Pay privately with Zcash.",
  /** PRD §7 pay page */
  pay: "Private pay · Zcash. They will not see your history. We will not see your seed.",
  /** PRD §7 error when jar empty */
  jarEmpty: "Jar empty. The agent cannot spend.",
  jarClosed: "Jar closed. The agent cannot spend.",
  /** A jar is an allowance recorded by Shade; no ZEC moves when it is created or charged. */
  jarIsLimit: "A jar is a spending limit. The ZEC stays in your wallet.",
  /** PRD §15 kill jar */
  killNote: "Stops new charges. Move leftover ZEC in your wallet.",
  /** PRD §15 view key copied */
  grantNote: "Revoke stops new access from us. Delete the file on their machine too.",
  /** PRD §15 detection lag */
  lag: "Shielded confirmations can take a minute.",
  /**
   * PRD §15 quantum line, updated for NU6.3: payments to Orchard receivers now land in Zcash's
   * Ironwood shielded pool, so "Orchard today" would be inaccurate. Never claim quantum-safe.
   */
  quantum: "Payments use Zcash's shielded pool today. When Zcash upgrades keys, Shade follows.",
  noAddress: "Add a Unified Address for this network. Shade does not hold a seed.",
  /** Shown wherever a full viewing key is uploaded for hosted detection. */
  ufvkNotice:
    "Shade keeps an encrypted copy of this viewing key to watch for payments. It also shows your outgoing payments, so use a receive-only account.",
  /** Third-party chain servers learn which transactions Shade looks up. */
  chainPrivacyNote:
    "Shade asks a Zcash light server about payments. That server can see which transactions we look up.",
  /** PRD §12 closing line */
  closing:
    "Zcash hides the money. Shade is how a product uses that without becoming a cryptographer.",
} as const;

/**
 * PRD §7 grant dialog, with "labelled" for PRD's "tagged": invoices carry a label, and a tag is a
 * name.shade handle (agents.md §2). "Share view for 7 days. Scope: invoices labelled payroll. …"
 */
export function grantDialogCopy(duration: string, scope: string): string {
  const scopeText = scope === "all" ? "all invoices" : `invoices labelled ${scope}`;
  return `Share view for ${duration}. Scope: ${scopeText}. You can revoke anytime.`;
}

/** PRD §7 jar line ("Cap 0.05 ZEC. Spent 0.012.") plus the remaining allowance. */
export function jarSummaryCopy(capZec: string, spentZec: string, leftZec: string): string {
  return `Cap ${capZec} ZEC. Spent ${spentZec}. Left ${leftZec}.`;
}
