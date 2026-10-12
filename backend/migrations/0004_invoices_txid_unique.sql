-- One chain txid may bind to at most one invoice (paste or detection).
-- Empty/null txid must not collide.

create unique index if not exists invoices_txid_unique
  on invoices (txid)
  where txid is not null;
