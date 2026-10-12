-- One transaction can pay several invoices of the same merchant: the scanner reports one payment per
-- (txid, memo group), and each memo group settles at most one invoice. Settled txids and detections are
-- therefore unique per (merchant, network, txid, memo_hash) instead of per txid. Merchant Confirm stays
-- txid-wide; settlement checks it under a per-txid advisory lock.
-- Existing rows already satisfy the stricter per-txid uniqueness, so the new indexes always build.
create unique index if not exists invoice_detections_memo_group_unique
  on invoice_detections (merchant_id, network, txid, memo_hash);
drop index if exists invoice_detections_merchant_txid_unique;

create unique index if not exists invoices_paid_memo_group_unique
  on invoices (merchant_id, network, txid, memo_hash) where txid is not null;
drop index if exists invoices_paid_txid_unique;
