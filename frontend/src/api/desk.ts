import type {
  AddressSaved,
  ApiKey,
  ApiKeyCreated,
  ApiKeyKind,
  Grant,
  GrantCreated,
  Invoice,
  InvoiceStatus,
  Jar,
  JarCharge,
  Me,
  Network,
  Page,
  Tag,
  ViewingKeyStatus,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from "@shade/contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, path, withQuery } from "@/api/client";
import { qk } from "@/api/keys";

/* Desk API (/api/desk, session cookie). One function per endpoint (agents.md §4.10). */

const PAGE = "25";

function pageOptions<T>(key: readonly unknown[], base: string, extra: Record<string, string> = {}) {
  return infiniteQueryOptions({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<T>>(withQuery(base, { ...extra, cursor: pageParam, limit: PAGE }), signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<T>) => last.next_cursor,
  });
}

// Me & settings -----------------------------------------------------------------------------------

export const meQuery = queryOptions({
  queryKey: qk.me,
  queryFn: ({ signal }) => api.get<Me>("/api/desk/me", signal),
});

export const saveProfile = (display_name: string) =>
  api.put<Me>("/api/desk/settings/profile", { display_name });

export const saveAddress = (network: Network, address: string) =>
  api.put<AddressSaved>("/api/desk/settings/address", { network, address });

export const switchNetwork = (network: Network) =>
  api.put<Me>("/api/desk/settings/network", { network });

// Invoices ----------------------------------------------------------------------------------------

export type InvoiceFilter = "all" | Exclude<InvoiceStatus, "authorized">;

export const invoicesQuery = (filter: InvoiceFilter) =>
  pageOptions<Invoice>(
    qk.invoiceList(filter),
    "/api/desk/invoices",
    filter === "all" ? {} : { status: filter },
  );

export interface NewInvoice {
  amount_zec: string;
  memo?: string;
  tag?: string;
  expires_in_sec?: number;
}

export const createInvoice = (body: NewInvoice) => api.post<Invoice>("/api/desk/invoices", body);
export const cancelInvoice = (id: string) =>
  api.post<Invoice>(path`/api/desk/invoices/${id}/cancel`);
/** Confirms the payer's claim, or with `txid` a payment the merchant found in their own wallet. */
export const acceptInvoice = (id: string, txid?: string) =>
  api.post<Invoice>(path`/api/desk/invoices/${id}/accept`, txid ? { txid } : undefined);
export const rejectInvoice = (id: string) =>
  api.post<Invoice>(path`/api/desk/invoices/${id}/reject`);

/** The server returns at most this many jars or grants: every live one first, then the newest. */
export const LIST_CAP = 200;

// Jars --------------------------------------------------------------------------------------------

export const jarsQuery = queryOptions({
  queryKey: qk.jars,
  queryFn: ({ signal }) => api.get<Jar[]>("/api/desk/jars", signal),
});

export const jarChargesQuery = (jarId: string) =>
  pageOptions<JarCharge>(qk.jarCharges(jarId), path`/api/desk/jars/${jarId}/charges`);

export const createJar = (body: { cap_zec: string; label: string }) =>
  api.post<Jar>("/api/desk/jars", body);
export const killJar = (id: string) => api.post<Jar>(path`/api/desk/jars/${id}/kill`);
export const cancelJarCharge = (jarId: string, chargeId: string) =>
  api.post<Jar>(path`/api/desk/jars/${jarId}/charges/${chargeId}/cancel`);

// Grants ------------------------------------------------------------------------------------------

export const grantsQuery = queryOptions({
  queryKey: qk.grants,
  queryFn: ({ signal }) => api.get<Grant[]>("/api/desk/grants", signal),
});

export const createGrant = (body: { scope: string; expires_in_sec: number }) =>
  api.post<GrantCreated>("/api/desk/grants", body);
export const revokeGrant = (id: string) => api.post<Grant>(path`/api/desk/grants/${id}/revoke`);

// Webhooks ----------------------------------------------------------------------------------------

export const webhooksQuery = queryOptions({
  queryKey: qk.webhooks,
  queryFn: ({ signal }) => api.get<WebhookEndpoint[]>("/api/desk/webhooks", signal),
});

export const deliveriesQuery = pageOptions<WebhookDelivery>(
  qk.deliveries,
  "/api/desk/webhooks/deliveries",
);

export const createWebhook = (url: string) =>
  api.post<WebhookEndpointCreated>("/api/desk/webhooks", { url });
export const deleteWebhook = (id: string) => api.delete(path`/api/desk/webhooks/${id}`);
export const sendTestWebhook = () =>
  api.post<{ event_id: string; endpoints: number }>("/api/desk/webhooks/test");

// Tags --------------------------------------------------------------------------------------------

export const tagsQuery = queryOptions({
  queryKey: qk.tags,
  queryFn: ({ signal }) => api.get<Tag[]>("/api/desk/tags", signal),
});

export const createTag = (name: string) => api.post<Tag>("/api/desk/tags", { name });

// API keys ----------------------------------------------------------------------------------------

export const apiKeysQuery = queryOptions({
  queryKey: qk.apiKeys,
  queryFn: ({ signal }) => api.get<ApiKey[]>("/api/desk/keys", signal),
});

export interface NewApiKey {
  kind: ApiKeyKind;
  label: string;
  jar_id?: string;
  network?: Network;
}

export const createApiKey = (body: NewApiKey) => api.post<ApiKeyCreated>("/api/desk/keys", body);
export const revokeApiKey = (id: string) => api.post<ApiKey>(path`/api/desk/keys/${id}/revoke`);

// Viewing keys ------------------------------------------------------------------------------------

export const viewingKeysQuery = queryOptions({
  queryKey: qk.viewingKeys,
  queryFn: ({ signal }) => api.get<ViewingKeyStatus[]>("/api/desk/viewing-keys", signal),
});

export const uploadViewingKey = (network: Network, ufvk: string, use_key_address: boolean) =>
  api.put<ViewingKeyStatus>(path`/api/desk/viewing-keys/${network}`, { ufvk, use_key_address });
export const deleteViewingKey = (network: Network) =>
  api.delete(path`/api/desk/viewing-keys/${network}`);
