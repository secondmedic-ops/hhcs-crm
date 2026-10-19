-- Purge synthetic demonstration test breaches prior to production launch:
-- 1. Test escalations associated with synthetic demo cases or walkthrough trigger text.
-- 2. Staged low-score QA evaluations (e.g. 12% staged warnings) and demo reviews.
-- 3. Stale demonstration callback breaches and orphaned test SLA timers.
-- 4. Reset SLA breach state on demo cases to 'ok'.
-- All configuration, rate cards, users, and product knowledge are preserved untouched.
do $$
declare
  v_esc_count int := 0;
  v_qa_count int := 0;
  v_cb_count int := 0;
  v_timer_count int := 0;
  v_case_count int := 0;
begin
  -- 1. Delete test escalations associated with synthetic demo cases or walkthrough triggers
  with del_esc as (
    delete from public.escalations
    where case_id in (
      select id from public.cases
      where case_no ~* '^(demo|test)-'
         or patient_id in (
           select id from public.patients
           where mobile ~ '^\+919800000'
              or mobile in ('+919820012012', '9930011223', '9930011224', '9930011225')
              or full_name ~* '^(demo|test)'
         )
    )
    or trigger_text ~* '(demo|synthetic|test|sample|simulat|slot at risk|technician running late|audit warning)'
    or (case_id is null and complaint_id is null and status <> 'resolved')
    returning id
  )
  select count(*) into v_esc_count from del_esc;

  -- 2. Delete staged low-score QA reviews and demo call evaluations
  with del_qa as (
    delete from public.qa_reviews
    where total_pct <= 20.0
       or notes ~* '(demo|audit warning|staged|test evaluation)'
       or call_id in (
         select id from public.calls
         where session_id ~* '^(local|demo|test)-'
            or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
            or raw->'first'->>'event_id' like 'local-%'
            or raw->'end'->>'event_id' like 'local-%'
       )
    returning id
  )
  select count(*) into v_qa_count from del_qa;

  -- 3. Delete stale demonstration callbacks
  with del_cb as (
    delete from public.callbacks
    where number in ('+919820012012', '9930011223', '9930011224', '9930011225')
       or number ~ '^\+919800000'
       or call_id in (
         select id from public.calls
         where session_id ~* '^(local|demo|test)-'
            or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
       )
    returning id
  )
  select count(*) into v_cb_count from del_cb;

  -- Delete stale breached SLA timers associated with demo cases/complaints
  with del_timers as (
    delete from public.sla_timers
    where status = 'breached' and (
      case_id in (select id from public.cases where case_no ~* '^(demo|test)-')
      or complaint_id in (select id from public.complaints where ref_no ~* '^(demo|test|cmp-)-' or description ~* 'demo')
      or (callback_id is null and case_id is null)
    )
    returning id
  )
  select count(*) into v_timer_count from del_timers;

  -- 4. Reset SLA breach state on demo cases to 'ok'
  with upd_cases as (
    update public.cases
    set sla_state = 'ok'
    where sla_state in ('breached', 'at_risk')
      and (
        case_no ~* '^(demo|test)-'
        or stage in ('closed', 'cancelled')
        or patient_id in (
          select id from public.patients
          where mobile ~ '^\+919800000' or mobile in ('+919820012012', '9930011223')
        )
      )
    returning id
  )
  select count(*) into v_case_count from upd_cases;

  -- Log cleanup action into audit_log if any records were modified
  if (v_esc_count + v_qa_count + v_cb_count + v_timer_count + v_case_count) > 0 then
    insert into public.audit_log (table_name, action, changes)
    values ('system', 'purge_demo_test_data', jsonb_build_object(
      'escalations_purged', v_esc_count,
      'qa_reviews_purged', v_qa_count,
      'callbacks_purged', v_cb_count,
      'sla_timers_purged', v_timer_count,
      'cases_sla_reset', v_case_count,
      'reason', 'Reset demonstration test breaches and staged QA warnings before production cutover'
    ));
  end if;

  raise notice 'Demo test breach purge complete: % escalations, % QA reviews, % callbacks, % SLA timers, % cases reset',
    v_esc_count, v_qa_count, v_cb_count, v_timer_count, v_case_count;
end $$;

