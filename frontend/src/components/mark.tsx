import { Link } from "@tanstack/react-router";

/** The wordmark: a single paper seam — the curtain — beside the name. */
export function Mark() {
  return (
    <Link to="/" className="inline-flex min-h-11 items-center gap-2.5 text-fg">
      <span className="inline-block h-6 w-[3px] rounded-[1px] bg-paper" aria-hidden />
      <span className="font-serif text-2xl leading-none">Shade</span>
    </Link>
  );
}

export function NetworkBadge({ network }: { network: "testnet" | "mainnet" }) {
  return network === "mainnet" ? (
    <span className="inline-flex items-center rounded-full border border-warn/70 px-2.5 py-0.5 text-xs font-medium text-warn">
      Mainnet · real ZEC
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-line-strong px-2.5 py-0.5 text-xs font-medium text-muted">
      Testnet
    </span>
  );
}
