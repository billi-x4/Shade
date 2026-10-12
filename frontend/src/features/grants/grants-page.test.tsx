import type { GrantCreated } from "@shade/contract";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SecretProvider } from "@/features/desk/secret-provider";
import { GrantsPage } from "@/features/grants/grants-page";
import { mockFetch, renderWithAnnouncer } from "@/test/utils";

const TOKEN = "gv_Q2hhbmdlIHRoaXMgdG9rZW4gYmVmb3JlIHNoaXBwaW5n";

const created: GrantCreated = {
  id: "grn_1",
  scope: "payroll",
  network: "testnet",
  state: "active",
  created_at: "2026-10-02T10:00:00.000Z",
  expires_at: "2026-10-09T10:00:00.000Z",
  revoked_at: null,
  last_viewed_at: null,
  note: "",
  token: TOKEN,
  view_url: `https://shade.example/view#${TOKEN}`,
};

describe("grant form", () => {
  it('rejects the label "all" in label mode instead of sharing every receipt', async () => {
    const { calls } = mockFetch([{ path: "/api/desk/grants", body: [] }]);
    renderWithAnnouncer(<GrantsPage />);
    expect(await screen.findByText("No grants yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Only invoices with a label" }));
    const label = screen.getByLabelText("Label");
    fireEvent.change(label, { target: { value: "All" } });
    // The preview must not claim a label grant covers all invoices.
    expect(screen.queryByText(/Scope: all invoices/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create grant" }));

    expect(
      screen.getByText('"all" is reserved. Choose All invoices and jar charges instead.'),
    ).toBeTruthy();
    expect(document.activeElement).toBe(label);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("calls them labels everywhere, never tags", async () => {
    mockFetch([{ path: "/api/desk/grants", body: [] }]);
    renderWithAnnouncer(<GrantsPage />);
    expect(await screen.findByText("No grants yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Only invoices with a label" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "payroll" } });
    expect(
      screen.getByText(
        "Share view for 7 days. Scope: invoices labelled payroll. You can revoke anytime.",
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create grant" }));
    expect(screen.getByText("Enter the label to share.")).toBeTruthy();
    expect(screen.queryByText(/tagged/)).toBeNull();
  });

  it("hands over only the view link, never the bare token", async () => {
    const { calls } = mockFetch([
      { path: "/api/desk/grants", body: [] },
      { method: "POST", path: "/api/desk/grants", status: 201, body: created },
    ]);
    renderWithAnnouncer(
      <SecretProvider>
        <GrantsPage />
      </SecretProvider>,
    );
    expect(await screen.findByText("No grants yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Only invoices with a label" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "payroll" } });
    fireEvent.click(screen.getByRole("button", { name: "Create grant" }));

    expect(await screen.findByRole("heading", { name: "Share this view link" })).toBeTruthy();
    expect(screen.getByText(created.view_url)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy view link" })).toBeTruthy();
    expect(screen.queryByText(TOKEN)).toBeNull();
    expect(screen.queryByText("Token")).toBeNull();
    expect(screen.getByText(/Shade shows this link once\./)).toBeTruthy();
    expect(screen.getByText(/Scope: invoices labelled payroll\./)).toBeTruthy();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      scope: "payroll",
      expires_in_sec: 604_800,
    });
  });
});
