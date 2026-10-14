import type { Me } from "@shade/contract";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "@/api/keys";
import { AddressSettingsPage } from "@/features/settings/address-page";
import {
  configFixture,
  invoiceFixture,
  meFixture,
  TESTNET_UA,
  viewingKeyFixture,
} from "@/test/fixtures";
import { liveRegionText, mockFetch, renderWithAnnouncer, renderWithRouter } from "@/test/utils";

const OTHER_UA = "utest1otheraddressofthesamewalletaccount";
const UNCONFIRMED =
  "Shade can't confirm this address belongs to your viewing key. If it comes from a different wallet or account, Shade won't detect payments to it.";
const MANAGED =
  "Your viewing key provides this address. Upload the key again with “Use this key's address” turned off, or delete the key, to use a different address.";

describe("network choice", () => {
  it("offers a way back when the operator turned off the desk's network", async () => {
    const { calls } = mockFetch([
      { path: "/api/config", body: configFixture(["testnet"]) },
      { path: "/api/desk/me", body: meFixture({ network: "mainnet" }, ["testnet"]), once: true },
      { path: "/api/desk/me", body: meFixture({ network: "testnet" }, ["testnet"]) },
      { path: "/api/desk/viewing-keys", body: [] },
      {
        method: "PUT",
        path: "/api/desk/settings/network",
        body: meFixture({ network: "testnet" }, ["testnet"]),
      },
    ]);
    renderWithAnnouncer(<AddressSettingsPage />);
    expect(
      await screen.findByText(/The desk is on Mainnet, but this server has turned mainnet off/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to testnet" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ network: "testnet" }),
    );
    expect(await screen.findByText(/This server runs testnet only/)).toBeTruthy();
  });

  it("drops other pages' cached lists of the old network instead of showing them stale", async () => {
    mockFetch([
      { path: "/api/config", body: configFixture(["testnet"]) },
      { path: "/api/desk/me", body: meFixture({ network: "mainnet" }, ["testnet"]), once: true },
      { path: "/api/desk/me", body: meFixture({ network: "testnet" }, ["testnet"]) },
      { path: "/api/desk/viewing-keys", body: [] },
      {
        method: "PUT",
        path: "/api/desk/settings/network",
        body: meFixture({ network: "testnet" }, ["testnet"]),
      },
    ]);
    const { client } = renderWithAnnouncer(<AddressSettingsPage />);
    // The Invoices and Jars pages were visited on mainnet earlier.
    client.setQueryData(qk.invoiceList("all"), {
      pages: [{ items: [invoiceFixture({ network: "mainnet" })], next_cursor: null }],
      pageParams: [null],
    });
    client.setQueryData(qk.jars, []);

    fireEvent.click(await screen.findByRole("button", { name: "Switch to testnet" }));
    expect(await screen.findByText(/This server runs testnet only/)).toBeTruthy();
    expect(client.getQueryData(qk.invoiceList("all"))).toBeUndefined();
    expect(client.getQueryData(qk.jars)).toBeUndefined();
    expect(client.getQueryData<Me>(qk.me)?.merchant.network).toBe("testnet");
  });

  it("confirms before moving a stranded desk onto mainnet", async () => {
    const { calls } = mockFetch([
      { path: "/api/config", body: configFixture(["mainnet"]) },
      { path: "/api/desk/me", body: meFixture({ network: "testnet" }, ["mainnet"]) },
      { path: "/api/desk/viewing-keys", body: [] },
    ]);
    renderWithAnnouncer(<AddressSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch to mainnet" }));
    expect(screen.getByRole("heading", { name: "Switch to mainnet?" })).toBeTruthy();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("only says mainnet is off when it is", async () => {
    mockFetch([
      { path: "/api/config", body: configFixture(["mainnet"]) },
      { path: "/api/desk/me", body: meFixture({ network: "mainnet" }, ["mainnet"]) },
      { path: "/api/desk/viewing-keys", body: [] },
    ]);
    renderWithAnnouncer(<AddressSettingsPage />);
    expect(await screen.findByText(/This server runs mainnet only\./)).toBeTruthy();
    expect(screen.queryByText(/Mainnet stays off/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch/ })).toBeNull();
  });
});

describe("receive address with a viewing key", () => {
  it("explains how to use another address of the same account while the key provides it", async () => {
    mockFetch([
      { path: "/api/config", body: configFixture() },
      { path: "/api/desk/me", body: meFixture() },
      { path: "/api/desk/viewing-keys", body: [viewingKeyFixture({ use_key_address: true })] },
    ]);
    renderWithRouter(<AddressSettingsPage />);
    const paragraph = await screen.findByText(/This address comes from your viewing key/);
    expect(paragraph.textContent).toBe(
      `This address comes from your viewing key, so Shade sees payments sent to it. To use another address from the same wallet account, upload the key again under Detection with "Use this key's address" turned off. Then save that address here. Shade cannot check that it belongs to the key. If it comes from another account, Shade will not see payments to it.`,
    );
    expect(screen.getByRole("link", { name: "Detection" }).getAttribute("href")).toBe(
      "/desk/settings/detection",
    );
    expect(screen.queryByRole("button", { name: "Save address" })).toBeNull();
  });

  it("saves another address of the key's wallet and shows the server's warning", async () => {
    const { calls } = mockFetch([
      { path: "/api/config", body: configFixture() },
      { path: "/api/desk/me", body: meFixture() },
      { path: "/api/desk/viewing-keys", body: [viewingKeyFixture({ use_key_address: false })] },
      {
        method: "PUT",
        path: "/api/desk/settings/address",
        body: {
          me: meFixture({ receive_addresses: { testnet: OTHER_UA, mainnet: null } }),
          address: OTHER_UA,
          notice: UNCONFIRMED,
        },
      },
    ]);
    renderWithAnnouncer(<AddressSettingsPage />);
    expect(await screen.findByText(TESTNET_UA)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: OTHER_UA } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));

    const notice = await screen.findByText(UNCONFIRMED);
    expect(notice.className).toMatch(/border-warn/);
    expect(screen.getByText(OTHER_UA)).toBeTruthy();
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      network: "testnet",
      address: OTHER_UA,
    });
    // Spoken with the outcome, not only shown.
    await waitFor(() =>
      expect(liveRegionText()).toBe(`Testnet receive address saved. ${UNCONFIRMED}`),
    );
  });

  it("puts the key-managed refusal next to the field", async () => {
    mockFetch([
      { path: "/api/config", body: configFixture() },
      { path: "/api/desk/me", body: meFixture() },
      // The key was switched to its own address in another tab after this page loaded.
      { path: "/api/desk/viewing-keys", body: [] },
      {
        method: "PUT",
        path: "/api/desk/settings/address",
        status: 409,
        body: { error: "ADDRESS_MANAGED_BY_KEY", message: MANAGED },
      },
    ]);
    renderWithAnnouncer(<AddressSettingsPage />);
    const input = await screen.findByLabelText("Replace with");
    fireEvent.change(input, { target: { value: OTHER_UA } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    const error = await screen.findByText(MANAGED);
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getAllByText(MANAGED)).toHaveLength(1);
  });
});
