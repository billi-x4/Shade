import { cn } from "@/lib/cn";

const VARIANTS = {
  primary:
    "bg-paper text-ink hover:bg-paper/90 disabled:hover:bg-paper aria-disabled:hover:bg-paper",
  ghost: "border border-line-strong bg-transparent text-fg hover:bg-surface-2",
  quiet: "bg-transparent text-muted hover:text-fg",
  danger: "border border-bad/70 bg-transparent text-bad hover:bg-bad/10",
  ink: "bg-ink text-paper hover:bg-ink/85",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45";

/** Button look for <button>, <a> and router links alike. */
export function buttonClass(variant: ButtonVariant = "primary", className?: string): string {
  return cn(BASE, VARIANTS[variant], className);
}
