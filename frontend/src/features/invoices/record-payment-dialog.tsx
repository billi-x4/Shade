/**
 * Record a payment the merchant found in their own wallet on an open invoice (desk Confirm with a
 * txid, `merchant_accept`). For when detection is off, or cannot read the chain yet, and the payer
 * never pasted a transaction id. Shade checks the transaction like a payer's paste, then waits for
 * it to be mined; it cannot see the amount or the memo, so the merchant checks those.
 */
import type { Invoice } from "@shade/contract";
import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { errorMessage } from "@/api/client";
import { Button } from "@/components/button";
import { Field, TextInput } from "@/components/field";
import { Modal } from "@/components/modal";
import { normalizeTxid } from "@/lib/validation";

const FORMAT =
  "A transaction id is 64 characters, digits and the letters a to f. Copy it again from your wallet.";

const EYEBROW = "font-mono text-[0.7rem] uppercase tracking-[0.14em] text-faint";

/**
 * What the merchant's wallet must show before they settle an invoice by hand: the amount and the
 * exact memo the payer's wallet wrote on chain. Shade cannot see either, so the merchant checks.
 */
export function WalletCheck({ invoice }: { invoice: Pick<Invoice, "amount_zec" | "chain_memo"> }) {
  return (
    <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3 rounded-sm border border-line-strong bg-bg p-4">
      <dt className={EYEBROW}>Amount</dt>
      <dd className="font-display text-3xl leading-none text-fg tabular">
        {invoice.amount_zec}
        <span className="ml-1.5 font-mono text-xs font-normal text-faint">ZEC</span>
      </dd>
      <dt className={EYEBROW}>Memo</dt>
      <dd className="font-mono text-sm text-fg wrap-anywhere">{invoice.chain_memo}</dd>
    </dl>
  );
}

export function RecordPaymentDialog({
  invoice,
  pending,
  error,
  onRecord,
  onCancel,
}: {
  invoice: Invoice;
  pending: boolean;
  error: unknown;
  onRecord: (txid: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [txid, setTxid] = useState("");
  const [formatError, setFormatError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const value = normalizeTxid(txid);
    if (!value) {
      setFormatError(FORMAT);
      inputRef.current?.focus();
      return;
    }
    setFormatError(null);
    onRecord(value);
  }

  const shown = formatError ?? (error ? errorMessage(error) : null);
  return (
    <Modal
      open
      onDismiss={pending ? undefined : onCancel}
      labelledBy={titleId}
      describedBy={bodyId}
      initialFocus={inputRef}
    >
      <form className="space-y-5 p-6" onSubmit={onSubmit} noValidate>
        <h2 id={titleId} className="font-display text-2xl leading-tight">
          Record a payment from your wallet
        </h2>
        <div id={bodyId} className="space-y-3 text-sm text-muted">
          <p>Record it only if your wallet shows this payment:</p>
          <WalletCheck invoice={invoice} />
          <p>
            Shade then checks that the transaction is shielded, newer than this invoice and mined.
            It marks the invoice paid and sends invoice.paid to your server. You cannot undo this.
          </p>
          {invoice.status === "expired" ? (
            <p className="text-warn">
              This invoice has expired. Shade records the payment only if it was mined within an
              hour after the invoice expired.
            </p>
          ) : null}
        </div>
        <Field label="Transaction id" error={shown}>
          {(control) => (
            <TextInput
              {...control}
              ref={inputRef}
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
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            onClick={pending ? undefined : onCancel}
            aria-disabled={pending || undefined}
          >
            Not yet
          </Button>
          <Button
            type="submit"
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
          >
            {pending ? "Recording…" : "Mark paid"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
