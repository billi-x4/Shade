-- Live charges per jar, kept by services/jars.ts: +1 in the charge's debit statement, -1 when a
-- charge is cancelled (both under the jar row's lock). The desk polls the jar list every 3 s; the
-- count it shows was a correlated count(*) over every charge of every listed jar, which grows with
-- each charge an agent ever made.
alter table jars add column if not exists charge_count integer not null default 0;

update jars j
set charge_count = (
  select count(*) from invoices i where i.jar_id = j.id and i.status = 'authorized'
);

alter table jars drop constraint if exists jars_charge_count_nonnegative;
alter table jars add constraint jars_charge_count_nonnegative check (charge_count >= 0) not valid;
