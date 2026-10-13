-- =====================================================================
-- CareDesk CRM  |  Post-discharge home care transition (SOP, Oct 2026)
--   1 intake: discharge details, who we spoke with, a strict interaction reason (disposition)
--   2 on-site clinical validation at Hinduja by a Care Coordinator (nurse): doctor / ward / family met,
--     discharge readiness, the recommended itemised list
--   3 commercials: the family keeps or drops items (12 -> 10), reason kept; decision-maker sign-off
--   4 bifurcated fulfilment: routing waits for sign-off, then diagnostics -> SecondMedic, manpower and
--     equipment -> Book My Medicare (existing route_case)
--   5 partner governance: Dispatched status, Excel / CSV status sync, deployment SLA
--   metrics: transition_metrics() (TAT, conversion, fulfilment SLA)
-- Expand only: new columns with defaults, a new table, new / replaced functions, views rebuilt.
-- =====================================================================

-- ---------- columns ----------
alter table cases add column if not exists care_type text not null default 'standard';
alter table cases add column if not exists hospital_name text;
alter table cases add column if not exists hospital_ward text;
alter table cases add column if not exists treating_doctor text;
alter table cases add column if not exists expected_discharge_on date;
alter table cases add column if not exists spoke_with text;
alter table cases add column if not exists decision_maker_name text;
alter table cases add column if not exists decision_maker_relation text;
alter table cases add column if not exists intake_disposition text;
alter table cases add column if not exists validation_status text not null default 'not_required';
alter table cases add column if not exists plan_days integer not null default 30;
alter table cases add column if not exists signoff_at timestamptz;
alter table cases add column if not exists signoff_by_name text;
alter table cases add column if not exists signoff_mode text;
alter table cases add column if not exists signoff_note text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cases_care_type_check') then
    alter table cases add constraint cases_care_type_check check (care_type in ('standard','post_discharge'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_spoke_with_check') then
    alter table cases add constraint cases_spoke_with_check
      check (spoke_with is null or spoke_with in ('patient','decision_maker','family_member','hospital_staff'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_intake_disposition_check') then
    alter table cases add constraint cases_intake_disposition_check check (intake_disposition is null or intake_disposition in (
      'requirement_captured','information_only','price_enquiry','follow_up_requested','not_interested',
      'already_arranged','wrong_number','duplicate'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_validation_status_check') then
    alter table cases add constraint cases_validation_status_check
      check (validation_status in ('not_required','pending','scheduled','done','not_ready'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_signoff_mode_check') then
    alter table cases add constraint cases_signoff_mode_check
      check (signoff_mode is null or signoff_mode in ('in_person','whatsapp','email','phone'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cases_plan_days_check') then
    alter table cases add constraint cases_plan_days_check check (plan_days between 1 and 365);
  end if;
end $$;
create index if not exists cases_care_type on cases(workspace_id, care_type, created_at);

alter table case_items add column if not exists recommended   boolean not null default false;  -- from the on-site validation
alter table case_items add column if not exists excluded      boolean not null default false;  -- dropped in negotiation
alter table case_items add column if not exists exclude_reason text;

alter table services add column if not exists unit text not null default 'unit';               -- shift, day, setup, test ...

alter table case_referrals add column if not exists dispatched_at timestamptz;
alter table case_referrals drop constraint if exists case_referrals_status_check;
alter table case_referrals add constraint case_referrals_status_check
  check (status in ('new','accepted','scheduled','dispatched','in_progress','completed','declined','cancelled'));

-- ---------- on-site clinical validation ----------
create table if not exists discharge_assessments (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  case_id         uuid not null references cases(id) on delete cascade,
  nurse_id        uuid references profiles(id),
  status          text not null default 'scheduled' check (status in ('scheduled','done','cancelled')),
  scheduled_at    timestamptz,
  visited_at      timestamptz,
  met_doctor      boolean not null default false,
  doctor_name     text,
  met_ward_staff  boolean not null default false,
  met_family      boolean not null default false,
  readiness       text check (readiness is null or readiness in ('ready','not_ready','deferred')),
  revised_discharge_on date,
  home_setup_notes text,
  clinical_summary text,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists assessments_case on discharge_assessments(case_id, created_at);
create index if not exists assessments_nurse on discharge_assessments(nurse_id, status);
alter table discharge_assessments enable row level security;

-- ---------- rate card: discharge items (Book My Medicare) ----------
alter table services drop constraint if exists services_category_check;
alter table services add constraint services_category_check
  check (category in ('lab','xray','ecg','visit','nursing','physio','beds','eldercare','homecare','equipment','icu','other'));

update providers set categories = array(select distinct unnest(categories || array['equipment','icu']))
 where code = 'BMM' and not (categories @> array['equipment','icu']);

-- Price 0 = not yet priced: Hinduja management sets each price through Settings > Rate card (rate-change approval).
-- A quote cannot be sent while its total is 0, so nothing is quoted on an unpriced item.
with w as (select id from workspaces where code = 'HHC')
insert into services (workspace_id, code, name, category, price, tat_hours, description, unit, approved_at)
select w.id, s.code, s.name, s.cat, 0, 24, s.descr, s.unit, now() from w, (values
  ('NURSE-12H',  'Nurse, 12-hour shift',              'nursing',   'Book My Medicare: qualified nurse, day or night shift', 'shift'),
  ('ATTEND-12H', 'Attendant, 12-hour shift',          'eldercare', 'Book My Medicare: trained attendant, day or night shift', 'shift'),
  ('BED-ICU',    'ICU bed (motorised), rental',        'beds',      'Book My Medicare: motorised ICU bed with rails and mattress', 'day'),
  ('MINI-ICU',   'Mini-ICU setup at home',             'icu',       'Book My Medicare: monitor, suction, oxygen and setup by a technician', 'setup'),
  ('HFNC',       'High-flow (HF) oxygen machine, rental', 'equipment', 'Book My Medicare: high-flow nasal oxygen machine with consumables', 'day'),
  ('OXY-CONC',   'Oxygen concentrator, rental',        'equipment', 'Book My Medicare: 5 or 10 litre concentrator', 'day'),
  ('MONITOR',    'Multipara monitor, rental',          'equipment', 'Book My Medicare: multipara patient monitor', 'day'),
  ('SUCTION',    'Suction machine, rental',            'equipment', 'Book My Medicare: suction machine with catheters', 'day'),
  ('AIRBED',     'Air mattress, rental',               'equipment', 'Book My Medicare: alternating-pressure air mattress', 'day')
) as s(code, name, cat, descr, unit)
on conflict (workspace_id, code) do nothing;

update services set unit = 'shift' where code = 'NURS-HOME' and unit = 'unit';
update services set unit = 'day'   where code = 'BED-HOSP'  and unit = 'unit';

-- ---------- SLA policies for the transition ----------
with w as (select id from workspaces where code = 'HHC')
insert into sla_policies (workspace_id, key, label, target_minutes, escalate_to, measured_by)
select w.id, s.k, s.l, s.m, s.r::app_role, s.mb from w, (values
  ('validation',      'On-site validation done after intake',   360,  'coordinator', 'Intake → validation visit recorded'),
  ('signoff',         'Family commercial sign-off',             1440, 'supervisor',  'Validation → sign-off'),
  ('provider_deploy', 'Partner deployment after sign-off',      1440, 'supervisor',  'Sign-off → every partner lead deployed')
) as s(k, l, m, r, mb)
on conflict (workspace_id, key) do nothing;

-- ---------- workflow-controlled columns ----------
create or replace function trg_case_guard() returns trigger language plpgsql as $$
begin
  if is_service() or current_setting('app.rpc', true) = 'on' then return new; end if;
  if new.stage is distinct from old.stage
     or new.case_no is distinct from old.case_no
     or new.quote_status is distinct from old.quote_status
     or new.subtotal is distinct from old.subtotal
     or new.total is distinct from old.total
     or new.discount_pct is distinct from old.discount_pct
     or new.discount_amount is distinct from old.discount_amount
     or new.amount_collected is distinct from old.amount_collected
     or new.payment_status is distinct from old.payment_status
     or new.closed_at is distinct from old.closed_at
     or new.booking_confirmed_at is distinct from old.booking_confirmed_at
     or new.quote_sent_at is distinct from old.quote_sent_at
     or new.validation_status is distinct from old.validation_status
     or new.signoff_at is distinct from old.signoff_at
     or new.signoff_by_name is distinct from old.signoff_by_name then
    raise exception 'This field is controlled by workflow rules. Use the action buttons on the case.' using errcode = 'P0001';
  end if;
  if old.stage in ('closed','cancelled') then
    raise exception 'Case is %; reopen it first.', old.stage using errcode = 'P0001';
  end if;
  return new;
end $$;

-- audit: names of the decision-maker and the doctor are personal data (DPDP Act); record that they changed, not the values
create or replace function trg_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; k text; diff jsonb := '{}'::jsonb; v_ws uuid; v_id uuid;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new); v_id := (n->>'id')::uuid; v_ws := (n->>'workspace_id')::uuid;
    insert into audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
    values (v_ws, tg_table_name, v_id, 'insert', null, app_uid());
    return new;
  elsif tg_op = 'DELETE' then
    o := to_jsonb(old); v_id := (o->>'id')::uuid; v_ws := (o->>'workspace_id')::uuid;
    insert into audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
    values (v_ws, tg_table_name, v_id, 'delete', o - 'decision_maker_name' - 'signoff_by_name' - 'treating_doctor', app_uid());
    return old;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if k in ('updated_at','ai_brief','last_seen_at') then continue; end if;
    if (o->k) is distinct from (n->k) then
      if k in ('decision_maker_name','signoff_by_name','treating_doctor') then
        diff := diff || jsonb_build_object(k, jsonb_build_object('old', '(personal data)', 'new', '(personal data)'));
      else
        diff := diff || jsonb_build_object(k, jsonb_build_object('old', o->k, 'new', n->k));
      end if;
    end if;
  end loop;
  if diff <> '{}'::jsonb then
    v_id := (n->>'id')::uuid; v_ws := (n->>'workspace_id')::uuid;
    insert into audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
    values (v_ws, tg_table_name, v_id, 'update', diff, app_uid());
  end if;
  return new;
end $$;

-- ---------- pricing: dropped items do not count; a changed total needs a new sign-off ----------
create or replace function recalc_case(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_sub numeric; c record; v_band numeric; v_total numeric;
begin
  select * into c from cases where id = p_case;
  select coalesce(sum(line_total) filter (where not excluded), 0) into v_sub from case_items where case_id = p_case;
  select discount_band_pct into v_band from workspaces where id = c.workspace_id;
  v_total := v_sub - round(v_sub * c.discount_pct / 100, 2);
  perform rpc_on();
  update cases set subtotal = v_sub,
    discount_amount = round(v_sub * discount_pct / 100, 2),
    total = v_total,
    quote_status = case when quote_status in ('sent') then 'sent'
                        when discount_pct > v_band then quote_status
                        else 'approved' end,
    signoff_at = case when signoff_at is not null and total is distinct from v_total then null else signoff_at end
  where id = p_case;
  if c.signoff_at is not null and c.total is distinct from v_total then
    perform log_interaction(p_case, 'system', 'internal', 'Scope changed after sign-off · new sign-off needed', null);
  end if;
end $$;

-- ---------- routing: by agreed items; post-discharge leads wait for the family's sign-off ----------
create or replace function categories_from_text(p text) returns text[] language sql immutable as $$
  select array_remove(array[
    case when p ~* '\mecg\M|electrocardio' then 'ecg' end,
    case when p ~* 'x[- ]?ray|radiograph' then 'xray' end,
    case when p ~* 'blood|\mlab\M|sample|\mcbc\M|sugar|thyroid|lipid|hba1c|\mtests?\M' then 'lab' end,
    case when p ~* 'nurs' then 'nursing' end,
    case when p ~* 'physio' then 'physio' end,
    case when p ~* '\mbeds?\M|fowler' then 'beds' end,
    case when p ~* 'elder|attendant|care ?taker|geriatric|old age' then 'eldercare' end,
    case when p ~* '\micu\M|intensive care|ventilat' then 'icu' end,
    case when p ~* 'high[- ]?flow|\mhfnc\M|\mhf machine|oxygen|concentrator|suction|monitor|bipap|cpap|air ?(bed|mattress)' then 'equipment' end
  ]::text[], null)
$$;

create or replace function route_case(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c record; v_cats text[]; pr record; v_new boolean; v_ref uuid; u record; v_svc text;
begin
  if current_setting('app.routing', true) = 'off' then return; end if;
  select * into c from cases where id = p_case;
  if not found then return; end if;
  if c.care_type = 'post_discharge' and c.signoff_at is null then return; end if;
  v_cats := array(select distinct category from case_items where case_id = p_case and not excluded);
  if coalesce(array_length(v_cats, 1), 0) = 0 then
    v_cats := categories_from_text(coalesce(c.services_requested, '') || ' ' || coalesce(c.additional_info, ''));
  end if;
  for pr in select * from providers where workspace_id = c.workspace_id and active and categories && v_cats loop
    insert into case_referrals (workspace_id, case_id, provider_id, categories, status, created_by, completed_at)
    values (c.workspace_id, p_case, pr.id, array(select unnest(v_cats) intersect select unnest(pr.categories)),
            case c.stage when 'closed' then 'completed' when 'cancelled' then 'cancelled' else 'new' end, app_uid(),
            case when c.stage = 'closed' then coalesce(c.closed_at, now()) end)
    on conflict (case_id, provider_id) do update
      set categories = excluded.categories,
          status = case when case_referrals.status = 'cancelled' and case_referrals.auto and c.stage not in ('closed','cancelled')
                        then 'new' else case_referrals.status end,
          updated_at = now()
    returning id, (xmax = 0) into v_ref, v_new;
    if v_new and c.stage not in ('closed','cancelled') then
      v_svc := (select string_agg(initcap(x), ', ') from unnest(array(select unnest(v_cats) intersect select unnest(pr.categories))) x);
      perform log_interaction(p_case, 'system', 'internal', 'Lead transferred to ' || pr.name || ' · ' || v_svc,
        'Shared: case ID, patient details, address and requirements. Call recordings are not shared.', null,
        jsonb_build_object('referral_id', v_ref, 'provider', pr.code));
      for u in select id from profiles where provider_id = pr.id and active loop
        perform notify_user(u.id, 'New lead ' || c.case_no, v_svc, '/leads', 'info');
      end loop;
      if pr.code <> 'SM' then
        perform sla_start(c.workspace_id, 'provider_accept', p_case, null, null);
      end if;
    end if;
  end loop;
  update case_referrals r set status = 'cancelled', updated_at = now()
   where r.case_id = p_case and r.auto and r.status = 'new'
     and not exists (select 1 from providers pv where pv.id = r.provider_id and pv.categories && v_cats);
end $$;

drop trigger if exists item_route on case_items;
create trigger item_route after insert or delete or update of excluded on case_items
  for each row execute function trg_item_route();

create or replace function trg_case_route() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.services_requested is distinct from old.services_requested
                           or new.additional_info is distinct from old.additional_info
                           or (new.signoff_at is not null and old.signoff_at is null)) then
    perform route_case(new.id);
  end if;
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    if new.stage = 'cancelled' then
      update case_referrals set status = 'cancelled', updated_at = now()
       where case_id = new.id and status not in ('completed','declined','cancelled');
    else
      update case_referrals r set updated_at = now(), status = case new.stage
          when 'booking' then 'accepted' when 'deployment' then 'scheduled' when 'completion' then 'in_progress'
          when 'payment' then 'completed' when 'closure' then 'completed' when 'closed' then 'completed' else r.status end,
          completed_at = case when new.stage in ('payment','closure','closed') then coalesce(r.completed_at, now()) else r.completed_at end
       where r.case_id = new.id and r.status not in ('declined','cancelled')
         and exists (select 1 from providers pv where pv.id = r.provider_id and pv.code = 'SM');
    end if;
  end if;
  return null;
end $$;

-- ---------- visibility: the validating nurse / named coordinator keeps the case end to end ----------
create or replace function can_see_case(p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from cases c
    where c.id = p_case and c.workspace_id = me_ws() and (
      has_role('supervisor','medical_desk','client_manager','client_clinical')
      or (has_role('coordinator') and (
            not exists (select 1 from case_referrals r where r.case_id = c.id and r.status <> 'cancelled')
            or exists (select 1 from case_referrals r join providers pv on pv.id = r.provider_id
                        where r.case_id = c.id and pv.code = 'SM' and r.status <> 'cancelled')))
      or (has_role('coordinator','field_staff') and (
            c.coordinator_id = app_uid()
            or exists (select 1 from discharge_assessments d where d.case_id = c.id and d.nurse_id = app_uid() and d.status <> 'cancelled')))
      or (has_role('agent') and (c.owner_id = app_uid() or c.created_by = app_uid() or c.owner_id is null
                                 or (c.stage not in ('closed','cancelled') and c.created_at > now() - interval '2 days')))
      or (has_role('field_staff') and exists (select 1 from assignments a where a.case_id = c.id and a.staff_id = app_uid()
                                              and (a.status in ('assigned','en_route','checked_in')
                                                   or (a.status = 'completed' and a.checkout_at > now() - interval '12 hours'))))
      or (has_role('provider') and exists (select 1 from case_referrals r where r.case_id = c.id and r.provider_id = me_provider()
                                                                         and r.status <> 'cancelled'))
    ))
$$;

-- ---------- stage gates (post-discharge adds intake, validation and sign-off checks) ----------
create or replace function case_gates(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c record; p record; v_to case_stage; checks jsonb := '[]'::jsonb;
  v_items int; v_lab int; v_samples int; v_checked int; v_open_asg int; v_open_cmp int;
begin
  select * into c from cases where id = p_case;
  if not found then raise exception 'Case not found'; end if;
  select * into p from patients where id = c.patient_id;
  v_to := next_stage(c.stage);
  select count(*) filter (where not excluded), count(*) filter (where category = 'lab' and not excluded)
    into v_items, v_lab from case_items where case_id = p_case;
  if c.stage = 'enquiry' then
    checks := jsonb_build_array(
      jsonb_build_object('label','Patient name and mobile', 'ok', p.full_name is not null and p.mobile is not null),
      jsonb_build_object('label','Address and pincode', 'ok', coalesce(c.address,'') <> '' and coalesce(c.pincode,'') <> ''),
      jsonb_build_object('label','Services requested noted', 'ok', coalesce(c.services_requested,'') <> '' or v_items > 0),
      jsonb_build_object('label','Consent recorded', 'ok', p.consent_verbal_at is not null or p.consent_digital_at is not null));
    if c.care_type = 'post_discharge' then
      checks := checks || jsonb_build_array(
        jsonb_build_object('label','Interaction reason recorded', 'ok', c.intake_disposition = 'requirement_captured'),
        jsonb_build_object('label','Spoke with patient or decision-maker', 'ok', c.spoke_with in ('patient','decision_maker')),
        jsonb_build_object('label','Expected discharge date', 'ok', c.expected_discharge_on is not null),
        jsonb_build_object('label','On-site validation done, discharge ready', 'ok', c.validation_status = 'done'),
        jsonb_build_object('label','Recommended item list', 'ok', exists (select 1 from case_items i where i.case_id = p_case and i.recommended)));
    end if;
  elsif c.stage = 'pricing' then
    checks := jsonb_build_array(
      jsonb_build_object('label','At least one rate-card service', 'ok', v_items > 0),
      jsonb_build_object('label','Discount approved (if above band)', 'ok', c.quote_status in ('approved','sent')),
      jsonb_build_object('label','Quote sent on approved template', 'ok', c.quote_status = 'sent'));
    if c.care_type = 'post_discharge' then
      checks := checks || jsonb_build_array(
        jsonb_build_object('label','Family commercial sign-off', 'ok', c.signoff_at is not null));
    end if;
  elsif c.stage = 'booking' then
    checks := jsonb_build_array(
      jsonb_build_object('label','Slot booked', 'ok', c.booked_slot is not null),
      jsonb_build_object('label','Address verified', 'ok', coalesce(c.address,'') <> ''),
      jsonb_build_object('label','Confirmation sent to patient', 'ok', c.booking_confirmed_at is not null),
      jsonb_build_object('label','Coordinator assigned', 'ok', c.coordinator_id is not null));
  elsif c.stage = 'deployment' then
    select count(*) into v_checked from assignments where case_id = p_case and status in ('checked_in','completed');
    checks := jsonb_build_array(
      jsonb_build_object('label','Field resource assigned', 'ok', exists(select 1 from assignments where case_id = p_case and status not in ('cancelled','reassigned'))),
      jsonb_build_object('label','Geo-tagged check-in at address', 'ok', v_checked > 0));
  elsif c.stage = 'completion' then
    select count(*) into v_open_asg from assignments where case_id = p_case and status not in ('completed','cancelled','reassigned');
    select count(*) into v_samples from samples where case_id = p_case and collected_at is not null;
    checks := jsonb_build_array(
      jsonb_build_object('label','All visits completed with patient sign-off', 'ok', v_open_asg = 0 and exists(select 1 from assignments where case_id = p_case and status = 'completed' and patient_signoff)),
      jsonb_build_object('label','Samples barcoded / ECG / X-ray captured', 'ok', v_samples > 0 or v_lab = 0));
  elsif c.stage = 'payment' then
    checks := jsonb_build_array(
      jsonb_build_object('label','Amount collected', 'ok', c.amount_collected >= c.total or c.payment_status = 'waived'),
      jsonb_build_object('label','Reconciled against gateway / bank', 'ok', c.payment_status in ('reconciled','waived') or c.total = 0));
  elsif c.stage = 'closure' then
    select count(*) into v_open_cmp from complaints where case_id = p_case and status in ('open','acknowledged');
    checks := jsonb_build_array(
      jsonb_build_object('label','Report delivered', 'ok', c.report_status in ('delivered','na')),
      jsonb_build_object('label','No open complaints', 'ok', v_open_cmp = 0),
      jsonb_build_object('label','Feedback captured', 'ok', c.feedback_rating is not null));
  end if;
  return jsonb_build_object('stage', c.stage, 'next', v_to, 'checks', checks,
    'ready', not exists (select 1 from jsonb_array_elements(checks) x where (x->>'ok')::boolean = false));
end $$;

-- ---------- 1. intake ----------
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
    hospital_name = coalesce(nullif(p->>'hospital_name',''), hospital_name),
    hospital_ward = coalesce(nullif(p->>'hospital_ward',''), hospital_ward),
    treating_doctor = coalesce(nullif(p->>'treating_doctor',''), treating_doctor),
    expected_discharge_on = coalesce(nullif(p->>'expected_discharge_on','')::date, expected_discharge_on),
    spoke_with = coalesce(nullif(p->>'spoke_with',''), spoke_with),
    decision_maker_name = coalesce(nullif(p->>'decision_maker_name',''), decision_maker_name),
    decision_maker_relation = coalesce(nullif(p->>'decision_maker_relation',''), decision_maker_relation),
    clinical_notes = coalesce(nullif(p->>'clinical_status',''), clinical_notes),
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
    'Intake' || case when v_type = 'post_discharge' then ' (post-discharge)' else '' end || ': ' || v_label,
    null, null, jsonb_build_object('disposition', v_disp));
  return (select jsonb_build_object('care_type', care_type, 'intake_disposition', intake_disposition,
                                    'validation_status', validation_status) from cases where id = p_case);
end $$;

-- ---------- 2. on-site clinical validation ----------
create or replace function schedule_validation(p_case uuid, p_nurse uuid, p_when timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; n record; v uuid;
begin
  if not has_role('coordinator','supervisor','medical_desk') then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.care_type <> 'post_discharge' then raise exception 'Mark the case as post-discharge first'; end if;
  if c.stage not in ('enquiry','pricing') then raise exception 'Validation is done before the commercials'; end if;
  select * into n from profiles where id = p_nurse and workspace_id = c.workspace_id and active
    and role in ('coordinator','field_staff','medical_desk');
  if not found then raise exception 'Pick an active care coordinator (nurse)'; end if;
  if p_when is null then raise exception 'Pick the visit date and time'; end if;
  update discharge_assessments set status = 'cancelled', updated_at = now() where case_id = p_case and status = 'scheduled';
  insert into discharge_assessments (workspace_id, case_id, nurse_id, status, scheduled_at, created_by)
  values (c.workspace_id, p_case, p_nurse, 'scheduled', p_when, app_uid()) returning id into v;
  perform rpc_on();
  update cases set validation_status = 'scheduled',
    coordinator_id = case when n.role = 'coordinator' then coalesce(coordinator_id, p_nurse) else coordinator_id end
  where id = p_case;
  perform log_interaction(p_case, 'system', 'internal', 'Hospital validation visit scheduled · ' || n.full_name || ' · '
    || to_char(p_when at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), null);
  perform notify_user(p_nurse, 'Hospital validation ' || c.case_no, coalesce(c.hospital_name, 'Hinduja') ||
    coalesce(', ' || c.hospital_ward, ''), '/cases/' || c.id, 'info');
  return v;
end $$;

create or replace function record_validation(p_case uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; a record; v_ready text; v_items int := 0; x jsonb;
begin
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  select * into a from discharge_assessments where case_id = p_case and status = 'scheduled' order by created_at desc limit 1 for update;
  if not (has_role('coordinator','supervisor','medical_desk') or (has_role('field_staff') and a.nurse_id = app_uid())) then
    raise exception 'Not allowed for your role';
  end if;
  if c.care_type <> 'post_discharge' then raise exception 'Mark the case as post-discharge first'; end if;
  if c.stage not in ('enquiry','pricing') then raise exception 'Validation is done before the commercials'; end if;
  v_ready := nullif(p->>'readiness','');
  if v_ready is null or v_ready not in ('ready','not_ready','deferred') then raise exception 'Record discharge readiness'; end if;
  if v_ready = 'ready' and not coalesce((p->>'met_doctor')::boolean, false) then
    raise exception 'Meet the treating doctor before confirming discharge readiness';
  end if;
  if v_ready = 'ready' and not coalesce((p->>'met_family')::boolean, false) then
    raise exception 'Meet the family before confirming discharge readiness';
  end if;
  if a.id is null then
    insert into discharge_assessments (workspace_id, case_id, nurse_id, status, scheduled_at, created_by)
    values (c.workspace_id, p_case, app_uid(), 'scheduled', now(), app_uid()) returning * into a;
  end if;
  update discharge_assessments set status = 'done', visited_at = coalesce(nullif(p->>'visited_at','')::timestamptz, now()),
    met_doctor = coalesce((p->>'met_doctor')::boolean, false), doctor_name = nullif(p->>'doctor_name',''),
    met_ward_staff = coalesce((p->>'met_ward_staff')::boolean, false), met_family = coalesce((p->>'met_family')::boolean, false),
    readiness = v_ready, revised_discharge_on = nullif(p->>'revised_discharge_on','')::date,
    home_setup_notes = nullif(p->>'home_setup_notes',''), clinical_summary = nullif(p->>'clinical_summary',''),
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
    expected_discharge_on = coalesce(nullif(p->>'revised_discharge_on','')::date, expected_discharge_on),
    treating_doctor = coalesce(nullif(p->>'doctor_name',''), treating_doctor)
  where id = p_case;
  if v_ready = 'ready' then
    perform sla_meet('validation', p_case);
    perform sla_start(c.workspace_id, 'signoff', p_case, null, null);
  end if;
  perform log_interaction(p_case, 'field', 'internal', 'Hospital validation: ' || case v_ready when 'ready' then 'discharge ready'
      when 'not_ready' then 'not ready for discharge' else 'discharge deferred' end
      || case when v_items > 0 then ' · ' || v_items || ' items recommended' else '' end,
    concat_ws(' · ', case when (p->>'met_doctor')::boolean then 'Doctor met' end,
                    case when (p->>'met_ward_staff')::boolean then 'Ward staff met' end,
                    case when (p->>'met_family')::boolean then 'Family met' end), 'Validation record');
  return jsonb_build_object('validation_status', case when v_ready = 'ready' then 'done' else 'not_ready' end, 'items', v_items);
end $$;

-- ---------- 3. commercials: scope and sign-off ----------
create or replace function set_item_scope(p_item uuid, p_included boolean, p_reason text default null, p_qty int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i record; c record;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into i from case_items where id = p_item;
  if not found or not can_see_case(i.case_id) then raise exception 'Item not found'; end if;
  select * into c from cases where id = i.case_id;
  if c.stage not in ('enquiry','pricing') then raise exception 'Services can only be changed during Enquiry or Pricing'; end if;
  if not p_included and coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for dropping the item'; end if;
  if p_qty is not null and p_qty < 1 then raise exception 'Quantity must be greater than or equal to 1'; end if;
  update case_items set excluded = not p_included,
    exclude_reason = case when p_included then null else trim(p_reason) end,
    qty = coalesce(p_qty, qty)
  where id = p_item;
  perform log_interaction(i.case_id, 'system', 'internal',
    'Scope: ' || i.service_name || case when not p_included then ' dropped (' || trim(p_reason) || ')'
      when i.excluded then ' added back' else ' quantity ' || coalesce(p_qty, i.qty) end, null);
  return (select jsonb_build_object('subtotal', subtotal, 'total', total, 'signoff_at', signoff_at) from cases where id = i.case_id);
end $$;

create or replace function record_signoff(p_case uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; v_mode text; v_n int; v_all int;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.stage <> 'pricing' then raise exception 'Move the case to Pricing first'; end if;
  if c.care_type = 'post_discharge' and c.validation_status <> 'done' then raise exception 'On-site validation is not done yet'; end if;
  if c.quote_status not in ('approved','sent') then raise exception 'Quote is %; approval needed before sign-off', c.quote_status; end if;
  if c.total <= 0 then raise exception 'Every agreed item needs a rate-card price before sign-off'; end if;
  v_mode := coalesce(nullif(p->>'mode',''), 'in_person');
  if v_mode not in ('in_person','whatsapp','email','phone') then raise exception 'Unknown sign-off mode %', v_mode; end if;
  if coalesce(trim(p->>'signed_by'), '') = '' then raise exception 'Enter the name of the decision-maker who signed off'; end if;
  select count(*) filter (where not excluded), count(*) into v_n, v_all from case_items where case_id = p_case;
  perform rpc_on();
  update cases set signoff_at = now(), signoff_by_name = trim(p->>'signed_by'), signoff_mode = v_mode,
    signoff_note = nullif(trim(p->>'note'), ''), plan_days = coalesce(nullif(p->>'plan_days','')::int, plan_days),
    decision_maker_name = coalesce(decision_maker_name, trim(p->>'signed_by'))
  where id = p_case;
  perform sla_meet('signoff', p_case);
  perform sla_start(c.workspace_id, 'provider_deploy', p_case, null, null);
  perform log_interaction(p_case, 'system', 'internal',
    'Commercial sign-off · ' || v_n || ' of ' || v_all || ' items · ' || coalesce(nullif(p->>'plan_days','')::int, c.plan_days)
      || ' days · ₹' || to_char(c.total, 'FM99999990.00'),
    nullif(trim(p->>'note'), ''), initcap(replace(v_mode, '_', ' ')));
  return (select jsonb_build_object('signoff_at', signoff_at, 'total', total, 'items', v_n,
    'providers', (select coalesce(jsonb_agg(pv.code order by pv.code desc), '[]'::jsonb)
                    from case_referrals r join providers pv on pv.id = r.provider_id
                   where r.case_id = p_case and r.status <> 'cancelled')) from cases where id = p_case);
end $$;

-- ---------- 5. partner governance: Dispatched status, deployment SLA ----------
create or replace function update_referral(p_id uuid, p_status text, p_note text default null, p_when timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; pv record; c record; v_label text; v_open int; v_done int; v_sm int;
begin
  select * into r from case_referrals where id = p_id for update;
  if not found then raise exception 'Lead not found'; end if;
  select * into pv from providers where id = r.provider_id;
  select * into c from cases where id = r.case_id;
  if c.workspace_id is distinct from me_ws() and not is_service() then raise exception 'Lead not found'; end if;
  if not (is_service() or has_role('supervisor','client_manager')
          or (has_role('provider') and r.provider_id = me_provider())
          or (has_role('coordinator') and pv.code = 'SM')) then
    raise exception 'Not allowed for your role';
  end if;
  if p_status not in ('accepted','scheduled','dispatched','in_progress','completed','declined','cancelled','new') then
    raise exception 'Unknown status %', p_status;
  end if;
  if p_status = 'new' and not has_role('supervisor','client_manager') then raise exception 'Only a supervisor can reopen a lead'; end if;
  if p_status = 'cancelled' and has_role('provider') then raise exception 'Use Decline, with a reason'; end if;
  if p_status = 'declined' and coalesce(trim(p_note), '') = '' then raise exception 'Give a reason for declining'; end if;
  if p_status = 'scheduled' and p_when is null and r.scheduled_at is null then raise exception 'Pick the visit date and time'; end if;
  if r.status in ('completed','declined','cancelled') and p_status <> 'new' and not has_role('supervisor','client_manager') then
    raise exception 'This lead is already %', r.status;
  end if;
  update case_referrals set
    status = p_status,
    accepted_at  = case when p_status in ('accepted','scheduled','dispatched','in_progress','completed') then coalesce(accepted_at, now()) else accepted_at end,
    scheduled_at = case when p_when is not null then p_when else scheduled_at end,
    dispatched_at = case when p_status in ('dispatched','in_progress','completed') then coalesce(dispatched_at, now()) else dispatched_at end,
    started_at   = case when p_status in ('in_progress','completed') then coalesce(started_at, now()) else started_at end,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    decline_reason = case when p_status = 'declined' then p_note else decline_reason end,
    assigned_to  = case when has_role('provider') then coalesce(assigned_to, app_uid()) else assigned_to end,
    last_note    = coalesce(nullif(trim(p_note), ''), last_note),
    updated_at   = now()
  where id = p_id;
  v_label := pv.name || ': ' || case p_status when 'accepted' then 'lead accepted' when 'scheduled' then 'visit scheduled ' ||
      to_char(coalesce(p_when, r.scheduled_at) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI')
    when 'dispatched' then 'staff / equipment dispatched'
    when 'in_progress' then 'deployed, service started' when 'completed' then 'service completed' when 'declined' then 'lead declined'
    when 'cancelled' then 'lead cancelled' else 'lead reopened' end;
  perform log_interaction(r.case_id, case when nullif(trim(p_note), '') is null then 'system' else 'note' end, 'internal', v_label, nullif(trim(p_note), ''),
    null, jsonb_build_object('referral_id', p_id, 'provider', pv.code, 'status', p_status));
  if p_status in ('accepted','scheduled','dispatched','in_progress','completed') then
    perform sla_meet('provider_accept', r.case_id);
  end if;
  -- deployment SLA: met once every live lead on the case is deployed or done
  if p_status in ('in_progress','completed') and not exists (
       select 1 from case_referrals x where x.case_id = r.case_id and x.status not in ('in_progress','completed','declined','cancelled')) then
    perform sla_meet('provider_deploy', r.case_id);
  end if;
  if p_status = 'declined' then
    perform notify_role(c.workspace_id, 'supervisor', pv.name || ' declined ' || c.case_no, p_note, '/cases/' || c.id, 'warn');
    if c.owner_id is not null then perform notify_user(c.owner_id, pv.name || ' declined ' || c.case_no, p_note, '/cases/' || c.id, 'warn'); end if;
  elsif p_status = 'completed' and c.owner_id is not null then
    perform notify_user(c.owner_id, pv.name || ' completed ' || c.case_no, p_note, '/cases/' || c.id, 'ok');
  end if;
  select count(*) filter (where status not in ('completed','declined','cancelled')),
         count(*) filter (where status = 'completed')
    into v_open, v_done from case_referrals where case_id = r.case_id;
  select count(*) into v_sm from case_referrals x join providers y on y.id = x.provider_id
   where x.case_id = r.case_id and y.code = 'SM' and x.status <> 'cancelled';
  if v_open = 0 and v_done > 0 and v_sm = 0 and c.stage not in ('closed','cancelled') then
    perform rpc_on();
    update cases set stage = 'closed', closed_at = now(), closed_by = app_uid(), service_completed_at = coalesce(service_completed_at, now()),
      sla_state = 'ok' where id = r.case_id;
    insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note)
    values (r.case_id, c.stage, 'closed', app_uid(), 'All provider services completed');
    perform log_interaction(r.case_id, 'system', 'internal', 'Case closed: all provider services completed', null);
  end if;
  return (select to_jsonb(x) from case_referrals x where id = p_id);
end $$;

-- Temporary Excel / CSV sync for a partner: one row per lead (case number + status), each applied through update_referral.
create or replace function import_referral_updates(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x jsonb; r record; v_status text; v_n int := 0; v_skip int := 0; v_err jsonb := '[]'::jsonb; v_i int := 0; v_prov uuid;
begin
  if not has_role('provider','supervisor','client_manager') then raise exception 'Not allowed for your role'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be a list'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'At most 500 rows per file'; end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    begin
      v_status := lower(regexp_replace(trim(coalesce(x->>'status', '')), '[\s-]+', '_', 'g'));
      v_status := case v_status when 'deployed' then 'in_progress' when 'started' then 'in_progress' when 'done' then 'completed'
                                 when 'rejected' then 'declined' else v_status end;
      v_prov := case when has_role('provider') then me_provider()
                     else (select id from providers where workspace_id = me_ws() and code = upper(coalesce(nullif(x->>'provider',''), 'BMM'))) end;
      select cr.* into r from case_referrals cr join cases c on c.id = cr.case_id
       where c.workspace_id = me_ws() and c.case_no = trim(x->>'case_no') and cr.provider_id = v_prov;
      if r.id is null then raise exception 'No lead for case %', coalesce(x->>'case_no', '(blank)'); end if;
      if v_status = '' or v_status = r.status then v_skip := v_skip + 1; continue; end if;
      perform update_referral(r.id, v_status, nullif(trim(x->>'note'), ''), nullif(x->>'scheduled_at','')::timestamptz);
      v_n := v_n + 1;
    exception when others then
      v_err := v_err || jsonb_build_array(jsonb_build_object('row', v_i, 'case_no', x->>'case_no', 'message', sqlerrm));
    end;
  end loop;
  insert into access_log(workspace_id, user_id, action, entity, entity_id, meta)
  values (me_ws(), app_uid(), 'partner_sync', 'case_referrals', null,
          jsonb_build_object('rows', v_i, 'updated', v_n, 'skipped', v_skip, 'errors', jsonb_array_length(v_err)));
  return jsonb_build_object('updated', v_n, 'skipped', v_skip, 'errors', v_err);
end $$;

-- ---------- metrics: TAT, conversion, fulfilment SLA ----------
create or replace function transition_metrics(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws(); v_deploy_min int; v jsonb;
begin
  if not has_role('supervisor','coordinator','client_manager','client_clinical') then raise exception 'Not allowed for your role'; end if;
  select target_minutes into v_deploy_min from sla_policies where workspace_id = v_ws and key = 'provider_deploy';
  with pc as (
    select c.*,
      (select min(d.visited_at) from discharge_assessments d where d.case_id = c.id and d.status = 'done') as validated_at,
      (select min(r.started_at) from case_referrals r where r.case_id = c.id and r.status <> 'cancelled') as first_deployed_at,
      (select count(*) from case_items i where i.case_id = c.id and i.recommended) as n_rec,
      (select count(*) from case_items i where i.case_id = c.id and i.recommended and not i.excluded) as n_kept
    from cases c
    where c.workspace_id = v_ws and c.care_type = 'post_discharge' and c.created_at >= p_from and c.created_at < p_to
  ), refs as (
    select pv.code, pv.name, r.*, c.signoff_at, c.expected_discharge_on
    from case_referrals r join providers pv on pv.id = r.provider_id join pc c on c.id = r.case_id
    where r.status <> 'cancelled'
  )
  select jsonb_build_object(
    'intake',        (select count(*) from pc),
    'validated',     (select count(*) from pc where validation_status = 'done'),
    'not_ready',     (select count(*) from pc where validation_status = 'not_ready'),
    'signed_off',    (select count(*) from pc where signoff_at is not null),
    'deployed',      (select count(*) from pc where first_deployed_at is not null),
    'cancelled',     (select count(*) from pc where stage = 'cancelled'),
    'conversion_pct', (select case when count(*) = 0 then null
                         else round(100.0 * count(*) filter (where signoff_at is not null) / count(*), 1) end from pc),
    'validation_to_signoff_pct', (select case when count(*) filter (where validation_status = 'done') = 0 then null
                         else round(100.0 * count(*) filter (where signoff_at is not null)
                                    / count(*) filter (where validation_status = 'done'), 1) end from pc),
    'tat_hours', jsonb_build_object(
      'intake_to_validation', (select round((percentile_cont(0.5) within group (order by extract(epoch from validated_at - created_at)) / 3600)::numeric, 1) from pc where validated_at is not null),
      'validation_to_signoff', (select round((percentile_cont(0.5) within group (order by extract(epoch from signoff_at - validated_at)) / 3600)::numeric, 1) from pc where signoff_at is not null and validated_at is not null),
      'signoff_to_deployment', (select round((percentile_cont(0.5) within group (order by extract(epoch from first_deployed_at - signoff_at)) / 3600)::numeric, 1) from pc where first_deployed_at is not null and signoff_at is not null),
      'intake_to_deployment', (select round((percentile_cont(0.5) within group (order by extract(epoch from first_deployed_at - created_at)) / 3600)::numeric, 1) from pc where first_deployed_at is not null)),
    'items', jsonb_build_object(
      'recommended', (select coalesce(sum(n_rec), 0) from pc),
      'agreed',      (select coalesce(sum(n_kept), 0) from pc where n_rec > 0),
      'retention_pct', (select case when coalesce(sum(n_rec), 0) = 0 then null else round(100.0 * sum(n_kept) / sum(n_rec), 1) end from pc)),
    'providers', coalesce((select jsonb_agg(x order by x->>'code' desc) from (
      select jsonb_build_object('code', code, 'name', name,
        'leads', count(*),
        'accepted', count(*) filter (where accepted_at is not null),
        'declined', count(*) filter (where status = 'declined'),
        'deployed', count(*) filter (where started_at is not null),
        'completed', count(*) filter (where status = 'completed'),
        'deploy_sla_pct', case when count(*) filter (where started_at is not null and signoff_at is not null) = 0 then null
          else round(100.0 * count(*) filter (where started_at is not null and signoff_at is not null
                                                and started_at <= signoff_at + make_interval(mins => coalesce(v_deploy_min, 1440)))
                     / count(*) filter (where started_at is not null and signoff_at is not null), 1) end,
        'before_discharge_pct', case when count(*) filter (where started_at is not null and expected_discharge_on is not null) = 0 then null
          else round(100.0 * count(*) filter (where started_at is not null and expected_discharge_on is not null
                                                and (started_at at time zone 'Asia/Kolkata')::date <= expected_discharge_on)
                     / count(*) filter (where started_at is not null and expected_discharge_on is not null), 1) end) x
      from refs group by code, name) t), '[]'::jsonb),
    'dispositions', coalesce((select jsonb_object_agg(intake_disposition, n) from (
      select intake_disposition, count(*) n from cases
      where workspace_id = v_ws and intake_disposition is not null and created_at >= p_from and created_at < p_to
      group by intake_disposition) d), '{}'::jsonb),
    'drop_reasons', coalesce((select jsonb_agg(jsonb_build_object('service', i.service_name, 'reason', i.exclude_reason))
      from case_items i join pc on pc.id = i.case_id where i.excluded), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------- RLS ----------
drop policy if exists assessments_read on discharge_assessments;
create policy assessments_read on discharge_assessments for select using (
  workspace_id = me_ws() and can_see_case(case_id) and not has_role('provider','admin','agent'));

-- ---------- views ----------
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
  (select count(*) from case_items i where i.case_id = c.id and not i.excluded) as items_agreed
from cases c
join patients p on p.id = c.patient_id
left join zones z on z.id = c.zone_id
left join profiles o on o.id = c.owner_id
left join profiles co on co.id = c.coordinator_id;

drop view if exists v_referrals;
create view v_referrals with (security_invoker = true) as
select r.*, pv.code as provider_code, pv.name as provider_name,
  c.case_no, c.stage as case_stage, c.priority, c.branch, c.services_requested, c.additional_info, c.clinical_notes,
  c.preferred_slot, c.address, c.pincode, c.created_at as case_created_at, c.patient_id,
  p.full_name as patient_name, p.age as patient_age, p.gender as patient_gender,
  case when has_role('agent') then mask_mobile(p.mobile) else p.mobile end as patient_mobile,
  case when has_role('agent') then mask_mobile(c.caller_mobile) else c.caller_mobile end as caller_mobile,
  c.caller_name, c.caller_relation, p.landmark, p.locality,
  a.full_name as assigned_name,
  (select string_agg(i.service_name || ' × ' || i.qty, ', ' order by i.created_at) from case_items i
    where i.case_id = r.case_id and not i.excluded and (i.category = any(r.categories) or cardinality(r.categories) = 0)) as service_names,
  c.care_type, c.hospital_name, c.hospital_ward, c.expected_discharge_on, c.plan_days, c.signoff_at
from case_referrals r
join providers pv on pv.id = r.provider_id
join cases c on c.id = r.case_id
join patients p on p.id = c.patient_id
left join profiles a on a.id = r.assigned_to;

create or replace view v_assessments with (security_invoker = true) as
select d.*, n.full_name as nurse_name, c.case_no
from discharge_assessments d
join cases c on c.id = d.case_id
left join profiles n on n.id = d.nurse_id;

-- ---------- grants ----------
grant select on v_cases, v_referrals, v_assessments, discharge_assessments to caredesk_app;
revoke insert, update, delete on discharge_assessments from caredesk_app;
grant execute on function set_intake(uuid, jsonb), schedule_validation(uuid, uuid, timestamptz), record_validation(uuid, jsonb),
  set_item_scope(uuid, boolean, text, int), record_signoff(uuid, jsonb), import_referral_updates(jsonb),
  transition_metrics(timestamptz, timestamptz), update_referral(uuid, text, text, timestamptz) to caredesk_app;

-- ---------- live updates (the change-tracking loop, re-run for the new table) ----------
do $$ declare t text; begin
  foreach t in array array['discharge_assessments'] loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;
