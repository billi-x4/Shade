import { COPY } from "@shade/contract";
import type { Network, PaymentProgress, PublicInvoice } from "@shade/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "@/api/client";
import { qk } from "@/api/keys";
import { getPublicInvoice, submitPayerTxid } from "@/api/public";
import { buttonClass } from "@/components/button-styles";
import { CopyButton } from "@/components/copy-button";
import { ExpiryCountdown } from "@/components/countdown";
import { Field, TextInput } from "@/components/field";
import { NetworkBadge } from "@/components/mark";
import { QrCode } from "@/components/qr-code";
import { ErrorState, LoadingState } from "@/components/states";
import { TXID_FORMAT_MESSAGE, txidErrorMessage } from "@/features/pay/pay-errors";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { useDocumentTitle, useNow } from "@/lib/hooks";
import { paymentProgressLabel } from "@/lib/status";
import { normalizeTxid } from "@/lib/validation";
import { paymentMemo } from "@/lib/zip321";

/**
 * Poll every 3 s while the invoice can still change; stop on paid, expired, cancelled.
 * A payment seen on chain before expiry can still settle an expired invoice, so a seen payment
 * keeps the page polling until it is paid (or the payment drops out of the chain).
 */
const POLL_MS = 3_000;
const LIVE = new Set<PublicInvoice["status"]>(["open", "paid_unverified"]);

function polling(invoice: PublicInvoice): boolean {
  return LIVE.has(invoice.status) || invoice.progress === "seen";
}

/**
 * What the page shows. Past expires_at nothing invites a payment any more: a new one could never
 * match. `now` is the payer's clock, so the page switches at expiry without waiting for a poll.
 */
type PayState = "pay" | "confirming" | "reported_expired" | "paid" | "expired" | "cancelled";

function payState(invoice: PublicInvoice, pastExpiry: boolean): PayState {
  if (invoice.status === "paid") return "paid";
  if (invoice.status === "cancelled") return "cancelled";
  if (invoice.status !== "expired" && !pastExpiry) return "pay";
  if (invoice.progress === "seen") return "confirming";
  if (invoice.status === "paid_unverified") return "reported_expired";
  return "expired";
}

/**
 * Type size by amount length, so the digits stay on one line inside the 358 px column of a 390 px
 * phone and the 400 px desktop column: "0.01" stays large, "12.12345678" steps down to 3rem and
 * "20999999.99999999" (the longest amount) to 2.25rem. The vw floor keeps them on one line on
 * 320 px screens too.
 */
function amountSize(amount: string): string {
  if (amount.length <= 7) return "text-6xl sm:text-7xl";
  if (amount.length <= 11) return "text-[length:clamp(2.25rem,12.5vw,3rem)]";
  return "text-[length:clamp(1.75rem,9.5vw,2.25rem)]";
}

/** Only a zcash: URI may become a link or a QR. */
function isPaymentUri(uri: string): boolean {
  return /^zcash:[a-z0-9]+/i.test(uri);
}

const WALLETS: Record<Network, { name: string; href: string; note: string }[]> = {
  testnet: [
    { name: "Zingo", href: "https://zingolabs.org", note: "testnet wallet for phone and desktop" },
    { name: "Testnet faucet", href: "https://zcashfaucet.jinolabs.xyz", note: "free testnet ZEC" },
  ],
  mainnet: [
    { name: "Zodl", href: "https://zodl.com", note: "phone wallet" },
    { name: "Zingo", href: "https://zingolabs.org", note: "phone and desktop wallet" },
  ],
};

function WalletLinks({ network }: { network: Network }) {
  return (
    <section aria-labelledby="need-wallet" className="space-y-2 text-sm">
      <h2 id="need-wallet" className="font-medium">
        Need a wallet?
      </h2>
      <ul className="space-y-1">
        {WALLETS[network].map((wallet) => (
          <li key={wallet.name}>
            <a
              href={wallet.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-2 text-fg underline underline-offset-4"
            >
              {wallet.name}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <span className="text-muted"> — {wallet.note}</span>
          </li>
        ))}
      </ul>
      <p className="text-faint">Shade never asks for your seed phrase.</p>
    </section>
  );
}

const STEPS: { key: PaymentProgress; label: string }[] = [
  { key: "awaiting", label: "Waiting" },
  { key: "seen", label: "On the network" },
  { key: "confirmed", label: "Paid" },
];

function stepIndex(progress: PaymentProgress): number {
  return progress === "confirmed" ? 2 : progress === "seen" || progress === "reported" ? 1 : 0;
}

function Progress({ invoice }: { invoice: PublicInvoice }) {
  const current = stepIndex(invoice.progress);
  return (
    <div className="space-y-3">
      <p role="status" aria-live="polite" className="text-base font-medium">
        {paymentProgressLabel(
          invoice.progress,
          invoice.confirmations,
          invoice.required_confirmations,
        )}
      </p>
      <ol className="grid grid-cols-3 gap-2" aria-label="Payment progress">
        {STEPS.map((step, index) => {
          const label = index === 1 && invoice.progress === "reported" ? "Reported" : step.label;
          return (
            <li
              key={step.key}
              aria-current={index === current ? "step" : undefined}
              className="space-y-1.5"
            >
              <span
                aria-hidden
                className={cn(
                  "block h-1 rounded-full",
                  index < current || invoice.progress === "confirmed"
                    ? "bg-ok"
                    : index === current
                      ? "bg-paper"
                      : "bg-surface-2",
                )}
              />
              <span className={cn("block text-xs", index <= current ? "text-fg" : "text-faint")}>
                {label}
                <span className="sr-only">
                  {index < current ? " (done)" : index === current ? " (now)" : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TxidForm({ invoice }: { invoice: PublicInvoice }) {
  const queryClient = useQueryClient();
  const [txid, setTxid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (value: string) => submitPayerTxid(invoice.id, value),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.publicInvoice(invoice.id), next);
      setTxid("");
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = normalizeTxid(txid);
    if (!value) {
      setError(TXID_FORMAT_MESSAGE);
      return;
    }
    setError(null);
    mutation.mutate(value);
  }

  const shownError = error ?? (mutation.isError ? txidErrorMessage(mutation.error) : null);
  return (
    <form className="space-y-3" onSubmit={onSubmit} noValidate>
      <h2 className="text-sm font-medium">
        Already paid? Paste the transaction id so the shop can check it.
      </h2>
      <Field label="Transaction id" error={shownError}>
        {(control) => (
          <TextInput
            {...control}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
            placeholder="64 characters from your wallet"
            value={txid}
            onChange={(event) => setTxid(event.target.value)}
          />
        )}
      </Field>
      <button
        type="submit"
        className={buttonClass("ghost", "w-full")}
        disabled={mutation.isPending || !txid.trim()}
      >
        {mutation.isPending ? "Checking…" : "Send transaction id"}
      </button>
      <p className="sr-only" role="status" aria-live="polite">
        {mutation.isPending ? "Checking the transaction id." : (shownError ?? "")}
      </p>
      {mutation.isSuccess ? (
        <p className="text-sm text-ok">
          Thanks. The shop will check it. This page updates by itself.
        </p>
      ) : null}
    </form>
  );
}

function Instructions({ invoice }: { invoice: PublicInvoice }) {
  if (!isPaymentUri(invoice.zip321)) {
    return (
      <p className="text-sm text-bad">
        This invoice cannot be paid from this page. Ask the shop for a new link.
      </p>
    );
  }
  return (
    <div className="space-y-5">
      <a href={invoice.zip321} className={buttonClass("primary", "min-h-14 w-full text-base")}>
        Open in wallet
      </a>
      <figure className="mx-auto w-full max-w-72 space-y-2">
        <div className="rounded-md bg-paper p-3">
          <QrCode
            value={invoice.zip321}
            label={`QR code to pay ${invoice.amount_zec} ZEC with a Zcash wallet`}
          />
        </div>
        <figcaption className="text-center text-xs text-faint">
          Scan with your wallet's camera.
        </figcaption>
      </figure>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CopyButton value={invoice.zip321} label="Copy payment link" />
        <ExpiryCountdown expiresAt={invoice.expires_at} className="text-sm text-muted" />
      </div>
      <ManualPay invoice={invoice} />
    </div>
  );
}

/**
 * For wallets that cannot open the link or scan the QR. Shade matches a payment by amount and the
 * exact memo inside the payment URI (the merchant memo plus its shade reference), so the memo is
 * offered verbatim. Without a readable memo there is nothing safe to pay by hand.
 */
function ManualPay({ invoice }: { invoice: PublicInvoice }) {
  const memo = paymentMemo(invoice.zip321);
  if (memo === null) return null;
  const rows = [
    { key: "address", label: "Address", value: invoice.address, mono: true },
    { key: "amount", label: "Amount (ZEC)", value: invoice.amount_zec, mono: false },
    { key: "memo", label: "Memo", value: memo, mono: true },
  ];
  return (
    <details className="group rounded-md border border-line-strong">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">
        Wallet did not open? Pay by hand
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-4">
        <p className="text-sm text-muted">
          Send exactly this amount to this address, with this memo. Your wallet adds the network fee
          on top.
        </p>
        <dl className="space-y-4">
          {rows.map((row) => (
            <div key={row.key} className="space-y-2">
              <dt className="text-xs text-faint">{row.label}</dt>
              <dd className="flex flex-wrap items-start justify-between gap-2">
                <span
                  className={cn("min-w-0 flex-1 text-sm wrap-anywhere", row.mono && "font-mono")}
                >
                  {row.value}
                </span>
                <CopyButton value={row.value} label={`Copy ${row.key}`} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-warn">
          Paste the memo exactly, including the shade reference at the end. A payment with a
          different memo is not found automatically.
        </p>
      </div>
    </details>
  );
}

function Closed({
  state,
  paidAt,
}: {
  state: "paid" | "expired" | "cancelled";
  paidAt: string | null;
}) {
  if (state === "paid") {
    return (
      <div className="space-y-2 rounded-md border border-ok/50 p-5">
        <p className="font-serif text-3xl text-ok">Paid.</p>
        <p className="text-sm text-muted">
          {paidAt ? `Confirmed ${formatDateTime(paidAt)}. ` : null}You can close this page.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-line-strong p-5">
      <p className="font-serif text-3xl">{state === "expired" ? "Expired." : "Cancelled."}</p>
      <p className="text-sm text-muted">
        {state === "expired"
          ? "This invoice is past its time. Do not pay it; ask the shop for a new one."
          : "The shop cancelled this invoice. Do not pay it."}
      </p>
    </div>
  );
}

/**
 * Shade saw the payment on chain before the invoice ran out of time. It becomes paid once it has
 * its confirmations, so the page keeps polling; a second payment would never match.
 */
function ConfirmingAfterExpiry() {
  return (
    <div className="space-y-2 rounded-md border border-line-strong p-5">
      <p className="text-sm">
        Your payment is on the network and is being confirmed. Do not pay again.
      </p>
      <p className="text-sm text-muted">This page updates by itself.</p>
    </div>
  );
}

/**
 * A payer reported a txid, then the invoice ran out of time. The report can still be accepted (or
 * rejected) by the shop, so the page keeps polling, but a new payment would land outside the
 * window: Shade would never match it.
 */
function ReportedExpired() {
  return (
    <div className="space-y-2 rounded-md border border-warn/50 p-5">
      <p className="text-sm text-warn">
        A payment was reported and the shop is checking it. This invoice is past its time; do not
        send another payment.
      </p>
      <p className="text-sm text-muted">If you have not paid, ask the shop for a new invoice.</p>
    </div>
  );
}

function InvoiceView({ invoice, reconnecting }: { invoice: PublicInvoice; reconnecting: boolean }) {
  useDocumentTitle(`Pay ${invoice.amount_zec} ZEC`);
  // Ticks on its own: an unchanged 3 s poll does not re-render, but expiry must still switch the page.
  const now = useNow(1000);
  const state = payState(invoice, new Date(invoice.expires_at).getTime() <= now);
  const showProgress = state !== "expired" && state !== "cancelled";
  return (
    <div className="space-y-8">
      {/* Mounted for the page's life: the progress live region unmounts once the invoice closes. */}
      <p className="sr-only" role="status" aria-live="polite">
        {state === "expired"
          ? "This invoice has run out of time."
          : state === "cancelled"
            ? "This invoice was cancelled."
            : ""}
      </p>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <NetworkBadge network={invoice.network} />
          {invoice.merchant_name ? (
            <p className="text-sm text-muted wrap-anywhere">
              Requested by <span className="text-fg">{invoice.merchant_name}</span>
            </p>
          ) : null}
        </div>
        <h1 className="font-serif text-3xl leading-tight">{COPY.payHeading}</h1>
        {/* The space lets the unit wrap below a long amount; wrap-anywhere only acts on screens
            too narrow for the smallest size. */}
        <p
          className={cn(
            "font-serif leading-none tabular wrap-anywhere",
            amountSize(invoice.amount_zec),
          )}
        >
          <span>{invoice.amount_zec}</span>{" "}
          <span className="font-sans text-xl whitespace-nowrap text-muted">ZEC</span>
        </p>
        {invoice.memo ? <p className="text-lg wrap-anywhere">{invoice.memo}</p> : null}
        {invoice.network === "testnet" ? (
          <p className="text-sm text-warn">Use a testnet wallet.</p>
        ) : null}
      </div>

      {showProgress ? <Progress invoice={invoice} /> : null}
      {reconnecting ? <p className="text-sm text-faint">Reconnecting…</p> : null}

      {state === "pay" ? (
        <>
          {invoice.status === "paid_unverified" ? (
            <p className="rounded-sm border border-warn/50 p-3 text-sm text-warn">
              A payment was reported for this invoice. If you have not paid yet, you can still pay
              below.
            </p>
          ) : null}
          <Instructions invoice={invoice} />
          <div className="space-y-1 text-sm text-muted">
            <p>{COPY.pay}</p>
            <p>{COPY.lag}</p>
          </div>
          <TxidForm invoice={invoice} />
        </>
      ) : state === "confirming" ? (
        <ConfirmingAfterExpiry />
      ) : state === "reported_expired" ? (
        <ReportedExpired />
      ) : (
        <Closed state={state} paidAt={invoice.paid_at} />
      )}

      <WalletLinks network={invoice.network} />
      <p className="text-xs text-faint wrap-anywhere">
        Paying to <span className="font-mono">{invoice.address}</span>
      </p>
    </div>
  );
}

function Missing() {
  useDocumentTitle("Invoice not found");
  return (
    <div className="space-y-3">
      <h1 className="font-serif text-4xl">No such invoice.</h1>
      <p className="text-muted">
        The link may be mistyped, or the shop removed this invoice. Ask them for a new link.
      </p>
    </div>
  );
}

/** Public pay page body (PRD §10): must work on a phone. */
export function PayView({ id }: { id: string }) {
  const query = useQuery({
    queryKey: qk.publicInvoice(id),
    queryFn: ({ signal }) => getPublicInvoice(id, signal),
    refetchInterval: (q) => (q.state.data && polling(q.state.data) ? POLL_MS : false),
    refetchIntervalInBackground: false,
  });

  if (query.data) return <InvoiceView invoice={query.data} reconnecting={query.isRefetchError} />;
  if (query.error instanceof ApiError && query.error.status === 404) return <Missing />;
  return (
    <div className="space-y-6">
      <h1 className="font-serif text-3xl leading-tight">{COPY.payHeading}</h1>
      {query.isPending ? (
        <LoadingState label="Loading the invoice…" rows={3} />
      ) : (
        <ErrorState
          error={query.error}
          title="This invoice did not load."
          onRetry={() => void query.refetch()}
        />
      )}
    </div>
  );
}
