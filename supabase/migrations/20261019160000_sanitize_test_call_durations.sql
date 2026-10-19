-- 20261019120000 is already payment_destination_accounts; use the next unused version.
-- No test-phase date cutoff is assumed. Known local/demo signatures come from
-- src/lib/localsim.js and src/demo/seed.js. Conflicting duration evidence becomes
-- NULL (unknown), never an invented four-hour call. Keep raw/timestamps unchanged.
do $$
declare repaired_count integer; remaining_count integer;
begin
  with provider_times as materialized (
    select id,
      case when raw->'end'->>'_st' ~ '^[0-9]{10}([0-9]{3})?$'
        then (raw->'end'->>'_st')::numeric / case when length(raw->'end'->>'_st') = 13 then 1000 else 1 end end as start_epoch,
      case when raw->'end'->>'_et' ~ '^[0-9]{10}([0-9]{3})?$'
        then (raw->'end'->>'_et')::numeric / case when length(raw->'end'->>'_et') = 13 then 1000 else 1 end end as end_epoch
    from public.calls where talk_seconds > 14400 and provider = 'myoperator'
  ), candidates as materialized (
    select c.id, workspace_id, talk_seconds as previous_seconds,
      case when session_id ~ '^(local|demo)-'
                  or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
                  or raw->'first'->>'event_id' like 'local-%'
                  or raw->'end'->>'event_id' like 'local-%'
        then 'test_event_outlier'
        else 'duration_conflicts_with_call_timing' end as reason
    from public.calls c left join provider_times t on t.id = c.id
    where talk_seconds > 14400 and (
      session_id ~ '^(local|demo)-'
      or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
      or raw->'first'->>'event_id' like 'local-%'
      or raw->'end'->>'event_id' like 'local-%'
      or (t.end_epoch - t.start_epoch between 0 and 14400
          and talk_seconds > t.end_epoch - t.start_epoch + 1)
      or (ended_at >= coalesce(answered_at, started_at)
          and coalesce(answered_at, started_at) >= started_at
          and extract(epoch from (ended_at - coalesce(answered_at, started_at))) between 0 and 14400
          and talk_seconds > extract(epoch from (ended_at - coalesce(answered_at, started_at))) + 1)
    )
    for update of c
  ), repaired as (
    update public.calls c set talk_seconds = null
    from candidates d where c.id = d.id
    returning c.id, c.workspace_id, d.previous_seconds, d.reason
  )
  insert into public.audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
  select workspace_id, 'calls', id, 'update',
    jsonb_build_object('talk_seconds', jsonb_build_object('old', previous_seconds, 'new', null),
      'reason', reason, 'migration', '20261019160000_sanitize_test_call_durations'), null
  from repaired;
  get diagnostics repaired_count = row_count;
  select count(*) into remaining_count from public.calls where talk_seconds > 14400;
  raise notice 'Call duration cleanup: % confirmed outliers nullified; % other long calls retained for review and excluded from averages',
    repaired_count, remaining_count;
end $$;

-- One row per call, preserving call counts and dates while making unknown,
-- zero, negative, non-connected and >4-hour talk times NULL for all averages.
-- Invoker security keeps calls' workspace/role RLS on direct reads.
create or replace view public.v_call_metrics with (security_invoker = true) as
select id, workspace_id, agent_id, direction, status, started_at, ring_seconds,
  case when status in ('answered','completed') and talk_seconds between 1 and 14400
    then talk_seconds end as talk_seconds
from public.calls;
revoke all on public.v_call_metrics from public;
grant select on public.v_call_metrics to caredesk_app;

-- Preserve existing RPC signatures, authorization, date boundaries and non-call metrics.
create or replace function dashboard_kpis(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws(); r jsonb;
begin
  if me_role() in ('field_staff','admin') then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'calls', (select jsonb_build_object(
        'total', count(*),
        'inbound', count(*) filter (where direction='inbound'),
        'outbound', count(*) filter (where direction='outbound'),
        'answered', count(*) filter (where status in ('answered','completed')),
        'missed', count(*) filter (where status = 'missed'),
        'abandoned', count(*) filter (where status = 'abandoned'),
        'answered_30s', count(*) filter (where status in ('answered','completed') and coalesce(ring_seconds,0) <= 30),
        'avg_ring', round(avg(ring_seconds) filter (where status in ('answered','completed')))::int,
        'avg_talk', round(avg(talk_seconds) filter (where talk_seconds > 0))::int)
      from public.v_call_metrics where workspace_id = v_ws and started_at between p_from and p_to),
    'callbacks_pending', (select count(*) from callbacks where workspace_id = v_ws and status in ('pending','in_progress')),
    'callbacks_overdue', (select count(*) from callbacks where workspace_id = v_ws and status in ('pending','in_progress') and due_at < now()),
    'funnel', (select jsonb_build_object(
        'enquiries', count(*),
        'quoted', count(*) filter (where quote_sent_at is not null),
        'booked', count(*) filter (where booking_confirmed_at is not null),
        'completed', count(*) filter (where service_completed_at is not null),
        'closed', count(*) filter (where stage = 'closed'),
        'cancelled', count(*) filter (where stage = 'cancelled'))
      from cases where workspace_id = v_ws and created_at between p_from and p_to),
    'bookings', (select count(*) from cases where workspace_id = v_ws and booking_confirmed_at between p_from and p_to),
    'stages', (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb) from (select stage, count(*) as n from cases where workspace_id = v_ws and stage not in ('closed','cancelled') group by stage) s),
    'in_progress', (select count(*) from cases where workspace_id = v_ws and stage in ('deployment','completion')),
    'delayed', (select count(*) from cases where workspace_id = v_ws and stage not in ('closed','cancelled') and sla_state = 'breached'),
    'at_risk', (select count(*) from cases where workspace_id = v_ws and stage not in ('closed','cancelled') and sla_state = 'at_risk'),
    'sla', (select jsonb_build_object(
        'total', count(*),
        'met', count(*) filter (where status = 'met'),
        'breached', count(*) filter (where status = 'breached'),
        'pct', case when count(*) filter (where status in ('met','breached')) = 0 then null
               else round(100.0 * count(*) filter (where status = 'met') / count(*) filter (where status in ('met','breached')), 1) end)
      from sla_timers where workspace_id = v_ws and started_at between p_from and p_to),
    'sla_by_policy', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select p.key, p.label, p.target_minutes,
          count(t.*) filter (where t.status = 'met') as met, count(t.*) filter (where t.status = 'breached') as breached,
          count(t.*) filter (where t.status = 'running') as running,
          round(avg(extract(epoch from (t.met_at - t.started_at))/60) filter (where t.met_at is not null)::numeric, 1) as avg_minutes
        from sla_policies p left join sla_timers t on t.workspace_id = p.workspace_id and t.policy_key = p.key and t.started_at between p_from and p_to
        where p.workspace_id = v_ws group by p.key, p.label, p.target_minutes order by p.target_minutes) x),
    'commercial', (select jsonb_build_object(
        'booking_value', coalesce(sum(total) filter (where booking_confirmed_at between p_from and p_to), 0),
        'completed_revenue', coalesce(sum(total) filter (where service_completed_at between p_from and p_to), 0),
        'outstanding', coalesce(sum(greatest(total - amount_collected, 0)) filter (where service_completed_at is not null and stage <> 'cancelled' and payment_status not in ('waived')), 0))
      from cases where workspace_id = v_ws),
    'collections', (select coalesce(sum(amount),0) from payments where workspace_id = v_ws and collected_at between p_from and p_to),
    'unreconciled', (select count(*) from payments where workspace_id = v_ws and not reconciled),
    'complaints_open', (select count(*) from complaints where workspace_id = v_ws and status in ('open','acknowledged')),
    'complaints_new', (select count(*) from complaints where workspace_id = v_ws and opened_at between p_from and p_to),
    'escalations_open', (select jsonb_build_object(
        'clinical', count(*) filter (where type in ('clinical','emergency')),
        'operational', count(*) filter (where type not in ('clinical','emergency')),
        'total', count(*))
      from escalations where workspace_id = v_ws and status <> 'resolved'),
    'approvals_pending', (select count(*) from approvals where workspace_id = v_ws and status = 'pending'),
    'by_zone', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select coalesce(z.name, 'Unmapped') as zone, count(*) as cases, count(*) filter (where c.booking_confirmed_at is not null) as booked,
               count(*) filter (where c.sla_state = 'breached') as breached, coalesce(sum(c.total),0) as value
        from cases c left join zones z on z.id = c.zone_id
        where c.workspace_id = v_ws and c.created_at between p_from and p_to group by 1 order by 2 desc) x),
    'by_service', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select i.category, count(*) as items, coalesce(sum(i.line_total),0) as value
        from case_items i join cases c on c.id = i.case_id
        where c.workspace_id = v_ws and c.created_at between p_from and p_to group by 1 order by 3 desc) x),
    'by_channel', (select coalesce(jsonb_object_agg(source_channel, n), '{}'::jsonb) from (
        select source_channel, count(*) as n from cases where workspace_id = v_ws and created_at between p_from and p_to group by 1) x),
    'hourly', (select coalesce(jsonb_agg(x order by x.h), '[]'::jsonb) from (
        select extract(hour from started_at at time zone 'Asia/Kolkata')::int as h, count(*) as calls,
               count(*) filter (where status in ('missed','abandoned')) as missed
        from calls where workspace_id = v_ws and started_at between p_from and p_to group by 1) x),
    'generated_at', now()
  ) into r;
  return r;
end $$;

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
                'abandon_pct', round(100.0 * count(*) filter (where status in ('abandoned','missed')) / nullif(count(*),0), 1),
                'avg_talk', round(avg(talk_seconds))::int)
              from public.v_call_metrics where workspace_id = v_ws and started_at >= t1 and started_at < t2),
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
              from profiles p left join public.v_call_metrics cl on cl.workspace_id = p.workspace_id and cl.agent_id = p.id and cl.started_at >= t1 and cl.started_at < t2
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

-- Refresh only the saved call/agent metrics. Clear stale AI narratives when
-- those values change; keep delivery status so historical emails are not resent.
do $$
declare previous_role text := current_setting('request.jwt.claim.role', true); refreshed_count integer;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  with refreshed as materialized (
    select id, mis_report(period_start, period_end, workspace_id) as report
    from public.mis_snapshots
  ), patched as (
    select s.id, jsonb_set(jsonb_set(s.data, '{agents}', r.report->'agents'),
      '{calls,avg_talk}', r.report#>'{calls,avg_talk}') as data
    from public.mis_snapshots s join refreshed r on r.id = s.id
  )
  update public.mis_snapshots s set data = p.data, narrative = null, generated_at = now()
  from patched p where s.id = p.id and s.data is distinct from p.data;
  get diagnostics refreshed_count = row_count;
  perform set_config('request.jwt.claim.role', coalesce(previous_role, ''), true);
  raise notice 'Call duration cleanup: % saved MIS snapshots refreshed', refreshed_count;
end $$;
