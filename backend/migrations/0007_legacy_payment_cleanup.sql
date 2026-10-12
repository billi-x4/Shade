-- Legacy (v0) payment rows that 0005 left behind. 0005 is applied in the field and immutable.
--
-- 1. Accepted rehearsals. v0 rehearse() wrote paid_unverified + 'rehearsal' with no txid, and
--    acceptUnverified() skipped the txid check for it and set paid + 'merchant_accept'. 0005 only
--    retired verification 'rehearsal', so these stayed paid and were served (and exported) as
--    verified grant receipts for a payment that never happened on chain. In v1 every non-jar paid
--    row carries a txid (ivk_scan and merchant_accept both write it), so this matches exactly the
--    leftovers.
update invoices
set status = 'cancelled', verification = null, paid_at = null
where jar_id is null and status = 'paid' and txid is null;

-- 2. Payer pastes. v0 submitTxid() set paid_at on paste; 0005 moved the txid to claimed_txid but
--    kept paid_at, so a rejected, reverted or expired claim showed an unpaid invoice with a payment
--    time. Only a settled invoice has one (v1 writes paid_at only when it settles to paid). Jar
--    charges keep theirs: receipts use paid_at, falling back to created_at.
update invoices
set paid_at = null
where jar_id is null and status <> 'paid' and paid_at is not null;

-- Keep it that way for new rows (NOT VALID, per the convention for CHECKs on existing tables).
alter table invoices
  add constraint invoices_paid_at_settled_check
  check (paid_at is null or status = 'paid' or jar_id is not null) not valid;
