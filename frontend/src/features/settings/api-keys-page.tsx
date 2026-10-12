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
import { formatDateTime, formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { checkLabel } from "@/lib/validation";

function KeyForm({ networks, defaultNetwork }: { networks: Network[]; defaultNetwork: Network }) {
  const reveal = useRevealSecret();
  const [label, setLabel] = useState("");
  const [network, setNetwork] = useState<Network>(defaultNetwork);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const mutation = useDeskMutation({
    mutationFn: createApiKey,
    invalidate: () => [qk.apiKeys],
    success: () => "Server key created. Copy it now; Shade shows it once.",
    onSuccess: (key) => {
      setLabel("");
      reveal({
        title: `Server key · ${key.label}`,
        intro: `Shade shows this key once. It works on ${key.network} only.`,
        items: [{ label: "Key", value: key.token }],
        notes: [
          <>
            Send it as <code className="text-fg">Authorization: Bearer {key.prefix}…</code> from
            your server. Never put it in a browser or an app.
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
    <form
      className="space-y-4 rounded-md border border-line-strong bg-surface p-5"
      onSubmit={onSubmit}
      noValidate
    >
      <h3 className="font-serif text-2xl">New server key</h3>
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
                  {option === "testnet" ? "Testnet (sk_test_)" : "Mainnet, real ZEC (sk_live_)"}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Creating…" : "Create key"}
      </Button>
      <ActionStatus mutation={mutation} />
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
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-5">
      <div className="min-w-0 space-y-1">
        <p className="font-medium wrap-anywhere">
          {apiKey.label || "Unnamed key"}{" "}
          <span className="font-normal text-muted">
            · {apiKey.kind === "agent" ? "agent key" : "server key"}
          </span>
        </p>
        <p className="font-mono text-sm text-muted">
          {apiKey.prefix}…{apiKey.last4}
        </p>
        <p className="text-sm text-faint">
          {apiKey.jar_id ? (
            <>
              Jar <code>{apiKey.jar_id}</code> ·{" "}
            </>
          ) : null}
          Created {formatDateTime(apiKey.created_at)} ·{" "}
          {apiKey.last_used_at
            ? `last used ${formatRelative(apiKey.last_used_at, now)}`
            : "never used"}
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
          <p>Anything using this key stops working right away. This cannot be undone.</p>
          {apiKey.kind === "agent" ? <p>The agent can no longer charge its jar.</p> : null}
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

export function ApiKeysSettingsPage() {
  const config = useAppConfig();
  const me = useQuery(meQuery);
  const keys = useQuery(apiKeysQuery);
  const now = useNow(30_000);
  return (
    <SettingsSection
      title="API keys"
      intro="Server keys call the /v1 API for your shop. Agent keys are made from a jar on the Jars page and can only charge that jar."
    >
      {config.data && me.data ? (
        <KeyForm
          networks={config.data.networks}
          defaultNetwork={
            // A desk left on a network the operator turned off must not preselect it.
            config.data.networks.includes(me.data.merchant.network)
              ? me.data.merchant.network
              : (config.data.networks[0] ?? me.data.merchant.network)
          }
        />
      ) : null}
      {keys.data && keys.isRefetchError ? (
        <RefreshError error={keys.error} onRetry={() => void keys.refetch()} />
      ) : null}
      {keys.data === undefined ? (
        keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : (
          <LoadingState label="Loading keys…" rows={2} />
        )
      ) : keys.data.length === 0 ? (
        <EmptyState title="No keys yet.">
          Create a server key to call the API from your backend.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {keys.data.map((apiKey) => (
            <KeyRow key={apiKey.id} apiKey={apiKey} now={now} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
