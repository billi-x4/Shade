import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";

/**
 * A window with its blind half drawn: two slats, and gold light through the gap below. Not three
 * equal bars, which would read as a menu button. Decorative; the name beside it is the label.
 */
export function BlindGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 flex-col gap-[2px] rounded-[4px] border-[1.5px] border-fg p-[2.5px]",
        className,
      )}
    >
      <span className="h-[2px] rounded-[1px] bg-fg" />
      <span className="h-[2px] rounded-[1px] bg-fg" />
      <span className="mt-auto h-[4px] rounded-[1px] bg-glow" />
    </span>
  );
}

/** The wordmark: the blind glyph beside the name, linking home. */
export function Mark() {
  return (
    <Link to="/" className="inline-flex min-h-11 items-center gap-2.5 text-fg">
      <BlindGlyph />
      <span className="font-display text-[1.65rem] leading-none tracking-tight">Shade</span>
    </Link>
  );
}

export function NetworkBadge({ network }: { network: "testnet" | "mainnet" }) {
  return network === "mainnet" ? (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-warn/70 px-2 py-0.5 font-mono text-[0.7rem] text-warn uppercase">
      <span aria-hidden className="h-2 w-1 rounded-[1px] bg-warn" />
      Mainnet · real ZEC
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-line-strong px-2 py-0.5 font-mono text-[0.7rem] text-muted uppercase">
      <span aria-hidden className="h-2 w-1 rounded-[1px] bg-glow" />
      Testnet
    </span>
  );
}
