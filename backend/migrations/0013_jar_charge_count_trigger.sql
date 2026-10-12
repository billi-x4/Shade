-- jars.charge_count kept by the database: triggers on invoices count each jar's live ('authorized')
-- charges. Application-side upkeep (0012) drifted while API processes from before 0012 kept charging
-- during a rolling deploy, and a cancel of such a charge then broke the non-negative check. A
-- trigger runs whatever code writes the row.
create or replace function shade_jar_charge_count() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' and old.jar_id is not null and old.status = 'authorized' then
    update jars set charge_count = charge_count - 1 where id = old.jar_id;
  end if;
  if tg_op <> 'DELETE' and new.jar_id is not null and new.status = 'authorized' then
    update jars set charge_count = charge_count + 1 where id = new.jar_id;
  end if;
  return null;
end;
$$;

-- CREATE TRIGGER waits for transactions already writing invoices and holds off new ones until this
-- migration commits, so the backfill below counts exactly what the triggers will keep up to date.
drop trigger if exists invoices_jar_charge_insert on invoices;
create trigger invoices_jar_charge_insert after insert on invoices
  for each row when (new.jar_id is not null and new.status = 'authorized')
  execute function shade_jar_charge_count();

drop trigger if exists invoices_jar_charge_update on invoices;
create trigger invoices_jar_charge_update after update of status, jar_id on invoices
  for each row when (old.status is distinct from new.status or old.jar_id is distinct from new.jar_id)
  execute function shade_jar_charge_count();

drop trigger if exists invoices_jar_charge_delete on invoices;
create trigger invoices_jar_charge_delete after delete on invoices
  for each row when (old.jar_id is not null and old.status = 'authorized')
  execute function shade_jar_charge_count();

update jars j
set charge_count = (
  select count(*) from invoices i where i.jar_id = j.id and i.status = 'authorized'
);
