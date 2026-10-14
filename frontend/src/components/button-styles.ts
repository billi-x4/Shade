import { cn } from "@/lib/cn";

const VARIANTS = {
  /** The one main action on a screen: gold light on night ink (ink on paper pages). */
  primary:
    "sheen bg-accent text-on-accent shadow-[0_1px_0_rgb(255_255_255/0.25)_inset,0_10px_30px_-12px_var(--color-glow)] hover:brightness-[1.06] disabled:hover:brightness-100 aria-disabled:hover:brightness-100",
  ghost: "border border-line-strong bg-transparent text-fg hover:border-fg/60 hover:bg-surface-2",
  quiet: "bg-transparent text-muted hover:text-fg",
  danger: "border border-bad/70 bg-transparent text-bad hover:bg-bad/10",
  ink: "bg-ink text-paper hover:bg-ink/85",
} as const;

export type ButtonVariant = keyof typeof VARIANTS;

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-sm px-4 text-sm font-semibold transition-[background-color,border-color,color,filter,transform] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-45";

/** Button look for <button>, <a> and router links alike. */
export function buttonClass(variant: ButtonVariant = "primary", className?: string): string {
  return cn(BASE, VARIANTS[variant], className);
}
