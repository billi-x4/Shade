import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/confirm-dialog";

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Kill
      </button>
      {open ? (
        <ConfirmDialog
          open
          title="Kill research-agent?"
          confirmLabel="Kill jar"
          onConfirm={onConfirm}
          onCancel={() => setOpen(false)}
        >
          <p>Stops new charges. Move leftover ZEC in your wallet.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

describe("ConfirmDialog", () => {
  it("opens modally, labelled by its title and described by the consequence", () => {
    render(<Harness onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    const dialog = document.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    const title = screen.getByRole("heading", { name: "Kill research-agent?" });
    expect(dialog?.getAttribute("aria-labelledby")).toBe(title.id);
    const body = document.getElementById(dialog?.getAttribute("aria-describedby") ?? "");
    expect(body?.textContent).toContain("Stops new charges.");
  });

  it("starts focused on the safe choice", () => {
    render(<Harness onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "Kill" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.querySelector("dialog") as HTMLDialogElement, { key: "Escape" });
    expect(document.querySelector("dialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("runs the action only on the explicit confirm button", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill jar" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows pending and error state and cannot be dismissed while pending", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Revoke?"
        confirmLabel="Revoke"
        pending
        onConfirm={() => {}}
        onCancel={onCancel}
      >
        <p>Gone.</p>
      </ConfirmDialog>,
    );
    expect(screen.getByRole("button", { name: "Working…" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.keyDown(document.querySelector("dialog") as HTMLDialogElement, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    rerender(
      <ConfirmDialog
        open
        title="Revoke?"
        confirmLabel="Revoke"
        error="Cannot reach Shade."
        onConfirm={() => {}}
        onCancel={onCancel}
      >
        <p>Gone.</p>
      </ConfirmDialog>,
    );
    expect(screen.getByText("Cannot reach Shade.")).toBeTruthy();
  });

  it("keeps focus inside while pending, so Escape still reaches the dialog", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const props = { open: true, title: "Revoke?", confirmLabel: "Revoke", onConfirm, onCancel };
    const { rerender } = render(
      <ConfirmDialog {...props}>
        <p>Gone.</p>
      </ConfirmDialog>,
    );
    const confirm = screen.getByRole("button", { name: "Revoke" });
    confirm.focus();
    rerender(
      <ConfirmDialog {...props} pending>
        <p>Gone.</p>
      </ConfirmDialog>,
    );
    // aria-disabled, not disabled: a disabled button would drop focus to <body>.
    const pending = screen.getByRole("button", { name: "Working…" });
    expect(pending.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(pending);
    fireEvent.click(pending);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("stays open and shows the outcome when the browser closes it while pending", () => {
    const onCancel = vi.fn();
    const props = { open: true, title: "Confirm this payment?", confirmLabel: "Confirm", onCancel };
    const { rerender } = render(
      <ConfirmDialog {...props} pending onConfirm={() => {}}>
        <p>Cannot be undone.</p>
      </ConfirmDialog>,
    );
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    // Chrome closes a modal on a second Escape in a row even if the page refuses the first.
    act(() => {
      dialog.close();
    });
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    expect(onCancel).not.toHaveBeenCalled();
    rerender(
      <ConfirmDialog {...props} error="Not mined yet." onConfirm={() => {}}>
        <p>Cannot be undone.</p>
      </ConfirmDialog>,
    );
    expect(dialog.open).toBe(true);
    expect(screen.getByText("Not mined yet.")).toBeTruthy();
  });

  it("closes for good when the browser closes it while idle, and opens again", () => {
    render(<Harness onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    act(() => {
      (document.querySelector("dialog") as HTMLDialogElement).close();
    });
    expect(document.querySelector("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    expect(document.querySelector("dialog")?.open).toBe(true);
  });
});
