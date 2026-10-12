-- Chain-time baseline of a viewing key that has not completed a scan yet: the time this key was
-- first uploaded, carried over when the same key is uploaded again (services/viewing-keys.ts).
-- Null means the row's own created_at. The detector keeps expired invoices as candidates from
-- this point (worker/repo.ts SCANNED_THROUGH), so re-uploading a key whose first scans failed
-- does not drop invoices that expired in the meantime.
alter table merchant_viewing_keys add column if not exists scan_from timestamptz;
