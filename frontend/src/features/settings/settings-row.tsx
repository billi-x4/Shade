/**
 * Layout inside a settings section: rows with a heading and a short note on the left and the form
 * or list on the right (stacked on phones), the small mono label used within rows, and the slip
 * that shows an address.
 */
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function SettingsRow({
  title,
  note,
  badge,
  index = 0,
  children,
}: {
  title: ReactNode;
  note?: ReactNode;
  /** Shown beside the heading, e.g. a mainnet badge. */
  badge?: ReactNode;
  /** Position in the section, for the staggered entrance. */
  index?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="rise grid gap-x-10 gap-y-5 md:grid-cols-[11rem_minmax(0,1fr)]"
      style={{ "--i": index } as CSSProperties}
    >
      <span aria-hidden className="slat-rule slat-open mb-2 block opacity-70 md:col-span-2" />
      <div className="space-y-2 md:sticky md:top-20 md:self-start">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="font-display text-2xl leading-tight">{title}</h3>
          {badge}
        </div>
        {note ? <p className="text-sm text-muted">{note}</p> : null}
      </div>
      <div className="min-w-0 space-y-5">{children}</div>
    </div>
  );
}

/** Small uppercase mono label above a value (also for <dt>s). */
export const EYEBROW = "font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase";

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(EYEBROW, className)}>{children}</p>;
}

/** An address shown in full, with a lit slat along its edge: where the money lands. */
export function Slip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "relative rounded-sm border border-line bg-surface py-3 pr-4 pl-5 font-mono text-sm leading-relaxed wrap-anywhere text-fg",
        className,
      )}
    >
      <span aria-hidden className="absolute inset-y-2.5 left-0 w-[3px] rounded-r-[1px] bg-glow" />
      {children}
    </p>
  );
}
