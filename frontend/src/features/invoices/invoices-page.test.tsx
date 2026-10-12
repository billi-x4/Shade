import type { InvoiceDetection } from "@shade/contract";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/keys";
import { InvoiceRow } from "@/features/invoices/invoice-row";
import { InvoicesPage } from "@/features/invoices/invoices-page";
import { configFixture, invoiceFixture, meFixture, viewingKeyFixture } from "@/test/fixtures";
import {
  mockFetch,
  renderWithAnnouncer,
  renderWithQuery,
  renderWithRouter,
  type MockRoute,
} from "@/test/utils";

const detection = (overrides: Partial<InvoiceDetection>): InvoiceDetection => ({
  state: "seen",
  txid: "ab".repeat(32),
  pool: "orchard",
  source: "shade_worker",
  block_height: 4_200_000,
  confirmations: 1,
  required_confirmations: 1,
  observed_at: "2026-10-02T11:00:00.000Z",
  ...overrides,
});

describe("invoice list", () => {
  it("keeps the rows and an open cancel dialog when a refresh fails", async () => {
    mockFetch([
      { path: "/api/config", body: configFixture() },
      { path: "/api/desk/me", body: meFixture() },
      {
        path: "/api/desk/invoices",
        body: { items: [invoiceFixture()], next_cursor: null },
        once: true,
      },
      {
        path: "/api/desk/invoices",
        status: 503,
        body: { error: "CHAIN_UNAVAILABLE", message: "Shade is down." },
      },
    ]);
    const { client } = renderWithAnnouncer(<InvoicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel invoice" }));
    const dialog = document.querySelector("dialog");
    expect(dialog?.open).toBe(true);

    await act(() => client.refetchQueries({ queryKey: qk.invoices }));

    // An open invoice keeps the list polling, so the next poll is the retry.
    expect(await screen.findByText(/Reconnecting…/)).toBeTruthy();
    expect(screen.getByText("Order 1042")).toBeTruthy();
    expect(dialog?.isConnected).toBe(true);
    expect(dialog?.open).toBe(true);
    expect(screen.queryByText("This did not load.")).toBeNull();
  });
});

describe("detection-off notice", () => {
  const NOTICE = /Automatic detection is off on testnet\./;
  const hostedConfig = { ...configFixture(), features: { hosted_detection: true } };
  const hostedMe = { ...meFixture(), hosted_detection: true };
  const emptyList = { path: "/api/desk/invoices", body: { items: [], next_cursor: null } };

  function routes(overrides: { me?: unknown; config?: unknown; keys?: unknown[] }): MockRoute[] {
    return [
      { path: "/api/config", body: overrides.config ?? hostedConfig },
      { path: "/api/desk/me", body: overrides.me ?? hostedMe },
      { path: "/api/desk/viewing-keys", body: overrides.keys ?? [] },
      emptyList,
    ];
  }

  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("says invoices will not settle by themselves and links to the fix", async () => {
    mockFetch(routes({}));
    renderWithRouter(<InvoicesPage />);
    const notice = await screen.findByText(NOTICE);
    expect(notice.closest("p")?.textContent).toBe(
      "Automatic detection is off on testnet. Invoices stay unpaid until you confirm a payment by hand. Turn on detection",
    );
    expect(screen.getByRole("link", { name: "Turn on detection" }).getAttribute("href")).toBe(
      "/desk/settings/detection",
    );
  });

  it("stays hidden once dismissed for that network", async () => {
    mockFetch(routes({}));
    const { unmount } = renderWithRouter(<InvoicesPage />);
    await screen.findByText(NOTICE);
    fireEvent.click(screen.getByRole("button", { name: "Don't show again" }));
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    unmount();

    renderWithRouter(<InvoicesPage />);
    expect(await screen.findByText("No invoices yet.")).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("is not shown with a viewing key, without hosted detection, or without an address", async () => {
    mockFetch(routes({ keys: [viewingKeyFixture()] }));
    const first = renderWithRouter(<InvoicesPage />);
    expect(await screen.findByText("No invoices yet.")).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
    first.unmount();

    const { calls } = mockFetch(routes({ config: configFixture(), me: meFixture() }));
    const second = renderWithRouter(<InvoicesPage />);
    expect(await screen.findByText("No invoices yet.")).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(calls.some((call) => call.path === "/api/desk/viewing-keys")).toBe(false);
    second.unmount();

    mockFetch(
      routes({
        me: {
          ...meFixture({ receive_addresses: { testnet: null, mainnet: null } }),
          hosted_detection: true,
        },
      }),
    );
    renderWithRouter(<InvoicesPage />);
    expect(await screen.findByText("Add a testnet receive address")).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe("invoice list polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const listGets = (calls: { method: string; path: string }[]) =>
    calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/desk/invoices"))
      .length;

  /** Only the intervals are fake: the 5 s refetch runs on demand, everything else keeps real time. */
  async function advancePoll() {
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
  }

  it("keeps refetching while an expired invoice has a payment confirming", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const expired = {
      status: "expired" as const,
      expires_at: "2026-10-02T10:30:00.000Z",
    };
    const { calls } = mockFetch([
      { path: "/api/config", body: configFixture() },
      { path: "/api/desk/me", body: meFixture() },
      {
        path: "/api/desk/invoices",
        once: true,
        body: {
          items: [invoiceFixture({ ...expired, detection: detection({ confirmations: 0 }) })],
          next_cursor: null,
        },
      },
      {
        path: "/api/desk/invoices",
        body: {
          items: [
            invoiceFixture({
              ...expired,
              status: "paid",
              verification: "ivk_scan",
              txid: "ab".repeat(32),
              paid_at: "2026-10-02T10:40:00.000Z",
              detection: detection({ state: "settled" }),
            }),
          ],
          next_cursor: null,
        },
      },
    ]);
    renderWithAnnouncer(<InvoicesPage />);
    expect(await screen.findByText("Seen on chain · 0/1 confirmations")).toBeTruthy();
    await advancePoll();
    expect(await screen.findByText("Paid · found by wallet scan")).toBeTruthy();
    expect(listGets(calls)).toBe(2);

    // Nothing left that can change: the list stops refetching.
    await advancePoll();
    expect(listGets(calls)).toBe(2);
  });

  it("does not refetch a list of closed invoices", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { calls } = mockFetch([
      { path: "/api/config", body: configFixture() },
      { path: "/api/desk/me", body: meFixture() },
      {
        path: "/api/desk/invoices",
        body: {
          items: [
            invoiceFixture({
              status: "expired",
              detection: detection({ state: "late", txid: "cd".repeat(32) }),
            }),
          ],
          next_cursor: null,
        },
      },
    ]);
    renderWithAnnouncer(<InvoicesPage />);
    expect(await screen.findByText("Expired")).toBeTruthy();
    await advancePoll();
    expect(listGets(calls)).toBe(1);
  });
});

describe("invoice row detections", () => {
  it("shows the seen payment on an expired invoice that is still confirming", () => {
    renderWithQuery(
      <ul>
        <InvoiceRow
          invoice={invoiceFixture({
            status: "expired",
            detection: detection({
              txid: "ef".repeat(32),
              confirmations: 0,
              required_confirmations: 3,
            }),
          })}
          explorerTemplate={null}
        />
      </ul>,
    );
    expect(screen.getByText("Seen on chain · 0/3 confirmations")).toBeTruthy();
    expect(screen.getByText("Seen transaction")).toBeTruthy();
    expect(screen.getByTitle("ef".repeat(32))).toBeTruthy();
    expect(screen.queryByText("Expired")).toBeNull();
  });

  it("warns about a payment that arrived after the invoice was cancelled", () => {
    renderWithQuery(
      <ul>
        <InvoiceRow
          invoice={invoiceFixture({
            status: "cancelled",
            detection: detection({ state: "late", txid: "cd".repeat(32) }),
          })}
          explorerTemplate={null}
        />
      </ul>,
    );
    expect(
      screen.getByText(
        /A payment arrived after this invoice was cancelled\. Shade did not mark it paid/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Late payment")).toBeTruthy();
    expect(screen.getByTitle("cd".repeat(32))).toBeTruthy();
  });

  it("warns about a late payment on an expired invoice", () => {
    renderWithQuery(
      <ul>
        <InvoiceRow
          invoice={invoiceFixture({ status: "expired", detection: detection({ state: "late" }) })}
          explorerTemplate={null}
        />
      </ul>,
    );
    expect(screen.getByText(/A payment arrived after this invoice expired\./)).toBeTruthy();
  });

  it("flags another payment on a paid invoice, but not the scanner catching up on the same one", () => {
    const paid = {
      status: "paid" as const,
      verification: "merchant_accept" as const,
      txid: "ef".repeat(32),
      paid_at: "2026-10-02T10:30:00.000Z",
    };
    const { unmount } = renderWithQuery(
      <ul>
        <InvoiceRow
          invoice={invoiceFixture({
            ...paid,
            detection: detection({ state: "settled_after", txid: "ef".repeat(32) }),
          })}
          explorerTemplate={null}
        />
      </ul>,
    );
    expect(screen.queryByText(/Another payment matched this invoice/)).toBeNull();
    unmount();

    renderWithQuery(
      <ul>
        <InvoiceRow
          invoice={invoiceFixture({
            ...paid,
            detection: detection({ state: "settled_after", txid: "12".repeat(32) }),
          })}
          explorerTemplate={null}
        />
      </ul>,
    );
    expect(screen.getByText(/Another payment matched this invoice/)).toBeTruthy();
    expect(screen.getByTitle("12".repeat(32))).toBeTruthy();
  });
});
