import { COPY } from "@shade/contract";
import type { Network, ViewingKeyStatus } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAppConfig } from "@/api/config";
import { ApiError, errorMessage } from "@/api/client";
import { deleteViewingKey, meQuery, uploadViewingKey, viewingKeysQuery } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Checkbox, Field, TextArea } from "@/components/field";
import { NetworkBadge } from "@/components/mark";
import { ErrorState, LoadingState, RefreshError } from "@/components/states";
import { StatusText } from "@/components/status-text";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { SettingsSection } from "@/features/settings/settings-layout";
import { formatRelative, plural } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { scanErrorLabel, scanStateLabel } from "@/lib/status";
import { checkUfvkInput } from "@/lib/validation";

function Disclosures() {
  return (
    <div className="space-y-2 border-l-2 border-warn/70 pl-4 text-sm">
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
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
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
        hint="Your receive address becomes this key's own shielded address, the only one Shade can confirm belongs to the key. Turn this off to keep another address of the same wallet account."
        checked={useKeyAddress}
        onChange={(event) => setUseKeyAddress(event.target.checked)}
      />
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Saving key…" : replacing ? "Save new key" : "Turn on detection"}
      </Button>
      {serverError ? null : <ActionStatus mutation={mutation} />}
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
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="text-muted">Status</dt>
        <dd>
          <StatusText status={scanStateLabel(scan.state)} />
          {scan.last_error ? (
            <p className="mt-1 text-warn">{scanErrorLabel(scan.last_error)}</p>
          ) : null}
        </dd>
        <dt className="text-muted">Last scan</dt>
        <dd>
          {scan.last_scan_at ? formatRelative(scan.last_scan_at, now) : "Not yet"}
          {scan.lag_blocks !== null
            ? scan.lag_blocks <= 1
              ? " · up to date"
              : ` · ${plural(scan.lag_blocks, "block")} behind`
            : null}
        </dd>
        <dt className="text-muted">Key fingerprint</dt>
        <dd>
          <code>{status.fingerprint}</code>
        </dd>
        <dt className="text-muted">Key address</dt>
        <dd className="font-mono wrap-anywhere">{status.key_address}</dd>
        <dt className="text-muted">Receive address</dt>
        <dd>
          {status.use_key_address
            ? "Uses this key's address"
            : "Your own address (Shade can't confirm it belongs to this key)"}
        </dd>
      </dl>
      <Button variant="danger" onClick={() => setConfirming(true)}>
        Delete viewing key
      </Button>
      {confirming ? null : <ActionStatus mutation={mutation} />}
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
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>
        Or keep the key on your own machine and run the scanner there. It posts matches to Shade
        with a server key:
      </p>
      <pre className="overflow-x-auto rounded-sm border border-line-strong bg-bg p-3 text-xs text-fg">
        {`SHADE_API_URL=${window.location.origin}  SHADE_API_KEY=sk_…  SHADE_UFVK=<viewing key>\nnpm run scan:local -w @shade/backend -- --network ${network}`}
      </pre>
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
      intro="With a viewing key, Shade finds shielded payments to your invoices by itself and marks them paid. Without one, you confirm each payment by hand."
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
        <>
          {keys.isRefetchError ? <RefreshError error={keys.error} /> : null}
          {config.data.networks.map((network) => {
            const status = keys.data.find((key) => key.network === network);
            return (
              <div
                key={network}
                className="space-y-5 rounded-md border border-line-strong bg-surface p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-serif text-2xl">
                    {network === "testnet" ? "Testnet" : "Mainnet"}
                  </h3>
                  {network === "mainnet" ? <NetworkBadge network="mainnet" /> : null}
                </div>
                {status ? (
                  <>
                    <KeyStatus status={status} now={now} />
                    {hosted ? (
                      <details className="border-t border-line pt-4">
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
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
                  <p className="text-sm text-muted">Hosted detection is off on this server.</p>
                )}
                {status ? null : <LocalScanner network={network} />}
              </div>
            );
          })}
        </>
      )}
    </SettingsSection>
  );
}
