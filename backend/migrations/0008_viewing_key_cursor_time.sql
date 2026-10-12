-- Chain time reached by the last successful hosted scan (block time of the cursor block).
-- Expired invoices stay scan candidates while expires_at > cursor_time - 70 minutes, so a detector that
-- lags behind the chain still matches payments mined before expiry. A key with a cursor but no recorded
-- time is treated as "unknown" for one pass (every expired invoice is kept), so no backfill is needed.
alter table merchant_viewing_keys add column if not exists cursor_time timestamptz;
