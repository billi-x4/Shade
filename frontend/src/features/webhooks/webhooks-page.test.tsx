import type { WebhookEndpoint } from "@shade/contract";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebhooksPage } from "@/features/webhooks/webhooks-page";
import { mockFetch, renderWithAnnouncer } from "@/test/utils";

const endpoint: WebhookEndpoint = {
  id: "whe_1",
  url: "https://shop.example/hooks/shade",
  network: "testnet",
  secret_hint: "a1b2",
  created_at: "2026-10-02T10:00:00.000Z",
  disabled_at: null,
  disabled_reason: null,
  failure_count: 0,
  last_delivery_at: null,
};

function renderWith(endpoints: WebhookEndpoint[]) {
  mockFetch([
    { path: "/api/desk/webhooks", body: endpoints },
    { path: "/api/desk/webhooks/deliveries", body: { items: [], next_cursor: null } },
  ]);
  renderWithAnnouncer(<WebhooksPage />);
}

describe("send test", () => {
  it("says on the page why it cannot send yet", async () => {
    renderWith([]);
    const hint = await screen.findByText("Add an endpoint to send a test.");
    const button = screen.getByRole("button", { name: "Send test" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(hint.id);
    expect(button.hasAttribute("title")).toBe(false);
  });

  it("explains a list where every endpoint is off", async () => {
    renderWith([{ ...endpoint, disabled_at: "2026-10-03T10:00:00.000Z" }]);
    expect(
      await screen.findByText("Every endpoint is off. Add one that works to send a test."),
    ).toBeTruthy();
  });

  it("drops the explanation once an endpoint is on", async () => {
    renderWith([endpoint]);
    expect(await screen.findByText(endpoint.url)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Send test" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText(/to send a test\./)).toBeNull();
  });
});
