import { COPY, grantDialogCopy } from "@shade/contract";
import type { Grant } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError, errorMessage } from "@/api/client";
import { LIST_CAP, createGrant, grantsQuery, meQuery, revokeGrant } from "@/api/desk";
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
import { cn } from "@/lib/cn";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { grantState } from "@/lib/status";
import { checkTag, isReservedLabel, normalizeTag } from "@/lib/validation";

/** PRD §12.4 needs a 10-minute grant; longer than one day asks for a fresh sign-in. */
const DURATIONS = [600, 86_400, 604_800, 2_592_000] as const;

const EYEBROW = "font-mono text-[0.7rem] uppercase tracking-[0.14em] text-faint";

/** One scope choice: the whole row is the radio's label, so it is one large target. */
function ScopeOption({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm border px-3 py-2.5 text-sm transition-colors",
        checked
          ? "border-accent bg-accent/[0.06] font-medium text-fg"
          : "border-line-strong text-muted hover:border-fg/50 hover:text-fg",
      )}
    >
      <input
        type="radio"
        name="grant-scope"
        className="size-5 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        onChange={onChange}
      />
      {children}
    </label>
  );
}

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
    success: () => "Grant created. Copy the view link now. Shade shows it once.",
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
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Scope</legend>
        <ScopeOption checked={scopeKind === "all"} onChange={() => setScopeKind("all")}>
          All invoices and jar charges
        </ScopeOption>
        <ScopeOption checked={scopeKind === "tag"} onChange={() => setScopeKind("tag")}>
          Only invoices with a label
        </ScopeOption>
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
              className="font-mono"
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
      {/* The grant as the auditor's side will read it: on paper, like the receipt view. */}
      <div className="theme-paper relative overflow-hidden rounded-sm py-3.5 pr-10 pl-4">
        <span
          aria-hidden
          className="blinds pointer-events-none absolute inset-y-0 right-0 w-6 opacity-60 [--slat:0.3rem]"
        />
        <p className={EYEBROW}>Preview</p>
        <p className="mt-1.5 text-sm text-fg">
          {grantDialogCopy(durationText, labelPending ? "your label" : scope)}
        </p>
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Creating…" : "Create grant"}
      </Button>
      {serverScopeError ? null : <ActionStatus mutation={mutation} />}
    </form>
  );
}

/** How many slats the time-left fuse has. */
const FUSE_SLATS = 24;

/**
 * Time left on an active grant: lit slats go dark from the right as it runs out. Decorative; the
 * "Ends in" line says the same in words.
 */
function TimeLeft({ grant, now }: { grant: Grant; now: number }) {
  const start = new Date(grant.created_at).getTime();
  const end = new Date(grant.expires_at).getTime();
  const share = end > start ? Math.min(1, Math.max(0, (end - now) / (end - start))) : 0;
  const lit = Math.ceil(share * FUSE_SLATS);
  return (
    <div aria-hidden className="flex max-w-64 gap-[3px]">
      {Array.from({ length: FUSE_SLATS }, (_, index) => (
        <span
          key={index}
          className={cn("h-1.5 flex-1 rounded-[1px]", index < lit ? "bg-glow" : "bg-line")}
        />
      ))}
    </div>
  );
}

function GrantRow({ grant, now }: { grant: Grant; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useDeskMutation({
    mutationFn: () => revokeGrant(grant.id),
    invalidate: () => [qk.grants],
    success: () => "Grant revoked. The view link and the download stop working.",
    onSuccess: () => setConfirming(false),
  });
  const state = grantState(grant.state);
  const active = grant.state === "active";
  return (
    <li className="grid gap-x-6 gap-y-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0 space-y-2.5">
        <p
          className={cn(
            "font-display text-2xl leading-tight wrap-anywhere",
            active ? "text-fg" : "text-muted",
          )}
        >
          {grant.scope === "all" ? (
            "All invoices and jar charges"
          ) : (
            <>
              Invoices labelled{" "}
              <span className="ml-0.5 inline-block rounded-[3px] border border-line-strong px-1.5 align-middle font-mono text-sm leading-6 font-normal text-muted">
                {grant.scope}
              </span>
            </>
          )}
        </p>
        {active ? <TimeLeft grant={grant} now={now} /> : null}
        <p className="font-mono text-[0.7rem] text-faint">
          {active
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
      </div>
      <div className="flex items-center gap-3 sm:justify-end">
        <StatusText status={state} />
        {active ? (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function GrantsPage() {
  const me = useQuery(meQuery);
  const grants = useQuery(grantsQuery);
  const now = useNow(30_000);
  const network = me.data?.merchant.network;
  const activeCount = grants.data?.filter((grant) => grant.state === "active").length ?? 0;
  const endedCount = (grants.data?.length ?? 0) - activeCount;
  return (
    <DeskPage
      title="Grants"
      intro="A grant is a link that shows your receipts to an accountant or auditor for a set time. It does not share your viewing key."
    >
      <SplitLayout
        aside={
          <Panel title="New grant">
            <GrantForm />
          </Panel>
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line-strong pb-4">
          <h2 className="font-display text-3xl leading-none">
            {network === "mainnet" ? "Mainnet grants" : "Testnet grants"}
          </h2>
          {grants.data?.length ? (
            <p className={EYEBROW}>
              {activeCount} active · {endedCount} ended
            </p>
          ) : null}
        </div>
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
            Create one to share a read-only list of your paid receipts.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line border-b border-line">
              {grants.data.map((grant) => (
                <GrantRow key={grant.id} grant={grant} now={now} />
              ))}
            </ul>
            {grants.data.length >= LIST_CAP ? (
              <p className="mt-4 text-sm text-muted">
                Shade lists every active grant, then the newest ended ones, up to {LIST_CAP} grants.
              </p>
            ) : null}
          </>
        )}
      </SplitLayout>
    </DeskPage>
  );
}
