-- Live updates only for real changes (21 Oct 2026). The change notes of 20261008100600_live_change_tracking were
-- statement triggers: they fire even when an UPDATE / DELETE matches no row. The minute cron (SLA scan, missed-call
-- sweep, AI backlog) runs such statements every minute, so every open screen reloaded every minute. That used up the
-- Hyperdrive free plan (100,000 queries a day per Cloudflare account) and the site showed "Database is unavailable".
-- Now the trigger is per row: a table is noted only when a row was inserted, updated or deleted.
--
-- track_changes() (re)installs the trigger on every public table except webhook_events / case_counters. A migration
-- that adds a table calls `select public.track_changes();` instead of copying the old DO block (that block made the
-- triggers per statement again).
create or replace function public.track_changes() returns void
language plpgsql as $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename not in ('webhook_events', 'case_counters') loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each row execute function public.note_change()', t);
  end loop;
end $$;
revoke all on function public.track_changes() from public;

select public.track_changes();
