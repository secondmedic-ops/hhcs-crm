-- MIS e-mail through Gmail SMTP: one send per snapshot (expand only, idempotent).
-- email_status: sending (claimed by a cron run) | accepted (Gmail accepted it; not proof of inbox delivery)
--             | failed (refused or not reached; reason in email_error, no addresses or secrets)
--             | unknown (connection lost after the message was handed over; never re-sent automatically)
alter table mis_snapshots add column if not exists email_status text;
alter table mis_snapshots add column if not exists email_attempted_at timestamptz;
alter table mis_snapshots add column if not exists emailed_at timestamptz;
alter table mis_snapshots add column if not exists email_error text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'mis_snapshots_email_status_check') then
    alter table mis_snapshots add constraint mis_snapshots_email_status_check
      check (email_status is null or email_status in ('sending', 'accepted', 'failed', 'unknown'));
  end if;
end $$;
