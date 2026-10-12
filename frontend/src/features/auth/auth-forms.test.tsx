import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignupPage } from "@/features/auth/signup-page";
import { configFixture } from "@/test/fixtures";
import { liveRegionText, mockFetch, renderWithRouter } from "@/test/utils";

const signUp = vi.hoisted(() => vi.fn());

// The Better Auth client keeps its own fetch (and refetches the session on focus), so replace
// the client itself rather than global fetch.
vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({ signUp: { email: signUp } }),
}));

describe("sign-up validation", () => {
  it("moves focus to the first invalid field and says what is wrong", async () => {
    const { calls } = mockFetch([{ path: "/api/config", body: configFixture() }]);
    renderWithRouter(<SignupPage />);
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "shop@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "other" } });
    const submit = screen.getByRole("button", { name: "Create account" });
    submit.focus();
    fireEvent.click(submit);

    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    await waitFor(() =>
      expect(liveRegionText()).toContain(
        "Use at least 12 characters. One more field needs fixing.",
      ),
    );
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(signUp).not.toHaveBeenCalled();
  });

  it("speaks the error even when focus is already in the invalid field", async () => {
    mockFetch([{ path: "/api/config", body: configFixture() }]);
    renderWithRouter(<SignupPage />);
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "shop@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery" },
    });
    const confirm = screen.getByLabelText("Confirm password");
    fireEvent.change(confirm, { target: { value: "correct horse" } });
    confirm.focus();
    fireEvent.submit(confirm.closest("form") as HTMLFormElement);

    expect(document.activeElement).toBe(confirm);
    await waitFor(() => expect(liveRegionText()).toContain("The passwords do not match."));
  });
});
