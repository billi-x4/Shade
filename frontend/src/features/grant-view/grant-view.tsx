import type { GrantView as GrantViewData, Receipt } from "@shade/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useAppConfig } from "@/api/config";
import { ApiError, errorMessage } from "@/api/client";
import { qk } from "@/api/keys";
import { exportGrant, viewGrant } from "@/api/public";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { ExpiryCountdown } from "@/components/countdown";
import { NetworkBadge } from "@/components/mark";
import { ErrorState, LoadingState, RefreshError } from "@/components/states";
import { StatusText } from "@/components/status-text";
import { Txid } from "@/components/txid";
import { useGrantToken } from "@/features/grant-view/grant-token";
import { attachmentFilename, saveBlob } from "@/lib/browser";
import { cn } from "@/lib/cn";
import { formatDateTime, truncateMiddle } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import { verificationLabel } from "@/lib/status";
import type { StatusLabel } from "@/lib/status";

/** /view re-fetches on focus and every 10 s. */
const REFRESH_MS = 10_000;

/** The view and the CSV export hold at most the newest 500 receipts (agents.md §6.3). */
const RECEIPT_LIMIT = 500;

/*
 * The API's `message` on a grant view is the merchant's revoke note ("…Delete the file on their
 * machine too."), so the auditor gets these lines instead.
 */
const ENDED_BY_SHOP = "The shop ended this view.";
const ASK_AGAIN = "Ask the shop for a new link if you still need these receipts.";

const EYEBROW = "font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase";

type ActiveView = Extract<GrantViewData, { state: "active" }>;

function scopeText(scope: string): string {
  return scope === "all" ? "All invoices and jar charges" : `Invoices labelled ${scope}`;
}

/** How Shade knows a receipt is real: a wallet scan outranks the shop's word. Words carry it. */
function receiptCheck(receipt: Receipt): StatusLabel {
  if (receipt.kind === "jar_charge") return { label: "Jar charge", tone: "neutral" };
  return {
    label: verificationLabel(receipt.verification),
    tone: receipt.verification === "ivk_scan" ? "ok" : "neutral",
  };
}

/** The page title: a lit slat over "Receipts". The light is on while the view is open. */
function Title({ children }: { children?: ReactNode }) {
  return (
    <div className="space-y-4">
      <span aria-hidden className="slat-open block h-1 w-12 rounded-[1px] bg-glow" />
      <h1 className="font-display text-6xl leading-[0.9] sm:text-7xl">Receipts</h1>
      {children}
    </div>
  );
}

/** The title slat with its light off: this view no longer opens. */
function UnlitSlat() {
  return <span aria-hidden className="block h-1 w-12 rounded-[1px] bg-line-strong" />;
}

/**
 * Ledger columns on wide screens: date, receipt, amount. The list is the grid and each row a
 * subgrid, so one long amount widens its column for every row and the columns stay aligned.
 */
const LEDGER_COLUMNS = "sm:grid-cols-[8.5rem_minmax(0,1fr)_auto] sm:gap-x-8";

/**
 * A memo hash shortened like a txid (same length, so their copy buttons line up). The label says
 * what it is; the title and the copy button keep the full "sha256:…" value.
 */
function shortMemoHash(memoHash: string): string {
  return truncateMiddle(memoHash.replace(/^sha256:/, ""), 10);
}

function ReceiptRow({
  receipt,
  explorerTemplate,
}: {
  receipt: Receipt;
  explorerTemplate: string | null;
}) {
  const when = receipt.paid_at ?? receipt.created_at;
  // Phones: date and amount share a line and the amount drops below when both do not fit.
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-3 py-5 sm:col-span-3 sm:grid sm:grid-cols-subgrid sm:items-start sm:gap-x-8">
      <time dateTime={when} className="text-sm text-muted tabular sm:pt-1.5">
        {formatDateTime(when)}
      </time>
      <p className="ml-auto text-right font-display text-3xl leading-none tabular sm:col-start-3 sm:row-start-1">
        {receipt.amount_zec}{" "}
        <span className="font-mono text-xs font-medium tracking-[0.1em] text-muted">ZEC</span>
      </p>
      <div className="min-w-0 basis-full space-y-2 sm:col-start-2 sm:row-start-1">
        <p className="font-mono text-sm leading-relaxed wrap-anywhere">
          {receipt.memo || <span className="font-sans text-faint">No memo</span>}
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <StatusText status={receiptCheck(receipt)} />
          {receipt.tag ? <span className="text-sm text-muted">Label {receipt.tag}</span> : null}
        </p>
        <div className="border-t border-dashed border-line pt-1">
          {receipt.txid ? (
            <Txid txid={receipt.txid} label="Transaction" explorerTemplate={explorerTemplate} />
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted">Memo hash</span>
            <code className="text-fg" title={receipt.memo_hash}>
              {shortMemoHash(receipt.memo_hash)}
            </code>
            <CopyButton
              value={receipt.memo_hash}
              label="Copy hash"
              variant="quiet"
              className="px-2"
            />
          </div>
        </div>
      </div>
    </li>
  );
}

function DownloadReceipts({ token, onGone }: { token: string; onGone: () => void }) {
  const download = useMutation({
    mutationFn: () => exportGrant(token),
    onSuccess: ({ blob, disposition }) =>
      saveBlob(blob, attachmentFilename(disposition, "shade-receipts.csv")),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 410) onGone();
    },
  });
  const gone = download.error instanceof ApiError && download.error.status === 410;
  const ended =
    download.error instanceof ApiError && download.error.code === "GRANT_EXPIRED"
      ? "This view has ended."
      : ENDED_BY_SHOP;
  return (
    <div className="space-y-2 sm:text-right">
      <Button
        onClick={() => download.mutate()}
        disabled={download.isPending}
        className="w-full px-5 sm:w-auto"
      >
        <Download aria-hidden size={16} strokeWidth={1.75} />
        {download.isPending ? "Preparing…" : "Download receipts (CSV)"}
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {download.isError ? (
          <span className="text-bad">
            {gone ? `The download no longer works. ${ended}` : errorMessage(download.error)}
          </span>
        ) : download.isSuccess ? (
          <span className="text-ok">Downloaded.</span>
        ) : null}
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <dt className={EYEBROW}>{label}</dt>
      <dd className="space-y-0.5">{children}</dd>
    </div>
  );
}

function Active({ view, token, onGone }: { view: ActiveView; token: string; onGone: () => void }) {
  const config = useAppConfig();
  const explorer = config.data?.explorer_tx_url[view.network] ?? null;
  const count = view.receipts.length;
  return (
    <div className="space-y-10">
      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Title>
          <p className="text-xl">{scopeText(view.scope)}</p>
        </Title>
        <DownloadReceipts token={token} onGone={onGone} />
      </div>

      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line-strong py-5 sm:flex sm:flex-wrap sm:justify-between sm:gap-x-10">
          {view.merchant_name ? (
            <Fact label="Shared by">
              <p className="font-display text-xl leading-tight wrap-anywhere">
                {view.merchant_name}
              </p>
            </Fact>
          ) : null}
          <Fact label="Open until">
            <p className="tabular">{formatDateTime(view.expires_at)}</p>
            <p className="text-sm text-muted">
              <ExpiryCountdown expiresAt={view.expires_at} expiredText="This view has ended." />
            </p>
          </Fact>
          <Fact label="Network">
            <NetworkBadge network={view.network} />
          </Fact>
          <Fact label="Receipts">
            <p className="font-display text-xl leading-tight tabular">{count}</p>
          </Fact>
        </dl>
        <div className="space-y-1 text-sm text-muted">
          <p>The shop can end this view at any time.</p>
          <p>This link shows read-only receipts. It is not a Zcash viewing key.</p>
        </div>
      </div>

      {count === 0 ? (
        <div className="border-t-2 border-b-4 border-double border-fg">
          <div className="space-y-2 py-10">
            <p className="font-display text-3xl">No receipts yet.</p>
            <p className="text-sm text-muted">
              Paid invoices in this scope appear here as soon as they settle.
            </p>
          </div>
          {/* Blank ruled lines: the ledger page waiting for its first entries. */}
          <div aria-hidden className="divide-y divide-line border-t border-line">
            <div className="h-12" />
            <div className="h-12" />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {count >= RECEIPT_LIMIT ? (
            <p className="flex gap-3 text-sm text-warn">
              <span aria-hidden className="mt-1.5 h-3 w-1 shrink-0 rounded-[1px] bg-warn" />
              Showing the newest {RECEIPT_LIMIT} receipts. Older ones are not in this view or the
              download.
            </p>
          ) : null}
          <div aria-hidden className={cn(EYEBROW, LEDGER_COLUMNS, "hidden pb-1 sm:grid")}>
            <span>Date</span>
            <span>Receipt</span>
            <span className="text-right">Amount</span>
          </div>
          <ul
            className={cn(
              "divide-y divide-line border-t-2 border-b-4 border-double border-fg sm:grid",
              LEDGER_COLUMNS,
            )}
            aria-label="Receipts"
          >
            {view.receipts.map((receipt) => (
              <ReceiptRow key={receipt.id} receipt={receipt} explorerTemplate={explorer} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Closed({ title, message, detail }: { title: string; message: string; detail?: string }) {
  return (
    <div className="max-w-2xl space-y-5">
      <UnlitSlat />
      <h1 className="font-display text-5xl leading-[0.95] sm:text-6xl">{title}</h1>
      <p className="text-lg text-muted">{message}</p>
      {detail ? (
        <p className="space-y-1 border-t border-line-strong pt-4">
          <span className={cn(EYEBROW, "block")}>Scope</span> <span>{detail}</span>
        </p>
      ) : null}
    </div>
  );
}

/** A 4xx is the server's final answer about this token (404 unknown, 400 malformed, 429 slow down). */
function isFinalAnswer(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/**
 * Each mounted view gets its own cache entry. The key never holds the token (keys.ts), and a new
 * #gv_ link remounts this component (key={token}), so it can never start from the previous
 * grant's receipts.
 */
let viewGeneration = 0;

function GrantReceipts({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [generation] = useState(() => ++viewGeneration);
  const queryKey = [...qk.grantView, generation] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => viewGrant(token),
    // Revoked, expired and unknown grants are final; only an active one can change. Outages
    // (5xx, network) may recover, so those keep polling.
    refetchInterval: (q) => {
      const { data, error } = q.state;
      if (error instanceof ApiError && error.status === 404) return false;
      if (data !== undefined) return data.state === "active" ? REFRESH_MS : false;
      return isFinalAnswer(error) ? false : REFRESH_MS;
    },
    refetchOnWindowFocus: true,
    // Receipts are never cached after the page goes away.
    gcTime: 0,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey });

  // The grant no longer exists: that outranks any receipts still on screen.
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <Closed
        title="This link does not open anything."
        message="Check that you copied the whole link, including the part after #."
      />
    );
  }
  if (query.data === undefined) {
    return (
      <div className="space-y-10">
        <Title />
        {query.isError ? (
          <ErrorState
            error={query.error}
            title="The receipts did not load."
            onRetry={() => void query.refetch()}
          />
        ) : (
          <LoadingState label="Opening the receipts…" />
        )}
      </div>
    );
  }
  const view = query.data;
  switch (view.state) {
    case "active":
      return (
        <div className="space-y-4">
          {query.isRefetchError ? <RefreshError error={query.error} /> : null}
          <Active view={view} token={token} onGone={refresh} />
        </div>
      );
    case "revoked":
      return (
        <Closed
          title="Access revoked."
          message={`${ENDED_BY_SHOP} ${ASK_AGAIN}`}
          detail={scopeText(view.scope)}
        />
      );
    case "expired":
      return (
        <Closed
          title="This view has ended."
          message={`The shop shared it until ${formatDateTime(view.expires_at)}. ${ASK_AGAIN}`}
          detail={scopeText(view.scope)}
        />
      );
    case "missing":
      return (
        <Closed
          title="This link does not open anything."
          message="Check that you copied the whole link, including the part after #."
        />
      );
  }
}

/** Auditor view of a grant. The token comes from the URL fragment and stays in memory. */
export function GrantView() {
  useDocumentTitle("Receipts");
  const token = useGrantToken();
  if (!token) {
    return (
      <Closed
        title="This page needs the full link."
        message="Open the full link the shop sent you. The part after # opens the receipts. The page keeps that part in memory only while it is open."
      />
    );
  }
  return <GrantReceipts key={token} token={token} />;
}
