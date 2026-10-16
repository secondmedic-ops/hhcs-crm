-- =====================================================================
-- CareDesk CRM  |  Callback initial delay (separate from the retry window)
--   * new workspace setting initial_delay_minutes: 0 (Immediate, the existing default), 30, 45 or 60
--   * the first eligible time is calculated from the ORIGINAL missed/abandoned call end time,
--     not from the callback creation time:
--         eligible_at = greatest(origin_call_at + initial delay, created_at)
--     Fallback when the original call end time is unavailable (call row missing or ended_at null,
--     e.g. a late import without timestamps): the delay cannot be anchored to anything real, so the
--     callback is treated as Immediate (eligible at creation). A late import is never doubly
--     delayed, and the deadline (due_at = eligible_at + retry window) always stays ahead.
--   * The retry window (buffer_minutes) and maximum attempts keep their separate meaning; the
--     deadline is now anchored to first eligibility instead of creation (identical for Immediate).
--   * Never dial before eligible_at; after eligibility wait for a free eligible agent, as before.
-- Expand only: new nullable columns, replaced functions.
-- =====================================================================
alter table callbacks add column if not exists origin_call_at timestamptz;
alter table callbacks add column if not exists eligible_at    timestamptz;

-- Existing pending rows keep working: they were created under Immediate, so their first
-- eligibility is their creation time (the scheduler keeps honouring next_attempt_at for retries).
update callbacks set eligible_at = created_at where eligible_at is null;

-- The workspace's auto-dial settings, with defaults (off, immediate, 30 min window, 3 attempts).
create or replace function autodial_cfg(p_ws uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enabled',               coalesce((w.settings->'autodial'->>'enabled')::boolean, false),
    'initial_delay_minutes', coalesce((w.settings->'autodial'->>'initial_delay_minutes')::int, 0),
    'buffer_minutes',        coalesce((w.settings->'autodial'->>'buffer_minutes')::int, 30),
    'max_attempts',          coalesce((w.settings->'autodial'->>'max_attempts')::int, 3))
  from workspaces w where w.id = p_ws
$$;

drop function if exists set_autodial(boolean, integer, integer);
create or replace function set_autodial(p_enabled boolean, p_buffer_minutes int, p_max_attempts int default 3,
  p_initial_delay_minutes int default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws();
begin
  if not has_role('supervisor','admin','client_manager') then raise exception 'Only a supervisor can change the auto-dialer'; end if;
  if p_buffer_minutes not in (30, 45, 60) then raise exception 'Buffer must be 30, 45 or 60 minutes'; end if;
  if p_initial_delay_minutes not in (0, 30, 45, 60) then raise exception 'Initial delay must be Immediate, 30, 45 or 60 minutes'; end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 5 then raise exception 'Attempts must be between 1 and 5'; end if;
  update workspaces set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('autodial',
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'initial_delay_minutes', coalesce(p_initial_delay_minutes, 0),
      'buffer_minutes', p_buffer_minutes, 'max_attempts', p_max_attempts))
  where id = v_ws;
  insert into access_log(workspace_id, user_id, action, entity, entity_id, meta)
  values (v_ws, app_uid(), 'settings_changed', 'autodial', v_ws::text, autodial_cfg(v_ws));
  return autodial_cfg(v_ws);
end $$;

-- A new missed / abandoned callback: eligible after the initial delay counted from the original
-- call's end time; the retry window and deadline start at first eligibility, never before it.
create or replace function trg_callback_schedule() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := autodial_cfg(new.workspace_id);
          v_origin timestamptz;
begin
  if (cfg->>'enabled')::boolean and new.status = 'pending' then
    -- original missed/abandoned call end time
    select k.ended_at into v_origin from calls k where k.id = new.call_id;
    if v_origin is not null then
      new.origin_call_at := coalesce(new.origin_call_at, v_origin);
      -- first eligibility: original call end + initial delay, never before the callback exists
      -- (a late import whose delay has already passed becomes eligible immediately)
      new.eligible_at := coalesce(new.eligible_at,
        greatest(new.origin_call_at + make_interval(mins => (cfg->>'initial_delay_minutes')::int), new.created_at));
    else
      -- Fallback (documented): the original call's end time is unavailable (the call row is missing
      -- or has no ended_at, e.g. an import without timestamps). The initial delay cannot be anchored
      -- to anything real, so the callback is treated as Immediate: eligible at creation. This also
      -- guarantees a late import is never doubly delayed.
      new.origin_call_at := null;
      new.eligible_at := coalesce(new.eligible_at, new.created_at);
    end if;
    -- the retry window starts at first eligibility, so the delay does not consume it
    new.due_at := new.eligible_at + make_interval(mins => (cfg->>'buffer_minutes')::int);
    new.next_attempt_at := coalesce(new.next_attempt_at, new.eligible_at);
  end if;
  return new;
end $$;
drop trigger if exists callback_schedule on callbacks;
create trigger callback_schedule before insert on callbacks for each row execute function trg_callback_schedule();

create or replace function callback_retry(p_id uuid, p_reason text default null) returns text
language plpgsql security definer set search_path = public as $$
declare cb callbacks; cfg jsonb; v_gap interval; v_next timestamptz;
begin
  select * into cb from callbacks where id = p_id for update;
  if cb.id is null or cb.status <> 'in_progress' then return coalesce(cb.status, 'missing'); end if;
  cfg := autodial_cfg(cb.workspace_id);
  if not (cfg->>'enabled')::boolean then
    update callbacks set status = 'pending', next_attempt_at = null,
      notes = concat_ws(E'\n', nullif(notes,''), p_reason) where id = p_id;      -- manual queue: the agent decides what next
    return 'pending';
  end if;
  v_gap := greatest(interval '2 minutes', make_interval(mins => (cfg->>'buffer_minutes')::int) / (cfg->>'max_attempts')::int);
  v_next := coalesce(cb.last_attempt_at, now()) + v_gap;
  if cb.attempts >= (cfg->>'max_attempts')::int or v_next >= cb.due_at or now() >= cb.due_at then
    update callbacks set status = 'unreachable', completed_at = now(), next_attempt_at = null,
      notes = concat_ws(E'\n', nullif(notes, ''), format('Auto-dialer: not reached after %s attempt(s)%s', attempts, coalesce(' · ' || p_reason, '')))
    where id = p_id;
    return 'unreachable';
  end if;
  update callbacks set status = 'pending', next_attempt_at = v_next,
    notes = concat_ws(E'\n', nullif(notes,''), p_reason) where id = p_id;
  return 'pending';
end $$;

-- One dialling round for the scheduler. Unchanged safety rules; eligibility now also honours
-- eligible_at: nothing is dialled before the initial delay has passed, and the retry window is
-- measured from first eligibility (due_at), so the delay never eats into it.
create or replace function autodial_claim() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cb record; ag record; v_out jsonb := '[]'::jsonb; v_call uuid; v_ref text; cfg jsonb;
begin
  if not is_service() then raise exception 'System only'; end if;
  -- Recover only after the existing call-log recovery has closed the call. Never redial an unresolved ringing request.
  for cb in select b.id from callbacks b
            where b.status = 'in_progress' and b.last_attempt_at < now() - interval '5 minutes'
              and not exists (select 1 from calls k where k.callback_id = b.id and k.status in ('ringing','answered'))
            for update skip locked loop
    perform callback_retry(cb.id, 'Call events missing or provider outcome unconfirmed; connection not verified');
  end loop;
  -- Retry window over and never dialled (no agent was free): mark unreachable.
  update callbacks b set status = 'unreachable', completed_at = now(), next_attempt_at = null,
    notes = concat_ws(E'\n', nullif(b.notes, ''), case when b.attempts = 0 then 'Auto-dialer: retry window expired without an eligible agent; no customer attempt made' else 'Auto-dialer: retry window expired before another attempt; see last attempt reason' end)
  where b.status = 'pending' and b.next_attempt_at is not null and b.due_at <= now()
    and (autodial_cfg(b.workspace_id)->>'enabled')::boolean;
  for cb in select b.* from callbacks b
            where b.status = 'pending' and b.next_attempt_at is not null and b.next_attempt_at <= now() and b.due_at > now()
              -- never dial before first eligibility (initial delay from the original call's end time)
              and coalesce(b.eligible_at, b.created_at) <= now()
              and b.attempts < (autodial_cfg(b.workspace_id)->>'max_attempts')::int
              and (autodial_cfg(b.workspace_id)->>'enabled')::boolean
            order by b.due_at, b.created_at
            for update skip locked loop
    select p.id, p.full_name, p.myoperator_user_id into ag from profiles p
    where p.workspace_id = cb.workspace_id and p.active and p.available and nullif(btrim(p.myoperator_user_id), '') is not null
      and p.role in ('agent','coordinator','supervisor')
      and not exists (select 1 from calls k where k.agent_id = p.id and k.status in ('ringing','answered'))
      and not exists (select 1 from callbacks o where o.assigned_to = p.id and o.status = 'in_progress')
    order by p.last_autodial_at nulls first, p.available_since
    limit 1 for update of p skip locked;
    continue when ag.id is null;
    -- Recheck after the profile lock: a concurrent manual dial may have just committed.
    continue when exists (select 1 from calls k where k.agent_id = ag.id and k.status in ('ringing','answered'));
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

-- the queue also shows the original call time, the scheduled first eligibility and the deadline
create or replace view v_callbacks with (security_invoker = true) as
select cb.id, cb.workspace_id, cb.call_id, cb.reason, cb.due_at, cb.status, cb.assigned_to, cb.attempts,
  cb.last_attempt_at, cb.completed_at, cb.created_at, cb.patient_id,
  case when has_role('agent') then mask_mobile(cb.number) else cb.number end as number,
  p.full_name as patient_name, pr.full_name as assignee_name,
  (select c.id from cases c where c.patient_id = cb.patient_id and c.stage not in ('closed','cancelled') order by c.created_at desc limit 1) as open_case_id,
  cb.next_attempt_at, cb.auto_dialled,
  cb.reached_at, cb.reached_call_id, cb.outcome, cb.outcome_note, cb.notes,
  cb.origin_call_at, cb.eligible_at
from callbacks cb
left join patients p on p.id = cb.patient_id
left join profiles pr on pr.id = cb.assigned_to;
grant select on v_callbacks to caredesk_app;

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
    'queue_dialling',   (select count(*) from callbacks where workspace_id = v_ws and status = 'in_progress'),
    'queue_awaiting_outcome', (select count(*) from callbacks where workspace_id = v_ws and status = 'reached'));
end $$;

