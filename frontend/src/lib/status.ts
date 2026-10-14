import type {
  DeliveryStatus,
  GrantState,
  Invoice,
  InvoiceDetection,
  PaymentProgress,
  ScanErrorCode,
  ScanState,
  Verification,
} from "@shade/contract";

/** Visual tone of a status. Plain words carry the meaning; tone only reinforces it. */
export type Tone = "ok" | "warn" | "bad" | "muted" | "neutral";

export interface StatusLabel {
  label: string;
  tone: Tone;
}

function seenLabel(detection: InvoiceDetection): StatusLabel {
  const have = detection.confirmations ?? 0;
  return {
    label: `Seen on chain · ${have}/${detection.required_confirmations} confirmations`,
    tone: "warn",
  };
}

/** Desk invoice status in plain words (never raw enums). */
export function invoiceStatus(
  invoice: Pick<Invoice, "status" | "verification" | "detection">,
): StatusLabel {
  switch (invoice.status) {
    case "paid":
      if (invoice.verification === "ivk_scan") {
        return { label: "Paid · found by wallet scan", tone: "ok" };
      }
      if (invoice.verification === "merchant_accept") {
        return { label: "Paid · confirmed by shop", tone: "ok" };
      }
      return { label: "Paid", tone: "ok" };
    case "paid_unverified":
      return { label: "Unverified · the payer sent a transaction id", tone: "warn" };
    case "authorized":
      return { label: "Jar charge", tone: "neutral" };
    case "expired":
      // A payment mined before expiry can still settle it once it has its confirmations.
      if (invoice.detection?.state === "seen") return seenLabel(invoice.detection);
      return { label: "Expired", tone: "muted" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    case "open":
      if (invoice.detection?.state === "seen") return seenLabel(invoice.detection);
      return { label: "Awaiting payment", tone: "neutral" };
  }
}

/** How a receipt was verified, for auditors. */
export function verificationLabel(verification: Verification): string {
  switch (verification) {
    case "ivk_scan":
      return "Found by wallet scan";
    case "merchant_accept":
      return "Confirmed by shop";
    case "jar_ledger":
      return "Jar charge";
    case "txid_unverified":
      return "Reported by payer, not verified";
  }
}

/** Payer-facing progress headline on the pay page. */
export function paymentProgressLabel(
  progress: PaymentProgress,
  confirmations: number | null,
  required: number,
): string {
  switch (progress) {
    case "awaiting":
      return "Waiting for your payment.";
    case "reported":
      return "Payment reported. The shop is checking it.";
    case "seen":
      return `Seen on the network · ${confirmations ?? 0} of ${required} confirmations.`;
    case "confirmed":
      return "Paid. The shop has your payment.";
  }
}

export function grantState(state: GrantState): StatusLabel {
  switch (state) {
    case "active":
      return { label: "Active", tone: "ok" };
    case "expired":
      return { label: "Expired", tone: "muted" };
    case "revoked":
      return { label: "Revoked", tone: "muted" };
  }
}

export function deliveryStatus(status: DeliveryStatus): StatusLabel {
  switch (status) {
    case "pending":
      return { label: "Queued", tone: "neutral" };
    case "in_flight":
      return { label: "Sending", tone: "neutral" };
    case "delivered":
      return { label: "Delivered", tone: "ok" };
    case "failed":
      return { label: "Retrying", tone: "warn" };
    case "dead":
      return { label: "Gave up", tone: "bad" };
    case "cancelled":
      return { label: "Cancelled · endpoint turned off or deleted", tone: "neutral" };
  }
}

const DELIVERY_ERRORS: Record<string, string> = {
  timeout: "Your server did not answer within 10 seconds.",
  dns_failed: "The host name did not resolve.",
  blocked_address: "The host points at a private or reserved address.",
  tls_error: "The TLS handshake failed.",
  connection_failed: "Shade could not connect.",
  redirect: "Your server answered with a redirect. Shade does not follow redirects.",
  body_too_large: "Your server's response was too large.",
};

export function deliveryErrorLabel(error: string): string {
  const http = /^http_(\d{3})$/.exec(error);
  if (http) return `Your server answered HTTP ${http[1]}.`;
  return DELIVERY_ERRORS[error] ?? "The delivery failed.";
}

export function endpointDisabledLabel(reason: string | null): string {
  if (reason === "gone_410") return "Turned off because your server answered 410 Gone.";
  if (reason === "failing")
    return "Turned off after failing for 3 days. Deliveries already queued keep retrying.";
  return "Turned off.";
}

export function scanStateLabel(state: ScanState): StatusLabel {
  switch (state) {
    case "idle":
      return { label: "Watching for payments", tone: "ok" };
    case "scanning":
      return { label: "Scanning now", tone: "ok" };
    case "error":
      return { label: "Needs attention", tone: "warn" };
    case "disabled":
      return { label: "Paused", tone: "muted" };
  }
}

export function scanErrorLabel(code: ScanErrorCode): string {
  switch (code) {
    case "chain_unavailable":
      return "Shade cannot reach the Zcash light server right now. It will retry.";
    case "scan_failed":
      return "The last scan failed. Shade will retry.";
    case "key_unavailable":
      return `Shade cannot open this key. Upload it again under "Replace this key". Your scan progress stays. If that does not fix it, the server's detection setup needs fixing.`;
    case "scanner_unsupported_upgrade":
      return "Shade's scanner cannot read payments made since the latest network upgrade yet. Until it is updated, check your wallet and use Record payment on each paid invoice.";
    case "ambiguous_match":
      return "One payment matched more than one invoice. Check its memo in your wallet and use Record payment on the right invoice.";
    case "txid_in_use":
      return "A payment Shade found was already confirmed on another invoice. Check its memo in your wallet to see which invoice it was for.";
  }
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  muted: "text-faint",
  neutral: "text-fg",
};
