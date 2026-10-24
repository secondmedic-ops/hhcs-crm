-- Administrators participate in calling under the same availability and identity rules as supervisors.
-- Preserve existing call reservations, pending-wrap-up checks, workspace scoping and retry handling.

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

  -- Retry window over and never dialled (attempts = 0, no agent was free): mark agent_unavailable.
  update callbacks b set status = 'agent_unavailable', completed_at = now(), next_attempt_at = null,
    notes = concat_ws(E'\n', nullif(b.notes, ''), 'Auto-dialer: retry window expired without an eligible agent; no customer attempt made')
  where b.status = 'pending' and b.next_attempt_at is not null and b.due_at <= now()
    and (autodial_cfg(b.workspace_id)->>'enabled')::boolean
    and b.attempts = 0;

  -- Retry window over after attempt(s) were made (attempts > 0): mark unreachable.
  update callbacks b set status = 'unreachable', completed_at = now(), next_attempt_at = null,
    notes = concat_ws(E'\n', nullif(b.notes, ''), 'Auto-dialer: retry window expired before another attempt; see last attempt reason')
  where b.status = 'pending' and b.next_attempt_at is not null and b.due_at <= now()
    and (autodial_cfg(b.workspace_id)->>'enabled')::boolean
    and b.attempts > 0;

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
      and p.role in ('agent','coordinator','supervisor','administrator')
      and not exists (select 1 from calls k where k.agent_id = p.id and k.status in ('ringing','answered'))
      and not exists (select 1 from callbacks o where o.assigned_to = p.id and o.status = 'in_progress')
      and not has_pending_wrapup(p.id)
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

create or replace function autodial_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws();
begin
  if not (is_ops() or has_role('admin','client_manager')) then raise exception 'Not allowed for your role'; end if;
  return autodial_cfg(v_ws) || jsonb_build_object(
    'agents_available', (select count(*) from profiles where workspace_id = v_ws and active and available
                           and myoperator_user_id is not null and role in ('agent','coordinator','supervisor','administrator')),
    'agents_linked',    (select count(*) from profiles where workspace_id = v_ws and active
                           and myoperator_user_id is not null and role in ('agent','coordinator','supervisor','administrator')),
    'queue_waiting',    (select count(*) from callbacks where workspace_id = v_ws and status = 'pending'),
    'queue_dialling',   (select count(*) from callbacks where workspace_id = v_ws and status = 'in_progress'),
    'queue_awaiting_outcome', (select count(*) from callbacks where workspace_id = v_ws and status = 'reached'));
end $$;
