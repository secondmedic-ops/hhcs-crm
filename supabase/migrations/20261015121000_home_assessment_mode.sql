-- Home assessment visit vs hospital bedside validation (Case 1 Step 3)
-- For home visits, doctor and ward staff are not present at the patient's home.
-- The nurse validates the home environment and family handover without requiring met_doctor.

-- 1. Schema & Assessment Type
alter table discharge_assessments add column if not exists assessment_type text not null default 'hospital_bedside';
alter table discharge_assessments drop constraint if exists discharge_assessments_assessment_type_check;
alter table discharge_assessments add constraint discharge_assessments_assessment_type_check
  check (assessment_type in ('hospital_bedside', 'home_visit'));

alter table cases add column if not exists assessment_type text not null default 'hospital_bedside';
alter table cases drop constraint if exists cases_assessment_type_check;
alter table cases add constraint cases_assessment_type_check
  check (assessment_type in ('hospital_bedside', 'home_visit'));

-- Update views so assessment_type is exposed in v_cases and v_assessments
drop view if exists v_cases;
create view v_cases with (security_invoker = true) as
select c.*,
  p.full_name   as patient_name,
  p.age         as patient_age,
  p.gender      as patient_gender,
  case when has_role('agent') then mask_mobile(p.mobile) else p.mobile end as patient_mobile,
  case when has_role('agent') then mask_mobile(c.caller_mobile) else c.caller_mobile end as caller_mobile_display,
  p.locality    as patient_locality,
  p.landmark    as patient_landmark,
  p.lat         as patient_lat,
  p.lng         as patient_lng,
  p.consent_verbal_at, p.consent_digital_at,
  z.name        as zone_name,
  o.full_name   as owner_name,
  o.agent_code  as owner_code,
  co.full_name  as coordinator_name,
  (select string_agg(i.service_name, ', ' order by i.created_at) from case_items i where i.case_id = c.id and not i.excluded) as service_names,
  (select string_agg(distinct i.category, ',') from case_items i where i.case_id = c.id and not i.excluded) as service_categories,
  (select min(t.due_at) from sla_timers t where t.case_id = c.id and t.status = 'running') as next_sla_due,
  (select t.policy_key from sla_timers t where t.case_id = c.id and t.status = 'running' order by t.due_at limit 1) as next_sla_key,
  (select count(*) from escalations e where e.case_id = c.id and e.status <> 'resolved') as open_escalations,
  (select count(*) from complaints k where k.case_id = c.id and k.status in ('open','acknowledged')) as open_complaints,
  (select string_agg(pv.name, ', ' order by pv.code desc) from case_referrals r join providers pv on pv.id = r.provider_id
    where r.case_id = c.id and r.status <> 'cancelled') as provider_names,
  (select jsonb_agg(jsonb_build_object('provider', pv.name, 'code', pv.code, 'status', r.status) order by pv.code desc)
     from case_referrals r join providers pv on pv.id = r.provider_id where r.case_id = c.id and r.status <> 'cancelled') as providers_status,
  (select count(*) from case_items i where i.case_id = c.id and i.recommended) as items_recommended,
  (select count(*) from case_items i where i.case_id = c.id and not i.excluded) as items_agreed,
  case when has_role('agent') then mask_mobile(c.decision_maker_mobile) else c.decision_maker_mobile end as decision_maker_mobile_display
from cases c
join patients p on p.id = c.patient_id
left join zones z on z.id = c.zone_id
left join profiles o on o.id = c.owner_id
left join profiles co on co.id = c.coordinator_id;

drop view if exists v_assessments;
create view v_assessments with (security_invoker = true) as
select d.*, n.full_name as nurse_name, c.case_no
from discharge_assessments d
join cases c on c.id = d.case_id
left join profiles n on n.id = d.nurse_id;

grant select on v_cases, v_assessments to caredesk_app;

-- 2. schedule_validation accepting optional p_type
drop function if exists schedule_validation(uuid, uuid, timestamptz);
create or replace function schedule_validation(p_case uuid, p_nurse uuid, p_when timestamptz, p_type text default 'hospital_bedside') returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; n record; v uuid; v_type text;
begin
  if not has_role('coordinator','supervisor','medical_desk') then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.care_type <> 'post_discharge' then raise exception 'Mark the case as post-discharge first'; end if;
  if c.stage not in ('enquiry','pricing') then raise exception 'Validation is done before the commercials'; end if;
  v_type := coalesce(nullif(p_type, ''), 'hospital_bedside');
  if v_type not in ('hospital_bedside', 'home_visit') then raise exception 'Invalid assessment type %', v_type; end if;
  select * into n from profiles where id = p_nurse and workspace_id = c.workspace_id and active
    and role in ('coordinator','field_staff','medical_desk');
  if not found then raise exception 'Pick an active care coordinator (nurse)'; end if;
  if p_when is null then raise exception 'Pick the visit date and time'; end if;
  update discharge_assessments set status = 'cancelled', updated_at = now() where case_id = p_case and status = 'scheduled';
  insert into discharge_assessments (workspace_id, case_id, nurse_id, status, scheduled_at, assessment_type, created_by)
  values (c.workspace_id, p_case, p_nurse, 'scheduled', p_when, v_type, app_uid()) returning id into v;
  perform rpc_on();
  update cases set validation_status = 'scheduled',
    assessment_type = v_type,
    coordinator_id = case when n.role = 'coordinator' then coalesce(coordinator_id, p_nurse) else coordinator_id end
  where id = p_case;
  if v_type = 'home_visit' then
    perform log_interaction(p_case, 'system', 'internal', 'Home assessment visit scheduled · ' || n.full_name || ' · '
      || to_char(p_when at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), null);
    perform notify_user(p_nurse, 'Home assessment ' || c.case_no, coalesce(c.address, 'Patient home'), '/cases/' || c.id, 'info');
  else
    perform log_interaction(p_case, 'system', 'internal', 'Hospital validation visit scheduled · ' || n.full_name || ' · '
      || to_char(p_when at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), null);
    perform notify_user(p_nurse, 'Hospital validation ' || c.case_no, coalesce(c.hospital_name, 'Hinduja') ||
      coalesce(', ' || c.hospital_ward, ''), '/cases/' || c.id, 'info');
  end if;
  return v;
end $$;

grant execute on function schedule_validation(uuid, uuid, timestamptz, text) to caredesk_app;

-- 3. record_validation relaxed for home visits
create or replace function record_validation(p_case uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; a record; v_ready text; v_items int := 0; x jsonb; v_type text;
begin
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  select * into a from discharge_assessments where case_id = p_case and status = 'scheduled' order by created_at desc limit 1 for update;
  if not (has_role('coordinator','supervisor','medical_desk') or (has_role('field_staff') and a.nurse_id = app_uid())) then
    raise exception 'Not allowed for your role';
  end if;
  if c.care_type <> 'post_discharge' then raise exception 'Mark the case as post-discharge first'; end if;
  if c.stage not in ('enquiry','pricing') then raise exception 'Validation is done before the commercials'; end if;
  v_type := coalesce(nullif(p->>'assessment_type',''), a.assessment_type, c.assessment_type, 'hospital_bedside');
  if v_type not in ('hospital_bedside', 'home_visit') then raise exception 'Invalid assessment type %', v_type; end if;
  v_ready := nullif(p->>'readiness','');
  if v_ready is null or v_ready not in ('ready','not_ready','deferred') then raise exception 'Record discharge readiness'; end if;
  if v_type = 'hospital_bedside' and v_ready = 'ready' and not coalesce((p->>'met_doctor')::boolean, false) then
    raise exception 'Meet the treating doctor before confirming discharge readiness';
  end if;
  if v_ready = 'ready' and not coalesce((p->>'met_family')::boolean, false) then
    raise exception 'Meet the family before confirming discharge readiness';
  end if;
  if a.id is null then
    insert into discharge_assessments (workspace_id, case_id, nurse_id, status, scheduled_at, assessment_type, created_by)
    values (c.workspace_id, p_case, app_uid(), 'scheduled', now(), v_type, app_uid()) returning * into a;
  end if;
  update discharge_assessments set status = 'done', visited_at = coalesce(nullif(p->>'visited_at','')::timestamptz, now()),
    assessment_type = v_type,
    met_doctor = coalesce((p->>'met_doctor')::boolean, false), doctor_name = nullif(p->>'doctor_name',''),
    met_ward_staff = coalesce((p->>'met_ward_staff')::boolean, false), met_family = coalesce((p->>'met_family')::boolean, false),
    readiness = v_ready, revised_discharge_on = nullif(p->>'revised_discharge_on','')::date,
    home_setup_notes = nullif(p->>'home_setup_notes',''), clinical_summary = nullif(p->>'clinical_summary',''),
    doctor_recommendations = nullif(p->>'doctor_recommendations',''),
    updated_at = now()
  where id = a.id;
  -- the recommended list replaces the earlier recommended list; items added by hand stay
  if jsonb_typeof(p->'items') = 'array' then
    delete from case_items where case_id = p_case and recommended;
    for x in select * from jsonb_array_elements(p->'items') loop
      if coalesce((x->>'qty')::int, 0) < 1 then raise exception 'Quantity must be greater than or equal to 1'; end if;
      insert into case_items (case_id, service_id, qty, recommended) values (p_case, (x->>'service_id')::uuid, (x->>'qty')::int, true);
      v_items := v_items + 1;
    end loop;
  end if;
  perform rpc_on();
  update cases set validation_status = case when v_ready = 'ready' then 'done' else 'not_ready' end,
    assessment_type = v_type,
    expected_discharge_on = coalesce(nullif(p->>'revised_discharge_on','')::date, expected_discharge_on),
    treating_doctor = coalesce(nullif(p->>'doctor_name',''), treating_doctor)
  where id = p_case;
  if v_ready = 'ready' then
    perform sla_meet('validation', p_case);
    perform sla_start(c.workspace_id, 'signoff', p_case, null, null);
  end if;
  perform log_interaction(p_case, 'field', 'internal',
    (case when v_type = 'home_visit' then 'Home assessment: ' else 'Hospital validation: ' end)
    || case v_ready when 'ready' then 'discharge ready'
       when 'not_ready' then 'not ready for discharge' else 'discharge deferred' end
    || case when v_items > 0 then ' · ' || v_items || ' items recommended' else '' end,
    concat_ws(' · ', case when (p->>'met_doctor')::boolean then 'Doctor met' end,
                    case when (p->>'met_ward_staff')::boolean then 'Ward staff met' end,
                    case when (p->>'met_family')::boolean then 'Family met' end),
    case when v_type = 'home_visit' then 'Home assessment record' else 'Validation record' end);
  return jsonb_build_object('validation_status', case when v_ready = 'ready' then 'done' else 'not_ready' end, 'items', v_items, 'assessment_type', v_type);
end $$;

grant execute on function record_validation(uuid, jsonb) to caredesk_app;

-- Live change tracking
do $$ declare t text; begin
  foreach t in array array['discharge_assessments', 'cases'] loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;

