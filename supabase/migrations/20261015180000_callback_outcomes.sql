-- =====================================================================
-- CareDesk CRM  |  Callback outcomes (F007: what "done" means for a callback)
--   Decision: track both moments.
--   * reached   the callback's own outbound call connects. Leaves the pending queue at once (dashboard
--               "Callbacks pending" still drops live, as the Hinduja MoM asked) and meets the missed_callback SLA.
--   * done      the agent records an outcome (resolved, follow-up needed, wrong number, not needed).
--   * Only the callback's own call reaches it: another outbound call to the same number no longer closes it.
--   * A reached call that never completes or lasts under 20 s of talk goes back to the queue (retry or
--     unreachable as before) and its SLA is reopened.
--   * MIS: reached / reached within SLA / closed with outcome / awaiting outcome; average minutes are raised to
--     reached (unreachable no longer counted in the average).
--   Legacy rows: "done" used to mean reached, so done rows get reached_at = completed_at and no outcome.
-- Expand only: new nullable columns, a wider status check, replaced functions.
-- =====================================================================

alter table callbacks add column if not exists reached_at      timestamptz;
alter table callbacks add column if not exists reached_call_id uuid references calls(id) on delete set null;
alter table callbacks add column if not exists outcome         text
  check (outcome in ('resolved','follow_up','wrong_number','not_needed'));
alter table callbacks add column if not exists outcome_note    text;

alter table callbacks drop constraint if exists callbacks_status_check;
alter table callbacks add constraint callbacks_status_check
  check (status in ('pending','in_progress','reached','done','unreachable'));

update callbacks set reached_at = completed_at where status = 'done' and reached_at is null and completed_at is not null;

-- SLA: met when the patient is reached, or when the callback is closed without a call.
create or replace function trg_callback_sla() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform sla_start(new.workspace_id, 'missed_callback', null, null, new.id, new.created_at, new.due_at);
  elsif (new.reached_at is not null and old.reached_at is null) or (new.status = 'done' and old.status <> 'done') then
    perform sla_meet('missed_callback', null, null, new.id);
  end if;
  return new;
end $$;

-- The callback's own call connected: reached now, not when the call ends. The agent still records the outcome.
create or replace function callback_connected(p_call uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c calls; n int;
begin
  select * into c from calls where id = p_call;
  if c.id is null or c.direction <> 'outbound' or c.callback_id is null then return 0; end if;
  update callbacks set status = 'reached', reached_at = coalesce(c.answered_at, now()), reached_call_id = c.id,
    assigned_to = coalesce(c.agent_id, assigned_to), next_attempt_at = null
  where id = c.callback_id and status in ('pending','in_progress');
  get diagnostics n = row_count;
  return n;
end $$;

-- The callback's own call ended. Completed with at least 20 s of talk (or no talk time reported): reached.
-- Not completed, or a drop-off under 20 s: back to the queue through callback_retry, SLA reopened.
create or replace function callback_call_ended(p_call uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c calls; cb callbacks; v_min_talk constant int := 20;
begin
  select * into c from calls where id = p_call;
  if c.id is null or c.direction <> 'outbound' or c.callback_id is null then return 'none'; end if;
  select * into cb from callbacks where id = c.callback_id for update;
  if cb.id is null then return 'missing'; end if;
  if cb.status = 'reached' and cb.reached_call_id is distinct from c.id then return cb.status; end if;  -- reached by another call
  if cb.status not in ('in_progress','reached') then return cb.status; end if;

  if c.status = 'completed' and (c.talk_seconds is null or c.talk_seconds >= v_min_talk) then
    if cb.status = 'in_progress' then        -- the answered event never came
      update callbacks set status = 'reached', reached_at = coalesce(c.answered_at, c.started_at, now()), reached_call_id = c.id,
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
    then format('patient on the line %s s only', coalesce(c.talk_seconds, 0)) else 'call ' || c.status end);
end $$;

-- The agent closes a callback with an outcome (after the call, or without one: resolved on WhatsApp, wrong number ...).
create or replace function callback_close(p_id uuid, p_outcome text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cb callbacks; v_case uuid; v_label text;
  v_names constant jsonb := '{"resolved":"Resolved","follow_up":"Follow-up needed","wrong_number":"Wrong number","not_needed":"No longer needed"}';
begin
  if not is_ops() then raise exception 'Not allowed'; end if;
  if p_outcome is null or not v_names ? p_outcome then raise exception 'Choose an outcome'; end if;
  if p_outcome = 'follow_up' and coalesce(btrim(p_note), '') = '' then raise exception 'Say what follow-up is needed'; end if;
  select * into cb from callbacks where id = p_id and workspace_id = me_ws() for update;
  if cb.id is null then raise exception 'Callback not found'; end if;
  if cb.status not in ('pending','in_progress','reached') then raise exception 'This callback is already closed'; end if;

  update callbacks set status = 'done', outcome = p_outcome, outcome_note = nullif(btrim(p_note), ''),
    completed_at = now(), completed_by = app_uid(), assigned_to = coalesce(assigned_to, app_uid()), next_attempt_at = null
  where id = p_id returning * into cb;

  if cb.patient_id is not null then
    select c.id into v_case from cases c where c.patient_id = cb.patient_id and c.stage not in ('closed','cancelled')
    order by c.created_at desc limit 1;
    select coalesce(agent_code, full_name) into v_label from profiles where id = app_uid();
    insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, call_id)
    values (cb.workspace_id, v_case, cb.patient_id, 'note', 'internal', app_uid(), v_label,
      'Callback closed: ' || (v_names->>p_outcome), cb.outcome_note, cb.reached_call_id);
  end if;
  return jsonb_build_object('id', cb.id, 'status', cb.status, 'outcome', cb.outcome);
end $$;

-- Manual status changes. Closing as done now needs an outcome (callback_close); a reached patient is never unreachable.
create or replace function callback_update(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not is_ops() then raise exception 'Not allowed'; end if;
  if p_status = 'done' then raise exception 'Record an outcome to close a callback'; end if;
  if p_status not in ('pending','in_progress','unreachable') then raise exception 'Unknown callback status'; end if;
  select status into v_old from callbacks where id = p_id;
  if v_old not in ('pending','in_progress') then raise exception 'This callback is no longer in the queue'; end if;
  update callbacks set status = p_status, notes = coalesce(nullif(p_note,''), notes), attempts = attempts + case when p_status in ('in_progress','unreachable') then 1 else 0 end,
    last_attempt_at = now(), assigned_to = coalesce(assigned_to, app_uid()),
    completed_at = case when p_status = 'unreachable' then now() end,
    completed_by = case when p_status = 'unreachable' then app_uid() end
  where id = p_id;
end $$;

-- the queue shows when the patient was reached and the outcome (columns appended)
create or replace view v_callbacks with (security_invoker = true) as
select cb.id, cb.workspace_id, cb.call_id, cb.reason, cb.due_at, cb.status, cb.assigned_to, cb.attempts,
  cb.last_attempt_at, cb.completed_at, cb.created_at, cb.patient_id,
  case when has_role('agent') then mask_mobile(cb.number) else cb.number end as number,
  p.full_name as patient_name, pr.full_name as assignee_name,
  (select c.id from cases c where c.patient_id = cb.patient_id and c.stage not in ('closed','cancelled') order by c.created_at desc limit 1) as open_case_id,
  cb.next_attempt_at, cb.auto_dialled,
  cb.reached_at, cb.reached_call_id, cb.outcome, cb.outcome_note
from callbacks cb
left join patients p on p.id = cb.patient_id
left join profiles pr on pr.id = cb.assigned_to;
grant select on v_callbacks to caredesk_app;

-- Settings screen and the agent's Available switch: adds how many reached callbacks still need an outcome.
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

-- MIS: unchanged except the callbacks block (reached vs closed with outcome).
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
                'by_mode', (select coalesce(jsonb_object_agg(mode, s), '{}'::jsonb) from (select mode, sum(amount) as s from payments where workspace_id = v_ws and collected_at >= t1 and collected_at < t2 group by 1) m))
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

-- call end is webhook work (database owner); users close callbacks through callback_close
revoke execute on function callback_call_ended(uuid) from public, caredesk_app;
grant execute on function callback_close(uuid, text, text) to caredesk_app;
