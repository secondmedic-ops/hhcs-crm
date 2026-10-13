-- =====================================================================
-- CareDesk CRM  |  Callback auto-dialer (Hinduja MoM, Oct 2026)
--   * agents mark themselves Available; the dialer only rings free, linked, available agents
--   * workspace setting: auto-dial on/off, buffer 30 / 45 / 60 min, attempts (1-5)
--   * a missed / abandoned caller is dialled as soon as an agent is free, retried evenly across the
--     buffer, and marked unreachable when the buffer runs out
--   * a callback is done the moment the patient connects (dashboard "Callbacks pending" drops live)
-- Expand only: new nullable / defaulted columns, new functions.
-- =====================================================================

alter table profiles  add column if not exists available        boolean not null default false;
alter table profiles  add column if not exists available_since  timestamptz;
alter table profiles  add column if not exists last_autodial_at timestamptz;
alter table callbacks add column if not exists next_attempt_at  timestamptz;
alter table callbacks add column if not exists auto_dialled     boolean not null default false;
alter table calls     add column if not exists callback_id      uuid references callbacks(id) on delete set null;
create index if not exists idx_callbacks_queue on callbacks(workspace_id, status, next_attempt_at);
create index if not exists idx_calls_callback on calls(callback_id) where callback_id is not null;

-- The workspace's auto-dial settings, with defaults (off, 30 min, 3 attempts).
create or replace function autodial_cfg(p_ws uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enabled',       coalesce((w.settings->'autodial'->>'enabled')::boolean, false),
    'buffer_minutes', coalesce((w.settings->'autodial'->>'buffer_minutes')::int, 30),
    'max_attempts',  coalesce((w.settings->'autodial'->>'max_attempts')::int, 3))
  from workspaces w where w.id = p_ws
$$;

-- Supervisors (and the admin / Hinduja manager) change the auto-dial settings.
create or replace function set_autodial(p_enabled boolean, p_buffer_minutes int, p_max_attempts int default 3) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws();
begin
  if not has_role('supervisor','admin','client_manager') then raise exception 'Only a supervisor can change the auto-dialer'; end if;
  if p_buffer_minutes not in (30, 45, 60) then raise exception 'Buffer must be 30, 45 or 60 minutes'; end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 5 then raise exception 'Attempts must be between 1 and 5'; end if;
  update workspaces set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('autodial',
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'buffer_minutes', p_buffer_minutes, 'max_attempts', p_max_attempts))
  where id = v_ws;
  insert into access_log(workspace_id, user_id, action, entity, entity_id, meta)
  values (v_ws, app_uid(), 'settings_changed', 'autodial', v_ws::text, autodial_cfg(v_ws));
  return autodial_cfg(v_ws);
end $$;

-- An operations user sets their own availability for auto-dialled callbacks.
create or replace function set_my_availability(p_available boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r profiles;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  update profiles set available = coalesce(p_available, false),
    available_since = case when coalesce(p_available, false) then now() end
  where id = app_uid() returning * into r;
  return jsonb_build_object('available', r.available, 'available_since', r.available_since,
    'linked', r.myoperator_user_id is not null);
end $$;

-- A new missed / abandoned callback: due at the end of the buffer when auto-dial is on, dialled right away.
create or replace function trg_callback_schedule() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := autodial_cfg(new.workspace_id);
begin
  if (cfg->>'enabled')::boolean and new.status = 'pending' then
    new.due_at := new.created_at + make_interval(mins => (cfg->>'buffer_minutes')::int);
    new.next_attempt_at := coalesce(new.next_attempt_at, new.created_at);
  end if;
  return new;
end $$;
drop trigger if exists callback_schedule on callbacks;
create trigger callback_schedule before insert on callbacks for each row execute function trg_callback_schedule();

-- A dial for a callback did not reach the patient (rejected, not answered, agent busy):
-- back to the queue with the next attempt spread across the buffer, or unreachable once attempts or buffer run out.
create or replace function callback_retry(p_id uuid, p_reason text default null) returns text
language plpgsql security definer set search_path = public as $$
declare cb callbacks; cfg jsonb; v_gap interval; v_next timestamptz;
begin
  select * into cb from callbacks where id = p_id for update;
  if cb.id is null or cb.status <> 'in_progress' then return coalesce(cb.status, 'missing'); end if;
  cfg := autodial_cfg(cb.workspace_id);
  if not (cfg->>'enabled')::boolean then
    update callbacks set status = 'pending' where id = p_id;      -- manual queue: the agent decides what next
    return 'pending';
  end if;
  v_gap := greatest(interval '2 minutes', make_interval(mins => (cfg->>'buffer_minutes')::int) / (cfg->>'max_attempts')::int);
  v_next := coalesce(cb.last_attempt_at, now()) + v_gap;
  if cb.attempts >= (cfg->>'max_attempts')::int or v_next >= cb.due_at then
    update callbacks set status = 'unreachable', completed_at = now(), next_attempt_at = null,
      notes = concat_ws(E'\n', nullif(notes, ''), format('Auto-dialer: not reached after %s attempt(s)%s', attempts, coalesce(' · ' || p_reason, '')))
    where id = p_id;
    return 'unreachable';
  end if;
  update callbacks set status = 'pending', next_attempt_at = v_next where id = p_id;
  return 'pending';
end $$;

-- The patient picked up: the callback is done now, not when the call ends.
create or replace function callback_connected(p_call uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c calls; n int;
begin
  select * into c from calls where id = p_call;
  if c.id is null or c.direction <> 'outbound' then return 0; end if;
  update callbacks set status = 'done', completed_at = now(), completed_by = c.agent_id, next_attempt_at = null
  where workspace_id = c.workspace_id and status in ('pending','in_progress')
    and (id = c.callback_id or (c.customer_number is not null and number = c.customer_number));
  get diagnostics n = row_count;
  return n;
end $$;

-- One dialling round for the scheduler (system connection only). Recovers stuck attempts, then pairs each due
-- callback with the free agent who has waited longest, marks both and writes the outbound call row.
-- Returns what the Worker must dial. SKIP LOCKED keeps two overlapping runs from dialling the same callback.
create or replace function autodial_claim() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cb record; ag record; v_out jsonb := '[]'::jsonb; v_call uuid; v_ref text; cfg jsonb;
begin
  if not is_service() then raise exception 'System only'; end if;

  -- an attempt with no answer and no end event after 5 minutes is treated as not reached
  for cb in select b.id from callbacks b
            where b.status = 'in_progress' and b.auto_dialled and b.last_attempt_at < now() - interval '5 minutes'
              and not exists (select 1 from calls k where k.callback_id = b.id and k.status = 'answered')
            for update skip locked loop
    update calls set status = 'failed', ended_at = now() where callback_id = cb.id and status = 'ringing';
    perform callback_retry(cb.id, 'no response from the line');
  end loop;

  -- buffer over and never dialled (no agent was free): unreachable, the supervisor sees it in the SLA escalations
  update callbacks b set status = 'unreachable', completed_at = now(), next_attempt_at = null,
    notes = concat_ws(E'\n', nullif(b.notes, ''), 'Auto-dialer: no agent free within the buffer')
  where b.status = 'pending' and b.next_attempt_at is not null and b.due_at < now()
    and (autodial_cfg(b.workspace_id)->>'enabled')::boolean;

  for cb in select b.* from callbacks b
            where b.status = 'pending' and b.next_attempt_at is not null and b.next_attempt_at <= now()
              and (autodial_cfg(b.workspace_id)->>'enabled')::boolean
            order by b.due_at, b.created_at
            for update skip locked loop
    select p.id, p.full_name, p.myoperator_user_id into ag from profiles p
    where p.workspace_id = cb.workspace_id and p.active and p.available and p.myoperator_user_id is not null
      and p.role in ('agent','coordinator','supervisor')
      and not exists (select 1 from calls k where k.agent_id = p.id and k.status in ('ringing','answered')
                        and k.started_at > now() - interval '30 minutes')
      and not exists (select 1 from callbacks o where o.assigned_to = p.id and o.status = 'in_progress'
                        and o.last_attempt_at > now() - interval '5 minutes')
    order by p.last_autodial_at nulls first, p.available_since
    limit 1 for update of p skip locked;
    continue when ag.id is null;              -- nobody free for this workspace now: try again next minute

    v_ref := 'crm-auto-' || gen_random_uuid();
    update callbacks set status = 'in_progress', assigned_to = ag.id, attempts = attempts + 1,
      last_attempt_at = now(), auto_dialled = true where id = cb.id;
    update profiles set last_autodial_at = now() where id = ag.id;
    insert into calls (workspace_id, direction, customer_number, agent_id, agent_name, status, patient_id, session_id,
      click_to_call_ref, callback_id)
    values (cb.workspace_id, 'outbound', cb.number, ag.id, ag.full_name, 'ringing', cb.patient_id, v_ref, v_ref, cb.id)
    returning id into v_call;
    v_out := v_out || jsonb_build_array(jsonb_build_object('callback_id', cb.id, 'call_id', v_call, 'ref', v_ref,
      'number', cb.number, 'agent_id', ag.id, 'myoperator_user_id', ag.myoperator_user_id));
  end loop;
  return v_out;
end $$;

-- the queue shows when the next automatic attempt is due
create or replace view v_callbacks with (security_invoker = true) as
select cb.id, cb.workspace_id, cb.call_id, cb.reason, cb.due_at, cb.status, cb.assigned_to, cb.attempts,
  cb.last_attempt_at, cb.completed_at, cb.created_at, cb.patient_id,
  case when has_role('agent') then mask_mobile(cb.number) else cb.number end as number,
  p.full_name as patient_name, pr.full_name as assignee_name,
  (select c.id from cases c where c.patient_id = cb.patient_id and c.stage not in ('closed','cancelled') order by c.created_at desc limit 1) as open_case_id,
  cb.next_attempt_at, cb.auto_dialled
from callbacks cb
left join patients p on p.id = cb.patient_id
left join profiles pr on pr.id = cb.assigned_to;
grant select on v_callbacks to caredesk_app;

-- Settings screen and the agent's Available switch: the settings plus who is free and what is waiting.
create or replace function autodial_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws();
begin
  if not (is_ops() or has_role('admin','client_manager')) then raise exception 'Not allowed for your role'; end if;
  return autodial_cfg(v_ws) || jsonb_build_object(
    'agents_available', (select count(*) from profiles where workspace_id = v_ws and active and available
                           and myoperator_user_id is not null and role in ('agent','coordinator','supervisor')),
    'agents_linked',    (select count(*) from profiles where workspace_id = v_ws and active
                           and myoperator_user_id is not null and role in ('agent','coordinator','supervisor')),
    'queue_waiting',    (select count(*) from callbacks where workspace_id = v_ws and status = 'pending'),
    'queue_dialling',   (select count(*) from callbacks where workspace_id = v_ws and status = 'in_progress'));
end $$;
