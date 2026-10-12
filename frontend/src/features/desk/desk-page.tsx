import type { ReactNode } from "react";
import { useDocumentTitle } from "@/lib/hooks";
import { cn } from "@/lib/cn";

/** Page heading for a desk area: the page's only h1, its title, and a one-paragraph explanation. */
export function DeskPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="font-serif text-4xl leading-tight sm:text-5xl">{title}</h1>
        {intro ? <p className="text-muted">{intro}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** Form panel beside a list: edged (>= 3:1) surface with its own h2. */
export function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "h-fit space-y-4 rounded-md border border-line-strong bg-surface p-5",
        className,
      )}
    >
      <h2 className="font-serif text-2xl">{title}</h2>
      {children}
    </section>
  );
}

/** The usual desk layout: a form column and a list column (stacked on phones). */
export function SplitLayout({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start">
      <div className="space-y-6">{aside}</div>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}
