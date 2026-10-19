-- REQ-11 / GAP-04: dedicated Hinduja Direct and SecondMedic Ops Escrow accounts.
-- Existing collections belong to Hinduja Direct. Keep four-argument callers compatible.
alter table public.payments add column if not exists destination_account text not null default 'HHC_HINDUJA';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.payments'::regclass
                 and conname = 'payments_destination_account_check') then
    alter table public.payments add constraint payments_destination_account_check
      check (destination_account in ('HHC_HINDUJA', 'HHC_SECONDMEDIC'));
  end if;
end $$;

create or replace function record_payment(p_case uuid, p_amount numeric, p_mode text, p_txn text, p_account text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; v uuid; v_rcpt text;
begin
  if not (is_ops() or has_role('field_staff') or is_service()) then raise exception 'Not allowed'; end if;
  if p_account is null or p_account not in ('HHC_HINDUJA', 'HHC_SECONDMEDIC') then
    raise exception 'Choose a valid bank account';
  end if;
  select * into c from cases where id = p_case;
  if p_mode = 'cash' and not coalesce((select (settings->>'allow_cash')::boolean from workspaces where id = c.workspace_id), false) then
    raise exception 'Cash collection is not enabled for this workspace';
  end if;
  v_rcpt := 'RCPT-' || replace(c.case_no, '-', '') || '-' || (select count(*) + 1 from payments where case_id = p_case);
  insert into payments(workspace_id, case_id, amount, mode, txn_ref, receipt_no, collected_by, destination_account)
  values (c.workspace_id, p_case, p_amount, p_mode, p_txn, v_rcpt, app_uid(), p_account) returning id into v;
  perform refresh_payment_status(p_case);
  perform log_interaction(p_case, 'payment', 'internal', 'Payment ₹' || p_amount || ' via ' || upper(p_mode) || ' · receipt ' || v_rcpt, null, coalesce('Txn ' || p_txn, 'Receipt'));
  return v;
end $$;

-- The explicit five-argument overload avoids ambiguity with existing defaulted calls.
create or replace function record_payment(p_case uuid, p_amount numeric, p_mode text, p_txn text default null) returns uuid
language sql security definer set search_path = public as $$
  select record_payment(p_case, p_amount, p_mode, p_txn, 'HHC_HINDUJA');
$$;
revoke execute on function record_payment(uuid, numeric, text, text, text) from public;
grant execute on function record_payment(uuid, numeric, text, text, text) to caredesk_app;

-- Used by the Worker RPC passthrough, browser demo and scheduled MIS snapshots.
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

