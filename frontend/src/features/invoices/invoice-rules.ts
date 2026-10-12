import {
  checkAmount,
  checkMemo,
  checkTag,
  isReservedLabel,
  RESERVED_LABEL,
} from "@/lib/validation";

/** Invoice lifetimes offered on the desk (API range 60 s .. 7 days). */
export const EXPIRY_PRESETS = [
  { seconds: 600, label: "10 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 86_400, label: "1 day" },
  { seconds: 604_800, label: "7 days" },
] as const;

export type InvoiceField = "amount" | "memo" | "tag";
export type InvoiceErrors = Partial<Record<InvoiceField, string>>;

/** Backend error codes that belong to one form field. */
export const SERVER_FIELD: Partial<Record<string, InvoiceField>> = {
  BAD_AMOUNT: "amount",
  BAD_MEMO: "memo",
  BAD_TAG: "tag",
};

export function validateInvoice(values: {
  amount: string;
  memo: string;
  tag: string;
}): InvoiceErrors {
  const errors: InvoiceErrors = {};
  const amount = checkAmount(values.amount);
  if (amount) errors.amount = amount;
  const memo = checkMemo(values.memo);
  if (memo) errors.memo = memo;
  const tag = isReservedLabel(values.tag)
    ? `"${RESERVED_LABEL}" is reserved. Pick another label.`
    : checkTag(values.tag);
  if (tag) errors.tag = tag;
  return errors;
}
