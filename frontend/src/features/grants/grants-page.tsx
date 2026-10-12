import { COPY, grantDialogCopy } from "@shade/contract";
import type { Grant } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, errorMessage } from "@/api/client";
import { LIST_CAP, createGrant, grantsQuery, revokeGrant } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, Select, TextInput } from "@/components/field";
import { EmptyState, ErrorState, LoadingState, RefreshError } from "@/components/states";
import { StatusText } from "@/components/status-text";
import { ActionStatus } from "@/features/desk/action-status";
import { useRevealSecret } from "@/features/desk/desk-context";
import { DeskPage, Panel, SplitLayout } from "@/features/desk/desk-page";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { grantState } from "@/lib/status";
import { checkTag, isReservedLabel, normalizeTag } from "@/lib/validation";

/** PRD §12.4 needs a 10-minute grant; longer than one day asks for a fresh sign-in. */
const DURATIONS = [600, 86_400, 604_800, 2_592_000] as const;

function GrantForm() {
  const reveal = useRevealSecret();
  const [scopeKind, setScopeKind] = useState<"all" | "tag">("all");
  const [tag, setTag] = useState("");
  const [duration, setDuration] = useState<number>(604_800);
  const [tagError, setTagError] = useState<string | null>(null);
  const tagRef = useRef<HTMLInputElement>(null);

  const scope = scopeKind === "all" ? "all" : normalizeTag(tag);
  // In label mode, "all" would silently widen the grant to every receipt.
  const labelPending = scopeKind === "tag" && (!scope || isReservedLabel(scope));
  const durationText = formatDuration(duration);

  const mutation = useDeskMutation({
    mutationFn: createGrant,
    invalidate: () => [qk.grants],
    success: () => "Grant created. Copy the view link now; Shade shows it once.",
    onSuccess: (grant, vars) => {
      setTag("");
      reveal({
        title: "Share this view link",
        intro: (
          <>
            {grantDialogCopy(formatDuration(vars.expires_in_sec), grant.scope)} It ends{" "}
            {formatDateTime(grant.expires_at)}. Shade shows this link once.
          </>
        ),
        // The link alone opens the view; the bare token is useless to an auditor and easy to
        // send instead of the link.
        items: [{ label: "View link", value: grant.view_url, block: true }],
        notes: [
          "Anyone with the link sees the receipts in scope until it expires or you revoke it. Send it privately.",
          COPY.grantNote,
        ],
      });
    },
  });
  // The server's wording says "tag"; the form calls it a label.
  const serverScopeError =
    mutation.error instanceof ApiError && mutation.error.code === "BAD_SCOPE"
      ? "Use a label you put on invoices, like payroll."
      : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (scopeKind === "tag") {
      const error = isReservedLabel(tag)
        ? '"all" is reserved. Choose All invoices and jar charges instead.'
        : normalizeTag(tag) === ""
          ? "Enter the label to share."
          : checkTag(tag);
      setTagError(error);
      if (error) {
        tagRef.current?.focus();
        return;
      }
    }
    mutation.mutate({ scope, expires_in_sec: duration });
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Scope</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="radio"
            name="grant-scope"
            className="size-5 accent-paper"
            checked={scopeKind === "all"}
            onChange={() => setScopeKind("all")}
          />
          All invoices and jar charges
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="radio"
            name="grant-scope"
            className="size-5 accent-paper"
            checked={scopeKind === "tag"}
            onChange={() => setScopeKind("tag")}
          />
          Only invoices with a label
        </label>
      </fieldset>
      {scopeKind === "tag" ? (
        <Field
          label="Label"
          error={tagError ?? serverScopeError}
          hint="The label you put on invoices, like payroll."
        >
          {(control) => (
            <TextInput
              {...control}
              ref={tagRef}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="payroll"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Field label="Share for">
        {(control) => (
          <Select
            {...control}
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            {DURATIONS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {formatDuration(seconds)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <p className="border-l-2 border-paper pl-3 text-sm">
        {grantDialogCopy(durationText, labelPending ? "your label" : scope)}
      </p>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Creating…" : "Create grant"}
      </Button>
      {serverScopeError ? null : <ActionStatus mutation={mutation} />}
    </form>
  );
}

function GrantRow({ grant, now }: { grant: Grant; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useDeskMutation({
    mutationFn: () => revokeGrant(grant.id),
    invalidate: () => [qk.grants],
    success: () => "Grant revoked. The view link has gone dark.",
    onSuccess: () => setConfirming(false),
  });
  const state = grantState(grant.state);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-5">
      <div className="min-w-0 space-y-1">
        <p className="font-medium wrap-anywhere">
          {grant.scope === "all" ? "All invoices" : `Invoices labelled ${grant.scope}`}
        </p>
        <p className="text-sm text-faint">
          {grant.state === "active"
            ? `Ends ${formatRelative(grant.expires_at, now)}`
            : grant.state === "revoked" && grant.revoked_at
              ? `Revoked ${formatDateTime(grant.revoked_at)}`
              : `Ended ${formatDateTime(grant.expires_at)}`}
          {" · "}
          {grant.last_viewed_at
            ? `Last opened ${formatRelative(grant.last_viewed_at, now)}`
            : "Not opened yet"}
        </p>
        {confirming ? null : <ActionStatus mutation={mutation} successText="Revoked." />}
      </div>
      <div className="flex items-center gap-3">
        <StatusText status={state} />
        {grant.state === "active" ? (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <ConfirmDialog
          open
          title="Revoke this grant?"
          confirmLabel="Revoke"
          pendingLabel="Revoking…"
          pending={mutation.isPending}
          error={mutation.isError ? errorMessage(mutation.error) : null}
          onConfirm={() => mutation.mutate()}
          onCancel={() => {
            mutation.reset();
            setConfirming(false);
          }}
        >
          <p>The view link and the receipt download stop working right away.</p>
          <p>{COPY.grantNote}</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

export function GrantsPage() {
  const grants = useQuery(grantsQuery);
  const now = useNow(30_000);
  return (
    <DeskPage
      title="Grants"
      intro="A grant is a time-boxed link to your receipts for an accountant or auditor. It is not your viewing key."
    >
      <SplitLayout
        aside={
          <Panel title="New grant">
            <GrantForm />
          </Panel>
        }
      >
        {grants.data && grants.isRefetchError ? (
          <RefreshError error={grants.error} onRetry={() => void grants.refetch()} />
        ) : null}
        {grants.data === undefined ? (
          grants.isError ? (
            <ErrorState error={grants.error} onRetry={() => void grants.refetch()} />
          ) : (
            <LoadingState label="Loading grants…" />
          )
        ) : grants.data.length === 0 ? (
          <EmptyState title="No grants yet.">
            Create one to share a read-only list of paid receipts.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line border-y border-line">
              {grants.data.map((grant) => (
                <GrantRow key={grant.id} grant={grant} now={now} />
              ))}
            </ul>
            {grants.data.length >= LIST_CAP ? (
              <p className="mt-4 text-sm text-muted">
                Showing every active grant, then the newest ended ones ({LIST_CAP} in all).
              </p>
            ) : null}
          </>
        )}
      </SplitLayout>
    </DeskPage>
  );
}
