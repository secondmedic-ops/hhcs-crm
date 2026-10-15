-- Callback safety: retain creation-time window, immediate eligibility, existing attempt limits and 20s recovery.
-- Never route another callback to an agent while a call is still active, regardless of call duration.
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

  -- Buffer over and never dialled (no agent was free): mark unreachable.
  update callbacks b set status = 'unreachable', completed_at = now(), next_attempt_at = null,
    notes = concat_ws(E'\n', nullif(b.notes, ''), case when b.attempts = 0 then 'Auto-dialer: retry window expired without an eligible agent; no customer attempt made' else 'Auto-dialer: retry window expired before another attempt; see last attempt reason' end)
  where b.status = 'pending' and b.next_attempt_at is not null and b.due_at <= now()
    and (autodial_cfg(b.workspace_id)->>'enabled')::boolean;

  for cb in select b.* from callbacks b
            where b.status = 'pending' and b.next_attempt_at is not null and b.next_attempt_at <= now() and b.due_at > now()
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


create or replace function callback_update(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not is_ops() then raise exception 'Not allowed'; end if;
  if p_status = 'done' then raise exception 'Record an outcome to close a callback'; end if;
  if p_status not in ('pending','in_progress','unreachable') then raise exception 'Unknown callback status'; end if;
  select status into v_old from callbacks where id = p_id and workspace_id = me_ws() for update;
  if v_old is null then raise exception 'Callback not found'; end if;
  if exists (select 1 from calls where callback_id = p_id and status in ('ringing','answered')) then raise exception 'Call is still active; wait for its outcome'; end if;
  if v_old not in ('pending','in_progress') then raise exception 'This callback is no longer in the queue'; end if;
  update callbacks set status = p_status, notes = coalesce(nullif(p_note,''), notes), attempts = attempts + case when p_status in ('in_progress','unreachable') then 1 else 0 end,
    last_attempt_at = now(), assigned_to = coalesce(assigned_to, app_uid()),
    completed_at = case when p_status = 'unreachable' then now() end,
    completed_by = case when p_status = 'unreachable' then app_uid() end
  where id = p_id and workspace_id = me_ws();
end $$;


create or replace view v_callbacks with (security_invoker = true) as
select cb.id, cb.workspace_id, cb.call_id, cb.reason, cb.due_at, cb.status, cb.assigned_to, cb.attempts,
  cb.last_attempt_at, cb.completed_at, cb.created_at, cb.patient_id,
  case when has_role('agent') then mask_mobile(cb.number) else cb.number end as number,
  p.full_name as patient_name, pr.full_name as assignee_name,
  (select c.id from cases c where c.patient_id = cb.patient_id and c.stage not in ('closed','cancelled') order by c.created_at desc limit 1) as open_case_id,
  cb.next_attempt_at, cb.auto_dialled,
  cb.reached_at, cb.reached_call_id, cb.outcome, cb.outcome_note, cb.notes
from callbacks cb
left join patients p on p.id = cb.patient_id
left join profiles pr on pr.id = cb.assigned_to;
grant select on v_callbacks to caredesk_app;



create or replace function callback_connected(p_call uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c calls; n int;
begin
  select * into c from calls where id = p_call;
  if c.id is null or c.direction <> 'outbound' or c.callback_id is null or c.status not in ('answered','completed') then return 0; end if;
  update callbacks set status = 'reached', reached_at = coalesce(c.answered_at, now()), reached_call_id = c.id,
    assigned_to = coalesce(c.agent_id, assigned_to), next_attempt_at = null
  where id = c.callback_id and workspace_id = c.workspace_id
    and c.id = (select id from calls where callback_id = c.callback_id order by started_at desc, id desc limit 1)
    and status in ('pending','in_progress');
  get diagnostics n = row_count;
  return n;
end $$;


create or replace function callback_call_ended(p_call uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c calls; cb callbacks; v_min_talk constant int := 20;
begin
  select * into c from calls where id = p_call;
  if c.id is null or c.direction <> 'outbound' or c.callback_id is null then return 'none'; end if;
  select * into cb from callbacks where id = c.callback_id for update;
  if cb.workspace_id is distinct from c.workspace_id then return 'missing'; end if;
  if c.id is distinct from (select id from calls where callback_id = cb.id order by started_at desc, id desc limit 1) then return cb.status; end if;
  if cb.id is null then return 'missing'; end if;
  if cb.status = 'reached' and cb.reached_call_id is distinct from c.id then return cb.status; end if;  -- reached by another call
  if cb.status not in ('in_progress','reached') then return cb.status; end if;

  if c.status = 'completed' and (c.talk_seconds is null or c.talk_seconds >= v_min_talk) then
    if cb.status = 'in_progress' then        -- the answered event never came
      update callbacks set status = 'reached', reached_at = coalesce(c.answered_at, c.ended_at, now()), reached_call_id = c.id,
        assigned_to = coalesce(c.agent_id, assigned_to), next_attempt_at = null
      where id = cb.id;
    end if;
    return 'reached';
  end if;

  if cb.status = 'reached' then
    update sla_timers set met_at = null, status = case when status = 'met' then 'running' else status end
    where policy_key = 'missed_callback' and callback_id = cb.id and met_at is not null;
    update callbacks set status = 'in_progress', reached_at = null, reached_call_id = null where id = cb.id;
  end if;
  return callback_retry(cb.id, case when c.status = 'completed'
    then format('patient on the line %s s only', coalesce(c.talk_seconds, 0))
    else coalesce(c.raw->>'callback_failure_reason', 'Call ' || c.status || '; customer connection not verified') end);
end $$;

