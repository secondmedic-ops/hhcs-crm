-- MyOperator connection entered in the app (Settings > Telephony), instead of only GitHub secrets.
-- Values here win over the Worker's MYOPERATOR_* secrets; an empty value falls back to the secret.
-- Only the Worker's system connection reads this table: no policies, and caredesk_app / anon / authenticated get nothing,
-- so no screen query can ever read a credential. Screens only see which fields are set (and the last 4 characters).

create table if not exists integration_settings (
  provider    text primary key,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

alter table integration_settings enable row level security;
revoke all on integration_settings from caredesk_app;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on integration_settings from %I', r);
    end if;
  end loop;
end $$;

-- Hinduja helpline on MyOperator: +91 80493 68621. Replaces the two placeholder lines from the first setup only if they
-- were never edited in Settings > Workspace.
update workspaces
   set settings = jsonb_set(jsonb_set(settings,
         '{did_numbers}', '["+918049368621"]'::jsonb),
         '{did_labels}', '{"+918049368621": "Hinduja helpline"}'::jsonb)
 where code = 'HHC'
   and settings->'did_numbers' = '["+912240000000","+912240000001"]'::jsonb;
