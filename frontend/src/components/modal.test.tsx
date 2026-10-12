import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/modal";

function theDialog(): HTMLDialogElement {
  const dialog = document.querySelector("dialog");
  if (!(dialog instanceof HTMLDialogElement)) throw new Error("no dialog");
  return dialog;
}

/** The browser closing the dialog on its own (a second Escape in a row, the Android back gesture). */
function closeNatively(dialog: HTMLDialogElement) {
  act(() => {
    dialog.close();
  });
}

/** An always-mounted Modal, like the re-auth dialog. */
function Harness({
  dismissible = true,
  onDismiss,
}: {
  dismissible?: boolean;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <p>Dismissed {dismissed}</p>
      <Modal
        open={open}
        labelledBy="title"
        onDismiss={
          dismissible
            ? () => {
                onDismiss?.();
                setDismissed((count) => count + 1);
                setOpen(false);
              }
            : undefined
        }
      >
        <h2 id="title">Title</h2>
        <button type="button">First</button>
        <button type="button" onClick={() => setOpen(false)}>
          Done
        </button>
      </Modal>
    </>
  );
}

/**
 * A row whose confirm dialog removes the row: with the close (`removeOnConfirm`), or later, when
 * the list refetch arrives (`gone`).
 */
function RemovableRow({
  removeOnConfirm,
  gone = false,
}: {
  removeOnConfirm: boolean;
  gone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState(false);
  return (
    <main id="main" tabIndex={-1}>
      <h1>Grants</h1>
      {removed || gone ? null : (
        <button type="button" onClick={() => setOpen(true)}>
          Revoke
        </button>
      )}
      <Modal open={open} labelledBy="title" onDismiss={() => setOpen(false)}>
        <h2 id="title">Revoke this grant?</h2>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            if (removeOnConfirm) setRemoved(true);
          }}
        >
          Confirm
        </button>
      </Modal>
    </main>
  );
}

describe("Modal", () => {
  it("returns focus to the page's h1 when its action removed the opener", () => {
    render(<RemovableRow removeOnConfirm />);
    const revoke = screen.getByRole("button", { name: "Revoke" });
    revoke.focus();
    fireEvent.click(revoke);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("moves focus off the opener when a later refetch removes it", async () => {
    const { rerender } = render(<RemovableRow removeOnConfirm={false} />);
    const revoke = screen.getByRole("button", { name: "Revoke" });
    revoke.focus();
    fireEvent.click(revoke);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(document.activeElement).toBe(revoke);

    // The list refetch drops the row while its button still has focus.
    rerender(<RemovableRow removeOnConfirm={false} gone />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })),
    );
  });

  it("treats a close by the browser as a dismissal, so it can open again", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    closeNatively(theDialog());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(theDialog().open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(theDialog().open).toBe(true);
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
  });

  it("shows a dialog that cannot be dismissed again when the browser closes it", () => {
    render(<Harness dismissible={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = theDialog();
    closeNatively(dialog);
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    // Its own buttons still close it.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(dialog.open).toBe(false);
  });

  it("does not report its own close as a dismissal", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(theDialog().open).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses once when the browser sends a cancel the page may not refuse", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = theDialog();
    act(() => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: false }));
      dialog.close();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Dismissed 1")).toBeTruthy();
  });

  it("refuses a cancelable cancel while it cannot be dismissed", () => {
    render(<Harness dismissible={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const cancel = new Event("cancel", { cancelable: true });
    act(() => {
      theDialog().dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(theDialog().open).toBe(true);
  });
});
