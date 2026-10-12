import { COPY } from "@shade/contract";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InvoiceForm } from "@/features/invoices/invoice-form";
import { mockFetch, renderWithQuery } from "@/test/utils";

const created = {
  id: "inv_1",
  amount_zec: "0.01",
  pay_url: "https://shade.example/pay/inv_1",
};

describe("invoice form", () => {
  it("validates on the client and does not call the API with bad input", () => {
    const { calls } = mockFetch([]);
    renderWithQuery(<InvoiceForm noAddress={false} />);
    fireEvent.change(screen.getByLabelText("Amount (ZEC)"), { target: { value: "0.123456789" } });
    fireEvent.change(screen.getByLabelText("Label (for grants)"), {
      target: { value: "Pay Roll" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));

    const amount = screen.getByLabelText("Amount (ZEC)");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    const describedBy = amount.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy.split(" ")[0] ?? "")?.textContent).toBe(
      "Use a number like 0.01, with at most 8 decimals.",
    );
    expect(document.activeElement).toBe(amount);
    expect(screen.getByText(/Use up to 32 lowercase letters/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("counts memo bytes against the 495-byte limit", () => {
    mockFetch([]);
    renderWithQuery(<InvoiceForm noAddress={false} />);
    expect(screen.getByText("0/495 bytes")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "☕☕" } });
    expect(screen.getByText("6/495 bytes")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "x".repeat(496) } });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    expect(screen.getByText("Keep the memo under 496 bytes.")).toBeTruthy();
  });

  it("uses placeholders, never prefilled values", () => {
    mockFetch([]);
    renderWithQuery(<InvoiceForm noAddress={false} />);
    for (const label of ["Amount (ZEC)", "Memo", "Label (for grants)"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.value).toBe("");
      expect(input.placeholder).not.toBe("");
    }
  });

  it("creates the invoice with normalized fields and offers the pay link", async () => {
    const { calls } = mockFetch([
      { method: "POST", path: "/api/desk/invoices", status: 201, body: created },
    ]);
    renderWithQuery(<InvoiceForm noAddress={false} />);
    fireEvent.change(screen.getByLabelText("Amount (ZEC)"), { target: { value: " 0.01 " } });
    fireEvent.change(screen.getByLabelText("Memo"), { target: { value: "Order 1042" } });
    fireEvent.change(screen.getByLabelText("Label (for grants)"), { target: { value: "Payroll" } });
    fireEvent.change(screen.getByLabelText("Expires after"), { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    expect(await screen.findByRole("button", { name: "Copy pay link" })).toBeTruthy();
    expect(calls[0]?.body).toEqual({
      amount_zec: "0.01",
      memo: "Order 1042",
      tag: "payroll",
      expires_in_sec: 600,
    });
    expect((screen.getByLabelText("Amount (ZEC)") as HTMLInputElement).value).toBe("");
  });

  it("puts a backend field error next to its field", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/desk/invoices",
        status: 400,
        body: { error: "BAD_MEMO", message: "Memo too long for the chain." },
      },
    ]);
    renderWithQuery(<InvoiceForm noAddress={false} />);
    fireEvent.change(screen.getByLabelText("Amount (ZEC)"), { target: { value: "0.01" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    expect(await screen.findByText("Memo too long for the chain.")).toBeTruthy();
    expect(screen.getByLabelText("Memo").getAttribute("aria-invalid")).toBe("true");
  });

  it("explains why it cannot be used without a receive address", () => {
    mockFetch([]);
    renderWithQuery(
      <InvoiceForm noAddress addressLink={<a href="/desk/settings/address">Add one</a>} />,
    );
    expect(screen.getByText(COPY.noAddress)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create invoice" })).toBeNull();
  });
});
