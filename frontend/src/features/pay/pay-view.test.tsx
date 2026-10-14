import { COPY } from "@shade/contract";
import type { PublicInvoice } from "@shade/contract";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayView } from "@/features/pay/pay-view";
import { mockFetch, renderWithQuery } from "@/test/utils";

const ZIP321 =
  "zcash:utest18z20cdj59zmjdl23hyxzrgn0hr7tlexmmkwav5nwzpgd27yk4y0dc7mwwn3c0cp960swz78h7fqsvxg72jvv4mehvvattdaemqljkrk4?amount=0.01&memo=T3JkZXIgMTA0MiAoc2hhZGU6SzdRMk05WEEp";

function invoice(overrides: Partial<PublicInvoice> = {}): PublicInvoice {
  return {
    id: "inv_1",
    status: "open",
    progress: "awaiting",
    network: "testnet",
    amount_zec: "0.01",
    memo: "Order 1042",
    address:
      "utest18z20cdj59zmjdl23hyxzrgn0hr7tlexmmkwav5nwzpgd27yk4y0dc7mwwn3c0cp960swz78h7fqsvxg72jvv4mehvvattdaemqljkrk4",
    zip321: ZIP321,
    merchant_name: "Northline Coffee",
    expires_at: new Date(Date.now() + 42 * 60_000).toISOString(),
    paid_at: null,
    confirmations: null,
    required_confirmations: 1,
    ...overrides,
  };
}

function renderPay(body: PublicInvoice, status = 200) {
  const mock = mockFetch([{ path: "/api/public/invoices/inv_1", status, body }]);
  renderWithQuery(<PayView id="inv_1" />);
  return mock;
}

function expectNoPaymentControls() {
  expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
  expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy payment link" })).toBeNull();
  expect(screen.queryByLabelText("Transaction id")).toBeNull();
  expect(screen.queryByText(/Pay by hand/)).toBeNull();
}

const invoiceGets = (calls: { method: string; path: string }[]) =>
  calls.filter((call) => call.method === "GET" && call.path === "/api/public/invoices/inv_1")
    .length;

describe("pay page", () => {
  it("awaiting: heading, amount, wallet link, QR, copy and honest lines", async () => {
    renderPay(invoice());
    const open = await screen.findByRole("link", { name: "Open in wallet" });
    expect(screen.getByRole("heading", { level: 1, name: COPY.payHeading })).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) => element?.tagName === "P" && element.textContent === "0.01 ZEC",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Order 1042")).toBeTruthy();
    expect(open.getAttribute("href")).toBe(ZIP321);
    expect(screen.getByRole("img", { name: /QR code to pay 0.01 ZEC/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy payment link" })).toBeTruthy();
    expect(screen.getByText("Waiting for your payment.").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText(COPY.pay)).toBeTruthy();
    expect(screen.getByText(COPY.lag)).toBeTruthy();
    expect(screen.getByText("Testnet")).toBeTruthy();
    expect(screen.getByText("Use a testnet wallet.")).toBeTruthy();
    expect(screen.getByText(/Expires in 4[12] min/)).toBeTruthy();
  });

  it("pay by hand: offers the address, the amount and the exact on-chain memo to copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderPay(invoice());
    const summary = await screen.findByText("Wallet did not open? Pay by hand");
    fireEvent.click(summary);
    expect(screen.getByText("Order 1042 (shade:K7Q2M9XA)")).toBeTruthy();
    expect(screen.getByText(/including the shade reference at the end/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy memo" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Order 1042 (shade:K7Q2M9XA)"));
    fireEvent.click(screen.getByRole("button", { name: "Copy amount" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("0.01"));
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(invoice().address));
  });

  it("pay by hand: hidden when the payment link carries no readable memo", async () => {
    renderPay(invoice({ zip321: ZIP321.replace(/&memo=.*/, "") }));
    await screen.findByRole("link", { name: "Open in wallet" });
    expect(screen.queryByText(/Pay by hand/)).toBeNull();
  });

  it("links testnet payers to Zingo and the faucet in a new tab, without referrer", async () => {
    renderPay(invoice());
    const zingo = await screen.findByRole("link", { name: /Zingo/ });
    expect(zingo.getAttribute("href")).toBe("https://zingolabs.org");
    expect(zingo.getAttribute("target")).toBe("_blank");
    expect(zingo.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: /Testnet faucet/ }).getAttribute("href")).toBe(
      "https://zcashfaucet.jinolabs.xyz",
    );
    expect(screen.queryByRole("link", { name: /Zodl/ })).toBeNull();
  });

  it("links mainnet payers to Zodl and Zingo", async () => {
    renderPay(invoice({ network: "mainnet" }));
    expect((await screen.findByRole("link", { name: /Zodl/ })).getAttribute("href")).toBe(
      "https://zodl.com",
    );
    expect(screen.queryByText("Use a testnet wallet.")).toBeNull();
  });

  it("reported: keeps the payment instructions visible", async () => {
    renderPay(invoice({ status: "paid_unverified", progress: "reported" }));
    expect(await screen.findByText("Payment reported. The shop is checking it.")).toBeTruthy();
    expect(screen.getByText(/If you have not paid yet, you can still pay below/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in wallet" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /QR code/ })).toBeTruthy();
  });

  it("reported but past expiry: stops inviting a payment that could never match", async () => {
    const { calls } = renderPay(
      invoice({
        status: "paid_unverified",
        progress: "reported",
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(await screen.findByText("Payment reported. The shop is checking it.")).toBeTruthy();
    expect(screen.getByText(/do not send another payment/)).toBeTruthy();
    expect(screen.getByText(/ask the shop for a new invoice/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy payment link" })).toBeNull();
    expect(screen.queryByLabelText("Transaction id")).toBeNull();
    expect(screen.queryByText(/you can still pay below/)).toBeNull();
    // Still reported, not closed: the page keeps checking for the shop's decision.
    expect(screen.queryByText("Expired.")).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("reported: switches to the expired notice at expires_at without a new answer", async () => {
    renderPay(
      invoice({
        status: "paid_unverified",
        progress: "reported",
        expires_at: new Date(Date.now() + 1_200).toISOString(),
      }),
    );
    expect(await screen.findByRole("link", { name: "Open in wallet" })).toBeTruthy();
    expect(
      await screen.findByText(/do not send another payment/, undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
    expect(screen.queryByLabelText("Transaction id")).toBeNull();
  });

  it("seen: shows confirmations so far", async () => {
    renderPay(invoice({ progress: "seen", confirmations: 1, required_confirmations: 3 }));
    expect(await screen.findByText("Seen on the network · 1 of 3 confirmations.")).toBeTruthy();
  });

  it("confirmed: shows Paid and hides the payment controls", async () => {
    renderPay(
      invoice({ status: "paid", progress: "confirmed", paid_at: "2026-10-02T10:00:00.000Z" }),
    );
    expect(await screen.findByText("Paid.")).toBeTruthy();
    expect(screen.getByText("Paid. The shop has your payment.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.queryByLabelText("Transaction id")).toBeNull();
  });

  it("expired: tells the payer not to pay", async () => {
    renderPay(invoice({ status: "expired", expires_at: "2026-10-01T10:00:00.000Z" }));
    expect(await screen.findByText("Expired.")).toBeTruthy();
    expect(screen.getByText(/Do not pay it/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
  });

  it("cancelled: tells the payer not to pay and announces it", async () => {
    renderPay(invoice({ status: "cancelled" }));
    expect(await screen.findByText("Cancelled.")).toBeTruthy();
    expect(screen.getByText("The shop cancelled this invoice. Do not pay it.")).toBeTruthy();
    expect(screen.getByText("The shop cancelled this invoice.").getAttribute("role")).toBe(
      "status",
    );
    expectNoPaymentControls();
  });

  it("open but past expires_at on this device: no payment controls", async () => {
    renderPay(invoice({ expires_at: new Date(Date.now() - 60_000).toISOString() }));
    expect(await screen.findByText("Expired.")).toBeTruthy();
    expect(screen.getByText(/Do not pay it/)).toBeTruthy();
    expectNoPaymentControls();
    expect(screen.queryByText("Waiting for your payment.")).toBeNull();
    // The progress live region is gone; a page-long one still announces the change.
    expect(screen.getByText("This invoice has run out of time.").getAttribute("role")).toBe(
      "status",
    );
  });

  it("expired but seen on chain: says the network is confirming it, never invites another payment", async () => {
    renderPay(
      invoice({
        status: "expired",
        progress: "seen",
        confirmations: 1,
        required_confirmations: 3,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(await screen.findByText("Seen on the network · 1 of 3 confirmations.")).toBeTruthy();
    expect(
      screen.getByText("The network is confirming your payment. Do not pay again."),
    ).toBeTruthy();
    expect(screen.queryByText("Expired.")).toBeNull();
    expect(screen.queryByText(/ask the shop for a new one/)).toBeNull();
    expectNoPaymentControls();
  });

  it("seen: switches to the confirming notice at expires_at without a new answer", async () => {
    renderPay(
      invoice({
        progress: "seen",
        confirmations: 0,
        required_confirmations: 3,
        expires_at: new Date(Date.now() + 1_200).toISOString(),
      }),
    );
    expect(await screen.findByRole("link", { name: "Open in wallet" })).toBeTruthy();
    expect(
      await screen.findByText(/is confirming your payment\. Do not pay again\./, undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();
    expectNoPaymentControls();
    expect(screen.queryByText("Expired.")).toBeNull();
  });

  it("missing: 404 shows a plain not-found heading", async () => {
    mockFetch([
      {
        path: "/api/public/invoices/inv_1",
        status: 404,
        body: { error: "NOT_FOUND", message: "No such invoice." },
      },
    ]);
    renderWithQuery(<PayView id="inv_1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "No such invoice." })).toBeTruthy();
  });

  it("never turns a non-zcash URI into a link", async () => {
    renderPay(invoice({ zip321: "javascript:alert(1)" }));
    expect(await screen.findByText(/cannot pay this invoice from this page/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in wallet" })).toBeNull();
  });

  it("maps txid check errors to plain copy", async () => {
    const { calls } = mockFetch([
      { path: "/api/public/invoices/inv_1", body: invoice() },
      {
        method: "POST",
        path: "/api/public/invoices/inv_1/txid",
        status: 422,
        body: { error: "TX_NOT_SHIELDED", message: "raw backend message" },
      },
    ]);
    renderWithQuery(<PayView id="inv_1" />);
    const input = await screen.findByLabelText("Transaction id");
    fireEvent.change(input, { target: { value: "not-a-txid" } });
    fireEvent.click(screen.getByRole("button", { name: "Send transaction id" }));
    expect(screen.getAllByText(/A transaction id is 64 characters/).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    fireEvent.change(input, { target: { value: "AB".repeat(32) } });
    fireEvent.click(screen.getByRole("button", { name: "Send transaction id" }));
    await waitFor(() =>
      expect(screen.getAllByText(/not a shielded payment/).length).toBeGreaterThan(0),
    );
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ txid: "ab".repeat(32) });
  });

  it("passes on the server's reason for a well-formed but rejected txid", async () => {
    const reversed =
      "That transaction id is in reversed byte order. Copy it again from your wallet or a block explorer.";
    mockFetch([
      { path: "/api/public/invoices/inv_1", body: invoice() },
      {
        method: "POST",
        path: "/api/public/invoices/inv_1/txid",
        status: 400,
        body: { error: "BAD_TXID", message: reversed },
      },
    ]);
    renderWithQuery(<PayView id="inv_1" />);
    fireEvent.change(await screen.findByLabelText("Transaction id"), {
      target: { value: "12".repeat(32) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send transaction id" }));
    await waitFor(() => expect(screen.getAllByText(reversed).length).toBeGreaterThan(0));
    expect(screen.queryByText(/A transaction id is 64 characters/)).toBeNull();
  });

  it("shows the reported state after a successful txid paste", async () => {
    mockFetch([
      { path: "/api/public/invoices/inv_1", body: invoice() },
      {
        method: "POST",
        path: "/api/public/invoices/inv_1/txid",
        body: invoice({ status: "paid_unverified", progress: "reported" }),
      },
    ]);
    renderWithQuery(<PayView id="inv_1" />);
    fireEvent.change(await screen.findByLabelText("Transaction id"), {
      target: { value: "cd".repeat(32) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send transaction id" }));
    expect(await screen.findByText("Payment reported. The shop is checking it.")).toBeTruthy();
    expect(screen.getByText(/The shop will check it/)).toBeTruthy();
  });
});

describe("pay page polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Only the intervals are fake: the 3 s poll runs on demand, everything else keeps real time. */
  async function advancePoll() {
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
  }

  it("keeps polling an expired invoice whose payment is confirming, until it is paid", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    const { calls } = mockFetch([
      {
        path: "/api/public/invoices/inv_1",
        once: true,
        body: invoice({
          status: "expired",
          progress: "seen",
          confirmations: 0,
          required_confirmations: 1,
          expires_at: expiresAt,
        }),
      },
      {
        path: "/api/public/invoices/inv_1",
        body: invoice({
          status: "paid",
          progress: "confirmed",
          confirmations: 1,
          required_confirmations: 1,
          expires_at: expiresAt,
          paid_at: "2026-10-02T10:00:00.000Z",
        }),
      },
    ]);
    renderWithQuery(<PayView id="inv_1" />);
    expect(await screen.findByText(/is confirming your payment/)).toBeTruthy();
    await advancePoll();
    expect(await screen.findByText("Paid.")).toBeTruthy();
    expect(invoiceGets(calls)).toBe(2);

    // Paid is final: polling stops.
    await advancePoll();
    await advancePoll();
    expect(invoiceGets(calls)).toBe(2);
  });

  it("stops polling an expired invoice with nothing on chain", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { calls } = renderPay(
      invoice({ status: "expired", expires_at: "2026-10-01T10:00:00.000Z" }),
    );
    expect(await screen.findByText("Expired.")).toBeTruthy();
    await advancePoll();
    await advancePoll();
    expect(invoiceGets(calls)).toBe(1);
  });
});
