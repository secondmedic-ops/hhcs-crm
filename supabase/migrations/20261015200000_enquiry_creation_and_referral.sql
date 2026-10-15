-- =====================================================================
-- CareDesk CRM  |  Fix enquiry creation sequence & referral source details
-- 1. Hardens norm_mobile to return NULL on empty or non-digit input.
-- 2. Hardens trg_case_before_insert to advance case_counters past any existing
--    case numbers, eliminating unique(case_no) conflicts.
-- 3. Hardens upsert_patient against concurrent unique_violation races.
-- 4. Prevents create_enquiry from overriding explicit new patient details with call caller info.
-- 5. Adds referral_subtype to cases, v_cases, v_referrals, and set_case_requirements.
-- =====================================================================

-- 1. Normalise mobile numbers safely
create or replace function norm_mobile(p text) returns text
language sql immutable as $$
  select case
    when p is null or trim(p) = '' or length(regexp_replace(p,'\D','','g')) = 0 then null
    when length(regexp_replace(p,'\D','','g')) = 10 then '+91' || regexp_replace(p,'\D','','g')
    when length(regexp_replace(p,'\D','','g')) = 12 and left(regexp_replace(p,'\D','','g'),2)='91'
      then '+' || regexp_replace(p,'\D','','g')
    when length(regexp_replace(p,'\D','','g')) = 11 and left(regexp_replace(p,'\D','','g'),1)='0'
      then '+91' || right(regexp_replace(p,'\D','','g'),10)
    else '+' || regexp_replace(p,'\D','','g') end
$$;

-- Clean up any historical corrupt empty/plus mobile records
update patients set mobile = null where mobile is not null and (trim(mobile) in ('+', '') or length(regexp_replace(mobile,'\D','','g')) = 0);
update patients set alt_mobile = null where alt_mobile is not null and (trim(alt_mobile) in ('+', '') or length(regexp_replace(alt_mobile,'\D','','g')) = 0);

-- 2. Add referral_subtype column to cases
alter table cases add column if not exists referral_subtype text;
alter table cases drop constraint if exists cases_referral_subtype_check;
alter table cases add constraint cases_referral_subtype_check
  check (referral_subtype is null or referral_subtype in (
    'Doctor', 'Nursing Team / Internal Nurse', 'ICU / Pamphlet Advertisement', 'Other',
    'doctor', 'nurse', 'icu_pamphlet', 'other'
  ));
comment on column cases.referral_subtype is
  'Detailed referral subtype when source_channel is referral (Doctor, Nursing Team / Internal Nurse, ICU / Pamphlet Advertisement, Other)';

-- 3. Hardened case number generation avoiding desync lock
create or replace function trg_case_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_tz text;
  v_day date;
  v_seq int;
  v_candidate text;
  v_prefix text;
  p record;
begin
  select code, timezone into v_code, v_tz from workspaces where id = new.workspace_id;
  v_day := (coalesce(new.created_at, now()) at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
  v_prefix := coalesce(v_code, 'HHC') || '-' || to_char(v_day, 'YYMMDD') || '-';

  if new.case_no is null then
    loop
      insert into case_counters(workspace_id, day, last_value)
      values (new.workspace_id, v_day, 1)
      on conflict (workspace_id, day)
      do update set last_value = case_counters.last_value + 1
      returning last_value into v_seq;

      v_candidate := v_prefix || lpad(v_seq::text, 5, '0');
      if not exists (select 1 from cases where case_no = v_candidate) then
        new.case_no := v_candidate;
        exit;
      end if;
    end loop;
  end if;

  new.stage := coalesce(new.stage, 'enquiry');
  new.quote_status := coalesce(new.quote_status, 'draft');
  new.subtotal := coalesce(new.subtotal, 0);
  new.total := coalesce(new.total, 0);
  new.discount_amount := coalesce(new.discount_amount, 0);
  new.discount_pct := coalesce(new.discount_pct, 0);
  new.amount_collected := coalesce(new.amount_collected, 0);
  new.payment_status := coalesce(new.payment_status, 'unpaid');
  select * into p from patients where id = new.patient_id;
  new.address := coalesce(new.address, p.address);
  new.pincode := coalesce(new.pincode, p.pincode);
  new.zone_id := coalesce(new.zone_id, p.zone_id, zone_for_pincode(new.workspace_id, coalesce(new.pincode, p.pincode)));
  new.created_by := coalesce(new.created_by, app_uid());
  new.owner_id := coalesce(new.owner_id, app_uid());
  return new;
end $$;

-- 4. Hardened upsert_patient handling unique_violation concurrency
create or replace function upsert_patient(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ws uuid := coalesce(me_ws(), (p->>'workspace_id')::uuid); v_mob text := norm_mobile(p->>'mobile');
begin
  if not (is_ops() or is_service()) then raise exception 'Not allowed for your role'; end if;
  -- an existing patient can be referenced directly (agents never see full numbers)
  if nullif(p->>'patient_id','') is not null then
    select id into v_id from patients where id = (p->>'patient_id')::uuid and workspace_id = v_ws;
    if v_id is null then raise exception 'Patient not found'; end if;
  end if;
  if v_id is null then
    select id into v_id from patients where workspace_id = v_ws and (
      (v_mob is not null and mobile = v_mob) or
      (v_mob is null and nullif(p->>'email','') is not null and lower(email) = lower(p->>'email'))) limit 1;
  end if;
  if v_id is null then
    begin
      insert into patients(workspace_id, full_name, age, gender, mobile, alt_mobile, email, address, landmark, locality, pincode, city, lat, lng, created_by)
      values (v_ws, coalesce(nullif(p->>'full_name',''),'Unknown caller'), nullif(p->>'age','')::int, nullif(p->>'gender',''), v_mob,
              norm_mobile(nullif(p->>'alt_mobile','')), nullif(p->>'email',''), nullif(p->>'address',''), nullif(p->>'landmark',''),
              nullif(p->>'locality',''), nullif(p->>'pincode',''), coalesce(nullif(p->>'city',''),'Mumbai'),
              nullif(p->>'lat','')::float8, nullif(p->>'lng','')::float8, app_uid())
      returning id into v_id;
    exception when unique_violation then
      if v_mob is not null then
        select id into v_id from patients where workspace_id = v_ws and mobile = v_mob;
      end if;
      if v_id is null and nullif(p->>'email','') is not null then
        select id into v_id from patients where workspace_id = v_ws and lower(email) = lower(p->>'email');
      end if;
      if v_id is null then raise; end if;
      update patients set
        full_name = coalesce(nullif(p->>'full_name',''), full_name),
        age = coalesce(nullif(p->>'age','')::int, age),
        gender = coalesce(nullif(p->>'gender',''), gender),
        email = coalesce(nullif(p->>'email',''), email),
        address = coalesce(nullif(p->>'address',''), address),
        landmark = coalesce(nullif(p->>'landmark',''), landmark),
        locality = coalesce(nullif(p->>'locality',''), locality),
        pincode = coalesce(nullif(p->>'pincode',''), pincode),
        lat = coalesce(nullif(p->>'lat','')::float8, lat),
        lng = coalesce(nullif(p->>'lng','')::float8, lng)
      where id = v_id;
    end;
  else
    update patients set
      full_name = coalesce(nullif(p->>'full_name',''), full_name),
      age = coalesce(nullif(p->>'age','')::int, age),
      gender = coalesce(nullif(p->>'gender',''), gender),
      email = coalesce(nullif(p->>'email',''), email),
      address = coalesce(nullif(p->>'address',''), address),
      landmark = coalesce(nullif(p->>'landmark',''), landmark),
      locality = coalesce(nullif(p->>'locality',''), locality),
      pincode = coalesce(nullif(p->>'pincode',''), pincode),
      lat = coalesce(nullif(p->>'lat','')::float8, lat),
      lng = coalesce(nullif(p->>'lng','')::float8, lng)
    where id = v_id;
  end if;
  return v_id;
end $$;

-- 5. Hardened create_enquiry with referral subtype support and distinct service items
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
begin
  if not (is_ops() or is_service()) then raise exception 'Not allowed for your role'; end if;
  v_discharge := parse_day(p->>'expected_discharge_on', 'Expected discharge date');
  v_start := parse_day(p->>'requested_service_start_on', 'Requested service start date');
  v_source := coalesce(nullif(p->>'source_channel',''), 'phone');
  v_subtype := case when v_source = 'referral' then nullif(trim(p->>'referral_subtype'), '') else null end;

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
                    expected_discharge_on, requested_service_start_on)
  values (v_ws, v_pat, nullif(p->>'caller_name',''), nullif(p->>'caller_relation',''), norm_mobile(nullif(p->>'caller_mobile','')),
          v_source, v_subtype, coalesce(nullif(p->>'priority',''),'routine'),
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

-- 6. Update set_case_requirements to support editing source channel and referral subtype
create or replace function set_case_requirements(p_case uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c record;
  v_dis date;
  v_start date;
  v_source text;
  v_subtype text;
  v_notes text[] := '{}';
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Nothing to save'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.stage in ('closed','cancelled') then raise exception 'Case is %; reopen it first.', c.stage; end if;

  v_dis := case when p ? 'expected_discharge_on' then parse_day(p->>'expected_discharge_on', 'Expected discharge date') else c.expected_discharge_on end;
  v_start := case when p ? 'requested_service_start_on' then parse_day(p->>'requested_service_start_on', 'Requested service start date') else c.requested_service_start_on end;

  if v_dis is null and c.expected_discharge_on is not null
     and c.care_type = 'post_discharge' and c.intake_disposition = 'requirement_captured' then
    raise exception 'Enter the expected discharge date';
  end if;

  v_source := case when p ? 'source_channel' then coalesce(nullif(trim(p->>'source_channel'),''), c.source_channel) else c.source_channel end;
  v_subtype := case
    when v_source <> 'referral' then null
    when p ? 'referral_subtype' then nullif(trim(p->>'referral_subtype'), '')
    else c.referral_subtype end;

  update cases set
    branch = case when p ? 'branch' then nullif(trim(p->>'branch'), '') else branch end,
    services_requested = case when p ? 'services_requested' then nullif(trim(p->>'services_requested'), '') else services_requested end,
    additional_info = case when p ? 'additional_info' then nullif(trim(p->>'additional_info'), '') else additional_info end,
    expected_discharge_on = v_dis,
    requested_service_start_on = v_start,
    source_channel = v_source,
    referral_subtype = v_subtype
  where id = p_case;

  if v_dis is distinct from c.expected_discharge_on then
    v_notes := v_notes || ('expected discharge ' || coalesce(to_char(v_dis, 'DD Mon YYYY'), 'cleared'));
  end if;
  if v_start is distinct from c.requested_service_start_on then
    v_notes := v_notes || ('requested service start ' || coalesce(to_char(v_start, 'DD Mon YYYY'), 'cleared'));
  end if;
  if v_source is distinct from c.source_channel or v_subtype is distinct from c.referral_subtype then
    v_notes := v_notes || ('source ' || v_source || coalesce(' (' || v_subtype || ')', ''));
  end if;

  if cardinality(v_notes) > 0 then
    perform log_interaction(p_case, 'system', 'internal', 'Details updated: ' || array_to_string(v_notes, ', '), null);
  end if;
  return jsonb_build_object(
    'case_id', p_case,
    'expected_discharge_on', v_dis,
    'requested_service_start_on', v_start,
    'source_channel', v_source,
    'referral_subtype', v_subtype
  );
end $$;

-- 7. Extend views with referral_subtype column
do $$
declare v_def text;
begin
  if not exists (select 1 from pg_attribute where attrelid = 'v_cases'::regclass and attname = 'referral_subtype' and not attisdropped) then
    v_def := rtrim(trim(pg_get_viewdef('v_cases'::regclass, true)), ';');
    execute 'create or replace view v_cases with (security_invoker = true) as select previous.*, x.referral_subtype from ('
      || v_def || ') previous left join cases x on x.id = previous.id';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'v_referrals'::regclass and attname = 'referral_subtype' and not attisdropped) then
    v_def := rtrim(trim(pg_get_viewdef('v_referrals'::regclass, true)), ';');
    execute 'create or replace view v_referrals with (security_invoker = true) as select previous.*, x.referral_subtype from ('
      || v_def || ') previous left join cases x on x.id = previous.case_id';
  end if;
end $$;
grant select on v_cases, v_referrals to caredesk_app;
