-- What "administrator" may do, defined once in has_role() so every policy and business action follows it:
--   an administrator passes any role check that names a senior role (supervisor, Hinduja management or clinical,
--   coordinator, medical desk), so it can see and do everything they can, including approvals and audit;
--   it does NOT match checks that name only restricted roles (agent, field staff, partner, platform admin). Those are
--   used to narrow or exclude (agent phone masking, field staff seeing only their visits, partners seeing only their
--   leads, the platform admin seeing no patient data), and an administrator must not be narrowed by them.
-- Managing logins was platform-admin only: is_user_admin() opens it to administrators too.
-- Expand only. The role name is compared as text: the enum value was added in the previous migration.

create or replace function has_role(variadic roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = any(roles)
      or (role::text = 'administrator'
          and roles && array['supervisor','client_manager','client_clinical','coordinator','medical_desk']::app_role[])
    from profiles where id = app_uid() and active), false)
$$;

/** Logins and their roles are managed by the platform admin and by administrators. */
create or replace function is_user_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role::text in ('admin', 'administrator') from profiles where id = app_uid() and active), false)
$$;

drop policy if exists profiles_admin on profiles;
create policy profiles_admin on profiles for all using (workspace_id = me_ws() and is_user_admin())
  with check (workspace_id = me_ws() and is_user_admin());

-- same guards as before, with administrators allowed where the platform admin was
create or replace function trg_profile_provider() returns trigger language plpgsql as $$
begin
  if new.role = 'provider' and new.provider_id is null then
    raise exception 'A service-provider login needs its provider (SecondMedic / Book My Medicare)' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.provider_id is distinct from old.provider_id and not (is_service() or is_user_admin()) then
    raise exception 'Only the platform admin or an administrator can change a user''s provider' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function trg_profile_guard() returns trigger
language plpgsql as $$
begin
  -- only requests made as a signed-in user (role caredesk_app) are limited; the Supabase SQL editor,
  -- migrations and the Worker's system connection are not
  if current_user <> 'caredesk_app' or is_service() or is_user_admin() then return new; end if;
  if new.myoperator_user_id is distinct from old.myoperator_user_id
     or new.myoperator_extension is distinct from old.myoperator_extension
     or new.agent_code is distinct from old.agent_code
     or new.active is distinct from old.active
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'Only the platform admin, an administrator or a supervisor (Settings > Telephony) can change calling details of a login' using errcode = 'P0001';
  end if;
  return new;
end $$;

grant execute on function has_role(app_role[]), is_user_admin() to caredesk_app;
