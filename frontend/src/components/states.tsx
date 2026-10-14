import type { ReactNode } from "react";
import { Button } from "@/components/button";
import { errorMessage } from "@/api/client";
import { cn } from "@/lib/cn";

/** Loading placeholder with a spoken label. */
export function LoadingState({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" className={cn("space-y-3", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden className="skeleton h-16 rounded-sm" />
      ))}
    </div>
  );
}

export function ErrorState({
  error,
  title = "This did not load.",
  onRetry,
  className,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-bad/50 bg-bad/5 p-5", className)}>
      <p className="font-medium text-fg">{title}</p>
      <p className="mt-1 text-sm text-muted">{errorMessage(error)}</p>
      {onRetry ? (
        <Button variant="ghost" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A background refresh failed while earlier data is still on screen. The data (and any dialog
 * opened from it) stays mounted; this line says it may be stale. Polled lists retry by themselves,
 * so they get "Reconnecting…"; the rest get a retry button.
 */
export function RefreshError({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  /** Omit for polled data: the next poll is the retry. */
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 text-sm text-faint", className)}>
      <p>
        {onRetry ? `Could not refresh. ${errorMessage(error)}` : "Reconnecting…"} What you see may
        be out of date.
      </p>
      {onRetry ? (
        <Button variant="quiet" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-dashed border-line-strong px-6 py-10">
      <span
        aria-hidden
        className="blinds blinds-fade pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-[0.07]"
      />
      <p className="relative font-display text-2xl">{title}</p>
      {children ? (
        <div className="relative mt-2 max-w-prose text-sm text-muted">{children}</div>
      ) : null}
    </div>
  );
}
