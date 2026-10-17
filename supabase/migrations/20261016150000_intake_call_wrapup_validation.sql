-- Migration: 20261016140000_intake_call_wrapup_validation.sql
-- 1. Call wrap-up & case intake extensions:
--    - adds action_taken to cases
--    - adds action_taken, followup_at, followup_owner_id to calls
--    - wrap_up_call() RPC for recording disposition, action taken, notes, follow-up per handled call
--    - updates set_intake() to support action_taken
-- 2. Hospital validation hardening:
--    - record_validation() requires treating doctor, ward nurse/staff, and family confirmation for hospital_bedside assessments marked Ready
--    - preserves separate home-visit rules (only family confirmation required)
-- 3. Commercial agreement & routing:
--    - set_item_scope() clears signoff_at on scope changes to enforce renewed sign-off
-- 4. Central coordination SPOC:
--    - assign_coordinator() RPC to assign/reassign Care Coordinator SPOC for complete journey monitoring including BMM-only cases
-- 5. Views:
--    - v_calls and v_cases extended with new columns preserving order

alter table cases add column if not exists action_taken text;
alter table calls add column if not exists action_taken text;
alter table calls add column if not exists followup_at timestamptz;
alter table calls add column if not exists followup_owner_id uuid references profiles(id);

-- wrap_up_call: record enquiry/call disposition, action taken, and optional follow-up per handled call
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

  if v_disp is null and v_act is null and v_notes is null and v_fo_at is null and v_case is null then
    raise exception 'Nothing to save for call wrap-up';
  end if;

  update calls set
    disposition = coalesce(v_disp, disposition),
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

-- assign_coordinator: assign or change the designated Care Coordinator SPOC on a case
create or replace function assign_coordinator(p_case uuid, p_coordinator uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c record;
  pr record;
begin
  if not (has_role('supervisor','coordinator') or is_ops()) then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;

  select * into pr from profiles where id = p_coordinator and workspace_id = c.workspace_id and role = 'coordinator' and active;
  if not found then raise exception 'Choose an active Care Coordinator in this workspace'; end if;

  update cases set coordinator_id = p_coordinator where id = p_case;

  perform log_interaction(p_case, 'system', 'internal',
    'Care Coordinator SPOC assigned: ' || pr.full_name, null, null,
    jsonb_build_object('coordinator_id', p_coordinator, 'coordinator_name', pr.full_name));

  return jsonb_build_object('case_id', p_case, 'coordinator_id', p_coordinator, 'coordinator_name', pr.full_name);
end $$;

-- set_intake: update case-level intake details, including action_taken
create or replace function set_intake(p_case uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; v_type text; v_disp text; v_label text;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.stage in ('closed','cancelled') then raise exception 'Case is %; reopen it first.', c.stage; end if;
  v_type := coalesce(nullif(p->>'care_type',''), c.care_type);
  v_disp := coalesce(nullif(p->>'intake_disposition',''), c.intake_disposition);
  if v_disp is null then raise exception 'Choose the interaction reason'; end if;
  if v_type = 'post_discharge' and v_disp = 'requirement_captured' then
    if coalesce(nullif(p->>'spoke_with',''), c.spoke_with) is null then raise exception 'Say who you spoke with'; end if;
    if coalesce(nullif(p->>'expected_discharge_on','')::date, c.expected_discharge_on) is null then raise exception 'Enter the expected discharge date'; end if;
  end if;
  update cases set
    care_type = v_type,
    intake_disposition = v_disp,
    action_taken = coalesce(nullif(p->>'action_taken',''), action_taken),
    hospital_name = coalesce(nullif(p->>'hospital_name',''), hospital_name),
    hospital_ward = coalesce(nullif(p->>'hospital_ward',''), hospital_ward),
    treating_doctor = coalesce(nullif(p->>'treating_doctor',''), treating_doctor),
    expected_discharge_on = coalesce(nullif(p->>'expected_discharge_on','')::date, expected_discharge_on),
    spoke_with = coalesce(nullif(p->>'spoke_with',''), spoke_with),
    decision_maker_name = coalesce(nullif(p->>'decision_maker_name',''), decision_maker_name),
    decision_maker_relation = coalesce(nullif(p->>'decision_maker_relation',''), decision_maker_relation),
    decision_maker_mobile = coalesce(norm_mobile(nullif(p->>'decision_maker_mobile','')), decision_maker_mobile),
    hospital_room = coalesce(nullif(p->>'hospital_room',''), hospital_room),
    clinical_notes = coalesce(nullif(p->>'clinical_status',''), nullif(p->>'clinical_notes',''), clinical_notes),
    services_requested = coalesce(nullif(p->>'services_requested',''), services_requested),
    plan_days = coalesce(nullif(p->>'plan_days','')::int, plan_days)
  where id = p_case;
  if v_type = 'post_discharge' and c.validation_status = 'not_required' then
    perform rpc_on();
    update cases set validation_status = 'pending' where id = p_case;
    perform sla_start(c.workspace_id, 'validation', p_case, null, null);
  end if;
  -- leads sent automatically at enquiry and not yet taken up wait for the family's sign-off
  if v_type = 'post_discharge' and c.signoff_at is null then
    update case_referrals set status = 'cancelled', updated_at = now()
     where case_id = p_case and auto and status = 'new';
    if found then
      perform log_interaction(p_case, 'system', 'internal', 'Partner leads on hold until the family signs off', null);
    end if;
  end if;
  v_label := initcap(replace(v_disp, '_', ' '));
  perform log_interaction(p_case, 'system', 'internal',
    'Intake' || case when v_type = 'post_discharge' then ' (post-discharge)' else '' end || ': ' || v_label
    || case when nullif(p->>'action_taken','') is not null then ' · ' || (p->>'action_taken') else '' end,
    null, null, jsonb_build_object('disposition', v_disp, 'action_taken', p->>'action_taken'));
  return (select jsonb_build_object('care_type', care_type, 'intake_disposition', intake_disposition,
                                    'action_taken', action_taken,
                                    'validation_status', validation_status) from cases where id = p_case);
end $$;

-- record_validation: enforce treating doctor, ward nurse/staff, and family confirmations for hospital bedside
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

  if v_type = 'hospital_bedside' and v_ready = 'ready' then
    if not coalesce((p->>'met_doctor')::boolean, false) then
      raise exception 'Meet the treating doctor before confirming discharge readiness';
    end if;
    if not coalesce((p->>'met_ward_staff')::boolean, false) then
      raise exception 'Meet the ward nurse or staff before confirming discharge readiness';
    end if;
    if not coalesce((p->>'met_family')::boolean, false) then
      raise exception 'Meet the family before confirming discharge readiness';
    end if;
  end if;

  if v_type = 'home_visit' and v_ready = 'ready' then
    if not coalesce((p->>'met_family')::boolean, false) then
      raise exception 'Meet the family before confirming discharge readiness';
    end if;
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

-- set_item_scope: dropping or adding an item clears sign-off so renewed sign-off is required
create or replace function set_item_scope(p_item uuid, p_included boolean, p_reason text default null, p_qty int default null,
                                          p_category text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i record; c record; v_cat text := coalesce(nullif(p_category,''), 'other');
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into i from case_items where id = p_item;
  if not found or not can_see_case(i.case_id) then raise exception 'Item not found'; end if;
  select * into c from cases where id = i.case_id;
  if c.stage not in ('enquiry','pricing') then raise exception 'Services can only be changed during Enquiry or Pricing'; end if;
  if not p_included and coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for dropping the item'; end if;
  if not p_included and v_cat not in ('cost','space','unwilling','clinical','arranged_elsewhere','other') then
    raise exception 'Unknown reason category %', v_cat;
  end if;
  if p_qty is not null and p_qty < 1 then raise exception 'Quantity must be greater than or equal to 1'; end if;
  update case_items set excluded = not p_included,
    exclude_reason = case when p_included then null else trim(p_reason) end,
    exclude_category = case when p_included then null else v_cat end,
    qty = coalesce(p_qty, qty)
  where id = p_item;
  if c.signoff_at is not null then
    perform rpc_on();
    update cases set signoff_at = null where id = i.case_id;
    perform log_interaction(i.case_id, 'system', 'internal', 'Scope changed after sign-off · new sign-off needed', null);
  end if;
  perform log_interaction(i.case_id, 'system', 'internal',
    'Scope: ' || i.service_name || case when not p_included then ' dropped (' || replace(v_cat, '_', ' ') || ': ' || trim(p_reason) || ')'
      when i.excluded then ' added back' else ' quantity ' || coalesce(p_qty, i.qty) end, null);
  return (select jsonb_build_object('subtotal', subtotal, 'total', total, 'signoff_at', signoff_at) from cases where id = i.case_id);
end $$;

-- Preserve v_calls column order and extend with action_taken, followup_at, followup_owner_id
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
  cl.action_taken, cl.followup_at, cl.followup_owner_id
from calls cl
left join workspaces w on w.id = cl.workspace_id
left join profiles pr on pr.id = cl.agent_id
left join patients p on p.id = cl.patient_id
left join cases c on c.id = cl.case_id;

-- Extend v_cases with action_taken if not already present
do $$
declare v_def text;
begin
  if not exists (select 1 from pg_attribute where attrelid = 'v_cases'::regclass and attname = 'action_taken' and not attisdropped) then
    v_def := rtrim(trim(pg_get_viewdef('v_cases'::regclass, true)), ';');
    execute 'create or replace view v_cases with (security_invoker = true) as select previous.*, x.action_taken from ('
      || v_def || ') previous left join cases x on x.id = previous.id';
  end if;
end $$;

-- create_enquiry: record intake_disposition and action_taken on case and call
create or replace function create_enquiry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pat uuid;
  v_case uuid;
  v_no text;
  v_ws uuid := coalesce(me_ws(), (p->>'workspace_id')::uuid);
  v_branch text;
  v_discharge date;
  v_start date;
  v_source text;
  v_subtype text;
  v_disp text;
  v_act text;
  v_care_type text;
  v_dm_name text;
  v_dm_rel text;
  v_dm_mobile text;
  v_spoke_with text;
  v_val_status text;
begin
  if not (is_ops() or is_service()) then raise exception 'Not allowed for your role'; end if;
  v_discharge := parse_day(p->>'expected_discharge_on', 'Expected discharge date');
  v_start := parse_day(p->>'requested_service_start_on', 'Requested service start date');
  v_source := coalesce(nullif(p->>'source_channel',''), 'phone');
  v_subtype := case when v_source = 'referral' then nullif(trim(p->>'referral_subtype'), '') else null end;
  v_care_type := coalesce(nullif(trim(p->>'care_type'), ''), 'standard');
  v_disp := coalesce(nullif(trim(p->>'intake_disposition'), ''), case when v_care_type = 'post_discharge' then 'requirement_captured' else null end);
  v_act := coalesce(nullif(trim(p->>'action_taken'), ''), 'Case created');
  v_dm_name := coalesce(nullif(trim(p->>'decision_maker_name'), ''), nullif(trim(p->>'caller_name'), ''));
  v_dm_rel := coalesce(nullif(trim(p->>'decision_maker_relation'), ''), nullif(trim(p->>'caller_relation'), ''));
  v_dm_mobile := coalesce(norm_mobile(nullif(p->>'decision_maker_mobile', '')), norm_mobile(nullif(p->>'caller_mobile', '')));
  v_spoke_with := nullif(trim(p->>'spoke_with'), '');
  v_val_status := case when v_care_type = 'post_discharge' then 'pending' else 'not_required' end;

  -- Only link patient from call if agent did not supply explicit patient name/details
  if nullif(p->'patient'->>'patient_id','') is null
     and nullif(p->'patient'->>'mobile','') is null
     and nullif(trim(p->'patient'->>'full_name'),'') is null
     and nullif(p->>'call_id','') is not null then
    p := jsonb_set(p, '{patient,patient_id}', coalesce(to_jsonb((select patient_id from calls where id = (p->>'call_id')::uuid and workspace_id = v_ws)), 'null'::jsonb));
  end if;

  -- new caller on a linked call: take the number from the call record when no mobile is typed. Not when a different
  -- patient is entered on a known caller's call (that number belongs to the known patient).
  if nullif(p->'patient'->>'patient_id','') is null
     and nullif(p->'patient'->>'mobile','') is null
     and nullif(p->>'call_id','') is not null
     and (nullif(trim(p->'patient'->>'full_name'),'') is null
          or (select patient_id from calls where id = (p->>'call_id')::uuid and workspace_id = v_ws) is null) then
    p := jsonb_set(p, '{patient,mobile}', coalesce(to_jsonb((select customer_number from calls where id = (p->>'call_id')::uuid and workspace_id = v_ws)), 'null'::jsonb));
  end if;

  if nullif(p->>'caller_mobile','') is null and nullif(p->>'call_id','') is not null then
    p := p || jsonb_build_object('caller_mobile', (select customer_number from calls where id = (p->>'call_id')::uuid and workspace_id = v_ws));
  end if;

  -- branch: as chosen, else the IVR department of the call when it names a branch
  v_branch := nullif(trim(p->>'branch'), '');
  if v_branch is null and nullif(p->>'call_id','') is not null then
    select b into v_branch from calls cl, workspaces w, jsonb_array_elements_text(coalesce(w.settings->'branches', '[]'::jsonb)) b
     where cl.id = (p->>'call_id')::uuid and w.id = cl.workspace_id and cl.department ilike '%' || b || '%' limit 1;
  end if;

  v_pat := upsert_patient(p->'patient' || jsonb_build_object('workspace_id', v_ws));
  if (p->>'consent')::boolean then
    update patients set consent_verbal_at = coalesce(consent_verbal_at, now()),
                        consent_verbal_call_id = coalesce(nullif(p->>'call_id','')::uuid, consent_verbal_call_id)
    where id = v_pat;
  end if;

  perform set_config('app.routing', 'off', true);
  insert into cases(workspace_id, patient_id, caller_name, caller_relation, caller_mobile, source_channel, referral_subtype, priority,
                    services_requested, clinical_notes, additional_info, branch, preferred_slot, address, pincode, owner_id,
                    expected_discharge_on, requested_service_start_on, intake_disposition, action_taken,
                    care_type, decision_maker_name, decision_maker_relation, decision_maker_mobile, spoke_with,
                    hospital_name, hospital_ward, treating_doctor, validation_status)
  values (v_ws, v_pat, nullif(p->>'caller_name',''), nullif(p->>'caller_relation',''), norm_mobile(nullif(p->>'caller_mobile','')),
          v_source, v_subtype, coalesce(nullif(p->>'priority',''),'routine'),
          nullif(p->>'services_requested',''), nullif(p->>'clinical_notes',''), nullif(p->>'additional_info',''), v_branch,
          nullif(p->>'preferred_slot','')::timestamptz,
          nullif(p->'patient'->>'address',''), nullif(p->'patient'->>'pincode',''), coalesce(nullif(p->>'owner_id','')::uuid, app_uid()),
          v_discharge, v_start, v_disp, v_act,
          v_care_type, v_dm_name, v_dm_rel, v_dm_mobile, v_spoke_with,
          nullif(trim(p->>'hospital_name'),''), nullif(trim(p->>'hospital_ward'),''), nullif(trim(p->>'treating_doctor'),''), v_val_status)
  returning id, case_no into v_case, v_no;

  if v_care_type = 'post_discharge' then
    perform sla_start(v_ws, 'validation', v_case, null, null);
  end if;

  insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note) values (v_case, null, 'enquiry', app_uid(), 'Case created');
  if nullif(p->>'call_id','') is not null then
    update calls set
      case_id = v_case,
      patient_id = v_pat,
      disposition = coalesce(disposition, v_disp),
      action_taken = coalesce(action_taken, 'Case ' || v_no || ' created')
    where id = (p->>'call_id')::uuid;
    perform log_interaction(v_case, 'phone', 'inbound', 'Enquiry captured from call · case ID generated', p->>'services_requested', null, jsonb_build_object('call_id', p->>'call_id'));
  else
    perform log_interaction(v_case, v_source, 'inbound', 'Enquiry captured · case ID generated', p->>'services_requested');
  end if;
  if (p->>'consent')::boolean then
    perform log_interaction(v_case, 'system', 'internal', 'Consent recorded (verbal)', null);
  end if;
  if (select array_length(array(select jsonb_array_elements_text(coalesce(p->'service_ids','[]'::jsonb))),1)) > 0 then
    insert into case_items(case_id, service_id)
    select distinct v_case, x::uuid from jsonb_array_elements_text(p->'service_ids') x;
  end if;
  perform set_config('app.routing', 'on', true);
  perform route_case(v_case);
  return jsonb_build_object('case_id', v_case, 'case_no', v_no, 'patient_id', v_pat);
end $$;

grant execute on function wrap_up_call(uuid, jsonb), assign_coordinator(uuid, uuid), set_intake(uuid, jsonb), record_validation(uuid, jsonb), set_item_scope(uuid, boolean, text, int, text), create_enquiry(jsonb) to caredesk_app;
grant select on v_calls, v_cases to caredesk_app;
