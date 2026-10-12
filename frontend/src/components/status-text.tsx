import { cn } from "@/lib/cn";
import { TONE_TEXT, type StatusLabel } from "@/lib/status";

const DOT: Record<StatusLabel["tone"], string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  muted: "bg-faint",
  neutral: "bg-fg",
};

/** A status in plain words with a tone dot. The words carry the meaning; color only echoes it. */
export function StatusText({ status, className }: { status: StatusLabel; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-sm font-medium",
        TONE_TEXT[status.tone],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone])} />
      {status.label}
    </span>
  );
}
