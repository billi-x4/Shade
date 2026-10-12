import { ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { explorerTxUrl } from "@/lib/browser";
import { truncateMiddle } from "@/lib/format";

/** A txid shortened for reading, with the full value one copy away and an explorer link when configured. */
export function Txid({
  txid,
  label,
  explorerTemplate,
}: {
  txid: string;
  label: string;
  explorerTemplate: string | null | undefined;
}) {
  const href = explorerTxUrl(explorerTemplate, txid);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted">{label}</span>
      <code className="text-fg" title={txid}>
        {truncateMiddle(txid, 10)}
      </code>
      <CopyButton value={txid} label="Copy id" variant="quiet" className="px-2" />
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1 px-2 text-muted underline-offset-4 hover:text-fg hover:underline"
        >
          Explorer
          <ExternalLink aria-hidden size={14} strokeWidth={1.75} />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}
