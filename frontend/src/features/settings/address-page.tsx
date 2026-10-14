import type { Me, Network, ViewingKeyStatus } from "@shade/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAppConfig } from "@/api/config";
import { ApiError, errorMessage } from "@/api/client";
import { meQuery, saveAddress, switchNetwork, viewingKeysQuery } from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Field, TextInput } from "@/components/field";
import { NetworkBadge } from "@/components/mark";
import { ErrorState, LoadingState, RefreshError } from "@/components/states";
import { ActionStatus } from "@/features/desk/action-status";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { SettingsSection } from "@/features/settings/settings-layout";
import { Eyebrow, SettingsRow, Slip } from "@/features/settings/settings-row";
import { cn } from "@/lib/cn";
import { checkAddressInput } from "@/lib/validation";

const NETWORK_NAME: Record<Network, string> = { testnet: "Testnet", mainnet: "Mainnet" };

function AddressForm({
  network,
  current,
  managedByKey,
  index,
}: {
  network: Network;
  current: string | null;
  managedByKey: boolean;
  index: number;
}) {
  const queryClient = useQueryClient();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const mutation = useDeskMutation({
    mutationFn: (value: string) => saveAddress(network, value),
    invalidate: () => [qk.tags],
    // The notice is part of the outcome (e.g. Shade can't confirm the address belongs to the key).
    success: (saved) =>
      [`${NETWORK_NAME[network]} receive address saved.`, saved.notice].filter(Boolean).join(" "),
    onSuccess: (saved) => {
      queryClient.setQueryData<Me>(qk.me, saved.me);
      setNotice(saved.notice);
      setAddress("");
    },
  });
  const serverError =
    mutation.error instanceof ApiError &&
    ["BAD_ADDRESS", "ADDRESS_MANAGED_BY_KEY"].includes(mutation.error.code)
      ? mutation.error.message
      : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = checkAddressInput(address, network);
    setError(next);
    setNotice(null);
    if (next) {
      ref.current?.focus();
      return;
    }
    mutation.mutate(address.trim());
  }

  return (
    <SettingsRow
      index={index}
      title={`${NETWORK_NAME[network]} address`}
      badge={network === "mainnet" ? <NetworkBadge network="mainnet" /> : null}
      note={network === "mainnet" ? "Real ZEC lands here." : "Testnet payments land here."}
    >
      {current ? (
        <div className="space-y-2">
          <Eyebrow>Current</Eyebrow>
          {/* Keyed by the address, so a saved change lights up once. */}
          <Slip key={current} className={cn(mutation.isSuccess && "lit")}>
            {current}
          </Slip>
          <CopyButton value={current} label="Copy address" variant="quiet" className="-ml-2 px-2" />
        </div>
      ) : (
        <p className="flex gap-2.5 text-sm text-warn">
          <span aria-hidden className="mt-1.5 h-2.5 w-1 shrink-0 rounded-[1px] bg-warn" />
          No address yet. Invoices, jars and tags on {network} need one.
        </p>
      )}
      {managedByKey ? (
        <p className="max-w-prose text-sm text-muted">
          This address comes from your viewing key, so Shade sees payments sent to it. To use
          another address from the same wallet account, upload the key again under{" "}
          <Link to="/desk/settings/detection" className="text-fg underline underline-offset-4">
            Detection
          </Link>{" "}
          with "Use this key's address" turned off. Then save that address here. Shade cannot check
          that it belongs to the key. If it comes from another account, Shade will not see payments
          to it.
        </p>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <Field
            label={current ? "Replace with" : "Unified Address"}
            hint="Copy it from your wallet's receive screen. It needs a shielded Orchard receiver, and Shade drops any transparent part. Never paste a seed phrase."
            error={error ?? serverError}
          >
            {(control) => (
              <TextInput
                {...control}
                ref={ref}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="font-mono"
                placeholder={network === "testnet" ? "utest1…" : "u1…"}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              type="submit"
              variant={current ? "ghost" : "primary"}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Saving…" : "Save address"}
            </Button>
            {serverError ? null : <ActionStatus mutation={mutation} successText="Saved." />}
          </div>
          {notice ? (
            <p className="rounded-sm border border-warn/50 bg-warn/5 p-3 text-sm text-warn">
              {notice}
            </p>
          ) : null}
        </form>
      )}
    </SettingsRow>
  );
}

function NetworkChoice({ me, enabled }: { me: Me; enabled: Network[] }) {
  const queryClient = useQueryClient();
  const [confirmMainnet, setConfirmMainnet] = useState(false);
  const mutation = useDeskMutation({
    mutationFn: switchNetwork,
    // Desk lists are filtered by the current network: refetch the ones on screen…
    invalidate: () => [qk.desk],
    success: (next) => `Desk switched to ${next.merchant.network}.`,
    onSuccess: (next) => {
      queryClient.setQueryData<Me>(qk.me, next);
      // …and drop the cached ones nothing shows right now, so the old network's invoices, jars
      // or grants never render under the new network's heading while they refetch.
      queryClient.removeQueries({
        queryKey: qk.desk,
        type: "inactive",
        predicate: (query) => query.queryKey[1] !== qk.me[1],
      });
      setConfirmMainnet(false);
    },
  });
  const current = me.merchant.network;
  // The operator can turn a network off (SHADE_NETWORKS) after the desk switched to it.
  const stranded = !enabled.includes(current);
  const target = stranded ? enabled[0] : enabled.find((network) => network !== current);

  function switchTo(network: Network) {
    // Mainnet means real money and a fresh sign-in: always through the confirmation.
    if (network === "mainnet") setConfirmMainnet(true);
    else mutation.mutate(network);
  }

  return (
    <SettingsRow
      index={0}
      title="Network"
      note="New invoices, jars and keys use the network the desk is on."
    >
      <div className="space-y-2">
        <Eyebrow>The desk is on</Eyebrow>
        <p className="flex items-center gap-3 font-display text-5xl leading-none">
          <span
            aria-hidden
            className={cn(
              "h-[0.62em] w-2 shrink-0 rounded-[2px]",
              stranded ? "bg-bad" : current === "mainnet" ? "bg-warn" : "bg-glow",
            )}
          />
          {NETWORK_NAME[current]}
        </p>
      </div>
      <div className="max-w-prose space-y-1.5 text-sm">
        {stranded ? (
          <p className="text-warn">
            The desk is on {NETWORK_NAME[current]}, but this server has turned {current} off. New
            invoices, jars and keys fail until you switch
            {target ? ` to ${NETWORK_NAME[target].toLowerCase()}` : null}.
          </p>
        ) : (
          <p className="text-muted">
            {current === "testnet"
              ? "Testnet coins have no value. Mainnet uses real ZEC."
              : "Invoices ask for real ZEC, and payers send real money."}
          </p>
        )}
        {!stranded && enabled.length < 2 ? (
          <p className="text-muted">
            This server runs {current} only.
            {enabled.includes("mainnet")
              ? null
              : " Mainnet stays off until the operator turns it on."}
          </p>
        ) : null}
      </div>
      {target ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button variant="ghost" onClick={() => switchTo(target)} disabled={mutation.isPending}>
            {mutation.isPending && target !== "mainnet"
              ? "Switching…"
              : target === "mainnet"
                ? "Switch to mainnet"
                : stranded
                  ? "Switch to testnet"
                  : "Switch back to testnet"}
          </Button>
          {confirmMainnet ? null : <ActionStatus mutation={mutation} />}
        </div>
      ) : null}
      {confirmMainnet ? (
        <ConfirmDialog
          open
          title="Switch to mainnet?"
          confirmLabel="Use real ZEC"
          pendingLabel="Switching…"
          cancelLabel={current === "testnet" && !stranded ? "Stay on testnet" : "Not now"}
          pending={mutation.isPending}
          error={mutation.isError ? errorMessage(mutation.error) : null}
          onConfirm={() => mutation.mutate("mainnet")}
          onCancel={() => {
            mutation.reset();
            setConfirmMainnet(false);
          }}
        >
          <p>New invoices ask for real ZEC, and payers send real money to your mainnet address.</p>
          <p>
            Your testnet invoices, jars and keys stay on testnet. From now on the desk shows the
            mainnet ones.
          </p>
        </ConfirmDialog>
      ) : null}
    </SettingsRow>
  );
}

function managedNetworks(keys: ViewingKeyStatus[] | undefined): Set<Network> {
  return new Set((keys ?? []).filter((key) => key.use_key_address).map((key) => key.network));
}

export function AddressSettingsPage() {
  const config = useAppConfig();
  const me = useQuery(meQuery);
  const keys = useQuery(viewingKeysQuery);

  return (
    <SettingsSection
      title="Receive addresses & network"
      intro="Payers send ZEC straight to your wallet. Shade never holds a seed or a spending key."
    >
      {/* Once loaded, a failed refresh keeps the forms and an open dialog on screen. */}
      {me.data === undefined || config.data === undefined || keys.isPending ? (
        me.data === undefined && me.isError ? (
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        ) : config.data === undefined && config.isError ? (
          <ErrorState error={config.error} onRetry={() => void config.refetch()} />
        ) : (
          <LoadingState label="Loading your settings…" rows={2} />
        )
      ) : (
        <div className="space-y-10">
          {me.isRefetchError ? (
            <RefreshError error={me.error} onRetry={() => void me.refetch()} />
          ) : null}
          <NetworkChoice me={me.data} enabled={config.data.networks} />
          {config.data.networks.map((network, index) => (
            <AddressForm
              key={network}
              index={index + 1}
              network={network}
              current={me.data.merchant.receive_addresses[network]}
              managedByKey={managedNetworks(keys.data).has(network)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
