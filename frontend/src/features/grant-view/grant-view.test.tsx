import { COPY } from "@shade/contract";
import type { GrantView as GrantViewData } from "@shade/contract";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { tokenFromHash } from "@/features/grant-view/grant-token";
import { GrantView } from "@/features/grant-view/grant-view";
import { mockFetch, renderWithQuery } from "@/test/utils";

const TOKEN = "gv_Q2hhbmdlIHRoaXMgdG9rZW4gYmVmb3JlIHNoaXBwaW5n";

const active: GrantViewData = {
  state: "active",
  scope: "payroll",
  network: "testnet",
  merchant_name: "Northline Coffee",
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  message: COPY.grantNote,
  receipts: [
    {
      id: "inv_1",
      kind: "invoice",
      amount_zec: "0.01",
      memo: "Order 1042",
      memo_hash: "sha256:00",
      tag: "payroll",
      txid: "ef".repeat(32),
      verification: "ivk_scan",
      paid_at: "2026-10-02T10:00:00.000Z",
      created_at: "2026-10-02T09:58:00.000Z",
    },
  ],
};

function openAt(hash: string) {
  window.history.replaceState(null, "", `/view${hash}`);
}

describe("grant view", () => {
  it("reads the token from the fragment, posts it in the body and clears it from the URL", async () => {
    openAt(`#${TOKEN}`);
    const { calls } = mockFetch([
      { method: "POST", path: "/api/public/grants/view", body: active },
      { path: "/api/config", body: { explorer_tx_url: { testnet: null, mainnet: null } } },
    ]);
    renderWithQuery(<GrantView />);
    expect(await screen.findByText("Invoices labelled payroll")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Receipts" })).toBeTruthy();
    const view = calls.find((call) => call.path === "/api/public/grants/view");
    expect(view?.method).toBe("POST");
    expect(view?.body).toEqual({ token: TOKEN });
    expect(calls.every((call) => !call.path.includes(TOKEN))).toBe(true);
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/view");
    expect(screen.getByText("Order 1042")).toBeTruthy();
    expect(screen.getByText("Found by wallet scan")).toBeTruthy();
  });

  it("asks for the full link when there is no token", () => {
    openAt("");
    const { calls } = mockFetch([]);
    renderWithQuery(<GrantView />);
    expect(
      screen.getByRole("heading", { level: 1, name: "This page needs the full link." }),
    ).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows the revoked state", async () => {
    openAt(`#${TOKEN}`);
    mockFetch([
      {
        method: "POST",
        path: "/api/public/grants/view",
        body: { state: "revoked", scope: "all", message: COPY.grantNote },
      },
    ]);
    renderWithQuery(<GrantView />);
    expect(await screen.findByRole("heading", { level: 1, name: "Access revoked." })).toBeTruthy();
    expect(
      screen.getByText(
        "The shop ended this view. Ask the shop for a new link if you still need these receipts.",
      ),
    ).toBeTruthy();
    // The API's message is the merchant's own revoke note, not something to show the auditor.
    expect(screen.queryByText(/Delete the file on their machine/)).toBeNull();
  });

  it("tells the auditor how long the view lasts, in their terms", async () => {
    openAt(`#${TOKEN}`);
    mockFetch([
      { method: "POST", path: "/api/public/grants/view", body: active },
      { path: "/api/config", body: { explorer_tx_url: { testnet: null, mainnet: null } } },
    ]);
    renderWithQuery(<GrantView />);
    const line = await screen.findByText(/This view is shared by the shop until/);
    expect(line.textContent).toMatch(
      /^Expires in \d+ min · This view is shared by the shop until .+\. The shop can end it at any time\.$/,
    );
    expect(screen.queryByText(/Delete the file on their machine/)).toBeNull();
    expect(screen.queryByText(/Showing the newest/)).toBeNull();
  });

  it("says when the list stops at the newest 500 receipts", async () => {
    openAt(`#${TOKEN}`);
    const first = active.state === "active" ? active.receipts[0] : undefined;
    if (!first) throw new Error("the fixture has a receipt");
    const receipts = Array.from({ length: 500 }, (_, index) => ({ ...first, id: `inv_${index}` }));
    mockFetch([
      { method: "POST", path: "/api/public/grants/view", body: { ...active, receipts } },
      { path: "/api/config", body: { explorer_tx_url: { testnet: null, mainnet: null } } },
    ]);
    renderWithQuery(<GrantView />);
    expect(
      await screen.findByText(
        "Showing the newest 500 receipts. Older ones are not in this view or the download.",
      ),
    ).toBeTruthy();
  });

  it("explains a dead CSV export (410) in the auditor's terms", async () => {
    openAt(`#${TOKEN}`);
    const { calls } = mockFetch([
      { method: "POST", path: "/api/public/grants/view", body: active },
      { path: "/api/config", body: { explorer_tx_url: { testnet: null, mainnet: null } } },
      {
        method: "POST",
        path: "/api/public/grants/export",
        status: 410,
        body: { error: "GRANT_REVOKED", message: "This grant was revoked." },
      },
    ]);
    renderWithQuery(<GrantView />);
    fireEvent.click(await screen.findByRole("button", { name: "Download receipts (CSV)" }));
    expect(
      await screen.findByText("The download no longer works. The shop ended this view."),
    ).toBeTruthy();
    const exportCall = calls.find((call) => call.path === "/api/public/grants/export");
    expect(exportCall?.body).toEqual({ token: TOKEN });
    // The view is re-checked so the page flips to the revoked state.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path === "/api/public/grants/view").length,
      ).toBeGreaterThan(1),
    );
  });

  it("downloads the CSV through an object URL", async () => {
    openAt(`#${TOKEN}`);
    mockFetch([
      { method: "POST", path: "/api/public/grants/view", body: active },
      { path: "/api/config", body: { explorer_tx_url: { testnet: null, mainnet: null } } },
      {
        method: "POST",
        path: "/api/public/grants/export",
        body: "paid_at,invoice_id\n",
        headers: {
          "content-type": "text/csv",
          "content-disposition": 'attachment; filename="shade-receipts-grn_1.csv"',
        },
      },
    ]);
    const createUrl = vi.fn(() => "blob:receipts");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderWithQuery(<GrantView />);
    fireEvent.click(await screen.findByRole("button", { name: "Download receipts (CSV)" }));
    expect(await screen.findByText("Downloaded.")).toBeTruthy();
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the server says the link opens nothing (404)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      openAt(`#${TOKEN}`);
      const { calls } = mockFetch([
        {
          method: "POST",
          path: "/api/public/grants/view",
          status: 404,
          body: { error: "NOT_FOUND", message: "No such grant." },
        },
      ]);
      renderWithQuery(<GrantView />);
      expect(
        await screen.findByRole("heading", { level: 1, name: "This link does not open anything." }),
      ).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(25_000));
      expect(calls.filter((call) => call.path === "/api/public/grants/view")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling through an outage before the first answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      openAt(`#${TOKEN}`);
      const { calls } = mockFetch([
        {
          method: "POST",
          path: "/api/public/grants/view",
          status: 503,
          body: { error: "CHAIN_UNAVAILABLE", message: "Shade is down." },
        },
      ]);
      renderWithQuery(<GrantView />);
      expect(await screen.findByText("The receipts did not load.")).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(10_500));
      expect(
        calls.filter((call) => call.path === "/api/public/grants/view").length,
      ).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches to the closed view when an open grant starts answering 404", async () => {
    openAt(`#${TOKEN}`);
    mockFetch([
      { method: "POST", path: "/api/public/grants/view", body: active, once: true },
      {
        method: "POST",
        path: "/api/public/grants/view",
        status: 404,
        body: { error: "NOT_FOUND", message: "No such grant." },
      },
      { path: "/api/config", body: { explorer_tx_url: { testnet: null, mainnet: null } } },
    ]);
    const { client } = renderWithQuery(<GrantView />);
    expect(await screen.findByText("Order 1042")).toBeTruthy();
    await act(() => client.refetchQueries({ queryKey: ["public", "grant-view"] }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link does not open anything." }),
    ).toBeTruthy();
    expect(screen.queryByText("Order 1042")).toBeNull();
  });

  it("never shows the previous grant's receipts under a newly pasted link", async () => {
    const OTHER = "gv_T3RoZXIgdG9rZW4gZm9yIGFub3RoZXIgc2hvcA";
    openAt(`#${TOKEN}`);
    const { calls } = mockFetch([
      { method: "POST", path: "/api/public/grants/view", body: active, once: true },
      {
        method: "POST",
        path: "/api/public/grants/view",
        body: { ...active, merchant_name: "Other Shop", receipts: [] },
      },
      { path: "/api/config", body: { explorer_tx_url: { testnet: null, mainnet: null } } },
    ]);
    renderWithQuery(<GrantView />);
    expect(await screen.findByText("Northline Coffee")).toBeTruthy();

    act(() => {
      window.location.hash = OTHER;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.queryByText("Northline Coffee")).toBeNull();
    expect(screen.queryByText("Order 1042")).toBeNull();
    expect(await screen.findByText("Other Shop")).toBeTruthy();
    expect(calls.filter((call) => call.path === "/api/public/grants/view").at(-1)?.body).toEqual({
      token: OTHER,
    });
  });

  it("accepts only well-formed tokens", () => {
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash("#main")).toBeNull();
    expect(tokenFromHash("#gv_short")).toBeNull();
    expect(tokenFromHash("")).toBeNull();
  });
});
