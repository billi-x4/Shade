import { errorMessage } from "@/api/client";
import { cn } from "@/lib/cn";

/** The tone slat in front of an outcome, as in StatusText. The words carry the meaning. */
const SLAT = "mt-[0.45em] h-2.5 w-1 shrink-0 rounded-[1px]";

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
    return (
      <p className={cn("flex items-start gap-2 text-sm text-bad", className)}>
        <span aria-hidden className={cn(SLAT, "bg-bad")} />
        {errorMessage(mutation.error)}
      </p>
    );
  }
  if (mutation.isSuccess && successText) {
    return (
      <p className={cn("flex items-start gap-2 text-sm text-ok", className)}>
        <span aria-hidden className={cn(SLAT, "bg-ok")} />
        {successText}
      </p>
    );
  }
  return null;
}
