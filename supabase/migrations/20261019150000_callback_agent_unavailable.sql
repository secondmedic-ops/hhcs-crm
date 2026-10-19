-- =====================================================================
-- CareDesk CRM  |  Callback agent_unavailable status
--   * Dedicated status when callback deadline expires without an eligible agent becoming available.
--   * Retains 'unreachable' strictly for cases where customer dial attempts occurred and went unanswered.
--   * Refactors autodial_claim() to mark attempts = 0 expired callbacks as 'agent_unavailable'.
--   * Updates callback_update and update_callback_status to accept 'agent_unavailable'.
--   * Updates mis_report() to split 'agent_unavailable' from 'unreachable'.
-- =====================================================================

alter table callbacks drop constraint if exists callbacks_status_check;
alter table callbacks add constraint callbacks_status_check
  check (status in ('pending','in_progress','reached','done','unreachable','agent_unavailable'));

-- One dialling round for the scheduler.
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

-- Manual status update for operations users
create or replace function callback_update(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not is_ops() then raise exception 'Not allowed'; end if;
  if p_status = 'done' then raise exception 'Record an outcome to close a callback'; end if;
  if p_status not in ('pending','in_progress','unreachable','agent_unavailable') then raise exception 'Unknown callback status'; end if;
  select status into v_old from callbacks where id = p_id and workspace_id = me_ws() for update;
  if v_old is null then raise exception 'Callback not found'; end if;
  if exists (select 1 from calls where callback_id = p_id and status in ('ringing','answered')) then raise exception 'Call is still active; wait for its outcome'; end if;
  if v_old not in ('pending','in_progress') then raise exception 'This callback is no longer in the queue'; end if;
  update callbacks set status = p_status, notes = coalesce(nullif(p_note,''), notes),
    attempts = attempts + case when p_status in ('in_progress','unreachable') then 1 else 0 end,
    last_attempt_at = now(), assigned_to = coalesce(assigned_to, app_uid()),
    completed_at = case when p_status in ('unreachable','agent_unavailable') then now() end,
    completed_by = case when p_status in ('unreachable','agent_unavailable') then app_uid() end
  where id = p_id and workspace_id = me_ws();
end $$;

-- Controlled callback status update with audit logging
create or replace function update_callback_status(p_id uuid, p_status text, p_note text default null) returns callbacks
language plpgsql security definer set search_path = public as $$
declare cb callbacks; v_old text;
begin
  if not has_role('agent','coordinator','supervisor') then raise exception 'Access denied'; end if;
  if p_status not in ('pending','in_progress','unreachable','agent_unavailable') then raise exception 'Unknown callback status'; end if;
  select status into v_old from callbacks where id = p_id and workspace_id = me_ws() for update;
  if v_old is null then raise exception 'Callback not found'; end if;
  if v_old in ('reached','done') then raise exception 'Callback already reached; close it through callback_close'; end if;
  update callbacks set status = p_status, notes = coalesce(nullif(p_note,''), notes),
    attempts = attempts + case when p_status in ('in_progress','unreachable') then 1 else 0 end,
    last_attempt_at = case when p_status = 'in_progress' then now() else last_attempt_at end,
    completed_at = case when p_status in ('unreachable','agent_unavailable') then now() end,
    completed_by = case when p_status in ('unreachable','agent_unavailable') then app_uid() end
  where id = p_id and workspace_id = me_ws() returning * into cb;
  insert into audit_log (workspace_id, actor_id, actor_role, action, entity, entity_id, diff)
  values (me_ws(), app_uid(), (select role from profiles where id = app_uid()), 'callback_status_updated', 'callbacks', p_id,
    jsonb_build_object('from', v_old, 'to', p_status, 'note', p_note));
  return cb;
end $$;

-- Replaced mis_report with matching signature, adding agent_unavailable count
create or replace function mis_report(p_from date, p_to date, p_ws uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := coalesce(p_ws, me_ws()); r jsonb; t1 timestamptz; t2 timestamptz;
begin
  if p_ws is not null and not is_service() then raise exception 'Not allowed'; end if;
  t1 := (p_from::timestamp at time zone 'Asia/Kolkata');
  t2 := ((p_to + 1)::timestamp at time zone 'Asia/Kolkata');
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'calls', (select jsonb_build_object('total', count(*), 'answered', count(*) filter (where status in ('answered','completed')),
                'missed', count(*) filter (where status='missed'), 'abandoned', count(*) filter (where status='abandoned'),
                'answer_within_30s_pct', round(100.0 * count(*) filter (where status in ('answered','completed') and coalesce(ring_seconds,0) <= 30) / nullif(count(*),0), 1),
                'abandon_pct', round(100.0 * count(*) filter (where status in ('abandoned','missed')) / nullif(count(*),0), 1))
              from calls where workspace_id = v_ws and started_at >= t1 and started_at < t2),
    'callbacks', (select jsonb_build_object('raised', count(*),
                'reached', count(*) filter (where reached_at is not null),
                'within_sla', count(*) filter (where reached_at is not null and reached_at <= due_at),
                'done', count(*) filter (where status='done'),
                'awaiting_outcome', count(*) filter (where status='reached'),
                'unreachable', count(*) filter (where status='unreachable'),
                'agent_unavailable', count(*) filter (where status='agent_unavailable'),
                'avg_minutes', round(avg(extract(epoch from (reached_at - created_at))/60)::numeric, 1),
                'outcomes', jsonb_build_object(
                  'resolved', count(*) filter (where outcome='resolved'), 'follow_up', count(*) filter (where outcome='follow_up'),
                  'wrong_number', count(*) filter (where outcome='wrong_number'), 'not_needed', count(*) filter (where outcome='not_needed')))
              from callbacks where workspace_id = v_ws and created_at >= t1 and created_at < t2),
    'funnel', (select jsonb_build_object('enquiries', count(*), 'quotes', count(*) filter (where quote_sent_at is not null),
                'bookings', count(*) filter (where booking_confirmed_at is not null), 'completions', count(*) filter (where service_completed_at is not null),
                'closed', count(*) filter (where stage='closed'), 'cancelled', count(*) filter (where stage='cancelled'),
                'conversion_pct', round(100.0 * count(*) filter (where booking_confirmed_at is not null) / nullif(count(*),0), 1))
              from cases where workspace_id = v_ws and created_at >= t1 and created_at < t2),
    'tat', (select jsonb_build_object(
                'quote_min', round(avg(extract(epoch from (c.quote_sent_at - h.changed_at))/60)::numeric, 1),
                'booking_min', round(avg(extract(epoch from (c.booking_confirmed_at - c.quote_sent_at))/60)::numeric, 1))
              from cases c left join case_stage_history h on h.case_id = c.id and h.to_stage = 'pricing'
              where c.workspace_id = v_ws and c.created_at >= t1 and c.created_at < t2),
    'cancellations', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select coalesce(cancel_reason,'Unspecified') as reason, count(*) as n
              from cases where workspace_id = v_ws and stage = 'cancelled' and updated_at >= t1 and updated_at < t2 group by 1 order by 2 desc) x),
    'revenue', (select jsonb_build_object('booking_value', coalesce(sum(total) filter (where booking_confirmed_at >= t1 and booking_confirmed_at < t2),0),
                'completed_value', coalesce(sum(total) filter (where service_completed_at >= t1 and service_completed_at < t2),0))
              from cases where workspace_id = v_ws),
    'collections', (select jsonb_build_object('collected', coalesce(sum(amount),0), 'count', count(*),
                'reconciled', count(*) filter (where reconciled), 'exceptions', count(*) filter (where exception is not null),
                'by_mode', (select coalesce(jsonb_object_agg(mode, s), '{}'::jsonb) from (select mode, sum(amount) as s from payments where workspace_id = v_ws and collected_at >= t1 and collected_at < t2 group by 1) m),
                'by_account', (select coalesce(jsonb_object_agg(destination_account, s), '{}'::jsonb)
                  from (select destination_account, sum(amount) as s from payments
                    where workspace_id = v_ws and collected_at >= t1 and collected_at < t2
                    group by destination_account) a))
              from payments where workspace_id = v_ws and collected_at >= t1 and collected_at < t2),
    'outstanding', (select coalesce(sum(greatest(total - amount_collected,0)),0) from cases where workspace_id = v_ws and service_completed_at is not null and stage <> 'cancelled' and payment_status <> 'waived'),
    'complaints', (select jsonb_build_object('new', count(*), 'resolved', count(*) filter (where resolved_at is not null),
                'ack_within_sla', count(*) filter (where acknowledged_at <= opened_at + interval '15 minutes'),
                'by_category', (select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (select category, count(*) as n from complaints where workspace_id = v_ws and opened_at >= t1 and opened_at < t2 group by 1) k))
              from complaints where workspace_id = v_ws and opened_at >= t1 and opened_at < t2),
    'escalations', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb) from (select type, count(*) as n from escalations where workspace_id = v_ws and raised_at >= t1 and raised_at < t2 group by 1) e),
    'sla', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
              select p.label, p.target_minutes, count(t.*) filter (where t.status='met') as met, count(t.*) filter (where t.status='breached') as breached,
                round(100.0 * count(t.*) filter (where t.status='met') / nullif(count(t.*) filter (where t.status in ('met','breached')),0), 1) as pct
              from sla_policies p left join sla_timers t on t.policy_key = p.key and t.workspace_id = p.workspace_id and t.started_at >= t1 and t.started_at < t2
              where p.workspace_id = v_ws group by p.label, p.target_minutes order by p.target_minutes) x),
    'zones', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
              select coalesce(z.name,'Unmapped') as zone, count(*) as enquiries, count(*) filter (where c.booking_confirmed_at is not null) as bookings,
                count(*) filter (where c.service_completed_at is not null) as completed, coalesce(sum(c.total) filter (where c.service_completed_at is not null),0) as revenue
              from cases c left join zones z on z.id = c.zone_id where c.workspace_id = v_ws and c.created_at >= t1 and c.created_at < t2 group by 1 order by 2 desc) x),
    'services', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
              select i.service_name, i.category, count(*) as n, sum(i.line_total) as value
              from case_items i join cases c on c.id = i.case_id where c.workspace_id = v_ws and c.created_at >= t1 and c.created_at < t2
              group by 1,2 order by 4 desc) x),
    'qa', (select jsonb_build_object('reviews', count(*), 'avg_pct', round(avg(total_pct),1)) from qa_reviews where workspace_id = v_ws and created_at >= t1 and created_at < t2),
    'agents', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
              select coalesce(p.agent_code, p.full_name) as agent, count(cl.*) as calls, round(avg(cl.talk_seconds))::int as avg_talk,
                (select round(avg(q.total_pct),1) from qa_reviews q where q.agent_id = p.id and q.created_at >= t1 and q.created_at < t2) as qa
              from profiles p left join calls cl on cl.agent_id = p.id and cl.started_at >= t1 and cl.started_at < t2
              where p.workspace_id = v_ws and p.role = 'agent' group by p.id, 1 order by 2 desc) x),
    'daily', (select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) from (
              select d::date as day,
                (select count(*) from calls where workspace_id = v_ws and (started_at at time zone 'Asia/Kolkata')::date = d::date) as calls,
                (select count(*) from cases where workspace_id = v_ws and (created_at at time zone 'Asia/Kolkata')::date = d::date) as enquiries,
                (select count(*) from cases where workspace_id = v_ws and (booking_confirmed_at at time zone 'Asia/Kolkata')::date = d::date) as bookings,
                (select coalesce(sum(amount),0) from payments where workspace_id = v_ws and (collected_at at time zone 'Asia/Kolkata')::date = d::date) as collections
              from generate_series(p_from, p_to, interval '1 day') d) x)
  ) into r;
  return r;
end $$;

-- Recreate view v_callbacks to ensure schema invoker
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

