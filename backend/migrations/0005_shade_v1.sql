-- Shade v1 domain schema.
--   * per-tenant txid identity; payer pastes are claims (claimed_txid), never reservations
--   * unique on-chain memo per invoice (memo_ref -> chain_memo -> canonical ZIP-302 memo_hash)
--   * network-bound API keys, grants, tags and webhook endpoints
--   * transactional webhook outbox with leased deliveries
--   * hosted detection: viewing keys sealed to the worker, leased scans, detection states
--   * Stripe-style idempotency, fixed-window rate limits, worker heartbeats
-- Migrations 0001-0004 are immutable history. Every new CHECK/FK on a pre-existing table is added
-- NOT VALID (enforced for new rows) after the data it covers has been backfilled.

-- ---------------------------------------------------------------------------
-- Merchants
-- ---------------------------------------------------------------------------
-- Webhook secrets moved to per-endpoint, encrypted storage. The merchant-level secret is retired.
alter table merchants alter column webhook_secret drop not null;
update merchants set webhook_secret = null;
alter table merchants
  add constraint merchants_user_fk foreign key (user_id) references "user" ("id")
  on delete restrict not valid;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
alter table invoices add column if not exists claimed_txid text;
alter table invoices add column if not exists memo_ref text;
alter table invoices add column if not exists chain_memo text;
alter table invoices add column if not exists created_height bigint;
alter table invoices add column if not exists paid_height bigint;
alter table invoices drop column if exists webhook_sent_at;

-- The rehearsal (fake-paid) path is gone. Retire rehearsal and other non-chain rows.
update invoices set status = 'cancelled', verification = null, paid_at = null, txid = null
where verification in ('rehearsal', 'test', 'replay');

-- A pasted txid is a claim, not a settlement: move it out of the settled-txid column.
update invoices set claimed_txid = txid, txid = null where status = 'paid_unverified';

-- Canonical memo hash over the ZIP-302 512-byte memo field of the on-chain memo.
-- Legacy rows have no memo_ref, so their on-chain memo is the merchant memo itself.
update invoices
set memo_hash = 'sha256:' || encode(
  sha256(
    case
      when memo = '' then decode('f6' || repeat('00', 511), 'hex')
      else convert_to(memo, 'UTF8')
        || decode(repeat('00', 512 - octet_length(convert_to(memo, 'UTF8'))), 'hex')
    end
  ),
  'hex'
)
where memo_ref is null;

alter table invoices
  add constraint invoices_verification_check check (
    verification is null
    or verification in ('txid_unverified', 'merchant_accept', 'ivk_scan', 'jar_ledger')
  ) not valid;

-- Settled txids are unique per tenant and network (no cross-tenant squatting).
drop index if exists invoices_txid_unique;
create unique index if not exists invoices_paid_txid_unique
  on invoices (merchant_id, network, txid) where txid is not null;

-- Every new non-jar invoice carries a unique on-chain memo, so a scanner match is unambiguous.
create unique index if not exists invoices_memo_ref_unique
  on invoices (merchant_id, network, memo_hash) where memo_ref is not null;

create index if not exists invoices_open_expiry_idx on invoices (expires_at) where status = 'open';
create index if not exists invoices_jar_idx on invoices (jar_id, created_at desc) where jar_id is not null;
create index if not exists invoices_merchant_status_idx
  on invoices (merchant_id, network, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Detections
-- ---------------------------------------------------------------------------
alter table invoice_detections add column if not exists network text;
update invoice_detections d set network = i.network from invoices i where i.id = d.invoice_id;
alter table invoice_detections alter column network set not null;
alter table invoice_detections
  add constraint invoice_detections_network_check check (network in ('testnet', 'mainnet')) not valid;
alter table invoice_detections add column if not exists block_hash text;
alter table invoice_detections add column if not exists block_time timestamptz;
alter table invoice_detections add column if not exists confirmations integer;
alter table invoice_detections add column if not exists state text not null default 'settled';
alter table invoice_detections
  add constraint invoice_detections_state_check
  check (state in ('seen', 'settled', 'settled_after', 'late', 'orphaned')) not valid;
alter table invoice_detections add column if not exists updated_at timestamptz not null default now();
-- observed_at stays as "when Shade recorded it"; block_time carries chain time.

-- NU6.3: payments to Orchard receivers land in the Ironwood pool.
alter table invoice_detections drop constraint if exists invoice_detections_pool_check;
alter table invoice_detections
  add constraint invoice_detections_pool_check
  check (pool in ('ironwood', 'orchard', 'sapling')) not valid;

-- 0003 created auto-named UNIQUE constraints; replace them with per-tenant uniqueness.
alter table invoice_detections drop constraint if exists invoice_detections_txid_key;
alter table invoice_detections drop constraint if exists invoice_detections_invoice_id_txid_key;
create unique index if not exists invoice_detections_merchant_txid_unique
  on invoice_detections (merchant_id, network, txid);
create index if not exists invoice_detections_seen_idx
  on invoice_detections (network, block_height) where state = 'seen';

-- ---------------------------------------------------------------------------
-- API keys: bound to a network at issue time (agent keys take their jar's network).
-- ---------------------------------------------------------------------------
alter table api_keys add column if not exists network text;
update api_keys set network = case when prefix like 'sk\_live\_%' then 'mainnet' else 'testnet' end;
update api_keys k set network = j.network from jars j where k.jar_id = j.id;
alter table api_keys alter column network set not null;
alter table api_keys
  add constraint api_keys_network_check check (network in ('testnet', 'mainnet')) not valid;
alter table api_keys add column if not exists last4 text not null default '';
alter table api_keys add column if not exists last_used_at timestamptz;
alter table api_keys add column if not exists expires_at timestamptz;
create index if not exists api_keys_jar_idx on api_keys (jar_id) where jar_id is not null;

-- ---------------------------------------------------------------------------
-- Jars
-- ---------------------------------------------------------------------------
create index if not exists jars_merchant_idx on jars (merchant_id, network, created_at desc);

-- ---------------------------------------------------------------------------
-- Grants: network-bound, second-granularity durations (10 minutes .. 90 days).
-- ---------------------------------------------------------------------------
alter table grants add column if not exists network text;
update grants g set network = m.network from merchants m where m.id = g.merchant_id;
alter table grants alter column network set not null;
alter table grants
  add constraint grants_network_check check (network in ('testnet', 'mainnet')) not valid;
alter table grants add column if not exists duration_sec integer;
update grants set duration_sec = days * 86400 where duration_sec is null;
alter table grants alter column duration_sec set not null;
alter table grants
  add constraint grants_duration_check check (duration_sec between 600 and 7776000) not valid;
alter table grants alter column days drop not null;
alter table grants add column if not exists last_viewed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Tags (name.shade): resolve to the merchant address on one network.
-- ---------------------------------------------------------------------------
alter table tags add column if not exists network text;
update tags t set network = m.network from merchants m where m.id = t.merchant_id;
alter table tags alter column network set not null;
alter table tags
  add constraint tags_network_check check (network in ('testnet', 'mainnet')) not valid;
create index if not exists tags_merchant_idx on tags (merchant_id);

-- ---------------------------------------------------------------------------
-- Webhook endpoints: per-endpoint secret (AES-256-GCM ciphertext), network-bound.
-- ---------------------------------------------------------------------------
alter table webhook_endpoints add column if not exists network text;
update webhook_endpoints e set network = m.network from merchants m where m.id = e.merchant_id;
alter table webhook_endpoints alter column network set not null;
alter table webhook_endpoints
  add constraint webhook_endpoints_network_check check (network in ('testnet', 'mainnet')) not valid;
alter table webhook_endpoints add column if not exists secret_ciphertext text;
alter table webhook_endpoints add column if not exists secret_hint text not null default '';
alter table webhook_endpoints add column if not exists disabled_reason text;
alter table webhook_endpoints add column if not exists failure_count integer not null default 0;
alter table webhook_endpoints add column if not exists last_delivery_at timestamptz;
-- Legacy endpoints were signed with the retired merchant secret: disable until re-added.
update webhook_endpoints
set disabled_at = coalesce(disabled_at, now()),
    disabled_reason = coalesce(disabled_reason, 'legacy_secret')
where secret_ciphertext is null;
create index if not exists webhook_endpoints_active_idx
  on webhook_endpoints (merchant_id, network) where disabled_at is null;

-- ---------------------------------------------------------------------------
-- Webhook outbox
-- ---------------------------------------------------------------------------
create table if not exists webhook_events (
  id text primary key,
  merchant_id text not null references merchants (id),
  network text not null check (network in ('testnet', 'mainnet')),
  type text not null check (type in ('invoice.paid', 'webhook.test')),
  invoice_id text references invoices (id),
  -- Exact JSON bytes that are signed and re-sent on every attempt. Never a plaintext memo.
  payload text not null,
  created_at timestamptz not null default now()
);
-- Exactly one invoice.paid event per invoice (delivery itself is at-least-once).
create unique index if not exists webhook_events_invoice_paid_unique
  on webhook_events (invoice_id) where type = 'invoice.paid';
create index if not exists webhook_events_merchant_idx on webhook_events (merchant_id, created_at desc);

alter table webhook_deliveries add column if not exists event_id text references webhook_events (id);
alter table webhook_deliveries add column if not exists status text not null default 'pending';
update webhook_deliveries
set status = case when status_code between 200 and 299 then 'delivered' else 'dead' end
where event_id is null;
alter table webhook_deliveries
  add constraint webhook_deliveries_status_check
  check (status in ('pending', 'in_flight', 'delivered', 'failed', 'dead', 'cancelled')) not valid;
alter table webhook_deliveries add column if not exists attempt integer not null default 0;
alter table webhook_deliveries add column if not exists next_attempt_at timestamptz;
alter table webhook_deliveries add column if not exists locked_until timestamptz;
alter table webhook_deliveries add column if not exists lease_id text;
alter table webhook_deliveries add column if not exists delivered_at timestamptz;
alter table webhook_deliveries add column if not exists updated_at timestamptz not null default now();
alter table webhook_deliveries rename column status_code to last_status_code;
alter table webhook_deliveries rename column error to last_error;
-- Stop retaining signed bodies and signatures per attempt (the event row holds the payload).
alter table webhook_deliveries alter column body drop not null;
alter table webhook_deliveries alter column signature drop not null;
update webhook_deliveries set body = null, signature = null;
create unique index if not exists webhook_deliveries_event_endpoint_unique
  on webhook_deliveries (event_id, endpoint_id) where event_id is not null;
create index if not exists webhook_deliveries_due_idx
  on webhook_deliveries (next_attempt_at) where status in ('pending', 'failed');
create index if not exists webhook_deliveries_inflight_idx
  on webhook_deliveries (locked_until) where status = 'in_flight';
create index if not exists webhook_deliveries_endpoint_idx
  on webhook_deliveries (endpoint_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Hosted detection: viewing keys sealed to the worker's X25519 public key.
-- The API tier cannot decrypt sealed_key; deleting a key wipes the ciphertext.
-- ---------------------------------------------------------------------------
create table if not exists merchant_viewing_keys (
  id text primary key,
  merchant_id text not null references merchants (id),
  network text not null check (network in ('testnet', 'mainnet')),
  sealed_key text not null,
  seal_kid text not null,
  fingerprint text not null,
  key_address text not null,
  use_key_address boolean not null default true,
  cursor_height bigint,
  cursor_hash text,
  tip_height bigint,
  last_scan_at timestamptz,
  last_error text,
  next_scan_at timestamptz,
  scan_locked_until timestamptz,
  scan_lease text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists merchant_viewing_keys_active_unique
  on merchant_viewing_keys (merchant_id, network) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Idempotency keys (POST /v1 mutations), scoped to the API key, kept 24h.
-- Inserted in the same transaction as the mutation; a rolled-back request leaves no row.
-- ---------------------------------------------------------------------------
create table if not exists idempotency_keys (
  api_key_id text not null references api_keys (id),
  idem_key text not null,
  request_hash text not null,
  response_status integer not null,
  response_body text not null,
  created_at timestamptz not null default now(),
  primary key (api_key_id, idem_key)
);
create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- Fixed-window rate limit counters.
-- ---------------------------------------------------------------------------
create table if not exists rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null,
  primary key (bucket, window_start)
);
create index if not exists rate_limits_window_idx on rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Worker liveness (detector progress, outbox drain) for /readyz and honest UI copy.
-- ---------------------------------------------------------------------------
create table if not exists worker_heartbeats (
  name text primary key,
  last_seen_at timestamptz not null,
  info jsonb not null default '{}'::jsonb
);
