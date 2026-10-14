import type { Invoice, InvoiceDetection, ScanErrorCode } from "@shade/contract";
import { describe, expect, it } from "vitest";
import {
  invoiceStatus,
  paymentProgressLabel,
  scanErrorLabel,
  verificationLabel,
} from "@/lib/status";

type StatusInput = Pick<Invoice, "status" | "verification" | "detection">;

const seen: InvoiceDetection = {
  state: "seen",
  txid: "a".repeat(64),
  pool: "ironwood",
  source: "shade_worker",
  block_height: 4_200_000,
  confirmations: 1,
  required_confirmations: 3,
  observed_at: "2026-10-02T10:00:00.000Z",
};

describe("invoiceStatus", () => {
  const cases: [StatusInput, string, string][] = [
    [
      { status: "paid", verification: "ivk_scan", detection: null },
      "Paid · found by wallet scan",
      "ok",
    ],
    [
      { status: "paid", verification: "merchant_accept", detection: null },
      "Paid · confirmed by shop",
      "ok",
    ],
    [
      { status: "paid_unverified", verification: "txid_unverified", detection: null },
      "Unverified · the payer sent a transaction id",
      "warn",
    ],
    [
      { status: "open", verification: null, detection: seen },
      "Seen on chain · 1/3 confirmations",
      "warn",
    ],
    [
      { status: "open", verification: null, detection: { ...seen, confirmations: null } },
      "Seen on chain · 0/3 confirmations",
      "warn",
    ],
    [{ status: "open", verification: null, detection: null }, "Awaiting payment", "neutral"],
    [
      { status: "open", verification: null, detection: { ...seen, state: "orphaned" } },
      "Awaiting payment",
      "neutral",
    ],
    [
      { status: "authorized", verification: "jar_ledger", detection: null },
      "Jar charge",
      "neutral",
    ],
    [{ status: "expired", verification: null, detection: null }, "Expired", "muted"],
    // Mined before expiry and still confirming: it becomes paid, so it does not read as expired.
    [
      { status: "expired", verification: null, detection: seen },
      "Seen on chain · 1/3 confirmations",
      "warn",
    ],
    [
      { status: "expired", verification: null, detection: { ...seen, state: "late" } },
      "Expired",
      "muted",
    ],
    [
      { status: "expired", verification: null, detection: { ...seen, state: "orphaned" } },
      "Expired",
      "muted",
    ],
    [{ status: "cancelled", verification: null, detection: null }, "Cancelled", "muted"],
  ];

  it.each(cases)("maps %o to plain words and a tone", (input, label, tone) => {
    expect(invoiceStatus(input)).toEqual({ label, tone });
  });

  it("never shows raw enum values", () => {
    for (const [input] of cases) {
      expect(invoiceStatus(input).label).not.toMatch(
        /ivk_scan|merchant_accept|paid_unverified|jar_ledger/,
      );
    }
  });
});

describe("receipt and payer labels", () => {
  it("names each verification for auditors", () => {
    expect(verificationLabel("ivk_scan")).toBe("Found by wallet scan");
    expect(verificationLabel("merchant_accept")).toBe("Confirmed by shop");
    expect(verificationLabel("jar_ledger")).toBe("Jar charge");
  });

  it("describes payer progress", () => {
    expect(paymentProgressLabel("awaiting", null, 1)).toBe("Waiting for your payment.");
    expect(paymentProgressLabel("reported", null, 1)).toBe(
      "Payment reported. The shop is checking it.",
    );
    expect(paymentProgressLabel("seen", 2, 10)).toBe(
      "Seen on the network · 2 of 10 confirmations.",
    );
    expect(paymentProgressLabel("confirmed", 10, 10)).toBe("Paid. The shop has your payment.");
  });
});

describe("scanErrorLabel", () => {
  const codes: ScanErrorCode[] = [
    "chain_unavailable",
    "scan_failed",
    "key_unavailable",
    "scanner_unsupported_upgrade",
    "ambiguous_match",
    "txid_in_use",
  ];

  it.each(codes)("explains %s in plain words", (code) => {
    const label = scanErrorLabel(code);
    expect(label.length).toBeGreaterThan(20);
    expect(label).not.toContain(code);
    expect(label).not.toMatch(/_/);
  });

  it("says a found payment was already confirmed on another invoice", () => {
    expect(scanErrorLabel("txid_in_use")).toMatch(
      /^A payment Shade found was already confirmed on another invoice\./,
    );
  });
});
