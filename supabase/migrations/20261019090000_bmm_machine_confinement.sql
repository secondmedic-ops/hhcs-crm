-- Dedicated BMM server accounts cannot use the human portal or generic patient-data surface.
alter table profiles add column if not exists integration_only boolean not null default false;

create or replace function integration_principal() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select integration_only from profiles where id = app_uid()), false)
$$;
revoke all on function integration_principal() from public;
grant execute on function integration_principal() to caredesk_app;

create or replace function guard_integration_profile() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.integration_only) or
     (tg_op = 'UPDATE' and new.integration_only is distinct from old.integration_only) then
    if not (is_service() or has_role('admin')) then
      raise exception 'Only the platform admin can change integration access' using errcode = '42501';
    end if;
  end if;
  if new.integration_only and (new.role <> 'provider' or not exists (
    select 1 from providers p where p.id = new.provider_id and p.workspace_id = new.workspace_id and p.code = 'BMM'
  )) then raise exception 'Integration-only accounts require a BMM provider in this workspace'; end if;
  return new;
end $$;
drop trigger if exists guard_integration_profile on profiles;
create trigger guard_integration_profile before insert or update on profiles
  for each row execute function guard_integration_profile();

-- Restrictive policies combine with existing workspace/provider policies. Only the explicitly scoped
-- SECURITY DEFINER BMM functions may disclose data to machine accounts. No grants are added.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' and rowsecurity loop
    execute format('drop policy if exists integration_confinement on public.%I', t);
    execute format('create policy integration_confinement on public.%I as restrictive for all to caredesk_app using (not integration_principal()) with check (not integration_principal())', t);
  end loop;
end $$;

-- Defence in depth for all provider logins, including human accounts, even if a permissive policy changes.
drop policy if exists provider_confidentiality on calls;
create policy provider_confidentiality on calls as restrictive for select to caredesk_app
  using (not has_role('provider'));
drop policy if exists provider_confidentiality on discharge_assessments;
create policy provider_confidentiality on discharge_assessments as restrictive for select to caredesk_app
  using (not has_role('provider'));
