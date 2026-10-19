-- =====================================================================
-- CareDesk CRM  |  Every connected call gets an outcome (calls.disposition)
-- Root cause (0 of 41 calls with a disposition): wrap_up_call does write calls.disposition, but the wrap-up form
--   lives only behind "Record wrap-up" in the Calls drawer. Nothing asks for it when a call ends, nothing blocks the
--   next call, and missed / failed calls never get one, so it was always skipped.
-- Fix:
--   * a fixed outcome list (call_outcomes) checked by wrap_up_call, which also stamps who / when;
--   * missed, abandoned and failed calls get an automatic outcome (disposition = the status, disposition_auto);
--   * my_pending_wrapup(): the agent's oldest connected call without an outcome since the rule went live. The app
--     shows a blocking wrap-up dialog for it; click-to-call and the auto-dialer skip an agent who has one;
--   * calls ended before the rule went live never block anyone; supervisors list them ("Without outcome").
-- Expand only: new columns, replaced functions.
-- =====================================================================
alter table calls add column if not exists disposition_at   timestamptz;
alter table calls add column if not exists disposition_by   uuid references profiles(id);
alter table calls add column if not exists disposition_auto boolean not null default false;
create index if not exists calls_pending_wrapup on calls(workspace_id, agent_id, ended_at) where status = 'completed' and disposition is null;

-- the moment the rule went live: calls that ended earlier never block an agent
update workspaces set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('outcome_required_since', now())
 where not (coalesce(settings, '{}'::jsonb) ? 'outcome_required_since');

create or replace function call_outcomes() returns text[] language sql immutable as $$
  select array['booked','quote_sent','callback_requested','info_only','wrong_number','no_response','test_internal']
$$;

-- Calls that never connected get their outcome automatically; a call that connects later loses it again.
create or replace function trg_call_auto_outcome() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('missed','abandoned','failed') and new.disposition is null then
    new.disposition := new.status; new.disposition_auto := true; new.disposition_at := now(); new.disposition_by := null;
  elsif new.status in ('answered','completed') and new.disposition_auto then
    new.disposition := null; new.disposition_auto := false; new.disposition_at := null;
  end if;
  return new;
end $$;
drop trigger if exists call_auto_outcome on calls;
create trigger call_auto_outcome before insert or update of status on calls for each row execute function trg_call_auto_outcome();

do $$
declare n int;
begin
  update calls set disposition = status, disposition_auto = true, disposition_at = coalesce(ended_at, started_at)
   where status in ('missed','abandoned','failed') and disposition is null;
  get diagnostics n = row_count;
  raise notice 'Automatic outcome set on % calls that never connected', n;
end $$;

-- An agent's own connected call that still needs an outcome (oldest first). Null when none.
create or replace function has_pending_wrapup(p_agent uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from calls k join workspaces w on w.id = k.workspace_id
    where k.agent_id = p_agent and k.status = 'completed' and k.disposition is null
      and k.ended_at >= coalesce((w.settings->>'outcome_required_since')::timestamptz, 'infinity'::timestamptz))
$$;

create or replace function my_pending_wrapup() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not is_ops() then return null; end if;
  select jsonb_build_object('id', k.id, 'direction', k.direction, 'started_at', k.started_at, 'ended_at', k.ended_at,
           'talk_seconds', k.talk_seconds, 'patient_name', p.full_name, 'case_id', k.case_id, 'case_no', c.case_no,
           'callback_id', k.callback_id,
           'pending', (select count(*) from calls x where x.agent_id = k.agent_id and x.status = 'completed' and x.disposition is null
                         and x.ended_at >= coalesce((w.settings->>'outcome_required_since')::timestamptz, 'infinity'::timestamptz)))
    into r
    from calls k join workspaces w on w.id = k.workspace_id
    left join patients p on p.id = k.patient_id left join cases c on c.id = k.case_id
   where k.agent_id = app_uid() and k.workspace_id = me_ws() and k.status = 'completed' and k.disposition is null
     and k.ended_at >= coalesce((w.settings->>'outcome_required_since')::timestamptz, 'infinity'::timestamptz)
   order by k.ended_at limit 1;
  return r;
end $$;
grant execute on function my_pending_wrapup() to caredesk_app;

-- wrap_up_call: same contract, the outcome must come from the fixed list (a value already on the call may be kept)
create or replace function wrap_up_call(p_call uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cl record;
  v_disp text;
  v_act text;
  v_notes text;
  v_fo_at timestamptz;
  v_fo_owner uuid;
  v_case uuid;
  v_cb uuid;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into cl from calls where id = p_call and workspace_id = me_ws() for update;
  if not found then raise exception 'Call not found'; end if;

  v_disp := nullif(trim(p->>'disposition'), '');
  v_act := nullif(trim(p->>'action_taken'), '');
  v_notes := nullif(trim(p->>'notes'), '');
  v_fo_at := nullif(trim(p->>'followup_at'), '')::timestamptz;
  v_fo_owner := coalesce(nullif(p->>'followup_owner', '')::uuid, nullif(p->>'followup_owner_id', '')::uuid, app_uid());
  v_case := coalesce(nullif(p->>'case_id', '')::uuid, cl.case_id);

  if v_disp is not null and v_disp is distinct from cl.disposition and not (v_disp = any(call_outcomes())) then
    raise exception 'Choose an outcome from the list';
  end if;
  if v_disp is null and v_act is null and v_notes is null and v_fo_at is null and v_case is null then
    raise exception 'Nothing to save for call wrap-up';
  end if;
  if cl.status = 'completed' and v_disp is null and cl.disposition is null then
    raise exception 'Choose the call outcome';
  end if;

  update calls set
    disposition = coalesce(v_disp, disposition),
    disposition_auto = case when v_disp is not null then false else disposition_auto end,
    disposition_at = case when v_disp is not null and v_disp is distinct from cl.disposition then now() else disposition_at end,
    disposition_by = case when v_disp is not null and v_disp is distinct from cl.disposition then app_uid() else disposition_by end,
    action_taken = coalesce(v_act, action_taken),
    notes = coalesce(v_notes, notes),
    case_id = v_case,
    followup_at = v_fo_at,
    followup_owner_id = case when v_fo_at is not null then v_fo_owner else followup_owner_id end
  where id = p_call;

  if v_fo_at is not null then
    insert into callbacks (workspace_id, call_id, number, patient_id, reason, due_at, assigned_to, notes)
    values (cl.workspace_id, p_call, cl.customer_number, cl.patient_id, 'followup', v_fo_at, v_fo_owner,
            concat_ws(' · ', 'Follow-up requested from call', v_act, v_notes))
    returning id into v_cb;
  end if;

  if v_case is not null then
    perform log_interaction(v_case, 'phone', cl.direction,
      'Call wrap-up: ' || coalesce(v_disp, 'handled') || case when v_act is not null then ' · ' || v_act else '' end,
      v_notes, null, jsonb_build_object('call_id', p_call, 'disposition', v_disp, 'action_taken', v_act, 'followup_at', v_fo_at));
  end if;

  return jsonb_build_object(
    'call_id', p_call,
    'disposition', coalesce(v_disp, cl.disposition),
    'action_taken', coalesce(v_act, cl.action_taken),
    'followup_at', v_fo_at,
    'followup_owner_id', v_fo_owner,
    'callback_id', v_cb,
    'case_id', v_case
  );
end $$;

-- v_calls: same columns in the same order, plus the outcome stamp and the callback note (appended)
create or replace view v_calls with (security_invoker = true) as
select cl.id, cl.workspace_id, cl.provider, cl.provider_call_id, cl.session_id, cl.direction,
  case when has_role('agent') then mask_mobile(cl.customer_number) else cl.customer_number end as customer_number,
  cl.did_number, cl.agent_id, coalesce(pr.agent_code || ' · ' || pr.full_name, cl.agent_name) as agent_label,
  cl.department, cl.status, cl.started_at, cl.answered_at, cl.ended_at, cl.ring_seconds, cl.talk_seconds,
  (cl.recording_filename is not null) as has_recording,
  cl.patient_id, cl.case_id, cl.disposition, cl.notes, cl.transcript, cl.ai_summary, cl.ai_sentiment, cl.ai_intent,
  cl.ai_extracted, cl.ai_flags, cl.ai_processed_at,
  p.full_name as patient_name, c.case_no,
  (select q.total_pct from qa_reviews q where q.call_id = cl.id order by q.created_at desc limit 1) as qa_pct,
  coalesce(w.settings->'did_labels'->>cl.did_number, case when cl.did_number is null then null else 'Main line' end) as line_label,
  cl.ai_status, cl.ai_error, cl.ai_attempts, cl.ai_started_at,
  cl.live_transcript, cl.live_transcript_completed_at,
  (nullif(cl.live_transcript, '') is not null and cl.live_transcript_completed_at is not null) as has_live_transcript,
  cl.action_taken, cl.followup_at, cl.followup_owner_id,
  cl.disposition_at, cl.disposition_auto, cl.callback_note,
  (cl.status = 'completed' and cl.disposition is null) as needs_outcome
from calls cl
left join workspaces w on w.id = cl.workspace_id
left join profiles pr on pr.id = cl.agent_id
left join patients p on p.id = cl.patient_id
left join cases c on c.id = cl.case_id;

-- The auto-dialer never rings an agent whose last connected call still needs its outcome.
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
      and p.role in ('agent','coordinator','supervisor')
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
