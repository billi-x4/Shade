import { useId, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/button";
import type { ButtonVariant } from "@/components/button-styles";
import { Modal } from "@/components/modal";

/**
 * Confirmation for destructive or irreversible actions. Restates the consequence, starts focused on
 * the safe choice, and shows the request's pending and error state in place. While pending the
 * buttons are aria-disabled rather than disabled: a disabled button drops focus out of the dialog,
 * and then Escape no longer reaches the dialog's handler that keeps it open.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pendingLabel = "Working…",
  cancelLabel = "Keep it",
  tone = "danger",
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  cancelLabel?: string;
  tone?: Extract<ButtonVariant, "danger" | "primary">;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onDismiss={pending ? undefined : onCancel}
      labelledBy={titleId}
      describedBy={bodyId}
      initialFocus={cancelRef}
    >
      <div className="space-y-4 p-6">
        <h2 id={titleId} className="font-serif text-2xl leading-tight">
          {title}
        </h2>
        <div id={bodyId} className="space-y-2 text-sm text-muted">
          {children}
        </div>
        {error ? <p className="text-sm text-bad">{error}</p> : null}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button
            ref={cancelRef}
            variant="ghost"
            onClick={pending ? undefined : onCancel}
            aria-disabled={pending || undefined}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone}
            onClick={pending ? undefined : onConfirm}
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
