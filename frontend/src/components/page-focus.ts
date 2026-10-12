/**
 * Where keyboard focus goes when its natural place is gone: the page's h1 (made focusable for the
 * moment with tabindex=-1), else the main landmark. Used after client-side navigation
 * (root-layout.tsx) and when a dialog's opener was removed by the dialog's own action (modal.tsx).
 */

/** Focuses the page start without scrolling: the router owns scroll position. */
export function focusPageStart(): void {
  const main = document.getElementById("main");
  const heading = (main ?? document).querySelector<HTMLElement>("h1");
  const target = heading ?? main;
  if (!target) return;
  if (!target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
    // Only while focused: a heading is not a control and should not stay in the focus order.
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }
  target.focus({ preventScroll: true });
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * Puts focus back on `element` (a dialog's opener). If it is already gone, or leaves the page
 * while it still has focus (the confirmed action removed its row once the list refetched), focus
 * moves to the page start instead of falling to <body>.
 */
export function restoreFocus(element: HTMLElement | null): void {
  if (!element?.isConnected) {
    focusPageStart();
    return;
  }
  const opener = element;
  opener.focus();
  if (document.activeElement !== opener) return;

  const observer = new MutationObserver(() => {
    if (opener.isConnected) return;
    stop();
    if (focusIsLost()) focusPageStart();
  });
  // Some browsers blur a removed element first; the removal itself has landed by the microtask.
  const onFocusOut = () => {
    stop();
    queueMicrotask(() => {
      if (!opener.isConnected && focusIsLost()) focusPageStart();
    });
  };
  const stop = () => {
    observer.disconnect();
    opener.removeEventListener("focusout", onFocusOut);
  };
  opener.addEventListener("focusout", onFocusOut);
  observer.observe(document.body, { childList: true, subtree: true });
}
