import { COPY } from "@shade/contract";
import type { Invoice } from "@shade/contract";
import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError } from "@/api/client";
import { createInvoice } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { Field, Select, TextInput } from "@/components/field";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import {
  EXPIRY_PRESETS,
  SERVER_FIELD,
  validateInvoice,
  type InvoiceErrors,
  type InvoiceField,
} from "@/features/invoices/invoice-rules";
import { MERCHANT_MEMO_MAX_BYTES, normalizeTag, utf8Bytes } from "@/lib/validation";

/**
 * New invoice. `noAddress` replaces the form with the honest reason it cannot be used yet, plus a
 * route to the fix (`addressLink`).
 */
export function InvoiceForm({
  noAddress,
  addressLink,
}: {
  noAddress: boolean;
  addressLink?: ReactNode;
}) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [tag, setTag] = useState("");
  const [expiry, setExpiry] = useState(3600);
  const [errors, setErrors] = useState<InvoiceErrors>({});
  const [created, setCreated] = useState<Invoice | null>(null);
  const refs = {
    amount: useRef<HTMLInputElement>(null),
    memo: useRef<HTMLInputElement>(null),
    tag: useRef<HTMLInputElement>(null),
  };

  const mutation = useDeskMutation({
    mutationFn: createInvoice,
    invalidate: () => [qk.invoices],
    success: (invoice) => `Invoice for ${invoice.amount_zec} ZEC created.`,
    onSuccess: (invoice) => {
      setCreated(invoice);
      setAmount("");
      setMemo("");
      setTag("");
      setErrors({});
    },
  });

  const serverField =
    mutation.error instanceof ApiError ? SERVER_FIELD[mutation.error.code] : undefined;
  const fieldError = (name: InvoiceField) =>
    errors[name] ??
    (serverField === name && mutation.error instanceof ApiError ? mutation.error.message : null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = validateInvoice({ amount, memo, tag });
    setErrors(next);
    const first = (["amount", "memo", "tag"] as const).find((name) => next[name]);
    if (first) {
      refs[first].current?.focus();
      return;
    }
    setCreated(null);
    mutation.mutate({
      amount_zec: amount.trim(),
      memo,
      tag: normalizeTag(tag) || undefined,
      expires_in_sec: expiry,
    });
  }

  if (noAddress) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-warn">{COPY.noAddress}</p>
        {addressLink}
      </div>
    );
  }

  const memoBytes = utf8Bytes(memo);
  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <Field label="Amount (ZEC)" error={fieldError("amount")}>
        {(control) => (
          <TextInput
            {...control}
            ref={refs.amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        )}
      </Field>
      <Field
        label="Memo"
        hint="The payer's wallet writes it on chain, with a short Shade reference added."
        error={fieldError("memo")}
        aside={
          <span
            className={
              memoBytes > MERCHANT_MEMO_MAX_BYTES
                ? "text-xs text-bad tabular"
                : "text-xs text-faint tabular"
            }
          >
            {memoBytes}/{MERCHANT_MEMO_MAX_BYTES} bytes
          </span>
        }
      >
        {(control) => (
          <TextInput
            {...control}
            ref={refs.memo}
            autoComplete="off"
            placeholder="Order 1042"
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
          />
        )}
      </Field>
      <Field
        label="Label (for grants)"
        hint="Optional. Grants can share only invoices with this label, like payroll."
        error={fieldError("tag")}
      >
        {(control) => (
          <TextInput
            {...control}
            ref={refs.tag}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="payroll"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          />
        )}
      </Field>
      <Field label="Expires after">
        {(control) => (
          <Select
            {...control}
            value={expiry}
            onChange={(event) => setExpiry(Number(event.target.value))}
          >
            {EXPIRY_PRESETS.map((preset) => (
              <option key={preset.seconds} value={preset.seconds}>
                {preset.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Creating…" : "Create invoice"}
      </Button>
      {serverField ? null : <ActionStatus mutation={mutation} />}
      {created?.pay_url ? (
        <div className="space-y-3 border-t border-line pt-4 text-sm">
          <p className="text-ok">
            Invoice for {created.amount_zec} ZEC created. Send the payer this link.
          </p>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={created.pay_url} label="Copy pay link" />
            <a
              href={created.pay_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center px-2 text-muted underline underline-offset-4 hover:text-fg"
            >
              Open pay page
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      ) : null}
    </form>
  );
}
