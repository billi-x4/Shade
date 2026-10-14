import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LandingPage } from "@/features/landing/landing-page";
import { mockFetch, renderWithRouter } from "@/test/utils";

/** The session read is a plain GET (api/session.ts); null means signed out. */
const session = (body: unknown) => mockFetch([{ path: "/api/auth/get-session", body }]);

function hero() {
  const section = screen.getByRole("heading", { level: 1 }).closest("section");
  if (!section) throw new Error("no hero section");
  return within(section);
}

describe("landing page", () => {
  it("offers a newcomer sign-up, not a desk that bounces them to sign-in", async () => {
    session(null);
    renderWithRouter(<LandingPage />);
    await screen.findByRole("heading", { level: 1 });
    expect(
      screen.getByText(
        "Shade gives your shop private Zcash invoices, a signed webhook when each one is paid, receipt views you can revoke and spending caps for AI agents.",
      ),
    ).toBeTruthy();
    expect(hero().getByRole("link", { name: "Create account" }).getAttribute("href")).toBe(
      "/signup",
    );
    expect(hero().queryByRole("link", { name: "Open the desk" })).toBeNull();
  });

  it("sends a signed-in merchant straight to the desk", async () => {
    session({ user: { email: "shop@example.com" }, session: {} });
    renderWithRouter(<LandingPage />);
    await screen.findByRole("heading", { level: 1 });
    const link = await hero().findByRole("link", { name: "Open the desk" });
    expect(link.getAttribute("href")).toBe("/desk/invoices");
  });

  it("reads the tagline as one heading, with the lit line in the middle", async () => {
    session(null);
    renderWithRouter(<LandingPage />);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Pay in the dark. Prove in the light. Keys stay yours.",
    );
  });

  it("walks the loop as numbered steps in plain words", async () => {
    session(null);
    renderWithRouter(<LandingPage />);
    const loop = within(await screen.findByRole("region", { name: "The loop in 90 seconds." }));
    const steps = loop.getAllByRole("listitem");
    expect(steps.map((step) => step.textContent?.slice(0, 2))).toEqual([
      "1.",
      "2.",
      "3.",
      "4.",
      "5.",
    ]);
    expect(loop.getByText(/Shade refuses the fourth call\. The jar is empty\./)).toBeTruthy();
    expect(screen.queryByText(/JAR_EMPTY/)).toBeNull();
    expect(screen.queryByText("0:00")).toBeNull();
  });

  it("shows what a shielded payment hides, in words a screen reader can hear", async () => {
    session(null);
    renderWithRouter(<LandingPage />);
    const problem = within(
      await screen.findByRole("region", { name: "A public chain shows everyone your sales." }),
    );
    expect(problem.getByRole("heading", { name: "On a public chain" })).toBeTruthy();
    expect(problem.getByRole("heading", { name: "On Zcash, shielded" })).toBeTruthy();
    expect(problem.getAllByText("Hidden")).toHaveLength(4);
  });
});
