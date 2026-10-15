-- =====================================================================
-- CareDesk CRM  |  Expected discharge and requested service start on the enquiry
--   Agents record, on the page where the requirement is captured (Agent console > New enquiry):
--   * expected discharge date     reuses cases.expected_discharge_on (the same field the post-discharge intake,
--                                 the hospital validation, the checklist and the partner leads already read)
--   * requested service start     new cases.requested_service_start_on: the date the patient / family wants the
--                                 captured home care to begin. A request only: not a booking, not a start.
--   Both are dates (no time, no time zone), nullable, never defaulted and never inferred from other fields.
--   They are independent of the callback queue (callbacks.due_at), the preferred visit slot (cases.preferred_slot)
--   and the booked slot (cases.booked_slot). No ordering or mandatory rule is added here.
--   Corrections go through set_case_requirements (the case page's Requirements > Edit), which also carries the
--   branch, request note and additional information that panel already edits.
-- Expand only: one nullable column, replaced functions, views extended with the new column at the end.
-- =====================================================================

alter table cases add column if not exists requested_service_start_on date;
comment on column cases.requested_service_start_on is
  'Date the patient / family asked home care to begin (requested, not confirmed). Independent of callbacks, preferred_slot and booked_slot.';
comment on column cases.expected_discharge_on is
  'Date the hospital discharge is currently expected (not confirmation that it happened). Set at enquiry, intake or validation.';

-- 'YYYY-MM-DD' -> date. Empty or null -> null. Anything else, or a day that does not exist, is refused.
create or replace function parse_day(p_value text, p_label text) returns date
language plpgsql stable as $$
declare v text := nullif(trim(p_value), ''); d date;
begin
  if v is null then return null; end if;
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '% must be a date (YYYY-MM-DD)', p_label; end if;
  begin
    d := v::date;
  exception when others then
    raise exception '% is not a real calendar date', p_label;
  end;
  return d;
end $$;

-- ---------- enquiry capture: same as 20261009110100_providers_routing plus the two dates ----------
create or replace function create_enquiry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_pat uuid; v_case uuid; v_no text; v_ws uuid := coalesce(me_ws(), (p->>'workspace_id')::uuid); v_branch text;
  v_discharge date; v_start date;
begin
  if not (is_ops() or is_service()) then raise exception 'Not allowed for your role'; end if;
  v_discharge := parse_day(p->>'expected_discharge_on', 'Expected discharge date');
  v_start := parse_day(p->>'requested_service_start_on', 'Requested service start date');
  if nullif(p->'patient'->>'patient_id','') is null and nullif(p->'patient'->>'mobile','') is null and nullif(p->>'call_id','') is not null then
    p := jsonb_set(p, '{patient,patient_id}', coalesce(to_jsonb((select patient_id from calls where id = (p->>'call_id')::uuid and workspace_id = v_ws)), 'null'::jsonb));
  end if;
  -- new caller on a linked call: take the number from the call record (agents only see it masked)
  if nullif(p->'patient'->>'patient_id','') is null and nullif(p->'patient'->>'mobile','') is null and nullif(p->>'call_id','') is not null then
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
  insert into cases(workspace_id, patient_id, caller_name, caller_relation, caller_mobile, source_channel, priority,
                    services_requested, clinical_notes, additional_info, branch, preferred_slot, address, pincode, owner_id,
                    expected_discharge_on, requested_service_start_on)
  values (v_ws, v_pat, nullif(p->>'caller_name',''), nullif(p->>'caller_relation',''), norm_mobile(nullif(p->>'caller_mobile','')),
          coalesce(nullif(p->>'source_channel',''),'phone'), coalesce(nullif(p->>'priority',''),'routine'),
          nullif(p->>'services_requested',''), nullif(p->>'clinical_notes',''), nullif(p->>'additional_info',''), v_branch,
          nullif(p->>'preferred_slot','')::timestamptz,
          nullif(p->'patient'->>'address',''), nullif(p->'patient'->>'pincode',''), coalesce(nullif(p->>'owner_id','')::uuid, app_uid()),
          v_discharge, v_start)
  returning id, case_no into v_case, v_no;
  insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note) values (v_case, null, 'enquiry', app_uid(), 'Case created');
  if nullif(p->>'call_id','') is not null then
    update calls set case_id = v_case, patient_id = v_pat where id = (p->>'call_id')::uuid;
    perform log_interaction(v_case, 'phone', 'inbound', 'Enquiry captured from call · case ID generated', p->>'services_requested', null, jsonb_build_object('call_id', p->>'call_id'));
  else
    perform log_interaction(v_case, coalesce(nullif(p->>'source_channel',''),'phone'), 'inbound', 'Enquiry captured · case ID generated', p->>'services_requested');
  end if;
  if (p->>'consent')::boolean then
    perform log_interaction(v_case, 'system', 'internal', 'Consent recorded (verbal)', null);
  end if;
  if (select array_length(array(select jsonb_array_elements_text(coalesce(p->'service_ids','[]'::jsonb))),1)) > 0 then
    insert into case_items(case_id, service_id)
    select v_case, x::uuid from jsonb_array_elements_text(p->'service_ids') x;
  end if;
  perform set_config('app.routing', 'on', true);
  perform route_case(v_case);
  return jsonb_build_object('case_id', v_case, 'case_no', v_no, 'patient_id', v_pat);
end $$;

-- ---------- correct the captured requirement on the case page ----------
-- p: any of branch, services_requested, additional_info, expected_discharge_on, requested_service_start_on.
-- Only keys present in p change (null or '' clears); every other column is left as it is, so editing one date
-- never touches the other. Changes are audited by trg_audit; date changes also go on the timeline.
create or replace function set_case_requirements(p_case uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; v_dis date; v_start date; v_notes text[] := '{}';
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Nothing to save'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.stage in ('closed','cancelled') then raise exception 'Case is %; reopen it first.', c.stage; end if;
  v_dis := case when p ? 'expected_discharge_on' then parse_day(p->>'expected_discharge_on', 'Expected discharge date') else c.expected_discharge_on end;
  v_start := case when p ? 'requested_service_start_on' then parse_day(p->>'requested_service_start_on', 'Requested service start date') else c.requested_service_start_on end;
  -- the post-discharge intake already requires the discharge date once the requirement is captured (set_intake):
  -- it cannot be cleared here either (older records that never had it stay editable)
  if v_dis is null and c.expected_discharge_on is not null
     and c.care_type = 'post_discharge' and c.intake_disposition = 'requirement_captured' then
    raise exception 'Enter the expected discharge date';
  end if;
  update cases set
    branch = case when p ? 'branch' then nullif(trim(p->>'branch'), '') else branch end,
    services_requested = case when p ? 'services_requested' then nullif(trim(p->>'services_requested'), '') else services_requested end,
    additional_info = case when p ? 'additional_info' then nullif(trim(p->>'additional_info'), '') else additional_info end,
    expected_discharge_on = v_dis,
    requested_service_start_on = v_start
  where id = p_case;
  if v_dis is distinct from c.expected_discharge_on then
    v_notes := v_notes || ('expected discharge ' || coalesce(to_char(v_dis, 'DD Mon YYYY'), 'cleared'));
  end if;
  if v_start is distinct from c.requested_service_start_on then
    v_notes := v_notes || ('requested service start ' || coalesce(to_char(v_start, 'DD Mon YYYY'), 'cleared'));
  end if;
  if cardinality(v_notes) > 0 then
    perform log_interaction(p_case, 'system', 'internal', 'Dates updated: ' || array_to_string(v_notes, ', '), null);
  end if;
  return jsonb_build_object('case_id', p_case, 'expected_discharge_on', v_dis, 'requested_service_start_on', v_start);
end $$;

-- ---------- views: append the new column without changing any existing column order ----------
do $$
declare v_def text;
begin
  if not exists (select 1 from pg_attribute where attrelid = 'v_cases'::regclass and attname = 'requested_service_start_on' and not attisdropped) then
    v_def := rtrim(trim(pg_get_viewdef('v_cases'::regclass, true)), ';');
    execute 'create or replace view v_cases with (security_invoker = true) as select previous.*, x.requested_service_start_on from ('
      || v_def || ') previous left join cases x on x.id = previous.id';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'v_referrals'::regclass and attname = 'requested_service_start_on' and not attisdropped) then
    v_def := rtrim(trim(pg_get_viewdef('v_referrals'::regclass, true)), ';');
    execute 'create or replace view v_referrals with (security_invoker = true) as select previous.*, x.requested_service_start_on from ('
      || v_def || ') previous left join cases x on x.id = previous.case_id';
  end if;
end $$;
grant select on v_cases, v_referrals to caredesk_app;
