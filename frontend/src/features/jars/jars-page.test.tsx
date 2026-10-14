import type { Jar, Me } from "@shade/contract";
import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "@/api/keys";
import { SecretProvider } from "@/features/desk/secret-provider";
import { JarsPage } from "@/features/jars/jars-page";
import { liveRegionText, mockFetch, renderWithAnnouncer } from "@/test/utils";

const me: Me = {
  user: { id: "usr_1", email: "shop@example.com", name: "", email_verified: true },
  merchant: {
    id: "mer_1",
    display_name: "Northline Coffee",
    network: "testnet",
    receive_addresses: { testnet: "utest1example", mainnet: null },
  },
  networks_enabled: ["testnet"],
  hosted_detection: false,
};

const jar: Jar = {
  id: "jar_1",
  label: "research-agent",
  status: "open",
  network: "testnet",
  cap_zec: "0.05",
  spent_zec: "0.01",
  remaining_zec: "0.04",
  address: "utest1example",
  charge_count: 0,
  created_at: "2026-10-02T10:00:00.000Z",
  killed_at: null,
  note: "",
};

const noCharges = { items: [], next_cursor: null };

function openKillDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Kill" }));
  const dialog = document.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  return dialog as HTMLDialogElement;
}

describe("jars page", () => {
  it("keeps the jars and an open kill dialog when a background poll fails", async () => {
    mockFetch([
      { path: "/api/desk/me", body: me },
      { path: "/api/desk/jars", body: [jar], once: true },
      {
        path: "/api/desk/jars",
        status: 503,
        body: { error: "CHAIN_UNAVAILABLE", message: "Shade is down." },
      },
      { path: "/api/desk/jars/jar_1/charges", body: noCharges },
    ]);
    const { client } = renderWithAnnouncer(<JarsPage />);
    expect(await screen.findByRole("heading", { name: "research-agent" })).toBeTruthy();
    const dialog = openKillDialog();

    await act(() => client.refetchQueries({ queryKey: qk.jars }));

    expect(await screen.findByText(/Reconnecting…/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "research-agent" })).toBeTruthy();
    expect(dialog.isConnected).toBe(true);
    expect(dialog.open).toBe(true);
    expect(screen.queryByText("This did not load.")).toBeNull();
  });

  it("still shows the error state when the first load fails", async () => {
    mockFetch([
      { path: "/api/desk/me", body: me },
      {
        path: "/api/desk/jars",
        status: 503,
        body: { error: "CHAIN_UNAVAILABLE", message: "Shade is down." },
      },
    ]);
    renderWithAnnouncer(<JarsPage />);
    expect(await screen.findByText("This did not load.")).toBeTruthy();
    expect(screen.getByText("Shade is down.")).toBeTruthy();
  });

  it("speaks a failed kill inside the open dialog", async () => {
    mockFetch([
      { path: "/api/desk/me", body: me },
      { path: "/api/desk/jars", body: [jar] },
      { path: "/api/desk/jars/jar_1/charges", body: noCharges },
      {
        method: "POST",
        path: "/api/desk/jars/jar_1/kill",
        status: 409,
        body: { error: "JAR_CLOSED", message: "This jar is already closed." },
      },
    ]);
    renderWithAnnouncer(<JarsPage />);
    expect(await screen.findByRole("heading", { name: "research-agent" })).toBeTruthy();
    const dialog = openKillDialog();
    fireEvent.click(screen.getByRole("button", { name: "Kill jar" }));
    await waitFor(() => expect(liveRegionText()).toContain("This jar is already closed."));
    expect(dialog.open).toBe(true);
  });

  it("loads a killed jar's charges only when they are opened", async () => {
    const killed: Jar = {
      ...jar,
      id: "jar_2",
      label: "old-agent",
      status: "killed",
      charge_count: 2,
      killed_at: "2026-10-02T11:00:00.000Z",
    };
    const { calls } = mockFetch([
      { path: "/api/desk/me", body: me },
      { path: "/api/desk/jars", body: [jar, killed] },
      { path: "/api/desk/jars/jar_1/charges", body: noCharges },
      {
        path: "/api/desk/jars/jar_2/charges",
        body: {
          items: [
            {
              id: "inv_c1",
              status: "authorized",
              amount_zec: "0.002",
              memo: "api:search",
              created_at: "2026-10-02T10:30:00.000Z",
            },
          ],
          next_cursor: null,
        },
      },
    ]);
    const chargePaths = () =>
      calls.filter((call) => call.path.includes("/charges")).map((call) => call.path);
    renderWithAnnouncer(<JarsPage />);
    expect(
      await screen.findByText("No charges yet. Give the agent its key to start."),
    ).toBeTruthy();
    expect(chargePaths()).toEqual(["/api/desk/jars/jar_1/charges?limit=25"]);

    fireEvent.click(screen.getByText("Charges · 2"));
    // Exact: the open jar's first-charge command also mentions api:search.
    expect(await screen.findByText("api:search")).toBeTruthy();
    expect(chargePaths()).toEqual([
      "/api/desk/jars/jar_1/charges?limit=25",
      "/api/desk/jars/jar_2/charges?limit=25",
    ]);
  });

  it("does not refetch every jar's charges when the window regains focus", async () => {
    const { calls } = mockFetch([
      { path: "/api/desk/me", body: me },
      { path: "/api/desk/jars", body: [jar] },
      { path: "/api/desk/jars/jar_1/charges", body: noCharges },
    ]);
    const count = (part: string) => calls.filter((call) => call.path.includes(part)).length;
    renderWithAnnouncer(<JarsPage />);
    expect(
      await screen.findByText("No charges yet. Give the agent its key to start."),
    ).toBeTruthy();
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      // The jar list itself still refreshes on focus.
      await waitFor(() =>
        expect(calls.filter((call) => call.path === "/api/desk/jars").length).toBeGreaterThan(1),
      );
      expect(count("/charges")).toBe(1);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it("gives the agent a copyable charge that never contains its key", async () => {
    mockFetch([
      { path: "/api/desk/me", body: me },
      { path: "/api/desk/jars", body: [jar] },
      { path: "/api/desk/jars/jar_1/charges", body: noCharges },
      {
        method: "POST",
        path: "/api/desk/keys",
        status: 201,
        body: {
          id: "key_1",
          kind: "agent",
          network: "testnet",
          prefix: "ag_AbCd…",
          last4: "wxyz",
          label: "research-agent",
          jar_id: "jar_1",
          created_at: "2026-10-02T10:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
          token: "ag_secretTokenValue0123456789wxyz",
        },
      },
    ]);
    renderWithAnnouncer(
      <SecretProvider>
        <JarsPage />
      </SecretProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Agent key" }));
    expect(await screen.findByText("ag_secretTokenValue0123456789wxyz")).toBeTruthy();
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    const example = within(dialog).getByText(/curl -X POST/);
    expect(example.textContent).toBe(
      [
        `curl -X POST ${window.location.origin}/v1/jars/jar_1/charge \\`,
        `  -H "Authorization: Bearer $SHADE_AGENT_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Idempotency-Key: call-1" \\`,
        `  -d '{"amount_zec":"0.002","memo":"api:search"}'`,
      ].join("\n"),
    );
    expect(example.textContent).not.toContain("ag_secret");
    expect(screen.getByRole("button", { name: "Copy example charge" })).toBeTruthy();

    // The jar card keeps the same first charge on screen, also without the key.
    const card = screen.getByRole("heading", { name: "research-agent" }).closest("li")!;
    expect(within(card).getByText(/curl -X POST/).textContent).toBe(example.textContent);
    expect(card.textContent).not.toContain("ag_secret");
    expect(within(card).getByRole("button", { name: "Copy command" })).toBeTruthy();
  });

  it("refetches a jar's charges only when the jar poll shows new activity", async () => {
    const charged = { ...jar, spent_zec: "0.02", remaining_zec: "0.03", charge_count: 1 };
    const { calls } = mockFetch([
      { path: "/api/desk/me", body: me },
      { path: "/api/desk/jars", body: [jar], once: true },
      { path: "/api/desk/jars", body: [jar], once: true },
      { path: "/api/desk/jars", body: [charged] },
      { path: "/api/desk/jars/jar_1/charges", body: noCharges },
    ]);
    const chargeFetches = () => calls.filter((call) => call.path.includes("/charges")).length;
    const { client } = renderWithAnnouncer(<JarsPage />);
    expect(
      await screen.findByText("No charges yet. Give the agent its key to start."),
    ).toBeTruthy();
    expect(chargeFetches()).toBe(1);

    await act(() => client.refetchQueries({ queryKey: qk.jars }));
    expect(chargeFetches()).toBe(1);

    await act(() => client.refetchQueries({ queryKey: qk.jars }));
    await waitFor(() => expect(chargeFetches()).toBe(2));
  });
});
