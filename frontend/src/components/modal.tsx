import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode, RefObject, SyntheticEvent } from "react";
import { useLiveRegions } from "@/components/announcer-context";
import { restoreFocus } from "@/components/page-focus";
import { cn } from "@/lib/cn";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusInside(
  dialog: HTMLDialogElement,
  initial: RefObject<HTMLElement | null> | undefined,
) {
  const target = initial?.current ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus();
}

/**
 * The dialog's own polite live region. showModal() makes the app's root region inert, so while the
 * dialog is open the announcer writes here instead (useAnnounce, e.g. a failed confirm or "Copied.").
 */
function DialogLiveRegion({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { register, unregister } = useLiveRegions();
  useEffect(() => {
    const region = ref.current;
    if (!open || !region) return;
    register(region);
    return () => {
      unregister(region);
      region.textContent = "";
    };
  }, [open, register, unregister]);
  return <div ref={ref} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />;
}

/**
 * Native modal <dialog> (showModal: top layer, inert background, focus contained). Controlled by
 * `open`. Focus moves to `initialFocus` (or the first control) and returns to the trigger on close,
 * or to the page's h1 when the dialog's action removed the trigger (a revoked or killed row).
 *
 * The browser can close a modal on its own: Chrome lets a page refuse only one Escape or back
 * gesture in a row, and the Android back gesture never sends a keydown. When that happens while
 * `open` is still true, the dialog is dismissed through `onDismiss`, or, if it cannot be dismissed
 * right now (no `onDismiss`: a pending request, a shown-once secret), shown again, so React and the
 * browser never disagree about whether it is open. (Not closedby="none": that hands the back
 * gesture to history, which can leave the desk and lose a shown-once secret.)
 */
export function Modal({
  open,
  onDismiss,
  labelledBy,
  describedBy,
  initialFocus,
  className,
  children,
}: {
  open: boolean;
  /** Escape or back. Omit to make the dialog closable only through its own buttons. */
  onDismiss?: () => void;
  labelledBy: string;
  describedBy?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const dismissRef = useRef(onDismiss);
  const focusRef = useRef(initialFocus);
  /** True while this Modal holds the dialog open; cleared before it closes the dialog itself. */
  const heldOpen = useRef(false);

  useEffect(() => {
    dismissRef.current = onDismiss;
    focusRef.current = initialFocus;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    // No trigger when focus was already lost (e.g. a button disabled while its request ran).
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body ? active : null;
    heldOpen.current = true;
    if (!dialog.open) dialog.showModal();
    focusInside(dialog, focusRef.current);
    return () => {
      heldOpen.current = false;
      if (dialog.open) dialog.close();
      restoreFocus(trigger);
    };
  }, [open]);

  const dismiss = (event: SyntheticEvent) => {
    event.preventDefault();
    dismissRef.current?.();
  };

  /** The browser closed the dialog while `open` is still true (see above). */
  const onClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    const dialog = ref.current;
    // React passes cancel and close on through the component tree; only this dialog's count.
    if (!dialog || event.target !== dialog) return;
    // Our own close (effect cleanup) or already shown again: nothing to reconcile.
    if (dialog.open || !heldOpen.current) return;
    const dismissNow = dismissRef.current;
    if (dismissNow) {
      dismissNow();
      return;
    }
    dialog.showModal();
    focusInside(dialog, focusRef.current);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-modal="true"
      onCancel={(event) => {
        // A cancel the page may not refuse still closes the dialog; onClose then syncs state.
        if (event.target === event.currentTarget && event.cancelable) dismiss(event);
      }}
      onClose={onClose}
      onKeyDown={(event: KeyboardEvent<HTMLDialogElement>) => {
        if (event.key === "Escape") dismiss(event);
      }}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100%-2rem))] overflow-y-auto rounded-lg border border-line-strong bg-surface p-0 text-fg shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)]",
        className,
      )}
    >
      {open ? children : null}
      <DialogLiveRegion open={open} />
    </dialog>
  );
}
