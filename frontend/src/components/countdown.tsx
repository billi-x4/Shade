import { formatSpan } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/cn";

/** "Expires in 42 min" — deliberately not a live region (it ticks every second). */
export function ExpiryCountdown({
  expiresAt,
  className,
  expiredText = "Expired",
}: {
  expiresAt: string;
  className?: string;
  expiredText?: string;
}) {
  const now = useNow(1000);
  const left = new Date(expiresAt).getTime() - now;
  return (
    <time dateTime={expiresAt} className={cn("tabular", className)}>
      {left > 0 ? `Expires in ${formatSpan(left)}` : expiredText}
    </time>
  );
}
