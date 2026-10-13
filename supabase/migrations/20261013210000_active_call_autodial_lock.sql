-- Never route another callback to an agent while a call is still active, regardless of call duration.
create or replace function autodial_claim() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cb record; ag record; v_out jsonb := '[]'::jsonb; v_call uuid; v_ref text; cfg jsonb;
begin
  if not is_service() then raise exception 'System only'; end if;

  -- An attempt with no answer and no end event after 5 minutes is treated as not reached.
  for cb in select b.id from callbacks b
            where b.status = 'in_progress' and b.auto_dialled and b.last_attempt_at < now() - interval '5 minutes'
              and not exists (select 1 from calls k where k.callback_id = b.id and k.status = 'answered')
            for update skip locked loop
    update calls set status = 'failed', ended_at = now() where callback_id = cb.id and status = 'ringing';
    perform callback_retry(cb.id, 'no response from the line');
  end loop;

  -- Buffer over and never dialled (no agent was free): mark unreachable.
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
      and not exists (select 1 from calls k where k.agent_id = p.id and k.status in ('ringing','answered'))
      and not exists (select 1 from callbacks o where o.assigned_to = p.id and o.status = 'in_progress'
                        and o.last_attempt_at > now() - interval '5 minutes')
    order by p.last_autodial_at nulls first, p.available_since
    limit 1 for update of p skip locked;
    continue when ag.id is null;

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