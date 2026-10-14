import type { Invoice } from "@shade/contract";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { errorMessage } from "@/api/client";
import { acceptInvoice, cancelInvoice, rejectInvoice } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { buttonClass } from "@/components/button-styles";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { ExpiryCountdown } from "@/components/countdown";
import { StatusText } from "@/components/status-text";
import { Txid } from "@/components/txid";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { RecordPaymentDialog, WalletCheck } from "@/features/invoices/record-payment-dialog";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { invoiceStatus } from "@/lib/status";

type Pending = "cancel" | "accept" | "reject" | "record" | null;

/** Long amounts step down a size, so one 13-digit amount does not widen the whole column. */
function amountSize(amount: string): string {
  if (amount.length <= 7) return "text-3xl";
  if (amount.length <= 10) return "text-2xl";
  return "text-xl";
}

function closedPhrase(status: Invoice["status"]): string {
  if (status === "cancelled") return "was cancelled";
  if (status === "expired") return "expired";
  return "closed";
}

/** A note under the ledger line that needs the merchant's eyes: a claim, a late or second payment. */
function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-1 rounded-sm border border-warn/50 bg-warn/[0.04] px-3 pt-2.5">
      {children}
    </div>
  );
}

/**
 * One invoice as a ledger line: the amount in its own column (the list is a grid; each row is a
 * subgrid, so amounts line up), then the memo, status, times and the actions this state allows.
 */
export function InvoiceRow({
  invoice,
  explorerTemplate,
}: {
  invoice: Invoice;
  explorerTemplate: string | null;
}) {
  const [confirming, setConfirming] = useState<Pending>(null);
  // The status this row first showed: a row that turns paid while on screen lights up once.
  const [firstStatus] = useState(invoice.status);
  const invalidate = () => [qk.invoices];

  const close = () => setConfirming(null);
  const cancel = useDeskMutation({
    mutationFn: () => cancelInvoice(invoice.id),
    invalidate,
    success: () => "Invoice cancelled.",
    onSuccess: close,
  });
  const accept = useDeskMutation({
    mutationFn: () => acceptInvoice(invoice.id),
    invalidate: () => [qk.invoices, qk.deliveries],
    success: () => "Payment confirmed. Shade sends invoice.paid to your server.",
    onSuccess: close,
  });
  const record = useDeskMutation({
    mutationFn: (txid: string) => acceptInvoice(invoice.id, txid),
    invalidate: () => [qk.invoices, qk.deliveries],
    success: () => "Payment recorded. Shade sends invoice.paid to your server.",
    onSuccess: close,
  });
  const reject = useDeskMutation({
    mutationFn: () => rejectInvoice(invoice.id),
    invalidate,
    success: () => "Report rejected. The invoice is open again.",
    onSuccess: close,
  });

  const status = invoiceStatus(invoice);
  const open = invoice.status === "open";
  const reported = invoice.status === "paid_unverified";
  const seen = invoice.detection?.state === "seen";
  // Nothing more can happen to it: its amount steps back.
  const closed = invoice.status === "cancelled" || (invoice.status === "expired" && !seen);
  const justPaid = invoice.status === "paid" && firstStatus !== "paid";
  const payLink = invoice.pay_url && (open || reported) ? invoice.pay_url : null;
  // Not while a payment is being confirmed: Shade already has it. An expired invoice still takes a
  // payment mined within an hour of its expiry.
  const canRecord = (open || invoice.status === "expired") && !seen;
  const hasActions = Boolean(payLink) || reported || canRecord || open;

  return (
    <li className="relative py-5 sm:col-span-2 sm:grid sm:grid-cols-subgrid sm:items-baseline">
      {/* The lit line: a payer's report waits for the merchant's decision. */}
      {reported ? (
        <span
          aria-hidden
          className="absolute inset-y-5 -left-3 w-1 rounded-[1px] bg-glow sm:-left-4"
        />
      ) : null}
      <p
        className={cn(
          "font-display leading-none tabular wrap-anywhere sm:min-w-[6.5rem] sm:text-right",
          amountSize(invoice.amount_zec),
          closed ? "text-muted" : "text-fg",
        )}
      >
        {invoice.amount_zec}
        <span className="ml-1.5 font-mono text-xs font-normal text-faint">ZEC</span>
      </p>

      <div className="mt-3 min-w-0 space-y-3 sm:mt-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
          <p className="min-w-0 font-mono text-sm wrap-anywhere">
            {invoice.memo || <span className="font-sans text-faint">No memo</span>}
          </p>
          <StatusText
            status={status}
            className={justPaid ? "lit rounded-sm px-1 -mx-1" : undefined}
          />
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.7rem] text-faint">
          {invoice.tag ? (
            <span className="inline-flex items-center rounded-[3px] border border-line-strong px-1.5 leading-5 text-muted">
              <span className="sr-only">Label </span>
              {invoice.tag}
            </span>
          ) : null}
          <span>Created {formatDateTime(invoice.created_at)}</span>
          {open || reported ? <ExpiryCountdown expiresAt={invoice.expires_at} /> : null}
          {invoice.paid_at ? <span>Paid {formatDateTime(invoice.paid_at)}</span> : null}
        </p>

        {reported && invoice.claimed_txid ? (
          <Callout>
            <p className="text-sm text-warn">
              The payer sent this transaction id. Check your wallet for {invoice.amount_zec} ZEC
              before you confirm.
            </p>
            <Txid
              txid={invoice.claimed_txid}
              label="Reported transaction"
              explorerTemplate={explorerTemplate}
            />
          </Callout>
        ) : null}
        {invoice.status === "paid" && invoice.txid ? (
          <Txid txid={invoice.txid} label="Transaction" explorerTemplate={explorerTemplate} />
        ) : null}
        {/* Also on an expired invoice: a payment mined before expiry still settles it. */}
        {seen && invoice.detection ? (
          <Txid
            txid={invoice.detection.txid}
            label="Seen transaction"
            explorerTemplate={explorerTemplate}
          />
        ) : null}
        {/* Keyed on the detection alone: the invoice is already cancelled or expired by then. */}
        {invoice.detection?.state === "late" ? (
          <Callout>
            <p className="text-sm text-warn">
              A payment arrived after this invoice {closedPhrase(invoice.status)}. Shade did not
              mark it paid. Refund or fulfil it from your wallet.
            </p>
            <Txid
              txid={invoice.detection.txid}
              label="Late payment"
              explorerTemplate={explorerTemplate}
            />
          </Callout>
        ) : null}
        {/* The settled txid itself is the scanner catching up on a confirmed invoice, not a new payment. */}
        {invoice.status === "paid" &&
        invoice.detection?.state === "settled_after" &&
        invoice.detection.txid !== invoice.txid ? (
          <Callout>
            <p className="text-sm text-warn">
              Another payment matched this invoice after it was paid. Check your wallet. If it is a
              second payment, refund it from there.
            </p>
            <Txid
              txid={invoice.detection.txid}
              label="Later payment"
              explorerTemplate={explorerTemplate}
            />
          </Callout>
        ) : null}

        {/* Groups wrap as units: the payer's report first, then the pay link, then changes. */}
        {hasActions ? (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            {reported ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => setConfirming("accept")}>Confirm</Button>
                <Button variant="ghost" onClick={() => setConfirming("reject")}>
                  Reject
                </Button>
              </div>
            ) : null}
            {payLink ? (
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton value={payLink} label="Copy pay link" />
                <a
                  href={payLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass("quiet", "px-2.5")}
                >
                  Open pay page
                  <ExternalLink aria-hidden size={14} strokeWidth={1.75} />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>
            ) : null}
            {canRecord || open ? (
              <div className="flex flex-wrap items-center gap-2">
                {canRecord ? (
                  <Button variant="ghost" onClick={() => setConfirming("record")}>
                    Record payment
                  </Button>
                ) : null}
                {open ? (
                  <Button
                    variant="quiet"
                    className="px-2.5"
                    onClick={() => setConfirming("cancel")}
                  >
                    Cancel invoice
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {confirming === null ? (
          <>
            <ActionStatus mutation={cancel} successText="Cancelled." />
            <ActionStatus mutation={accept} successText="Confirmed. Marked paid." />
            <ActionStatus mutation={record} successText="Recorded. Marked paid." />
            <ActionStatus mutation={reject} successText="Rejected. Open again." />
          </>
        ) : null}

        {confirming === "accept" ? (
          <ConfirmDialog
            open
            title="Confirm this payment?"
            confirmLabel="Confirm payment"
            pendingLabel="Confirming…"
            cancelLabel="Not yet"
            tone="primary"
            pending={accept.isPending}
            error={accept.isError ? errorMessage(accept.error) : null}
            onConfirm={() => accept.mutate()}
            onCancel={() => {
              accept.reset();
              close();
            }}
          >
            <p>Confirm only if your wallet shows this payment:</p>
            <WalletCheck invoice={invoice} />
            <p>
              Shade checks that the transaction is mined. Then it marks the invoice paid and sends
              invoice.paid to your server, which fulfils the order. You cannot undo this.
            </p>
          </ConfirmDialog>
        ) : null}
        {confirming === "record" ? (
          <RecordPaymentDialog
            invoice={invoice}
            pending={record.isPending}
            error={record.isError ? record.error : null}
            onRecord={(txid) => record.mutate(txid)}
            onCancel={() => {
              record.reset();
              close();
            }}
          />
        ) : null}
        {confirming === "reject" ? (
          <ConfirmDialog
            open
            title="Reject this report?"
            confirmLabel="Reject report"
            pendingLabel="Rejecting…"
            pending={reject.isPending}
            error={reject.isError ? errorMessage(reject.error) : null}
            onConfirm={() => reject.mutate()}
            onCancel={() => {
              reject.reset();
              close();
            }}
          >
            <p>Shade clears the transaction id the payer sent and opens the invoice again.</p>
            <p>The payer can still pay it until it expires.</p>
          </ConfirmDialog>
        ) : null}
        {confirming === "cancel" ? (
          <ConfirmDialog
            open
            title="Cancel this invoice?"
            confirmLabel="Cancel invoice"
            pendingLabel="Cancelling…"
            pending={cancel.isPending}
            error={cancel.isError ? errorMessage(cancel.error) : null}
            onConfirm={() => cancel.mutate()}
            onCancel={() => {
              cancel.reset();
              close();
            }}
          >
            <p>The pay page will say the invoice is cancelled. You cannot reopen it.</p>
            <p>
              If someone pays it anyway, the ZEC still reaches your wallet. Refund it from there.
            </p>
          </ConfirmDialog>
        ) : null}
      </div>
    </li>
  );
}
