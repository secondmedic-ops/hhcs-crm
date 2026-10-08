-- Live screens without Supabase Realtime: every statement that changes a table notes the table name for the
-- current transaction. The Worker reads the list before commit and tells the live-updates hub (a Durable Object),
-- which pushes {"tables": [...]} to open screens. Only table names travel, never row data.
create or replace function public.note_change() returns trigger
language plpgsql as $$
declare cur text := coalesce(current_setting('caredesk.changed', true), '');
begin
  if position(',' || tg_table_name || ',' in cur || ',') = 0 then
    perform set_config('caredesk.changed', cur || ',' || tg_table_name, true);
  end if;
  return null;
end $$;
grant execute on function public.note_change() to caredesk_app;

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename not in ('webhook_events', 'case_counters') loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;

-- Deployment log written by the pipeline (step 7), same as every project on the stack.
create table if not exists public.deployments (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  sha     text not null,
  subject text,
  author  text,
  areas   text,
  status  text not null,
  run_url text
);
alter table public.deployments enable row level security;
revoke all on public.deployments from caredesk_app;
