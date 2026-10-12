import type { GrantView as GrantViewData, Receipt } from "@shade/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { useAppConfig } from "@/api/config";
import { ApiError, errorMessage } from "@/api/client";
import { qk } from "@/api/keys";
import { exportGrant, viewGrant } from "@/api/public";
import { Button } from "@/components/button";
import { ExpiryCountdown } from "@/components/countdown";
import { ErrorState, LoadingState, RefreshError } from "@/components/states";
import { Txid } from "@/components/txid";
import { useGrantToken } from "@/features/grant-view/grant-token";
import { attachmentFilename, saveBlob } from "@/lib/browser";
import { formatDateTime } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import { verificationLabel } from "@/lib/status";

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

type ActiveView = Extract<GrantViewData, { state: "active" }>;

function scopeText(scope: string): string {
  return scope === "all" ? "All invoices and jar charges" : `Invoices labelled ${scope}`;
}

function ReceiptRow({
  receipt,
  explorerTemplate,
}: {
  receipt: Receipt;
  explorerTemplate: string | null;
}) {
  const when = receipt.paid_at ?? receipt.created_at;
  return (
    <li className="grid gap-3 py-5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      <p className="font-serif text-2xl tabular">
        {receipt.amount_zec} <span className="font-sans text-sm text-muted">ZEC</span>
      </p>
      <div className="min-w-0 space-y-1.5 text-sm">
        <p className="wrap-anywhere">
          {receipt.memo || <span className="text-faint">No memo</span>}
        </p>
        <p className="flex flex-wrap gap-x-3 text-muted">
          <span>
            {receipt.kind === "jar_charge" ? "Jar charge" : verificationLabel(receipt.verification)}
          </span>
          <time dateTime={when}>{formatDateTime(when)}</time>
          {receipt.tag ? <span>Label {receipt.tag}</span> : null}
        </p>
        {receipt.txid ? (
          <Txid txid={receipt.txid} label="Transaction" explorerTemplate={explorerTemplate} />
        ) : null}
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
    <div className="space-y-2">
      <Button variant="ghost" onClick={() => download.mutate()} disabled={download.isPending}>
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

function Active({ view, token, onGone }: { view: ActiveView; token: string; onGone: () => void }) {
  const config = useAppConfig();
  const explorer = config.data?.explorer_tx_url[view.network] ?? null;
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {view.merchant_name ? (
            <>
              Shared by <span className="text-fg">{view.merchant_name}</span> ·{" "}
            </>
          ) : null}
          Read-only receipts. Not a Zcash viewing key.
        </p>
        <h1 className="font-serif text-4xl leading-tight sm:text-5xl">Receipts</h1>
        <p className="text-lg">{scopeText(view.scope)}</p>
        <p className="text-sm text-muted">
          <ExpiryCountdown expiresAt={view.expires_at} expiredText="This view has ended." /> · This
          view is shared by the shop until {formatDateTime(view.expires_at)}. The shop can end it at
          any time.
        </p>
      </div>
      <DownloadReceipts token={token} onGone={onGone} />
      {view.receipts.length === 0 ? (
        <div className="border-y border-line py-10">
          <p className="font-serif text-xl">No receipts yet.</p>
          <p className="mt-2 text-sm text-muted">
            Paid invoices in this scope appear here as soon as they settle.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {view.receipts.length >= RECEIPT_LIMIT ? (
            <p className="text-sm text-muted">
              Showing the newest {RECEIPT_LIMIT} receipts. Older ones are not in this view or the
              download.
            </p>
          ) : null}
          <ul className="divide-y divide-line border-y border-line" aria-label="Receipts">
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
    <div className="space-y-4">
      <h1 className="font-serif text-4xl leading-tight sm:text-5xl">{title}</h1>
      <p className="text-muted">{message}</p>
      {detail ? <p className="text-sm text-faint">{detail}</p> : null}
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
      <div className="space-y-6">
        <h1 className="font-serif text-4xl">Receipts</h1>
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
        message="Open the grant link you were sent. The part after # is the key to the receipts, and this page keeps it only while it is open."
      />
    );
  }
  return <GrantReceipts key={token} token={token} />;
}
