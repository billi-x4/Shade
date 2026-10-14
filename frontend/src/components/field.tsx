import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * Label, control, hint and error wired together by id. The hint and the error sit outside the
 * label so the accessible name stays short; both are linked through aria-describedby.
 */
export function Field({
  label,
  hint,
  error,
  aside,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Right-aligned note next to the label, e.g. a byte counter. */
  aside?: ReactNode;
  className?: string;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {aside}
      </div>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={errorId} className="text-sm text-bad">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-fg transition-colors placeholder:text-faint hover:border-fg/50 focus-visible:border-accent aria-invalid:border-bad sm:text-sm disabled:opacity-50";

export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(CONTROL, "min-h-11", className)} {...props} />;
}

export function TextArea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(CONTROL, "min-h-24 py-2.5 font-mono", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(CONTROL, "min-h-11", className)} {...props} />;
}

export function Checkbox({
  label,
  hint,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
      />
      <div className="text-sm">
        <label htmlFor={id} className="font-medium text-fg">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="mt-1 text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
