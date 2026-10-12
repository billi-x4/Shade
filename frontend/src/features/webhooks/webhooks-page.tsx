import type { Page, WebhookDelivery, WebhookEndpoint } from "@shade/contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, errorMessage } from "@/api/client";
import {
  createWebhook,
  deleteWebhook,
  deliveriesQuery,
  sendTestWebhook,
  webhooksQuery,
} from "@/api/desk";
import { qk } from "@/api/keys";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, TextInput } from "@/components/field";
import { EmptyState, ErrorState, LoadingState, RefreshError } from "@/components/states";
import { StatusText } from "@/components/status-text";
import { ActionStatus } from "@/features/desk/action-status";
import { useRevealSecret } from "@/features/desk/desk-context";
import { DeskPage, Panel, SplitLayout } from "@/features/desk/desk-page";
import { useDeskMutation } from "@/features/desk/use-desk-mutation";
import { formatDateTime, formatRelative, plural } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { deliveryErrorLabel, deliveryStatus, endpointDisabledLabel } from "@/lib/status";
import { checkWebhookUrl } from "@/lib/validation";

function EndpointForm() {
  const reveal = useRevealSecret();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const mutation = useDeskMutation({
    mutationFn: createWebhook,
    invalidate: () => [qk.webhooks],
    success: () => "Endpoint added. Copy its signing secret now; Shade shows it once.",
    onSuccess: (endpoint) => {
      setUrl("");
      reveal({
        title: "Signing secret",
        intro: (
          <>
            Shade signs every delivery to{" "}
            <span className="wrap-anywhere text-fg">{endpoint.url}</span> with this secret. It is
            shown once.
          </>
        ),
        items: [{ label: "Secret", value: endpoint.secret }],
        notes: [
          <>
            Verify <code className="text-fg">X-Shade-Signature-V2</code> on every request and drop
            events older than five minutes.{" "}
            <a
              href="/docs#webhooks"
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg underline underline-offset-4"
            >
              How to verify
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>,
        ],
      });
    },
  });
  const serverError =
    mutation.error instanceof ApiError && mutation.error.code === "BAD_URL"
      ? mutation.error.message
      : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next = checkWebhookUrl(url);
    setError(next);
    if (next) {
      ref.current?.focus();
      return;
    }
    mutation.mutate(url.trim());
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <Field
        label="Endpoint URL"
        hint="A public https URL on your server. Shade posts invoice.paid there, signed."
        error={error ?? serverError}
      >
        {(control) => (
          <TextInput
            {...control}
            ref={ref}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://shop.example/hooks/shade"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Adding…" : "Add endpoint"}
      </Button>
      {serverError ? null : <ActionStatus mutation={mutation} />}
    </form>
  );
}

function EndpointRow({ endpoint, now }: { endpoint: WebhookEndpoint; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useDeskMutation({
    mutationFn: () => deleteWebhook(endpoint.id),
    invalidate: () => [qk.webhooks, qk.deliveries],
    success: () => "Endpoint deleted.",
    onSuccess: () => setConfirming(false),
  });
  const disabled = endpoint.disabled_at !== null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-5">
      <div className="min-w-0 space-y-1">
        <p className="font-mono text-sm wrap-anywhere">{endpoint.url}</p>
        <p className="text-sm text-faint">
          Secret ends in <code className="text-muted">{endpoint.secret_hint}</code>
          {" · "}
          {endpoint.last_delivery_at
            ? `Last delivery ${formatRelative(endpoint.last_delivery_at, now)}`
            : "No deliveries yet"}
          {endpoint.failure_count > 0
            ? ` · ${plural(endpoint.failure_count, "failure")} in a row`
            : null}
        </p>
        {disabled ? (
          <p className="text-sm text-warn">{endpointDisabledLabel(endpoint.disabled_reason)}</p>
        ) : null}
        {confirming ? null : <ActionStatus mutation={mutation} />}
      </div>
      <div className="flex items-center gap-3">
        <StatusText
          status={disabled ? { label: "Off", tone: "muted" } : { label: "On", tone: "ok" }}
        />
        <Button variant="ghost" onClick={() => setConfirming(true)}>
          Delete
        </Button>
      </div>
      {confirming ? (
        <ConfirmDialog
          open
          title="Delete this endpoint?"
          confirmLabel="Delete endpoint"
          pendingLabel="Deleting…"
          pending={mutation.isPending}
          error={mutation.isError ? errorMessage(mutation.error) : null}
          onConfirm={() => mutation.mutate()}
          onCancel={() => {
            mutation.reset();
            setConfirming(false);
          }}
        >
          <p className="wrap-anywhere">Shade stops sending events to {endpoint.url}.</p>
          <p>Deliveries still waiting for this endpoint are cancelled. This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

function DeliveryRow({ delivery, now }: { delivery: WebhookDelivery; now: number }) {
  const status = deliveryStatus(delivery.status);
  return (
    <li className="space-y-1 py-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p>
          <code className="text-fg">{delivery.event_type}</code>
          <span className="text-faint"> · {formatRelative(delivery.created_at, now)}</span>
        </p>
        <StatusText status={status} />
      </div>
      <p className="font-mono text-xs text-faint wrap-anywhere">{delivery.endpoint_url}</p>
      <p className="text-muted">
        {plural(delivery.attempt, "attempt")}
        {delivery.last_status_code ? ` · last answer HTTP ${delivery.last_status_code}` : null}
        {delivery.delivered_at ? ` · delivered ${formatDateTime(delivery.delivered_at)}` : null}
        {delivery.status === "failed" && delivery.next_attempt_at
          ? ` · next try ${formatRelative(delivery.next_attempt_at, now)}`
          : null}
      </p>
      {delivery.last_error && delivery.status !== "delivered" ? (
        <p className="text-warn">{deliveryErrorLabel(delivery.last_error)}</p>
      ) : null}
    </li>
  );
}

function inFlight(data: InfiniteData<Page<WebhookDelivery>> | undefined): boolean {
  return (
    data?.pages.some((page) =>
      page.items.some((item) => item.status === "pending" || item.status === "in_flight"),
    ) ?? false
  );
}

function Deliveries() {
  const now = useNow(15_000);
  const list = useInfiniteQuery({
    ...deliveriesQuery,
    refetchInterval: (query) => (inFlight(query.state.data) ? 3_000 : false),
  });
  // Once loaded, a failed refresh keeps the rows on screen.
  if (list.data === undefined) {
    return list.isError ? (
      <ErrorState error={list.error} onRetry={() => void list.refetch()} />
    ) : (
      <LoadingState label="Loading deliveries…" />
    );
  }
  const stale = list.isRefetchError ? (
    <RefreshError
      error={list.error}
      onRetry={inFlight(list.data) ? undefined : () => void list.refetch()}
    />
  ) : null;
  const items = list.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <div className="space-y-4">
        {stale}
        <EmptyState title="No deliveries yet.">
          Press Send test to check your endpoint end to end.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {stale}
      <ul className="divide-y divide-line border-y border-line">
        {items.map((delivery) => (
          <DeliveryRow key={delivery.id} delivery={delivery} now={now} />
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          variant="ghost"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? "Loading…" : "Show older deliveries"}
        </Button>
      ) : null}
    </div>
  );
}

export function WebhooksPage() {
  const endpoints = useQuery(webhooksQuery);
  const now = useNow(30_000);
  const test = useDeskMutation({
    mutationFn: sendTestWebhook,
    invalidate: () => [qk.deliveries, qk.webhooks],
    success: (result) => `Test event sent to ${plural(result.endpoints, "endpoint")}.`,
  });
  const active = endpoints.data?.filter((endpoint) => endpoint.disabled_at === null) ?? [];
  const testHintId = useId();
  // Said on the page, not only in a tooltip: touch and keyboard users never see a title.
  const testHint =
    endpoints.data === undefined || active.length > 0
      ? null
      : endpoints.data.length === 0
        ? "Add an endpoint to send a test."
        : "Every endpoint is off. Add one that works to send a test.";

  return (
    <DeskPage
      title="Webhooks"
      intro="Shade tells your server when an invoice is paid, with a signed invoice.paid event. Up to five endpoints per network."
    >
      <SplitLayout
        aside={
          <Panel title="New endpoint">
            <EndpointForm />
          </Panel>
        }
      >
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-serif text-2xl">Endpoints</h2>
            <Button
              variant="ghost"
              onClick={() => test.mutate()}
              disabled={test.isPending || active.length === 0}
              aria-describedby={testHint ? testHintId : undefined}
            >
              {test.isPending ? "Sending…" : "Send test"}
            </Button>
          </div>
          {testHint ? (
            <p id={testHintId} className="text-sm text-muted">
              {testHint}
            </p>
          ) : null}
          <ActionStatus
            mutation={test}
            successText={
              test.data ? `Sent webhook.test to ${plural(test.data.endpoints, "endpoint")}.` : null
            }
          />
          {endpoints.data && endpoints.isRefetchError ? (
            <RefreshError error={endpoints.error} onRetry={() => void endpoints.refetch()} />
          ) : null}
          {endpoints.data === undefined ? (
            endpoints.isError ? (
              <ErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
            ) : (
              <LoadingState label="Loading endpoints…" rows={2} />
            )
          ) : endpoints.data.length === 0 ? (
            <EmptyState title="No endpoints yet.">
              Add your server's URL to get a signed event when an invoice is paid.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {endpoints.data.map((endpoint) => (
                <EndpointRow key={endpoint.id} endpoint={endpoint} now={now} />
              ))}
            </ul>
          )}
        </section>
        <section className="space-y-4">
          <h2 className="font-serif text-2xl">Deliveries</h2>
          <Deliveries />
        </section>
      </SplitLayout>
    </DeskPage>
  );
}
