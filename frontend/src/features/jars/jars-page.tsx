import { COPY, jarSummaryCopy } from "@shade/contract";
import type { Jar, JarCharge } from "@shade/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, KeyRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
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
import { cn } from "@/lib/cn";
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

const EYEBROW = "font-mono text-[0.7rem] uppercase tracking-[0.14em] text-faint";

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
          <div className="relative">
            <TextInput
              {...control}
              ref={capRef}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.006"
              className="h-16 pr-14 font-display text-4xl tabular sm:text-4xl"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-4 flex items-center font-mono text-xs text-faint"
            >
              ZEC
            </span>
          </div>
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
            className="font-mono"
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
    success: () => `Charge of ${charge.amount_zec} ZEC cancelled. The jar can spend it again.`,
    onSuccess: () => setConfirming(false),
  });
  const cancelled = charge.status === "cancelled";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="font-display text-xl leading-none tabular">
            <span className={cancelled ? "text-faint line-through" : "text-fg"}>
              {charge.amount_zec}
            </span>
            <span className="ml-1 font-mono text-[0.65rem] font-normal text-faint">ZEC</span>
          </span>
          {charge.memo ? (
            <span className="font-mono text-xs text-muted wrap-anywhere">{charge.memo}</span>
          ) : null}
        </p>
        <p className="font-mono text-[0.7rem] text-faint">
          {formatDateTime(charge.created_at)}
          {cancelled ? " · Cancelled" : null}
        </p>
      </div>
      {!cancelled && jar.status === "open" ? (
        <Button variant="quiet" className="px-2.5" onClick={() => setConfirming(true)}>
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
          <p>{charge.amount_zec} ZEC goes back into the jar. The agent can spend it again.</p>
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
    <details className="group" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-mono text-[0.7rem] tracking-[0.14em] text-muted uppercase hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.75}
          className="transition-transform group-open:rotate-90"
        />
        Charges · {jar.charge_count}
      </summary>
      {expanded ? <JarCharges jar={jar} /> : null}
    </details>
  );
}

/** One slat per tenth of the cap. */
const SLATS = 10;

/**
 * The cap as a blind. Lit slats are what the agent can still spend; each charge closes it a little
 * more from the top, and an empty jar lets no light through. Decorative: jarSummaryCopy says the
 * same in words. The slats open one by one when the page loads.
 */
function CapBlind({ jar }: { jar: Jar }) {
  const cap = zecToZat(jar.cap_zec) ?? 0n;
  const left = zecToZat(jar.remaining_zec) ?? 0n;
  // In thousandths, so a small charge still dims part of a slat.
  const lit = cap > 0n ? Number((left * 1000n) / cap) / 1000 : 0;
  const killed = jar.status === "killed";
  return (
    <div
      aria-hidden
      className={cn(
        "grid w-20 shrink-0 content-start gap-[5px] rounded-sm border p-2 sm:w-24",
        killed ? "border-line" : "border-line-strong/60",
      )}
    >
      {Array.from({ length: SLATS }, (_, index) => {
        // Counted from the bottom: the bottom slats stay lit longest.
        const fromBottom = SLATS - 1 - index;
        const fill = Math.min(1, Math.max(0, lit * SLATS - fromBottom));
        return (
          <span key={index} className="relative h-[5px] overflow-hidden rounded-[1px] bg-line">
            <span
              className={cn(
                "slat-open absolute inset-y-0 left-0 transition-[width] duration-700 ease-curtain",
                killed ? "bg-faint/45" : "bg-glow",
              )}
              style={{ width: `${fill * 100}%`, "--i": fromBottom } as CSSProperties}
            />
          </span>
        );
      })}
    </div>
  );
}

function JarCard({ jar }: { jar: Jar }) {
  const reveal = useRevealSecret();
  const killHintId = useId();
  const [confirmKill, setConfirmKill] = useState(false);
  const agentKey = useDeskMutation({
    mutationFn: () => createApiKey({ kind: "agent", label: jar.label, jar_id: jar.id }),
    invalidate: () => [qk.apiKeys],
    success: () => "Agent key created. Save it now. Shade shows it once.",
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
            runs a sample agent. Set <code className="text-fg">SHADE_API_URL</code> to{" "}
            {window.location.origin} first.
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
  const command = chargeCommand(jar.id);
  const section = "border-t border-line px-5 py-4 sm:px-6";
  return (
    <li
      className={cn(
        "rounded-lg border",
        open ? "border-line-strong bg-surface" : "border-dashed border-line-strong bg-transparent",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 pt-5 sm:px-6">
        <h3
          className={cn(
            "min-w-0 font-display text-3xl leading-none wrap-anywhere",
            open ? "text-fg" : "text-muted",
          )}
        >
          {jar.label}
        </h3>
        <StatusText
          status={open ? { label: "Open", tone: "ok" } : { label: "Killed", tone: "muted" }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 px-5 sm:px-6">
        <span className="font-mono text-[0.7rem] text-faint">Jar id</span>
        <code className="text-[0.7rem] text-muted wrap-anywhere">{jar.id}</code>
        <CopyButton value={jar.id} label="Copy id" variant="quiet" className="px-2" />
      </div>

      <div className="flex gap-5 px-5 pt-1 pb-5 sm:gap-7 sm:px-6">
        <CapBlind jar={jar} />
        <div className="min-w-0 space-y-2">
          <p className={EYEBROW}>{open ? "Left to spend" : "Spent"}</p>
          <p
            className={cn(
              "font-display text-5xl leading-none tabular wrap-anywhere",
              open ? "text-fg" : "text-muted",
            )}
          >
            {open ? jar.remaining_zec : jar.spent_zec}
            <span className="ml-2 font-mono text-sm font-normal text-faint">ZEC</span>
          </p>
          <p className="text-sm text-muted tabular">
            {jarSummaryCopy(jar.cap_zec, jar.spent_zec, jar.remaining_zec)}
          </p>
          {empty ? <p className="text-sm font-medium text-warn">{COPY.jarEmpty}</p> : null}
          {open ? null : (
            <>
              <p className="text-sm text-muted">{COPY.jarClosed}</p>
              <p className="font-mono text-[0.7rem] text-faint">
                Killed {formatDateTime(jar.killed_at ?? jar.created_at)}.
              </p>
            </>
          )}
        </div>
      </div>

      {open ? (
        <div className={cn(section, "flex flex-wrap items-center gap-x-3 gap-y-2")}>
          <Button variant="ghost" onClick={() => agentKey.mutate()} disabled={agentKey.isPending}>
            <KeyRound aria-hidden size={16} strokeWidth={1.75} />
            {agentKey.isPending ? "Creating key…" : "Agent key"}
          </Button>
          <Button
            variant="danger"
            aria-describedby={killHintId}
            onClick={() => setConfirmKill(true)}
          >
            Kill
          </Button>
          <p id={killHintId} className="min-w-0 basis-full text-xs text-faint sm:flex-1 sm:basis-0">
            {COPY.killNote}
          </p>
          <ActionStatus mutation={agentKey} className="basis-full" />
        </div>
      ) : null}
      {confirmKill ? null : (
        <ActionStatus mutation={kill} successText="Killed." className="px-5 pb-4 sm:px-6" />
      )}

      {/* The whole command until the agent's first charge lands; then one line keeps it a copy away. */}
      {open && jar.charge_count === 0 ? (
        <div className={cn(section, "space-y-2")}>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p className={EYEBROW}>First charge</p>
            <CopyButton value={command} label="Copy command" variant="quiet" className="px-2" />
          </div>
          <pre className="rounded-sm border border-line bg-bg p-3 text-[0.7rem] leading-relaxed whitespace-pre-wrap text-muted wrap-anywhere">
            <code>{command}</code>
          </pre>
          <p className="text-xs text-faint">
            The command reads the agent key from the{" "}
            <code className="text-muted">SHADE_AGENT_KEY</code> variable. Press Agent key to make
            one.
          </p>
        </div>
      ) : null}
      {open && jar.charge_count > 0 ? (
        <div className={cn(section, "flex flex-wrap items-center justify-between gap-x-3 py-2")}>
          <code className="min-w-0 text-[0.7rem] text-faint wrap-anywhere">
            <span className="text-muted">POST</span> /v1/jars/{jar.id}/charge
          </code>
          <CopyButton value={command} label="Copy command" variant="quiet" className="px-2" />
        </div>
      ) : null}

      <section className={cn(section, "space-y-1")}>
        {open ? (
          <>
            <h4 className="flex min-h-11 items-center font-mono text-[0.7rem] tracking-[0.14em] text-muted uppercase">
              Charges · {jar.charge_count}
            </h4>
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
  const openCount = jars.data?.filter((jar) => jar.status === "open").length ?? 0;
  const killedCount = (jars.data?.length ?? 0) - openCount;

  return (
    <DeskPage
      title="Jars"
      intro="A jar gives an AI agent a spending cap. The agent charges the jar for each paid call. When it reaches the cap, Shade refuses the next charge."
    >
      <SplitLayout
        aside={
          <Panel title="New jar">
            {noAddress ? (
              <div className="space-y-2 rounded-sm border border-warn/50 bg-warn/[0.04] p-4 text-sm">
                <p className="text-warn">{COPY.noAddress}</p>
                <Link
                  to="/desk/settings/address"
                  className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4"
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
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line-strong pb-4">
          <h2 className="font-display text-3xl leading-none">
            {network === "mainnet" ? "Mainnet jars" : "Testnet jars"}
          </h2>
          {jars.data?.length ? (
            <p className={EYEBROW}>
              {openCount} open · {killedCount} killed
            </p>
          ) : null}
        </div>
        {jars.data && jars.isRefetchError ? <RefreshError error={jars.error} /> : null}
        {jars.data === undefined ? (
          jars.isError ? (
            <ErrorState error={jars.error} onRetry={() => void jars.refetch()} />
          ) : (
            <LoadingState label="Loading jars…" />
          )
        ) : jars.data.length === 0 ? (
          <EmptyState title="No jars yet.">
            Create a jar, then press Agent key. The agent gets its own key, and that key can only
            charge that jar.
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
                Shade lists every open jar, then the newest killed ones, up to {LIST_CAP} jars.
              </p>
            ) : null}
          </>
        )}
      </SplitLayout>
    </DeskPage>
  );
}
