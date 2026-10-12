import type { Tag } from "@shade/contract";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TagsSettingsPage } from "@/features/settings/tags-page";
import { meFixture, TESTNET_UA } from "@/test/fixtures";
import { mockFetch, renderWithAnnouncer } from "@/test/utils";

const tag: Tag = {
  id: "tag_1",
  name: "northline",
  display: "northline.shade",
  network: "testnet",
  address: TESTNET_UA,
  created_at: "2026-10-02T10:00:00.000Z",
};

describe("tags settings", () => {
  it("shows the whole address a tag resolves to, never an abridged one", async () => {
    mockFetch([
      { path: "/api/desk/me", body: meFixture() },
      { path: "/api/desk/tags", body: [tag] },
    ]);
    renderWithAnnouncer(<TagsSettingsPage />);
    expect(await screen.findByText("northline.shade")).toBeTruthy();
    expect(screen.getByText(TESTNET_UA)).toBeTruthy();
    expect(screen.queryByText(/…/)).toBeNull();
  });

  it("checks names with the name.shade rules and hint", async () => {
    const { calls } = mockFetch([
      { path: "/api/desk/me", body: meFixture() },
      { path: "/api/desk/tags", body: [] },
    ]);
    renderWithAnnouncer(<TagsSettingsPage />);
    const input = await screen.findByLabelText("Name");
    expect(
      screen.getByText(/Lowercase letters, digits and hyphens \(not at the start or end\)/),
    ).toBeTruthy();
    for (const value of ["my_shop", "shop-"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: /^Claim / }));
      expect(screen.getByText(/starting and ending with a letter or digit/)).toBeTruthy();
    }
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it('claims "northline" for "Northline.shade", never "northline.shade.shade"', async () => {
    const { calls } = mockFetch([
      { path: "/api/desk/me", body: meFixture() },
      { path: "/api/desk/tags", body: [] },
      { method: "POST", path: "/api/desk/tags", body: tag },
    ]);
    renderWithAnnouncer(<TagsSettingsPage />);
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Northline.shade" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim northline.shade" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({ name: "northline" }),
    );
  });
});
