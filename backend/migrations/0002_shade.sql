-- Shade v0: invoices, jars, grants, tags, webhooks.
-- Amounts are ZEC decimal strings (numeric). No seeds. No raw view keys.

create table if not exists merchants (
  id text primary key,
  user_id text not null unique,
  display_name text not null default '',
  network text not null default 'testnet' check (network in ('testnet', 'mainnet')),
  ua_testnet text,
  ua_mainnet text,
  webhook_secret text not null,
  created_at timestamptz not null default now()
);

create table if not exists jars (
  id text primary key,
  merchant_id text not null references merchants (id),
  label text not null,
  cap_zec numeric(20, 8) not null check (cap_zec > 0),
  spent_zec numeric(20, 8) not null default 0 check (spent_zec >= 0),
  status text not null default 'open' check (status in ('open', 'killed')),
  address text not null,
  network text not null check (network in ('testnet', 'mainnet')),
  created_at timestamptz not null default now(),
  killed_at timestamptz,
  check (spent_zec <= cap_zec)
);

create table if not exists api_keys (
  id text primary key,
  merchant_id text not null references merchants (id),
  kind text not null check (kind in ('merchant', 'agent')),
  jar_id text references jars (id),
  prefix text not null,
  key_hash text not null unique,
  label text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (
    (kind = 'merchant' and jar_id is null)
    or (kind = 'agent' and jar_id is not null)
  )
);

create index if not exists api_keys_merchant_idx on api_keys (merchant_id);

create table if not exists tags (
  id text primary key,
  merchant_id text not null references merchants (id),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists invoices (
  id text primary key,
  merchant_id text not null references merchants (id),
  jar_id text references jars (id),
  amount_zec numeric(20, 8) not null check (amount_zec > 0),
  memo text not null default '',
  memo_hash text not null,
  tag text,
  network text not null check (network in ('testnet', 'mainnet')),
  address text not null,
  zip321 text not null,
  status text not null check (
    status in ('open', 'paid', 'paid_unverified', 'authorized', 'expired', 'cancelled')
  ),
  verification text,
  txid text,
  expires_at timestamptz not null,
  paid_at timestamptz,
  webhook_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists invoices_merchant_idx on invoices (merchant_id, created_at desc);

create table if not exists grants (
  id text primary key,
  merchant_id text not null references merchants (id),
  scope text not null,
  days integer not null check (days between 1 and 90),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists grants_merchant_idx on grants (merchant_id);

create table if not exists webhook_endpoints (
  id text primary key,
  merchant_id text not null references merchants (id),
  url text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create index if not exists webhook_endpoints_merchant_idx on webhook_endpoints (merchant_id);

create table if not exists webhook_deliveries (
  id text primary key,
  merchant_id text not null references merchants (id),
  endpoint_id text,
  invoice_id text,
  event_type text not null,
  body text not null,
  signature text not null,
  status_code integer,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists webhook_deliveries_merchant_idx
  on webhook_deliveries (merchant_id, created_at desc);
