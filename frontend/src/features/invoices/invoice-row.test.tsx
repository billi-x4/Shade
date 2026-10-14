import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InvoiceRow } from "@/features/invoices/invoice-row";
import { invoiceFixture } from "@/test/fixtures";
import { mockFetch, renderWithAnnouncer } from "@/test/utils";

const TXID = "ab".repeat(32);

describe("record payment", () => {
  it("marks an open invoice paid with a txid from the merchant's wallet", async () => {
    const invoice = invoiceFixture();
    const { calls } = mockFetch([
      {
        method: "POST",
        path: `/api/desk/invoices/${invoice.id}/accept`,
        body: { ...invoice, status: "paid", verification: "merchant_accept", txid: TXID },
      },
    ]);
    renderWithAnnouncer(<InvoiceRow invoice={invoice} explorerTemplate={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    const field = screen.getByLabelText("Transaction id");
    expect(document.activeElement).toBe(field);
    // The exact memo the payer's wallet wrote, for the merchant to check against their wallet.
    expect(screen.getByText(invoice.chain_memo)).toBeTruthy();

    fireEvent.change(field, { target: { value: "not a txid" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark paid" }));
    expect(screen.getByText(/A transaction id is 64 characters/)).toBeTruthy();
    expect(calls).toHaveLength(0);

    fireEvent.change(field, { target: { value: `  ${TXID.toUpperCase()}  ` } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: "POST", body: { txid: TXID } });
    await waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
  });

  it("shows the server's refusal in the dialog", async () => {
    const invoice = invoiceFixture();
    mockFetch([
      {
        method: "POST",
        path: `/api/desk/invoices/${invoice.id}/accept`,
        status: 422,
        body: {
          error: "OUTSIDE_WINDOW",
          message: "That transaction was mined outside this invoice's payment window.",
        },
      },
    ]);
    renderWithAnnouncer(<InvoiceRow invoice={invoice} explorerTemplate={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    fireEvent.change(screen.getByLabelText("Transaction id"), { target: { value: TXID } });
    fireEvent.click(screen.getByRole("button", { name: "Mark paid" }));
    expect(await screen.findByText(/outside this invoice's payment window/)).toBeTruthy();
    expect(document.querySelector("dialog[open]")).not.toBeNull();
  });

  it("is offered on an expired invoice, with the one-hour rule", () => {
    mockFetch([]);
    renderWithAnnouncer(
      <InvoiceRow invoice={invoiceFixture({ status: "expired" })} explorerTemplate={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(
      screen.getByText(/only if it was mined within an hour after the invoice expired/),
    ).toBeTruthy();
  });

  it("is not offered while a payment is being confirmed, or once the invoice is closed", () => {
    mockFetch([]);
    const { unmount } = renderWithAnnouncer(
      <InvoiceRow
        invoice={invoiceFixture({
          detection: {
            state: "seen",
            txid: TXID,
            pool: "ironwood",
            source: "shade_worker",
            block_height: 4_470_000,
            confirmations: 0,
            required_confirmations: 1,
            observed_at: "2026-10-06T10:00:00.000Z",
          },
        })}
        explorerTemplate={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
    unmount();
    renderWithAnnouncer(
      <InvoiceRow invoice={invoiceFixture({ status: "cancelled" })} explorerTemplate={null} />,
    );
    expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
  });
});
