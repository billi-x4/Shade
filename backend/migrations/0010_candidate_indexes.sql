-- Indexes for the hosted detector's per-pass candidate queries (worker/repo.ts):
--   * memo lookup of candidates by (merchant, network, memo_hash) — legacy rows have memo_ref null, so
--     invoices_memo_ref_unique (partial on memo_ref is not null) cannot serve it;
--   * the expired-candidate window (expires_at within 70 minutes of the scanned chain time).
-- Measured on Postgres 18 with 1.15M invoices (one merchant: 300k expired, 200k paid, 2k open):
-- range planning 118-250 ms -> 0.2-0.6 ms, memo lookup 86-136 ms -> 0.1 ms.
create index if not exists invoices_candidate_memo_idx
  on invoices (merchant_id, network, memo_hash) where jar_id is null;

create index if not exists invoices_expired_candidate_idx
  on invoices (merchant_id, network, expires_at) where status = 'expired' and jar_id is null;
