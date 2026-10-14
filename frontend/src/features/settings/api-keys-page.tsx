import type { ApiKey, Network } from "@shade/contract";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAppConfig } from "@/api/config";
import { errorMessage } from "@/api/client";
import { apiKeysQuery, createApiKey, meQuery, revokeApiKey } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, Select, TextInput } from "@/components/field";
import { NetworkBadge } from "@/components/mark";
import { EmptyState, ErrorState, LoadingState, RefreshError } from "@/components/states";
import { StatusText } from "@/components/status-text";
import { ActionStatus } from "@/features/desk/action-status";
import { useRevealSecret } from "@/features/desk/desk-context";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { SettingsSection } from "@/features/settings/settings-layout";
import { SettingsRow } from "@/features/settings/settings-row";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { checkLabel } from "@/lib/validation";

/** The API sends the visible start of a key already ending in "…" (sk_test_AbCd…). */
function keyStart(prefix: string): string {
  return prefix.endsWith("…") ? prefix.slice(0, -1) : prefix;
}

function KeyForm({ networks, defaultNetwork }: { networks: Network[]; defaultNetwork: Network }) {
  const reveal = useRevealSecret();
  const [label, setLabel] = useState("");
  const [network, setNetwork] = useState<Network>(defaultNetwork);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const mutation = useDeskMutation({
    mutationFn: createApiKey,
    invalidate: () => [qk.apiKeys],
    success: () => "Server key created. Copy it now. Shade shows it once.",
    onSuccess: (key) => {
      setLabel("");
      reveal({
        title: `Server key · ${key.label}`,
        intro: `Shade shows this key once. It works on ${key.network} only.`,
        items: [{ label: "Key", value: key.token }],
        notes: [
          <>
            Send it as{" "}
            <code className="text-fg">Authorization: Bearer {keyStart(key.prefix)}…</code> from your
            server. Never put it in a browser or an app.
          </>,
        ],
      });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = checkLabel(label);
    setError(next);
    if (next) {
      ref.current?.focus();
      return;
    }
    mutation.mutate({ kind: "merchant", label: label.trim(), network });
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <Field
        label="Label"
        hint="Where the key lives, so you know what breaks if you revoke it."
        error={error}
      >
        {(control) => (
          <TextInput
            {...control}
            ref={ref}
            autoComplete="off"
            placeholder="shop-backend"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        )}
      </Field>
      {networks.length > 1 ? (
        <Field label="Network">
          {(control) => (
            <Select
              {...control}
              value={network}
              onChange={(event) => setNetwork(event.target.value as Network)}
            >
              {networks.map((option) => (
                <option key={option} value={option}>
                  {option === "testnet" ? "Testnet · sk_test_" : "Mainnet, real ZEC · sk_live_"}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create key"}
        </Button>
        <ActionStatus mutation={mutation} />
      </div>
    </form>
  );
}

function KeyRow({ apiKey, now }: { apiKey: ApiKey; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useDeskMutation({
    mutationFn: () => revokeApiKey(apiKey.id),
    invalidate: () => [qk.apiKeys],
    success: () => `Key ${apiKey.label} revoked.`,
    onSuccess: () => setConfirming(false),
  });
  const revoked = apiKey.revoked_at !== null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-5 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-60 space-y-1.5">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("font-medium wrap-anywhere", revoked ? "text-muted" : "text-fg")}>
            {apiKey.label || "Unnamed key"}
          </span>
          <span className="text-sm text-faint">
            {apiKey.kind === "agent" ? "Agent key" : "Server key"}
          </span>
        </p>
        <p className={cn("font-mono text-sm", revoked ? "text-faint" : "text-muted")}>
          {keyStart(apiKey.prefix)}…{apiKey.last4}
        </p>
        <p className="text-sm text-faint">
          {apiKey.jar_id ? (
            <>
              Jar <code className="text-muted">{apiKey.jar_id}</code> ·{" "}
            </>
          ) : null}
          Created {formatDateTime(apiKey.created_at)} ·{" "}
          {apiKey.last_used_at
            ? `last used ${formatRelative(apiKey.last_used_at, now)}`
            : "never used"}
          {apiKey.revoked_at ? ` · revoked ${formatDateTime(apiKey.revoked_at)}` : null}
        </p>
        {confirming ? null : <ActionStatus mutation={mutation} />}
      </div>
      <div className="flex items-center gap-3">
        <NetworkBadge network={apiKey.network} />
        {revoked ? (
          <StatusText status={{ label: "Revoked", tone: "muted" }} />
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </div>
      {confirming ? (
        <ConfirmDialog
          open
          title={`Revoke ${apiKey.label || "this key"}?`}
          confirmLabel="Revoke key"
          pendingLabel="Revoking…"
          pending={mutation.isPending}
          error={mutation.isError ? errorMessage(mutation.error) : null}
          onConfirm={() => mutation.mutate()}
          onCancel={() => {
            mutation.reset();
            setConfirming(false);
          }}
        >
          <p>Anything that uses this key stops working at once. You cannot undo this.</p>
          {apiKey.kind === "agent" ? <p>The agent can no longer charge its jar.</p> : null}
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

function KeyList({ keys, now }: { keys: ApiKey[]; now: number }) {
  return (
    <ul className="divide-y divide-line">
      {keys.map((apiKey) => (
        <KeyRow key={apiKey.id} apiKey={apiKey} now={now} />
      ))}
    </ul>
  );
}

export function ApiKeysSettingsPage() {
  const config = useAppConfig();
  const me = useQuery(meQuery);
  const keys = useQuery(apiKeysQuery);
  const now = useNow(30_000);
  const live = keys.data?.filter((apiKey) => apiKey.revoked_at === null) ?? [];
  const revoked = keys.data?.filter((apiKey) => apiKey.revoked_at !== null) ?? [];
  return (
    <SettingsSection
      title="API keys"
      intro="A server key lets your own backend call the Shade API for this shop. Agent keys come from a jar on the Jars page and can only charge that jar."
    >
      <div className="space-y-10">
        {config.data && me.data ? (
          <SettingsRow
            index={0}
            title="New server key"
            note="Shade shows the key once, right after you create it. Keep it on your server."
          >
            <KeyForm
              networks={config.data.networks}
              defaultNetwork={
                // A desk left on a network the operator turned off must not preselect it.
                config.data.networks.includes(me.data.merchant.network)
                  ? me.data.merchant.network
                  : (config.data.networks[0] ?? me.data.merchant.network)
              }
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          index={1}
          title="Live keys"
          note={
            keys.data ? (
              <span className="block font-display text-4xl leading-none text-fg tabular">
                {live.length}
              </span>
            ) : undefined
          }
        >
          {keys.data && keys.isRefetchError ? (
            <RefreshError error={keys.error} onRetry={() => void keys.refetch()} />
          ) : null}
          {keys.data === undefined ? (
            keys.isError ? (
              <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
            ) : (
              <LoadingState label="Loading keys…" rows={2} />
            )
          ) : live.length === 0 ? (
            <EmptyState title={keys.data.length === 0 ? "No keys yet." : "No live keys."}>
              Create a server key to call the API from your backend.
            </EmptyState>
          ) : (
            <KeyList keys={live} now={now} />
          )}
        </SettingsRow>
        {revoked.length > 0 ? (
          <SettingsRow index={2} title="Revoked" note="These keys no longer work.">
            <KeyList keys={revoked} now={now} />
          </SettingsRow>
        ) : null}
      </div>
    </SettingsSection>
  );
}
