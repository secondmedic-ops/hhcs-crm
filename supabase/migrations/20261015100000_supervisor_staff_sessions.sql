-- A supervisor (or an administrator) keeps their own authenticated login while operating with a staff member's RLS
-- permissions. Records show "Staff Name - Supervisor (Name)", or "- Administrator (Name)" when an administrator opened it.
create table if not exists staff_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  supervisor_id uuid not null references profiles(id),
  staff_id uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  ended_at timestamptz,
  check (supervisor_id <> staff_id)
);
alter table staff_sessions enable row level security;
revoke all on staff_sessions from public, caredesk_app;
create index if not exists staff_sessions_owner on staff_sessions(supervisor_id, expires_at) where ended_at is null;

alter table audit_log add column if not exists staff_id uuid references profiles(id);
alter table audit_log add column if not exists staff_session_id uuid references staff_sessions(id);
alter table access_log add column if not exists staff_id uuid references profiles(id);
alter table access_log add column if not exists staff_session_id uuid references staff_sessions(id);

-- Keep the real supervisor as the accountable actor. The selected staff ID is separate, never inferred from a name.
create or replace function stamp_staff_session() returns trigger
language plpgsql security definer set search_path = public as $$
declare s staff_sessions%rowtype; v text := current_setting('caredesk.staff_session', true);
begin
  if nullif(v, '') is null then return new; end if;
  select * into s from staff_sessions where id = v::uuid;
  if not found then raise exception 'Invalid staff session'; end if;
  if new.workspace_id is distinct from s.workspace_id then raise exception 'Staff session workspace mismatch'; end if;
  if tg_table_name = 'interactions' then
    new.actor_label := (select full_name from profiles where id = s.staff_id) || ' - ' ||
      (select case when role::text = 'administrator' then 'Administrator' else 'Supervisor' end || ' (' || full_name || ')' from profiles where id = s.supervisor_id);
    new.meta := coalesce(new.meta, '{}'::jsonb) || jsonb_build_object('supervisor_id', s.supervisor_id, 'staff_id', s.staff_id, 'staff_session_id', s.id);
  else
    new.staff_id := s.staff_id; new.staff_session_id := s.id;
    if tg_table_name = 'audit_log' then new.actor_id := s.supervisor_id;
    else new.user_id := s.supervisor_id; end if;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['audit_log','access_log','interactions'] loop
    execute format('drop trigger if exists stamp_staff_session on %I', t);
    execute format('create trigger stamp_staff_session before insert on %I for each row execute function stamp_staff_session()', t);
  end loop;
  foreach t in array array['staff_sessions'] loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;

-- Explicit lists preserve the existing view column order; new columns go at the end.
create or replace view v_audit with (security_invoker = true) as
select l.id, l.workspace_id, l.table_name, l.record_id, l.action, l.changes, l.actor_id, l.at,
  case when l.staff_id is null then pr.full_name else st.full_name || ' - ' || case when pr.role::text = 'administrator' then 'Administrator' else 'Supervisor' end || ' (' || pr.full_name || ')' end as actor_name,
  pr.role as actor_role, l.staff_id, l.staff_session_id
from audit_log l left join profiles pr on pr.id = l.actor_id left join profiles st on st.id = l.staff_id;
create or replace view v_access with (security_invoker = true) as
select l.id, l.workspace_id, l.user_id, l.action, l.entity, l.entity_id, l.meta, l.at,
  case when l.staff_id is null then pr.full_name else st.full_name || ' - ' || case when pr.role::text = 'administrator' then 'Administrator' else 'Supervisor' end || ' (' || pr.full_name || ')' end as user_name,
  pr.role as user_role, l.staff_id, l.staff_session_id
from access_log l left join profiles pr on pr.id = l.user_id left join profiles st on st.id = l.staff_id;
grant select on v_audit, v_access to caredesk_app;
