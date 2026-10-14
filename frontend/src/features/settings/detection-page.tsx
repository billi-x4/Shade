import { COPY } from "@shade/contract";
import type { Network, ViewingKeyStatus } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAppConfig } from "@/api/config";
import { ApiError, errorMessage } from "@/api/client";
import { deleteViewingKey, meQuery, uploadViewingKey, viewingKeysQuery } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Checkbox, Field, TextArea } from "@/components/field";
import { NetworkBadge } from "@/components/mark";
import { ErrorState, LoadingState, RefreshError } from "@/components/states";
import { StatusText } from "@/components/status-text";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { SettingsSection } from "@/features/settings/settings-layout";
import { EYEBROW, Eyebrow, SettingsRow } from "@/features/settings/settings-row";
import { formatRelative, plural } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { scanErrorLabel, scanStateLabel } from "@/lib/status";
import { checkUfvkInput } from "@/lib/validation";

function Disclosures() {
  return (
    <div className="space-y-2 rounded-sm border border-warn/40 bg-warn/5 p-4 text-sm">
      <Eyebrow className="text-warn">Before you paste</Eyebrow>
      <p>{COPY.ufvkNotice}</p>
      <p className="text-muted">{COPY.chainPrivacyNote}</p>
    </div>
  );
}

function UploadForm({ network, replacing = false }: { network: Network; replacing?: boolean }) {
  const [ufvk, setUfvk] = useState("");
  const [useKeyAddress, setUseKeyAddress] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mutation = useDeskMutation({
    mutationFn: (key: string) => uploadViewingKey(network, key, useKeyAddress),
    invalidate: () => [qk.viewingKeys, qk.me],
    success: () => "Viewing key saved. Shade is watching for payments.",
  });
  const serverError =
    mutation.error instanceof ApiError &&
    ["BAD_VIEWING_KEY", "VIEWING_KEY_ADDRESS_MISMATCH", "HOSTED_DETECTION_DISABLED"].includes(
      mutation.error.code,
    )
      ? mutation.error.message
      : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = checkUfvkInput(ufvk, network);
    setError(next);
    if (next) {
      ref.current?.focus();
      return;
    }
    const key = ufvk.trim();
    // The key leaves component state as soon as it is on its way.
    setUfvk("");
    mutation.mutate(key);
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <Disclosures />
      <Field
        label="Full viewing key"
        hint={`Export it from your wallet. It starts with ${network === "testnet" ? "uviewtest1" : "uview1"}. Never paste a seed phrase or a spending key.`}
        error={error ?? serverError}
      >
        {(control) => (
          <TextArea
            {...control}
            ref={ref}
            rows={4}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={network === "testnet" ? "uviewtest1…" : "uview1…"}
            value={ufvk}
            onChange={(event) => setUfvk(event.target.value)}
          />
        )}
      </Field>
      <Checkbox
        label="Use this key's address"
        hint="Your receive address becomes this key's own address. It is the only address Shade can confirm belongs to the key. Turn this off to keep another address from the same wallet account."
        checked={useKeyAddress}
        onChange={(event) => setUseKeyAddress(event.target.checked)}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving key…" : replacing ? "Save new key" : "Turn on detection"}
        </Button>
        {serverError ? null : <ActionStatus mutation={mutation} />}
      </div>
    </form>
  );
}

function KeyStatus({ status, now }: { status: ViewingKeyStatus; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useDeskMutation({
    mutationFn: () => deleteViewingKey(status.network),
    invalidate: () => [qk.viewingKeys, qk.me],
    success: () => "Viewing key deleted. Detection is off for this network.",
    onSuccess: () => setConfirming(false),
  });
  const scan = status.scan;
  return (
    <div className="space-y-6">
      <dl className="grid gap-x-8 gap-y-5 text-sm sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <dt className={EYEBROW}>Status</dt>
          <dd>
            <StatusText status={scanStateLabel(scan.state)} className="text-base" />
            {scan.last_error ? (
              <p className="mt-1.5 max-w-prose text-warn">{scanErrorLabel(scan.last_error)}</p>
            ) : null}
          </dd>
        </div>
        <div className="space-y-1.5">
          <dt className={EYEBROW}>Last scan</dt>
          <dd>
            {scan.last_scan_at ? formatRelative(scan.last_scan_at, now) : "Not yet"}
            {scan.lag_blocks !== null
              ? scan.lag_blocks <= 1
                ? " · up to date"
                : ` · ${plural(scan.lag_blocks, "block")} behind`
              : null}
          </dd>
        </div>
        <div className="space-y-1.5">
          <dt className={EYEBROW}>Key fingerprint</dt>
          <dd>
            <code className="text-fg">{status.fingerprint}</code>
          </dd>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <dt className={EYEBROW}>Key address</dt>
          <dd className="font-mono text-xs leading-relaxed wrap-anywhere text-muted">
            {status.key_address}
          </dd>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <dt className={EYEBROW}>Receive address</dt>
          <dd>
            {status.use_key_address
              ? "Uses this key's address"
              : "Your own address. Shade cannot check that it belongs to this key."}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete viewing key
        </Button>
        {confirming ? null : <ActionStatus mutation={mutation} />}
      </div>
      {confirming ? (
        <ConfirmDialog
          open
          title="Delete this viewing key?"
          confirmLabel="Delete key"
          pendingLabel="Deleting…"
          pending={mutation.isPending}
          error={mutation.isError ? errorMessage(mutation.error) : null}
          onConfirm={() => mutation.mutate()}
          onCancel={() => {
            mutation.reset();
            setConfirming(false);
          }}
        >
          <p>Shade wipes its encrypted copy and stops watching {status.network} for payments.</p>
          <p>
            Payments still reach your wallet. Until you add a key again, you confirm them by hand.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function LocalScanner({ network }: { network: Network }) {
  const command = `SHADE_API_URL=${window.location.origin}  SHADE_API_KEY=sk_…  SHADE_UFVK=<viewing key>\nnpm run scan:local -w @shade/backend -- --network ${network}`;
  return (
    <div className="space-y-3 border-t border-line pt-5">
      <h4 className="font-medium text-fg">Run the scanner yourself</h4>
      <p className="max-w-prose text-sm text-muted">
        The viewing key stays on your computer. The scanner runs from a copy of the Shade code and
        reports each payment to Shade with a server key.
      </p>
      <pre className="rounded-sm border border-line-strong bg-bg p-3 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-fg">
        {command}
      </pre>
      <CopyButton value={command} label="Copy command" variant="quiet" className="-ml-2 px-2" />
    </div>
  );
}

export function DetectionSettingsPage() {
  const config = useAppConfig();
  const me = useQuery(meQuery);
  const keys = useQuery({ ...viewingKeysQuery, refetchInterval: 10_000 });
  const now = useNow(15_000);
  const hosted = Boolean(config.data?.features.hosted_detection && me.data?.hosted_detection);

  return (
    <SettingsSection
      title="Detection"
      intro="With a viewing key, Shade spots payments to your invoices and marks them paid. Without one, you confirm each payment yourself. A viewing key can see payments but cannot spend them."
    >
      {/* Once loaded, a failed poll keeps the status, an open dialog and a typed key on screen. */}
      {config.data === undefined || keys.data === undefined ? (
        config.data === undefined && config.isError ? (
          <ErrorState error={config.error} onRetry={() => void config.refetch()} />
        ) : keys.data === undefined && keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : (
          <LoadingState label="Loading detection status…" rows={2} />
        )
      ) : (
        <div className="space-y-10">
          {keys.isRefetchError ? <RefreshError error={keys.error} /> : null}
          {config.data.networks.map((network, index) => {
            const status = keys.data.find((key) => key.network === network);
            return (
              <SettingsRow
                key={network}
                index={index}
                title={network === "testnet" ? "Testnet" : "Mainnet"}
                badge={network === "mainnet" ? <NetworkBadge network="mainnet" /> : null}
                note={
                  status
                    ? "Viewing key on file."
                    : hosted
                      ? "Add a viewing key to turn detection on."
                      : "Off on this server."
                }
              >
                {status ? (
                  <>
                    <KeyStatus status={status} now={now} />
                    {hosted ? (
                      <details className="group border-t border-line pt-2">
                        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                          <ChevronRight
                            aria-hidden
                            size={16}
                            strokeWidth={1.75}
                            className="shrink-0 text-muted transition-transform group-open:rotate-90"
                          />
                          Replace this key or change its address setting
                        </summary>
                        <div className="pt-4">
                          <UploadForm network={network} replacing />
                        </div>
                      </details>
                    ) : null}
                  </>
                ) : hosted ? (
                  <UploadForm network={network} />
                ) : (
                  <p className="max-w-prose text-sm text-muted">
                    This server does not watch for payments. Run the scanner yourself, or confirm
                    each payment by hand.
                  </p>
                )}
                {status ? null : <LocalScanner network={network} />}
              </SettingsRow>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}
