import type { Invoice } from "@shade/contract";
import { useState } from "react";
import { errorMessage } from "@/api/client";
import { acceptInvoice, cancelInvoice, rejectInvoice } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { ExpiryCountdown } from "@/components/countdown";
import { StatusText } from "@/components/status-text";
import { Txid } from "@/components/txid";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { RecordPaymentDialog } from "@/features/invoices/record-payment-dialog";
import { formatDateTime } from "@/lib/format";
import { invoiceStatus } from "@/lib/status";

type Pending = "cancel" | "accept" | "reject" | "record" | null;

function closedPhrase(status: Invoice["status"]): string {
  if (status === "cancelled") return "was cancelled";
  if (status === "expired") return "expired";
  return "closed";
}

export function InvoiceRow({
  invoice,
  explorerTemplate,
}: {
  invoice: Invoice;
  explorerTemplate: string | null;
}) {
  const [confirming, setConfirming] = useState<Pending>(null);
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
    success: () => "Payment confirmed. Your server gets the paid webhook.",
    onSuccess: close,
  });
  const record = useDeskMutation({
    mutationFn: (txid: string) => acceptInvoice(invoice.id, txid),
    invalidate: () => [qk.invoices, qk.deliveries],
    success: () => "Payment recorded. Your server gets the paid webhook.",
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

  return (
    <li className="space-y-3 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-serif text-3xl tabular">
          {invoice.amount_zec} <span className="font-sans text-base text-muted">ZEC</span>
        </p>
        <StatusText status={status} />
      </div>
      <div className="space-y-1 text-sm">
        <p className="wrap-anywhere">
          {invoice.memo || <span className="text-faint">No memo</span>}
        </p>
        <p className="flex flex-wrap gap-x-3 text-faint">
          {invoice.tag ? <span>Label {invoice.tag}</span> : null}
          <span>Created {formatDateTime(invoice.created_at)}</span>
          {open || reported ? <ExpiryCountdown expiresAt={invoice.expires_at} /> : null}
          {invoice.paid_at ? <span>Paid {formatDateTime(invoice.paid_at)}</span> : null}
        </p>
      </div>

      {reported && invoice.claimed_txid ? (
        <div className="space-y-2 rounded-sm border border-warn/40 p-3">
          <p className="text-sm text-warn">
            A payer says they paid. Check your wallet for {invoice.amount_zec} ZEC before you
            confirm.
          </p>
          <Txid
            txid={invoice.claimed_txid}
            label="Reported transaction"
            explorerTemplate={explorerTemplate}
          />
        </div>
      ) : null}
      {invoice.status === "paid" && invoice.txid ? (
        <Txid txid={invoice.txid} label="Transaction" explorerTemplate={explorerTemplate} />
      ) : null}
      {/* Also on an expired invoice: a payment mined before expiry still settles it. */}
      {invoice.detection?.state === "seen" ? (
        <Txid
          txid={invoice.detection.txid}
          label="Seen transaction"
          explorerTemplate={explorerTemplate}
        />
      ) : null}
      {/* Keyed on the detection alone: the invoice is already cancelled or expired by then. */}
      {invoice.detection?.state === "late" ? (
        <div className="space-y-2 rounded-sm border border-warn/40 p-3">
          <p className="text-sm text-warn">
            A payment arrived after this invoice {closedPhrase(invoice.status)}. Shade did not mark
            it paid. Refund or fulfil it from your wallet.
          </p>
          <Txid
            txid={invoice.detection.txid}
            label="Late payment"
            explorerTemplate={explorerTemplate}
          />
        </div>
      ) : null}
      {/* The settled txid itself is the scanner catching up on a confirmed invoice, not a new payment. */}
      {invoice.status === "paid" &&
      invoice.detection?.state === "settled_after" &&
      invoice.detection.txid !== invoice.txid ? (
        <div className="space-y-2 rounded-sm border border-warn/40 p-3">
          <p className="text-sm text-warn">
            Another payment matched this invoice after it was already paid. Check your wallet; if it
            is a second payment, refund it from there.
          </p>
          <Txid
            txid={invoice.detection.txid}
            label="Later payment"
            explorerTemplate={explorerTemplate}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {invoice.pay_url && (open || reported) ? (
          <>
            <CopyButton value={invoice.pay_url} label="Copy pay link" />
            <a
              href={invoice.pay_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center px-2 text-sm text-muted underline underline-offset-4 hover:text-fg"
            >
              Open pay page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        ) : null}
        {reported ? (
          <>
            <Button onClick={() => setConfirming("accept")}>Confirm</Button>
            <Button variant="ghost" onClick={() => setConfirming("reject")}>
              Reject
            </Button>
          </>
        ) : null}
        {/* Not while a payment is being confirmed: Shade already has it. An expired invoice still
            takes a payment mined within an hour of its expiry. */}
        {(open || invoice.status === "expired") && invoice.detection?.state !== "seen" ? (
          <Button variant="ghost" onClick={() => setConfirming("record")}>
            Record payment
          </Button>
        ) : null}
        {open ? (
          <Button variant="quiet" onClick={() => setConfirming("cancel")}>
            Cancel invoice
          </Button>
        ) : null}
      </div>
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
          <p>
            Confirm only if your wallet shows {invoice.amount_zec} ZEC with the memo{" "}
            <span className="wrap-anywhere text-fg">“{invoice.chain_memo}”</span>.
          </p>
          <p>
            Shade checks the transaction is mined, marks the invoice paid and tells your server to
            fulfil the order. This cannot be undone.
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
          <p>The invoice goes back to open and the reported transaction id is cleared.</p>
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
          <p>The pay page will say it is cancelled. A cancelled invoice cannot be reopened.</p>
          <p>If someone pays it anyway, the ZEC still reaches your wallet; refund it from there.</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}
