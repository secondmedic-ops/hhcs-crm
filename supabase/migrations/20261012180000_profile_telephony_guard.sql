-- =====================================================================
-- CareDesk CRM  |  Guard the calling identity on a login
-- A user may update their own profile row (profiles_self), which let any
-- login set its own MyOperator user id: an agent could take another agent's
-- MyOperator id and place calls as them. The calling identity and account
-- fields now change only through the admin, or the Worker's system
-- connection (Settings > Telephony, supervisor or admin).
-- =====================================================================

create or replace function trg_profile_guard() returns trigger
language plpgsql as $$
begin
  -- only requests made as a signed-in user (role caredesk_app) are limited; the Supabase SQL editor,
  -- migrations and the Worker's system connection are not
  if current_user <> 'caredesk_app' or is_service() or has_role('admin') then return new; end if;
  if new.myoperator_user_id is distinct from old.myoperator_user_id
     or new.myoperator_extension is distinct from old.myoperator_extension
     or new.agent_code is distinct from old.agent_code
     or new.active is distinct from old.active
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'Only the platform admin or a supervisor (Settings > Telephony) can change calling details of a login' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists profile_guard on profiles;
create trigger profile_guard before update on profiles for each row execute function trg_profile_guard();
