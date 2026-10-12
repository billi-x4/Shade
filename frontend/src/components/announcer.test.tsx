import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncerProvider } from "@/components/announcer";
import { useAnnounce } from "@/components/announcer-context";
import { Modal } from "@/components/modal";

function Speak({ message }: { message: string }) {
  const announce = useAnnounce();
  return (
    <button type="button" onClick={() => announce(message)}>
      Say {message}
    </button>
  );
}

function Harness() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <Speak message="Outside" />
      <button type="button" onClick={() => setOuter(true)}>
        Open outer
      </button>
      <Modal open={outer} labelledBy="outer-title" onDismiss={() => setOuter(false)}>
        <h2 id="outer-title">Outer</h2>
        <Speak message="From outer" />
        <button type="button" onClick={() => setInner(true)}>
          Open inner
        </button>
        <button type="button" onClick={() => setOuter(false)}>
          Close outer
        </button>
      </Modal>
      <Modal open={inner} labelledBy="inner-title">
        <h2 id="inner-title">Inner</h2>
        <Speak message="From inner" />
        <button type="button" onClick={() => setInner(false)}>
          Close inner
        </button>
      </Modal>
    </>
  );
}

function regionIn(scope: Element): Element {
  const region = [...scope.querySelectorAll('[role="status"][aria-live="polite"]')].find(
    (node) => node.closest("dialog") === (scope.tagName === "DIALOG" ? scope : null),
  );
  if (!region) throw new Error("no live region");
  return region;
}

function dialogNamed(id: string): HTMLDialogElement {
  const dialog = document.querySelector(`dialog[aria-labelledby="${id}"]`);
  if (!(dialog instanceof HTMLDialogElement)) throw new Error(`no dialog ${id}`);
  return dialog;
}

async function say(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Say ${name}` }));
  await act(() => vi.advanceTimersByTimeAsync(100));
}

describe("announcer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("speaks through the root region while no modal is open", async () => {
    render(
      <AnnouncerProvider>
        <Harness />
      </AnnouncerProvider>,
    );
    await say("Outside");
    expect(regionIn(document.body).textContent).toBe("Outside");
  });

  it("speaks through the topmost open modal, whose background is inert", async () => {
    render(
      <AnnouncerProvider>
        <Harness />
      </AnnouncerProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open outer" }));
    const outer = dialogNamed("outer-title");
    expect(outer.open).toBe(true);
    await say("From outer");
    expect(regionIn(outer).textContent).toBe("From outer");
    expect(regionIn(document.body).textContent).toBe("");

    // A dialog over a dialog (re-auth over a confirm): the newest one hears it.
    fireEvent.click(screen.getByRole("button", { name: "Open inner" }));
    const inner = dialogNamed("inner-title");
    await say("From inner");
    expect(regionIn(inner).textContent).toBe("From inner");
    expect(regionIn(outer).textContent).toBe("");

    // Closing the top one hands announcements back to the one below, then to the root.
    fireEvent.click(screen.getByRole("button", { name: "Close inner" }));
    await say("From outer");
    expect(regionIn(outer).textContent).toBe("From outer");
    fireEvent.click(screen.getByRole("button", { name: "Close outer" }));
    await say("Outside");
    expect(regionIn(document.body).textContent).toBe("Outside");
  });

  it("repeats an identical message", async () => {
    render(
      <AnnouncerProvider>
        <Harness />
      </AnnouncerProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Say Outside" }));
    await act(() => vi.advanceTimersByTimeAsync(100));
    fireEvent.click(screen.getByRole("button", { name: "Say Outside" }));
    expect(regionIn(document.body).textContent).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(regionIn(document.body).textContent).toBe("Outside");
  });
});
