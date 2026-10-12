import type { AppConfig } from "@shade/contract";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetectionSettingsPage } from "@/features/settings/detection-page";
import { configFixture, meFixture, viewingKeyFixture } from "@/test/fixtures";
import { mockFetch, renderWithAnnouncer } from "@/test/utils";

/** The backend's message for 422 VIEWING_KEY_ADDRESS_MISMATCH (services/viewing-keys.ts). */
const MISMATCH =
  "Shade can't confirm that your receive address belongs to this viewing key, so it might not detect payments to it. Turn on “Use this key's address” for this upload. To use another address of the same wallet, upload the key again afterwards with it turned off, then save that address under Receive addresses.";

function hostedConfig(): AppConfig {
  return { ...configFixture(), features: { hosted_detection: true } };
}

function hostedMe() {
  return { ...meFixture(), hosted_detection: true };
}

describe("detection settings", () => {
  it("says only the key's own address can be confirmed", async () => {
    mockFetch([
      { path: "/api/config", body: hostedConfig() },
      { path: "/api/desk/me", body: hostedMe() },
      { path: "/api/desk/viewing-keys", body: [] },
    ]);
    renderWithAnnouncer(<DetectionSettingsPage />);
    const checkbox = await screen.findByLabelText("Use this key's address");
    const hint = document.getElementById(checkbox.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe(
      "Your receive address becomes this key's own shielded address, the only one Shade can confirm belongs to the key. Turn this off to keep another address of the same wallet account.",
    );
  });

  it("shows the address-mismatch refusal next to the key field", async () => {
    const { calls } = mockFetch([
      { path: "/api/config", body: hostedConfig() },
      { path: "/api/desk/me", body: hostedMe() },
      { path: "/api/desk/viewing-keys", body: [] },
      {
        method: "PUT",
        path: "/api/desk/viewing-keys/testnet",
        status: 422,
        body: { error: "VIEWING_KEY_ADDRESS_MISMATCH", message: MISMATCH },
      },
    ]);
    renderWithAnnouncer(<DetectionSettingsPage />);
    fireEvent.click(await screen.findByLabelText("Use this key's address"));
    const field = screen.getByLabelText("Full viewing key");
    fireEvent.change(field, { target: { value: "uviewtest1qqqq" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on detection" }));

    const error = await screen.findByText(MISMATCH);
    expect(field.getAttribute("aria-describedby")).toContain(error.id);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    // Once, next to the field: the generic inline outcome stays out of the way.
    expect(screen.getAllByText(MISMATCH)).toHaveLength(1);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
        ufvk: "uviewtest1qqqq",
        use_key_address: false,
      }),
    );
  });

  it("fills this site's address into the local scanner command", async () => {
    mockFetch([
      { path: "/api/config", body: configFixture() },
      { path: "/api/desk/me", body: meFixture() },
      { path: "/api/desk/viewing-keys", body: [] },
    ]);
    renderWithAnnouncer(<DetectionSettingsPage />);
    const command = await screen.findByText(/npm run scan:local/);
    expect(command.textContent).toContain(`SHADE_API_URL=${window.location.origin} `);
    expect(command.textContent).not.toContain("<this site>");
  });

  it("describes a key used with the merchant's own address and a payment taken elsewhere", async () => {
    mockFetch([
      { path: "/api/config", body: hostedConfig() },
      { path: "/api/desk/me", body: hostedMe() },
      {
        path: "/api/desk/viewing-keys",
        body: [
          viewingKeyFixture({
            use_key_address: false,
            scan: { ...viewingKeyFixture().scan, state: "error", last_error: "txid_in_use" },
          }),
        ],
      },
    ]);
    renderWithAnnouncer(<DetectionSettingsPage />);
    expect(
      await screen.findByText("Your own address (Shade can't confirm it belongs to this key)"),
    ).toBeTruthy();
    expect(
      screen.getByText(/A payment Shade found was already confirmed on another invoice\./),
    ).toBeTruthy();
    expect(screen.queryByText(/txid_in_use/)).toBeNull();
  });
});
