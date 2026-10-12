import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRequestReauth } from "@/features/desk/desk-context";
import { ReauthProvider } from "@/features/desk/reauth-provider";
import { liveRegionText, renderWithAnnouncer } from "@/test/utils";

const signIn = vi.hoisted(() => vi.fn());

// The Better Auth client keeps its own fetch (and refetches the session on focus), so replace
// the client itself rather than global fetch.
vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    getSession: async () => ({ data: { user: { email: "shop@example.com" } }, error: null }),
    signIn: { email: signIn },
  }),
}));

function NeedsFreshSession({ onResult }: { onResult?: (ok: boolean) => void }) {
  const reauth = useRequestReauth();
  return (
    <button type="button" onClick={() => void reauth().then(onResult)}>
      Do something sensitive
    </button>
  );
}

function openDialog(onResult?: (ok: boolean) => void) {
  renderWithAnnouncer(
    <ReauthProvider>
      <NeedsFreshSession onResult={onResult} />
    </ReauthProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Do something sensitive" }));
  return {
    password: screen.getByLabelText("Password"),
    confirm: screen.getByRole("button", { name: "Confirm and continue" }),
  };
}

/** The live region inside the open dialog (the root one is inert behind showModal). */
function dialogRegionText(): string | null | undefined {
  return document.querySelector("dialog")?.querySelector('[role="status"]')?.textContent;
}

describe("re-auth dialog", () => {
  it("focuses the password field and speaks an empty-password error inside the dialog", async () => {
    const { password, confirm } = openDialog();
    confirm.focus();
    fireEvent.click(confirm);
    expect(screen.getByText("Enter your password.")).toBeTruthy();
    expect(document.activeElement).toBe(password);
    await waitFor(() => expect(dialogRegionText()).toBe("Enter your password."));
    expect(liveRegionText()).toBe("Enter your password.");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("returns focus to the password field and speaks a failed sign-in", async () => {
    signIn.mockResolvedValueOnce({
      data: null,
      error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid" },
    });
    const { password, confirm } = openDialog();
    fireEvent.change(password, { target: { value: "wrong password" } });
    confirm.focus();
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(screen.getByText("That email and password do not match.")).toBeTruthy();
    expect(document.activeElement).toBe(password);
    await waitFor(() => expect(dialogRegionText()).toBe("That email and password do not match."));
  });

  it("cancels the request when the browser closes the dialog, and can ask again", async () => {
    const onResult = vi.fn();
    openDialog(onResult);
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    // The Android back gesture, or a second Escape in a row, closes it without our handlers.
    await act(async () => {
      dialog.close();
    });
    expect(onResult).toHaveBeenCalledWith(false);
    expect(dialog.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Do something sensitive" }));
    expect(dialog.open).toBe(true);
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("stays open while checking, even if the browser closes it, then shows the result", async () => {
    let answer: (value: unknown) => void = () => {};
    signIn.mockClear();
    signIn.mockReturnValueOnce(new Promise((done) => (answer = done)));
    const onResult = vi.fn();
    const { password, confirm } = openDialog(onResult);
    fireEvent.change(password, { target: { value: "wrong password" } });
    confirm.focus();
    fireEvent.click(confirm);
    const checking = screen.getByRole("button", { name: "Checking…" });
    // aria-disabled, so focus stays in the dialog and Escape still reaches its handler.
    expect(checking.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(checking);
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    act(() => {
      dialog.close();
    });
    expect(dialog.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => {
      answer({
        data: null,
        error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid" },
      });
    });
    expect(dialog.open).toBe(true);
    expect(screen.getByText("That email and password do not match.")).toBeTruthy();
    expect(signIn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(dialog.open).toBe(false);
  });
});
