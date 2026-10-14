import type { Invoice, Network, Page } from "@shade/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useAppConfig } from "@/api/config";
import { invoicesQuery, meQuery, viewingKeysQuery, type InvoiceFilter } from "@/api/desk";
import { Button } from "@/components/button";
import { Select } from "@/components/field";
import { focusPageStart } from "@/components/page-focus";
import { EmptyState, ErrorState, LoadingState, RefreshError } from "@/components/states";
import { DeskPage, Panel, SplitLayout } from "@/features/desk/desk-page";
import { InvoiceForm } from "@/features/invoices/invoice-form";
import { InvoiceRow } from "@/features/invoices/invoice-row";

const FILTERS: { value: InvoiceFilter; label: string }[] = [
  { value: "all", label: "All invoices" },
  { value: "open", label: "Awaiting payment" },
  { value: "paid_unverified", label: "Reported by payer" },
  { value: "paid", label: "Paid" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

/**
 * Refetch every 5 s while anything can still change state. That includes an expired
 * invoice with a payment seen on chain: it becomes paid once the payment has its confirmations.
 */
function isLive(invoice: Invoice): boolean {
  return (
    invoice.status === "open" ||
    invoice.status === "paid_unverified" ||
    invoice.detection?.state === "seen"
  );
}

function pollWhileLive(data: InfiniteData<Page<Invoice>> | undefined): number | false {
  return data?.pages.some((page) => page.items.some(isLive)) ? 5_000 : false;
}

/** Per browser and network: a merchant who runs the scanner on their own machine hides it once. */
const noticeKey = (network: Network) => `shade:detection-off-notice:${network}`;

function noticeDismissed(network: Network): boolean {
  try {
    return window.localStorage.getItem(noticeKey(network)) === "dismissed";
  } catch {
    return false;
  }
}

/**
 * The server offers hosted detection but this network has no viewing key, so invoices here stay
 * unpaid until the merchant confirms each payment by hand. Rendered only while a receive address
 * exists (the form's no-address message covers the rest); keyed by network by its parent.
 */
function DetectionOffNotice({ network }: { network: Network }) {
  const config = useAppConfig();
  const me = useQuery(meQuery);
  const [dismissed, setDismissed] = useState(() => noticeDismissed(network));
  const hosted = Boolean(config.data?.features.hosted_detection && me.data?.hosted_detection);
  const keys = useQuery({ ...viewingKeysQuery, enabled: hosted && !dismissed });
  if (!hosted || dismissed || keys.data === undefined) return null;
  if (keys.data.some((key) => key.network === network)) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(noticeKey(network), "dismissed");
    } catch {
      // Storage blocked: hidden for this visit only.
    }
    // The button disappears with the notice; start again from the page heading, not <body>.
    focusPageStart();
    setDismissed(true);
  }

  return (
    <div className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-1 overflow-hidden rounded-md border border-warn/50 bg-warn/[0.04] py-2 pr-2 pl-6">
      {/* Three warn slats: the blind is down on this network. */}
      <span aria-hidden className="absolute top-1/2 left-2.5 grid -translate-y-1/2 gap-[3px]">
        <span className="h-[3px] w-1.5 rounded-[1px] bg-warn" />
        <span className="h-[3px] w-1.5 rounded-[1px] bg-warn" />
        <span className="h-[3px] w-1.5 rounded-[1px] bg-warn" />
      </span>
      <p className="min-w-0 flex-1 basis-72 py-2 text-sm text-muted">
        <span className="font-medium text-warn">Automatic detection is off on {network}.</span>{" "}
        Invoices stay unpaid until you confirm a payment by hand.{" "}
        <Link
          to="/desk/settings/detection"
          className="font-medium text-fg underline underline-offset-4"
        >
          Turn on detection
        </Link>
      </p>
      <Button variant="quiet" className="px-3" onClick={dismiss}>
        Don't show again
      </Button>
    </div>
  );
}

function InvoiceList({ filter }: { filter: InvoiceFilter }) {
  const config = useAppConfig();
  const me = useQuery(meQuery);
  const list = useInfiniteQuery({
    ...invoicesQuery(filter),
    refetchInterval: (query) => pollWhileLive(query.state.data),
  });

  // Once loaded, a failed refresh keeps the rows (and any open confirm dialog) on screen.
  if (list.data === undefined) {
    return list.isError ? (
      <ErrorState error={list.error} onRetry={() => void list.refetch()} />
    ) : (
      <LoadingState label="Loading invoices…" />
    );
  }
  const stale = list.isRefetchError ? (
    <RefreshError
      error={list.error}
      onRetry={pollWhileLive(list.data) ? undefined : () => void list.refetch()}
    />
  ) : null;

  const invoices = list.data.pages.flatMap((page) => page.items);
  if (invoices.length === 0) {
    return (
      <div className="space-y-4">
        {stale}
        {filter === "all" ? (
          <EmptyState title="No invoices yet.">
            Create one with the form. You get a pay link and a QR code the payer's wallet reads.
          </EmptyState>
        ) : (
          <EmptyState title="Nothing here.">
            No invoices have this status. Choose All invoices to see every one.
          </EmptyState>
        )}
      </div>
    );
  }
  const network = me.data?.merchant.network ?? "testnet";
  const explorer = config.data?.explorer_tx_url[network] ?? null;
  return (
    <div className="space-y-4">
      {stale}
      {/* A grid with one subgrid row per invoice, so the amount column lines up down the list. */}
      <ul className="divide-y divide-line border-b border-line sm:grid sm:grid-cols-[fit-content(15rem)_minmax(0,1fr)] sm:gap-x-6">
        {invoices.map((invoice) => (
          <InvoiceRow key={invoice.id} invoice={invoice} explorerTemplate={explorer} />
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          variant="ghost"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? "Loading…" : "Show older invoices"}
        </Button>
      ) : null}
    </div>
  );
}

export function InvoicesPage() {
  const me = useQuery(meQuery);
  const [filter, setFilter] = useState<InvoiceFilter>("all");
  const filterId = useId();
  const network = me.data?.merchant.network;
  const noAddress = me.data ? !me.data.merchant.receive_addresses[me.data.merchant.network] : false;

  return (
    <DeskPage
      title="Invoices"
      intro="Ask for an exact amount of ZEC. The invoice turns paid when a wallet scan finds the payment, or when you confirm it."
    >
      {network && !noAddress ? <DetectionOffNotice key={network} network={network} /> : null}
      <SplitLayout
        aside={
          <Panel title="New invoice">
            {me.data === undefined ? (
              me.isError ? (
                <ErrorState error={me.error} onRetry={() => void me.refetch()} />
              ) : (
                <LoadingState label="Loading your settings…" rows={2} />
              )
            ) : (
              <InvoiceForm
                noAddress={noAddress}
                addressLink={
                  <Link
                    to="/desk/settings/address"
                    className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4"
                  >
                    Add a {network} receive address
                  </Link>
                }
              />
            )}
          </Panel>
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line-strong pb-4">
          <h2 className="font-display text-3xl leading-none">
            {network === "mainnet" ? "Mainnet invoices" : "Testnet invoices"}
          </h2>
          <div className="flex w-full items-center gap-3 sm:w-auto">
            <label
              htmlFor={filterId}
              className="font-mono text-[0.7rem] tracking-[0.14em] text-faint uppercase"
            >
              Show
            </label>
            <Select
              id={filterId}
              className="min-w-0 flex-1 sm:w-52 sm:flex-none"
              value={filter}
              onChange={(event) => setFilter(event.target.value as InvoiceFilter)}
            >
              {FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <InvoiceList filter={filter} />
      </SplitLayout>
    </DeskPage>
  );
}
