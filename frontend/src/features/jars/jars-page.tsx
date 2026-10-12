import { COPY, jarSummaryCopy } from "@shade/contract";
import type { Jar, JarCharge } from "@shade/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, errorMessage } from "@/api/client";
import {
  cancelJarCharge,
  createApiKey,
  createJar,
  jarChargesQuery,
  jarsQuery,
  LIST_CAP,
  killJar,
  meQuery,
} from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Field, TextInput } from "@/components/field";
import { EmptyState, ErrorState, LoadingState, RefreshError } from "@/components/states";
import { StatusText } from "@/components/status-text";
import { ActionStatus } from "@/features/desk/action-status";
import { useRevealSecret } from "@/features/desk/desk-context";
import { DeskPage, Panel, SplitLayout } from "@/features/desk/desk-page";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { formatDateTime } from "@/lib/format";
import { checkAmount, checkLabel, zecToZat } from "@/lib/validation";

/**
 * The Jars tab refreshes every 3 s while the page is visible. Only the jar list polls; an open
 * jar's charges load once and refetch when its spend or charge count moves (not on window focus),
 * and a killed jar's charges load only when opened. So the poll stays one request however many
 * jars there are, and a page of 200 jars does not burst 200 requests (the desk is rate limited
 * per merchant).
 */
const JAR_POLL_MS = 3_000;

/**
 * A copyable first charge for the agent's own code. The key stays in $SHADE_AGENT_KEY: the shown
 * command never contains it.
 */
function chargeCommand(jarId: string): string {
  return [
    `curl -X POST ${window.location.origin}/v1/jars/${encodeURIComponent(jarId)}/charge \\`,
    `  -H "Authorization: Bearer $SHADE_AGENT_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: call-1" \\`,
    `  -d '{"amount_zec":"0.002","memo":"api:search"}'`,
  ].join("\n");
}

function JarForm() {
  const [cap, setCap] = useState("");
  const [label, setLabel] = useState("");
  const [errors, setErrors] = useState<{ cap?: string; label?: string }>({});
  const capRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const mutation = useDeskMutation({
    mutationFn: createJar,
    invalidate: () => [qk.jars],
    success: (jar) => `Jar ${jar.label} created with a cap of ${jar.cap_zec} ZEC.`,
    onSuccess: () => {
      setCap("");
      setLabel("");
    },
  });
  const serverError = mutation.error instanceof ApiError ? mutation.error : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = { cap: checkAmount(cap) ?? undefined, label: checkLabel(label) ?? undefined };
    setErrors(next);
    if (next.cap) return capRef.current?.focus();
    if (next.label) return labelRef.current?.focus();
    mutation.mutate({ cap_zec: cap.trim(), label: label.trim() });
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <p className="text-sm text-muted">{COPY.jarIsLimit}</p>
      <Field
        label="Cap (ZEC)"
        error={errors.cap ?? (serverError?.code === "BAD_AMOUNT" ? serverError.message : null)}
      >
        {(control) => (
          <TextInput
            {...control}
            ref={capRef}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.006"
            value={cap}
            onChange={(event) => setCap(event.target.value)}
          />
        )}
      </Field>
      <Field
        label="Label"
        hint="Name it after the agent that spends from it."
        error={errors.label ?? (serverError?.code === "BAD_LABEL" ? serverError.message : null)}
      >
        {(control) => (
          <TextInput
            {...control}
            ref={labelRef}
            autoComplete="off"
            placeholder="research-agent"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Creating…" : "Create jar"}
      </Button>
      {serverError?.code === "BAD_AMOUNT" || serverError?.code === "BAD_LABEL" ? null : (
        <ActionStatus mutation={mutation} successText="Jar created." />
      )}
    </form>
  );
}

function ChargeRow({ jar, charge }: { jar: Jar; charge: JarCharge }) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useDeskMutation({
    mutationFn: () => cancelJarCharge(jar.id, charge.id),
    invalidate: () => [qk.jars, qk.jarCharges(jar.id)],
    success: () => `Charge of ${charge.amount_zec} ZEC cancelled. The allowance is back.`,
    onSuccess: () => setConfirming(false),
  });
  const cancelled = charge.status === "cancelled";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm">
      <div className="min-w-0 space-y-0.5">
        <p className={cancelled ? "text-faint tabular line-through" : "tabular"}>
          {charge.amount_zec} ZEC
          {charge.memo ? <span className="wrap-anywhere text-muted"> · {charge.memo}</span> : null}
        </p>
        <p className="text-faint">
          {formatDateTime(charge.created_at)}
          {cancelled ? " · cancelled" : null}
        </p>
      </div>
      {!cancelled && jar.status === "open" ? (
        <Button variant="quiet" onClick={() => setConfirming(true)}>
          Cancel charge
        </Button>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          open
          title="Cancel this charge?"
          confirmLabel="Cancel charge"
          pendingLabel="Cancelling…"
          cancelLabel="Keep it"
          pending={mutation.isPending}
          error={mutation.isError ? errorMessage(mutation.error) : null}
          onConfirm={() => mutation.mutate()}
          onCancel={() => {
            mutation.reset();
            setConfirming(false);
          }}
        >
          <p>{charge.amount_zec} ZEC goes back to the jar's allowance.</p>
          <p>No ZEC moves. If the agent already paid someone, settle that in your wallet.</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

function JarCharges({ jar }: { jar: Jar }) {
  // Focus would refetch every stale jar's charges at once; the activity check below covers it.
  const charges = useInfiniteQuery({ ...jarChargesQuery(jar.id), refetchOnWindowFocus: false });
  const { refetch } = charges;
  const activity = `${jar.spent_zec}|${jar.charge_count}`;
  const seen = useRef(activity);
  useEffect(() => {
    if (seen.current === activity) return;
    seen.current = activity;
    void refetch();
  }, [activity, refetch]);
  // Once loaded, a failed poll keeps the rows (and any open dialog) on screen.
  if (charges.data === undefined) {
    return charges.isError ? (
      <ErrorState error={charges.error} onRetry={() => void charges.refetch()} />
    ) : (
      <LoadingState label={`Loading charges for ${jar.label}…`} rows={1} />
    );
  }
  const stale = charges.isRefetchError ? <RefreshError error={charges.error} /> : null;
  const items = charges.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <div className="space-y-2">
        {stale}
        <p className="text-sm text-faint">
          {jar.status === "open"
            ? "No charges yet. Give the agent its key to start."
            : "No charges."}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {stale}
      <ul className="divide-y divide-line">
        {items.map((charge) => (
          <ChargeRow key={charge.id} jar={jar} charge={charge} />
        ))}
      </ul>
      {charges.hasNextPage ? (
        <Button
          variant="ghost"
          onClick={() => void charges.fetchNextPage()}
          disabled={charges.isFetchingNextPage}
        >
          {charges.isFetchingNextPage ? "Loading…" : "Show older charges"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A killed jar changes no more: its charges stay folded away and load only when opened. Always a
 * disclosure, since charge_count leaves out cancelled charges, which the list still shows.
 */
function KilledJarCharges({ jar }: { jar: Jar }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
        Charges · {jar.charge_count}
      </summary>
      {expanded ? <JarCharges jar={jar} /> : null}
    </details>
  );
}

function SpendMeter({ jar }: { jar: Jar }) {
  const cap = zecToZat(jar.cap_zec) ?? 0n;
  const spent = zecToZat(jar.spent_zec) ?? 0n;
  const percent = cap > 0n ? Number((spent * 1000n) / cap) / 10 : 0;
  return (
    <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={
          jar.status === "killed"
            ? "h-full bg-faint"
            : percent >= 100
              ? "h-full bg-warn"
              : "h-full bg-paper"
        }
        style={{ width: `${Math.min(100, percent)}%` }}
      />
    </div>
  );
}

function JarCard({ jar }: { jar: Jar }) {
  const reveal = useRevealSecret();
  const [confirmKill, setConfirmKill] = useState(false);
  const agentKey = useDeskMutation({
    mutationFn: () => createApiKey({ kind: "agent", label: jar.label, jar_id: jar.id }),
    invalidate: () => [qk.apiKeys],
    success: () => "Agent key created. Save it now; Shade shows it once.",
    onSuccess: (key) =>
      reveal({
        title: `Agent key for ${jar.label}`,
        intro: "Shade shows this key once. It can only charge this jar, and only up to the cap.",
        items: [
          { label: "Agent key", value: key.token },
          { label: "Jar id", value: jar.id },
          { label: "Example charge", value: chargeCommand(jar.id), block: true },
        ],
        notes: [
          <>
            Put the key in the <code className="text-fg">SHADE_AGENT_KEY</code> environment variable
            before you run the example. Keep it out of shell history and source control.
          </>,
          <>
            Send a new <code className="text-fg">Idempotency-Key</code> with each paid call. A retry
            with the same key is never charged twice.
          </>,
          <>
            In a checkout of the Shade repository,{" "}
            <code className="text-fg">npm run demo:agent -w @shade/backend -- --jar {jar.id}</code>{" "}
            runs a sample agent (set <code className="text-fg">SHADE_API_URL</code> to{" "}
            {window.location.origin}).
          </>,
          COPY.killNote,
        ],
      }),
  });
  const kill = useDeskMutation({
    mutationFn: () => killJar(jar.id),
    invalidate: () => [qk.jars, qk.jarCharges(jar.id)],
    success: () => `Jar ${jar.label} killed. New charges fail.`,
    onSuccess: () => setConfirmKill(false),
  });

  const open = jar.status === "open";
  const empty = open && (zecToZat(jar.remaining_zec) ?? 0n) === 0n;
  return (
    <li className="space-y-4 rounded-md border border-line-strong bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-serif text-2xl wrap-anywhere">{jar.label}</h3>
        <StatusText
          status={open ? { label: "Open", tone: "ok" } : { label: "Killed", tone: "muted" }}
        />
      </div>
      <div className="space-y-2">
        <p className="tabular">{jarSummaryCopy(jar.cap_zec, jar.spent_zec, jar.remaining_zec)}</p>
        <SpendMeter jar={jar} />
        {open ? null : <p className="text-sm text-muted">{COPY.jarClosed}</p>}
        {empty ? <p className="text-sm text-warn">{COPY.jarEmpty}</p> : null}
        <p className="text-sm text-muted">
          {open ? COPY.killNote : `Killed ${formatDateTime(jar.killed_at ?? jar.created_at)}.`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Jar id</span>
        <code className="wrap-anywhere">{jar.id}</code>
        <CopyButton value={jar.id} label="Copy id" variant="quiet" className="px-2" />
      </div>
      {open ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => agentKey.mutate()} disabled={agentKey.isPending}>
            {agentKey.isPending ? "Creating key…" : "Agent key"}
          </Button>
          <Button variant="danger" onClick={() => setConfirmKill(true)}>
            Kill
          </Button>
        </div>
      ) : null}
      <ActionStatus mutation={agentKey} />
      {confirmKill ? null : <ActionStatus mutation={kill} successText="Killed." />}
      <section className="space-y-2 border-t border-line pt-4">
        {open ? (
          <>
            <h4 className="text-sm font-medium">Charges · {jar.charge_count}</h4>
            <JarCharges jar={jar} />
          </>
        ) : (
          <KilledJarCharges jar={jar} />
        )}
      </section>
      {confirmKill ? (
        <ConfirmDialog
          open
          title={`Kill ${jar.label}?`}
          confirmLabel="Kill jar"
          pendingLabel="Killing…"
          pending={kill.isPending}
          error={kill.isError ? errorMessage(kill.error) : null}
          onConfirm={() => kill.mutate()}
          onCancel={() => {
            kill.reset();
            setConfirmKill(false);
          }}
        >
          <p>{COPY.killNote}</p>
          <p>
            Every charge after this fails with "{COPY.jarClosed}" You cannot reopen a killed jar.
          </p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

export function JarsPage() {
  const me = useQuery(meQuery);
  const jars = useQuery({ ...jarsQuery, refetchInterval: JAR_POLL_MS });
  const network = me.data?.merchant.network ?? "testnet";
  const noAddress = me.data ? !me.data.merchant.receive_addresses[network] : false;

  return (
    <DeskPage
      title="Jars"
      intro="A jar gives an AI agent a spending limit. It can spend up to the cap; the next charge fails closed."
    >
      <SplitLayout
        aside={
          <Panel title="New jar">
            {noAddress ? (
              <div className="space-y-3 text-sm">
                <p className="text-warn">{COPY.noAddress}</p>
                <Link
                  to="/desk/settings/address"
                  className="inline-flex min-h-11 items-center underline underline-offset-4"
                >
                  Add a {network} receive address
                </Link>
              </div>
            ) : (
              <JarForm />
            )}
          </Panel>
        }
      >
        {jars.data && jars.isRefetchError ? <RefreshError error={jars.error} /> : null}
        {jars.data === undefined ? (
          jars.isError ? (
            <ErrorState error={jars.error} onRetry={() => void jars.refetch()} />
          ) : (
            <LoadingState label="Loading jars…" />
          )
        ) : jars.data.length === 0 ? (
          <EmptyState title="No jars yet.">
            Create one, then press Agent key to give an agent its own key for that jar.
          </EmptyState>
        ) : (
          <>
            <ul className="space-y-6">
              {jars.data.map((jar) => (
                <JarCard key={jar.id} jar={jar} />
              ))}
            </ul>
            {jars.data.length >= LIST_CAP ? (
              <p className="mt-4 text-sm text-muted">
                Showing every open jar, then the newest killed ones ({LIST_CAP} in all).
              </p>
            ) : null}
          </>
        )}
      </SplitLayout>
    </DeskPage>
  );
}
