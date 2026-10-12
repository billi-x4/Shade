/**
 * Explicit snake_case → camelCase mappers, one per wire DTO. Every wire field is mapped; the SDK tests and
 * backend/test/sdk-contract.test.ts assert that nothing is dropped.
 */
import type {
  Grant,
  GrantCreated,
  Invoice,
  InvoiceDetection,
  Jar,
  JarChargeResult,
  Page,
  PayableInvoice,
  ShadeEvent,
  Tag,
  TagResolution,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from "./types.ts";
import type {
  WireGrant,
  WireGrantCreated,
  WireInvoice,
  WireInvoiceDetection,
  WireJar,
  WireJarChargeResult,
  WirePage,
  WireTag,
  WireTagResolution,
  WireWebhookEndpoint,
  WireWebhookEndpointCreated,
  WireWebhookEvent,
} from "./wire.ts";

export function mapPage<W, T>(page: WirePage<W>, mapItem: (item: W) => T): Page<T> {
  return { items: page.items.map(mapItem), nextCursor: page.next_cursor };
}

export function mapInvoiceDetection(d: WireInvoiceDetection): InvoiceDetection {
  return {
    state: d.state,
    txid: d.txid,
    pool: d.pool,
    source: d.source,
    blockHeight: d.block_height,
    confirmations: d.confirmations,
    requiredConfirmations: d.required_confirmations,
    observedAt: d.observed_at,
  };
}

export function mapInvoice(inv: WireInvoice): Invoice {
  return {
    id: inv.id,
    status: inv.status,
    verification: inv.verification,
    network: inv.network,
    amountZec: inv.amount_zec,
    memo: inv.memo,
    chainMemo: inv.chain_memo,
    memoHash: inv.memo_hash,
    tag: inv.tag,
    address: inv.address,
    zip321: inv.zip321,
    payUrl: inv.pay_url,
    txid: inv.txid,
    claimedTxid: inv.claimed_txid,
    createdHeight: inv.created_height,
    jarId: inv.jar_id,
    createdAt: inv.created_at,
    expiresAt: inv.expires_at,
    paidAt: inv.paid_at,
    detection: inv.detection === null ? null : mapInvoiceDetection(inv.detection),
  };
}

/** Invoices that are not jar charges always carry an address, a ZIP-321 URI and a pay URL (wire contract). */
export function mapPayableInvoice(inv: WireInvoice): PayableInvoice {
  return mapInvoice(inv) as PayableInvoice;
}

export function mapJar(jar: WireJar): Jar {
  return {
    id: jar.id,
    label: jar.label,
    status: jar.status,
    network: jar.network,
    capZec: jar.cap_zec,
    spentZec: jar.spent_zec,
    remainingZec: jar.remaining_zec,
    address: jar.address,
    chargeCount: jar.charge_count,
    createdAt: jar.created_at,
    killedAt: jar.killed_at,
    note: jar.note,
  };
}

export function mapJarChargeResult(charge: WireJarChargeResult): JarChargeResult {
  return {
    invoiceId: charge.invoice_id,
    jarId: charge.jar_id,
    amountZec: charge.amount_zec,
    memoHash: charge.memo_hash,
    remainingZec: charge.remaining_zec,
    status: charge.status,
    createdAt: charge.created_at,
  };
}

export function mapGrant(grant: WireGrant): Grant {
  return {
    id: grant.id,
    scope: grant.scope,
    network: grant.network,
    state: grant.state,
    createdAt: grant.created_at,
    expiresAt: grant.expires_at,
    revokedAt: grant.revoked_at,
    lastViewedAt: grant.last_viewed_at,
    note: grant.note,
  };
}

export function mapGrantCreated(grant: WireGrantCreated): GrantCreated {
  return { ...mapGrant(grant), token: grant.token, viewUrl: grant.view_url };
}

export function mapWebhookEndpoint(endpoint: WireWebhookEndpoint): WebhookEndpoint {
  return {
    id: endpoint.id,
    url: endpoint.url,
    network: endpoint.network,
    secretHint: endpoint.secret_hint,
    createdAt: endpoint.created_at,
    disabledAt: endpoint.disabled_at,
    disabledReason: endpoint.disabled_reason,
    failureCount: endpoint.failure_count,
    lastDeliveryAt: endpoint.last_delivery_at,
  };
}

export function mapWebhookEndpointCreated(
  endpoint: WireWebhookEndpointCreated,
): WebhookEndpointCreated {
  return { ...mapWebhookEndpoint(endpoint), secret: endpoint.secret };
}

export function mapTag(tag: WireTag): Tag {
  return {
    id: tag.id,
    name: tag.name,
    display: tag.display,
    network: tag.network,
    address: tag.address,
    createdAt: tag.created_at,
  };
}

export function mapTagResolution(tag: WireTagResolution): TagResolution {
  return { name: tag.name, network: tag.network, address: tag.address };
}

export function mapWebhookEvent(event: WireWebhookEvent): ShadeEvent {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.created_at,
    network: event.network,
    invoiceId: event.invoice_id,
    amountZec: event.amount_zec,
    memoHash: event.memo_hash,
    txid: event.txid,
    paidAt: event.paid_at,
    verification: event.verification,
  };
}
