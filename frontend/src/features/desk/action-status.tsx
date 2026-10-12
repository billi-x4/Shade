import { errorMessage } from "@/api/client";
import { cn } from "@/lib/cn";

/**
 * Inline outcome of one mutation, right next to its control. Visual only: the spoken outcome goes
 * through the shared live region (useDeskMutation), so this is not a live region itself.
 */
export function ActionStatus({
  mutation,
  pendingText,
  successText,
  className,
}: {
  mutation: { isPending: boolean; isError: boolean; isSuccess: boolean; error: unknown };
  /** Omit when the control's own label already says it is working. */
  pendingText?: string;
  successText?: string | null;
  className?: string;
}) {
  if (mutation.isPending) {
    return pendingText ? (
      <p className={cn("text-sm text-muted", className)}>{pendingText}</p>
    ) : null;
  }
  if (mutation.isError) {
    return <p className={cn("text-sm text-bad", className)}>{errorMessage(mutation.error)}</p>;
  }
  if (mutation.isSuccess && successText) {
    return <p className={cn("text-sm text-ok", className)}>{successText}</p>;
  }
  return null;
}
