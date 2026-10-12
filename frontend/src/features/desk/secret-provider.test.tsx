import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRevealSecret } from "@/features/desk/desk-context";
import { SecretProvider } from "@/features/desk/secret-provider";
import { renderWithAnnouncer } from "@/test/utils";

function agentKey(jar: string, token: string) {
  return {
    title: `Agent key for ${jar}`,
    intro: "Shade shows this key once.",
    items: [{ label: "Agent key", value: token }],
  };
}

/** Two creations that were in flight together finish in the same tick. */
function CreateTwo() {
  const reveal = useRevealSecret();
  return (
    <button
      type="button"
      onClick={() => {
        reveal(agentKey("jar A", "ag_first"));
        reveal(agentKey("jar B", "ag_second"));
      }}
    >
      Create two
    </button>
  );
}

function openDialog(): HTMLDialogElement {
  const dialog = document.querySelector("dialog");
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) throw new Error("no open dialog");
  return dialog;
}

describe("shown-once secrets", () => {
  it("queues a second secret instead of replacing one not yet saved", () => {
    renderWithAnnouncer(
      <SecretProvider>
        <CreateTwo />
      </SecretProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create two" }));

    const first = openDialog();
    expect(screen.getByRole("heading", { name: "Agent key for jar A" })).toBeTruthy();
    expect(screen.getByText("ag_first")).toBeTruthy();
    expect(screen.queryByText("ag_second")).toBeNull();
    // The position is part of the dialog's name, so a screen reader hears there is another.
    const names = (first.getAttribute("aria-labelledby") ?? "").split(" ");
    expect(names.map((id) => document.getElementById(id)?.textContent).join(" ")).toBe(
      "Agent key for jar A 1 of 2",
    );

    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    // A new dialog, so it is announced as one.
    expect(openDialog()).not.toBe(first);
    expect(screen.getByRole("heading", { name: "Agent key for jar B" })).toBeTruthy();
    expect(screen.getByText("ag_second")).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
    // Focus starts on the new secret, not on "I saved it", so a repeated Enter cannot skip it.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy agent key" }));

    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    expect(document.querySelector("dialog")?.open).toBe(false);
  });

  it("ignores the second click of a double-click, which would skip the next secret", () => {
    renderWithAnnouncer(
      <SecretProvider>
        <CreateTwo />
      </SecretProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create two" }));
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }), { detail: 1 });
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }), { detail: 2 });
    expect(openDialog()).toBeTruthy();
    expect(screen.getByText("ag_second")).toBeTruthy();
  });

  it("shows a single secret without a position and keeps it open if the browser closes it", () => {
    function CreateOne() {
      const reveal = useRevealSecret();
      return (
        <button type="button" onClick={() => reveal(agentKey("jar A", "ag_only"))}>
          Create one
        </button>
      );
    }
    renderWithAnnouncer(
      <SecretProvider>
        <CreateOne />
      </SecretProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create one" }));
    const dialog = openDialog();
    expect(screen.queryByText("1 of 1")).toBeNull();
    act(() => {
      dialog.close();
    });
    expect(dialog.open).toBe(true);
    expect(screen.getByText("ag_only")).toBeTruthy();

    // A later secret still shows after the first is saved.
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    fireEvent.click(screen.getByRole("button", { name: "Create one" }));
    expect(openDialog()).toBeTruthy();
    expect(screen.getByText("ag_only")).toBeTruthy();
  });
});
