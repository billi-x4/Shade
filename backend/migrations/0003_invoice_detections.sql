-- Scanner/wallet match claims for shielded invoices.
-- Shade does not store viewing keys, seeds, or ZIP-321 URIs here.
-- txid is unique globally so one chain tx cannot settle two invoices.

create table if not exists invoice_detections (
  id text primary key,
  merchant_id text not null references merchants (id),
  invoice_id text not null references invoices (id),
  txid text not null,
  pool text not null check (pool in ('orchard', 'sapling')),
  amount_zec numeric(20, 8) not null check (amount_zec > 0),
  memo_hash text not null,
  block_height bigint,
  observed_at timestamptz not null,
  source text not null check (
    source in ('merchant_device', 'external_scanner', 'shade_worker')
  ),
  created_at timestamptz not null default now(),
  unique (txid),
  unique (invoice_id, txid)
);

create index if not exists invoice_detections_merchant_idx
  on invoice_detections (merchant_id, created_at desc);

create index if not exists invoice_detections_invoice_idx
  on invoice_detections (invoice_id);
