import { COPY } from "@shade/contract";
import type { Network, PaymentProgress, PublicInvoice } from "@shade/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, Clock } from "lucide-react";
import { useState } from "react";
import type { CSSProperties, FormEvent } from "react";
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
 * Type size by amount length, so the digits stay on one line inside the receipt: its content box
 * is 316 px on a 390 px phone, 350 px on desktop and 254 px on a 320 px screen. "0.01" stays
 * large, "12.12345678" steps down to 3rem and "20999999.99999999" (the longest amount, 277 px at
 * 2.25rem) to 2.25rem. The vw floor keeps them on one line on 320 px screens too.
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

const EYEBROW = "font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase";

/**
 * Gold light through blinds behind the receipt on wide screens. Fixed to the viewport and clipped
 * there, so it never widens the page.
 */
function Beam() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 hidden overflow-hidden lg:block"
    >
      <span className="blinds blinds-fade absolute -top-32 -left-40 h-[52rem] w-[62rem] -rotate-12 opacity-[0.07]" />
    </div>
  );
}

/** The heading slat with its light off: nothing on this page can be paid. */
function UnlitSlat() {
  return <span aria-hidden className="block h-1 w-12 rounded-[1px] bg-line-strong" />;
}

function PayHeading() {
  return (
    <div className="space-y-3">
      <span aria-hidden className="slat-open block h-1 w-12 rounded-[1px] bg-glow" />
      <h1 className="font-display text-[2rem] leading-[0.95] sm:text-[2.6rem]">
        {COPY.payHeading}
      </h1>
    </div>
  );
}

const WALLETS: Record<Network, { name: string; href: string; note: string }[]> = {
  testnet: [
    { name: "Zingo", href: "https://zingolabs.org", note: "Testnet wallet for phone and desktop" },
    { name: "Testnet faucet", href: "https://zcashfaucet.jinolabs.xyz", note: "Free testnet ZEC" },
  ],
  mainnet: [
    { name: "Zodl", href: "https://zodl.com", note: "Phone wallet" },
    { name: "Zingo", href: "https://zingolabs.org", note: "Phone and desktop wallet" },
  ],
};

function WalletLinks({ network }: { network: Network }) {
  return (
    <section aria-labelledby="need-wallet" className="space-y-3">
      <h2 id="need-wallet" className="font-display text-xl">
        Need a wallet?
      </h2>
      <ul className="divide-y divide-line border-y border-line">
        {WALLETS[network].map((wallet) => (
          <li
            key={wallet.name}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 py-1"
          >
            <a
              href={wallet.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 font-medium text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg"
            >
              {wallet.name}
              <ArrowUpRight aria-hidden size={15} strokeWidth={1.75} className="text-muted" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <span className="pb-2 text-sm text-muted sm:pb-0">{wallet.note}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">Shade never asks for your seed phrase.</p>
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

/** Three slats that light up as the payment moves: gold while it travels, green once it is paid. */
function Progress({ invoice }: { invoice: PublicInvoice }) {
  const current = stepIndex(invoice.progress);
  const paid = invoice.progress === "confirmed";
  return (
    <div className="space-y-4">
      <p
        role="status"
        aria-live="polite"
        className={cn("text-lg leading-snug font-medium", paid && "text-ok")}
      >
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
              className="space-y-2.5"
            >
              <span
                aria-hidden
                style={{ "--i": index + 3 } as CSSProperties}
                className={cn(
                  "slat-open block h-1.5 rounded-[1px] transition-[background-color,box-shadow] duration-700",
                  paid
                    ? "bg-ok shadow-[0_0_18px_-3px_var(--color-ok)]"
                    : index < current
                      ? "bg-glow"
                      : index === current
                        ? "bg-glow shadow-[0_0_18px_-3px_var(--color-glow)]"
                        : "bg-fg/12",
                )}
              />
              <span
                className={cn(
                  "block font-mono text-[0.65rem] leading-snug tracking-[0.1em] uppercase",
                  index === current ? "text-fg" : index < current ? "text-muted" : "text-faint",
                )}
              >
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

/** The bill: who asks, how much, for what, and where the payment is. */
function Receipt({
  invoice,
  state,
  reconnecting,
}: {
  invoice: PublicInvoice;
  state: PayState;
  reconnecting: boolean;
}) {
  const closed = state === "expired" || state === "cancelled";
  return (
    <div
      style={{ "--i": 0 } as CSSProperties}
      className="rise relative overflow-hidden rounded-lg border border-line-strong bg-surface"
    >
      <span
        aria-hidden
        className="blinds blinds-fade pointer-events-none absolute top-0 right-0 h-36 w-3/4 -scale-x-100 opacity-[0.07]"
      />
      <div className="relative space-y-6 p-4 min-[380px]:p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          {invoice.merchant_name ? (
            <p className="min-w-0 wrap-anywhere">
              <span className={cn(EYEBROW, "block")}>Requested by</span>{" "}
              <span className="mt-1 block font-display text-2xl leading-tight">
                {invoice.merchant_name}
              </span>
            </p>
          ) : null}
          <NetworkBadge network={invoice.network} />
        </div>
        <div className="space-y-2">
          {/* The space lets the unit wrap below a long amount; wrap-anywhere only acts on screens
              too narrow for the smallest size. */}
          <p
            className={cn(
              "font-display leading-none tabular wrap-anywhere",
              amountSize(invoice.amount_zec),
              closed && "text-muted",
            )}
          >
            <span>{invoice.amount_zec}</span>{" "}
            <span className="font-mono text-sm font-medium tracking-[0.12em] whitespace-nowrap text-muted">
              ZEC
            </span>
          </p>
          {invoice.memo ? <p className="text-lg wrap-anywhere">{invoice.memo}</p> : null}
        </div>
        {invoice.network === "testnet" ? (
          <p className="flex items-center gap-2 text-sm text-warn">
            <span aria-hidden className="h-2.5 w-1 shrink-0 rounded-[1px] bg-warn" />
            Use a testnet wallet.
          </p>
        ) : null}
        {/* A closed invoice has no progress: its live region goes, the page-long one speaks. */}
        {closed ? null : (
          <div className="border-t border-dashed border-line-strong pt-5">
            <Progress invoice={invoice} />
          </div>
        )}
        {reconnecting ? <p className="text-sm text-faint">Reconnecting…</p> : null}
      </div>
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
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-1">
        <h2 className="font-display text-xl">Already paid?</h2>
        <p className="text-sm text-muted">
          Paste the transaction id from your wallet so the shop can check it.
        </p>
      </div>
      <Field label="Transaction id" error={shownError}>
        {(control) => (
          <TextInput
            {...control}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
            placeholder="64 characters"
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
      <p className="rounded-lg border border-bad/50 bg-bad/5 p-4 text-sm text-bad">
        You cannot pay this invoice from this page. Ask the shop for a new link.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      <a href={invoice.zip321} className={buttonClass("primary", "min-h-14 w-full text-base")}>
        Open in wallet
      </a>
      <figure className="mx-auto w-full max-w-72 space-y-4">
        <figcaption className="flex items-center gap-3">
          <span aria-hidden className="h-px flex-1 bg-line" />
          <span className={EYEBROW}>Or scan with your wallet</span>
          <span aria-hidden className="h-px flex-1 bg-line" />
        </figcaption>
        {/* The code's own quiet zone is the card's margin, so the paper is one even sheet. */}
        <div className="overflow-hidden rounded-lg bg-paper shadow-[0_18px_44px_-32px_var(--color-glow)]">
          <QrCode
            value={invoice.zip321}
            label={`QR code to pay ${invoice.amount_zec} ZEC with a Zcash wallet`}
          />
        </div>
      </figure>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CopyButton value={invoice.zip321} label="Copy payment link" />
        <p className="inline-flex items-center gap-2 text-sm text-muted">
          <Clock aria-hidden size={15} strokeWidth={1.75} />
          <ExpiryCountdown expiresAt={invoice.expires_at} />
        </p>
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
    { key: "amount", label: "Amount in ZEC", value: invoice.amount_zec, mono: false },
    { key: "memo", label: "Memo", value: memo, mono: true },
  ];
  return (
    <details className="group rounded-lg border border-line-strong bg-surface">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
        Wallet did not open? Pay by hand
        <ChevronDown
          aria-hidden
          size={16}
          strokeWidth={1.75}
          className="shrink-0 text-muted transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      <div className="space-y-5 border-t border-line px-4 pt-4 pb-5">
        <p className="text-sm text-muted">
          Send exactly this amount to this address with this memo. Your wallet adds the network fee
          on top.
        </p>
        <dl className="divide-y divide-line border-y border-line">
          {rows.map((row) => (
            <div key={row.key} className="space-y-2 py-4">
              <dt className={EYEBROW}>{row.label}</dt>
              <dd className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span
                  className={cn(
                    "min-w-0 wrap-anywhere",
                    row.mono
                      ? "font-mono text-sm leading-relaxed"
                      : "font-display text-3xl tabular",
                  )}
                >
                  {row.value}
                </span>
                <CopyButton value={row.value} label={`Copy ${row.key}`} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="flex gap-3 text-sm text-warn">
          <span aria-hidden className="mt-1.5 h-3 w-1 shrink-0 rounded-[1px] bg-warn" />
          Paste the memo exactly, including the shade reference at the end. Shade cannot match a
          payment with a different memo.
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
      <div className="lit relative overflow-hidden rounded-lg border border-ok/60 bg-ok/[0.06]">
        {/* The same light through the slats, in the paid color. */}
        <span
          aria-hidden
          style={{ "--color-glow": "var(--color-ok)" } as CSSProperties}
          className="blinds blinds-fade pointer-events-none absolute inset-y-0 right-0 w-3/4 -scale-x-100 opacity-[0.1]"
        />
        <div className="relative space-y-3 p-6">
          <p className="font-display text-6xl leading-none text-ok">Paid.</p>
          <p className="text-sm text-muted">
            {paidAt ? `Confirmed ${formatDateTime(paidAt)}. ` : null}You can close this page.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4 rounded-lg border border-line-strong p-6">
      <UnlitSlat />
      <p className="font-display text-5xl leading-none">
        {state === "expired" ? "Expired." : "Cancelled."}
      </p>
      <p className="text-sm text-muted">
        {state === "expired"
          ? "This invoice ran out of time. Do not pay it. Ask the shop for a new one."
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
    <div className="space-y-2 rounded-lg border border-line-strong p-5">
      <p className="font-medium">The network is confirming your payment. Do not pay again.</p>
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
    <div className="space-y-2 rounded-lg border border-warn/50 bg-warn/5 p-5">
      <p className="text-sm text-warn">
        The shop is checking the reported payment. This invoice has expired, so do not send another
        payment.
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
  return (
    <div className="space-y-8 pt-4 sm:pt-10">
      <Beam />
      {/* Mounted for the page's life: the progress live region unmounts once the invoice closes. */}
      <p className="sr-only" role="status" aria-live="polite">
        {state === "expired"
          ? "This invoice has run out of time."
          : state === "cancelled"
            ? "The shop cancelled this invoice."
            : ""}
      </p>
      <PayHeading />
      <Receipt invoice={invoice} state={state} reconnecting={reconnecting} />

      {state === "pay" ? (
        <>
          <div style={{ "--i": 1 } as CSSProperties} className="rise space-y-6">
            {invoice.status === "paid_unverified" ? (
              <p className="rounded-lg border border-warn/50 bg-warn/5 p-4 text-sm text-warn">
                The shop is checking a reported payment. If you have not paid yet, you can still pay
                below.
              </p>
            ) : null}
            <Instructions invoice={invoice} />
          </div>
          <div className="space-y-1.5 border-l-2 border-glow/70 pl-4 text-sm text-muted">
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

      <span aria-hidden className="slat-rule block" />
      <WalletLinks network={invoice.network} />
      <p className="space-y-1 text-xs text-faint">
        <span className="block font-mono tracking-[0.14em] uppercase">Paying to</span>{" "}
        <span className="block font-mono leading-relaxed text-muted wrap-anywhere">
          {invoice.address}
        </span>
      </p>
    </div>
  );
}

function Missing() {
  useDocumentTitle("Invoice not found");
  return (
    <div className="space-y-4 pt-6 sm:pt-12">
      <UnlitSlat />
      <h1 className="font-display text-5xl leading-[0.95]">No such invoice.</h1>
      <p className="text-muted">
        The link may have a typo, or the shop removed this invoice. Ask the shop for a new link.
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
    <div className="space-y-8 pt-4 sm:pt-10">
      <PayHeading />
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
