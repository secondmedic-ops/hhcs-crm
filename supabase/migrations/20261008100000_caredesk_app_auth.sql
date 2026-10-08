-- CareDesk on the sb-spring-cf-stack pipeline: who is asking, as seen by the database.
-- The Worker verifies the Supabase login (ES256) and then, inside each request's transaction, sets
--   request.jwt.claim.sub  = the user's id      -> app_uid()
--   request.jwt.claim.role = 'service_role'     -> only for system work (MyOperator webhooks, cron, inbound email)
-- and switches to the role caredesk_app, so Row Level Security and the role checks in every RPC apply.
-- Nothing here depends on Supabase's auth schema, so the same migrations run on a plain local Postgres.

create or replace function public.app_uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function public.app_claim_role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '')
$$;

-- The role every user request runs as (never logs in; the Worker's database user switches to it).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'caredesk_app') then
    create role caredesk_app nologin;
  end if;
end $$;
grant caredesk_app to current_user;
-- the Worker connects as postgres (Supabase pooler user postgres.<ref>); make sure it may switch to caredesk_app
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'postgres') and current_user <> 'postgres' then
    execute 'grant caredesk_app to postgres';
  end if;
end $$;
