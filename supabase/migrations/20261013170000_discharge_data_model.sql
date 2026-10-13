-- =====================================================================
-- CareDesk CRM  |  Discharge-to-homecare data model, part 2 (Oct 2026)
--   * case: decision-maker mobile, hospital room / bed; validation: the doctor's recommendations
--   * commercial ledger: why an item was dropped (cost, space, unwilling ...) and a payment schedule
--     (instalments as % of the agreed total; amounts and paid / overdue status computed, never typed)
--   * partner work orders: partner_deployments = Book My Medicare staff (staff ID, shift) and equipment
--     (model, serial) with dispatch / delivery / install / on-duty times; they move the lead along
--   * journey: cases.journey_state (intake_logged -> onsite_assessed -> commercial_approved ->
--     partner_dispatched -> setup_installed -> active_care -> closed; cancelled), derived by the database
--     from what happened, with case_journey_history
-- SecondMedic's own diagnostic orders stay on assignments (field visits) and samples (barcode, report file_url).
-- Expand only.
-- =====================================================================

-- ---------- journey states ----------
do $$ begin
  create type case_journey as enum ('intake_logged','onsite_assessed','commercial_approved','partner_dispatched',
                                    'setup_installed','active_care','closed','cancelled');
exception when duplicate_object then null; end $$;

-- ---------- columns ----------
alter table cases add column if not exists decision_maker_mobile text;
alter table cases add column if not exists hospital_room text;
alter table cases add column if not exists journey_state case_journey not null default 'intake_logged';
alter table cases add column if not exists journey_at timestamptz;
create index if not exists cases_journey on cases(workspace_id, journey_state);

alter table discharge_assessments add column if not exists doctor_recommendations text;

alter table case_items add column if not exists exclude_category text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'case_items_exclude_category_check') then
    alter table case_items add constraint case_items_exclude_category_check check (exclude_category is null or exclude_category in
      ('cost','space','unwilling','clinical','arranged_elsewhere','other'));
  end if;
end $$;
update case_items set exclude_category = 'other' where excluded and exclude_category is null;

-- ---------- journey history ----------
create table if not exists case_journey_history (
  id          bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  case_id     uuid not null references cases(id) on delete cascade,
  from_state  case_journey,
  to_state    case_journey not null,
  changed_by  uuid references profiles(id),
  changed_at  timestamptz not null default now()
);
create index if not exists journey_history_case on case_journey_history(case_id, changed_at);
alter table case_journey_history enable row level security;

-- ---------- payment schedule (instalments as % of the agreed total) ----------
create table if not exists payment_schedule (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  case_id     uuid not null references cases(id) on delete cascade,
  seq         integer not null check (seq between 1 and 24),
  label       text not null,
  due_on      date not null,
  pct         numeric(5,2) not null check (pct > 0 and pct <= 100),
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  unique (case_id, seq)
);
alter table payment_schedule enable row level security;

-- ---------- partner work orders (Book My Medicare staff and equipment) ----------
create table if not exists partner_deployments (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  case_id         uuid not null references cases(id) on delete cascade,
  referral_id     uuid not null references case_referrals(id) on delete cascade,
  case_item_id    uuid references case_items(id) on delete set null,
  resource_type   text not null check (resource_type in ('staff','equipment')),
  staff_name      text,
  staff_ref       text,                    -- the partner's staff ID
  shift           text check (shift is null or shift in ('day','night','24h')),
  equipment_model text,
  equipment_serial text,
  status          text not null default 'dispatched'
                  check (status in ('dispatched','delivered','installed','active','returned','cancelled')),
  dispatched_at   timestamptz,
  delivered_at    timestamptz,
  installed_at    timestamptz,
  active_from     timestamptz,
  ended_at        timestamptz,
  note            text,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists deployments_case on partner_deployments(case_id, status);
create index if not exists deployments_referral on partner_deployments(referral_id);
create index if not exists deployments_serial on partner_deployments(workspace_id, equipment_serial) where equipment_serial is not null;
alter table partner_deployments enable row level security;

-- ---------- journey: derived from what happened ----------
create or replace function journey_of(p_case uuid) returns case_journey
language sql stable security definer set search_path = public as $$
  select case
    when c.stage = 'closed' then 'closed'
    when c.stage = 'cancelled' then 'cancelled'
    when c.stage in ('completion','payment','closure')
      or exists (select 1 from partner_deployments d where d.case_id = c.id and d.status = 'active') then 'active_care'
    when exists (select 1 from partner_deployments d where d.case_id = c.id and d.status = 'installed')
      or exists (select 1 from case_referrals r where r.case_id = c.id and r.status in ('in_progress','completed')) then 'setup_installed'
    when c.stage = 'deployment'
      or exists (select 1 from partner_deployments d where d.case_id = c.id and d.status in ('dispatched','delivered'))
      or exists (select 1 from case_referrals r where r.case_id = c.id and r.status = 'dispatched') then 'partner_dispatched'
    when c.signoff_at is not null or c.stage = 'booking' then 'commercial_approved'
    when c.validation_status in ('done','not_ready') then 'onsite_assessed'
    else 'intake_logged'
  end::case_journey
  from cases c where c.id = p_case
$$;

create or replace function refresh_journey(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c record; v case_journey;
begin
  select id, workspace_id, journey_state into c from cases where id = p_case;
  if not found then return; end if;
  v := journey_of(p_case);
  if v is distinct from c.journey_state then
    perform rpc_on();
    update cases set journey_state = v, journey_at = now() where id = p_case;
    insert into case_journey_history (workspace_id, case_id, from_state, to_state, changed_by)
    values (c.workspace_id, p_case, c.journey_state, v, app_uid());
  end if;
end $$;

create or replace function trg_journey() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform refresh_journey(case when tg_op = 'DELETE' then old.case_id else new.case_id end);
  return null;
end $$;
create or replace function trg_case_journey() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage or new.signoff_at is distinct from old.signoff_at
     or new.validation_status is distinct from old.validation_status then
    perform refresh_journey(new.id);
  end if;
  return null;
end $$;
drop trigger if exists zy_case_journey on cases;
create trigger zy_case_journey after insert or update on cases for each row execute function trg_case_journey();
drop trigger if exists zy_referral_journey on case_referrals;
create trigger zy_referral_journey after insert or update or delete on case_referrals for each row execute function trg_journey();
drop trigger if exists zy_deployment_journey on partner_deployments;
create trigger zy_deployment_journey after insert or update or delete on partner_deployments for each row execute function trg_journey();

-- ---------- partner work orders ----------
-- Book My Medicare (or a supervisor / Hinduja management) logs one staff member or one piece of equipment for a lead,
-- or moves it on: dispatched -> delivered -> installed -> active (on duty / in use) -> returned. The lead follows:
-- first dispatch = Dispatched, first install / on duty = Deployed.
create or replace function log_deployment(p_referral uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; pv record; d record; v_id uuid := nullif(p->>'id','')::uuid; v_status text; v_type text; v_item uuid;
  v_at timestamptz := coalesce(nullif(p->>'at','')::timestamptz, now()); v_rank int; v_old int; v_label text;
begin
  select * into r from case_referrals where id = p_referral for update;
  if not found then raise exception 'Lead not found'; end if;
  if r.workspace_id is distinct from me_ws() then raise exception 'Lead not found'; end if;
  select * into pv from providers where id = r.provider_id;
  if not (has_role('supervisor','client_manager') or (has_role('provider') and r.provider_id = me_provider())) then
    raise exception 'Not allowed for your role';
  end if;
  if pv.code = 'SM' then raise exception 'SecondMedic work is logged as field visits and samples on the case'; end if;
  if r.status not in ('accepted','scheduled','dispatched','in_progress') then
    raise exception 'Accept the lead before logging staff or equipment (lead is %)', r.status;
  end if;
  v_status := coalesce(nullif(p->>'status',''), 'dispatched');
  if v_status not in ('dispatched','delivered','installed','active','returned','cancelled') then raise exception 'Unknown status %', v_status; end if;
  v_rank := array_position(array['dispatched','delivered','installed','active','returned'], v_status);
  -- with no id this finds nothing and leaves d as an all-null row, so d.* below reads as null
  select * into d from partner_deployments where id = v_id and referral_id = p_referral for update;
  if v_id is not null then
    if d.id is null then raise exception 'Work order not found'; end if;
    if d.status in ('returned','cancelled') then raise exception 'This work order is already %', d.status; end if;
    v_old := array_position(array['dispatched','delivered','installed','active','returned'], d.status);
    if v_status <> 'cancelled' and v_rank < v_old then raise exception 'Status cannot go back from % to %', d.status, v_status; end if;
    v_type := d.resource_type;
  else
    v_type := nullif(p->>'resource_type','');
    if v_type is null or v_type not in ('staff','equipment') then raise exception 'Choose staff or equipment'; end if;
  end if;
  v_item := coalesce(nullif(p->>'case_item_id','')::uuid, d.case_item_id);
  if v_item is not null and not exists (select 1 from case_items i where i.id = v_item and i.case_id = r.case_id and not i.excluded
                                        and (i.category = any(r.categories) or cardinality(r.categories) = 0)) then
    raise exception 'That item is not part of this lead';
  end if;
  if v_type = 'staff' and coalesce(nullif(trim(p->>'staff_ref'),''), d.staff_ref) is null then raise exception 'Enter the staff ID'; end if;
  if v_type = 'staff' and coalesce(nullif(trim(p->>'staff_name'),''), d.staff_name) is null then raise exception 'Enter the staff name'; end if;
  if v_type = 'staff' and v_status in ('delivered','installed') then raise exception 'Staff go from dispatched to active (on duty)'; end if;
  if v_type = 'equipment' and v_status in ('delivered','installed','active')
     and coalesce(nullif(trim(p->>'equipment_serial'),''), d.equipment_serial) is null then
    raise exception 'Enter the equipment serial number';
  end if;
  if v_id is null then
    insert into partner_deployments (workspace_id, case_id, referral_id, case_item_id, resource_type, staff_name, staff_ref, shift,
      equipment_model, equipment_serial, status, dispatched_at, delivered_at, installed_at, active_from, note, created_by)
    values (r.workspace_id, r.case_id, p_referral, v_item, v_type, nullif(trim(p->>'staff_name'),''), nullif(trim(p->>'staff_ref'),''),
      nullif(p->>'shift',''), nullif(trim(p->>'equipment_model'),''), nullif(trim(p->>'equipment_serial'),''), v_status, v_at,
      case when v_status in ('delivered','installed','active') and v_type = 'equipment' then v_at end,
      case when v_status in ('installed','active') and v_type = 'equipment' then v_at end,
      case when v_status = 'active' then v_at end, nullif(trim(p->>'note'),''), app_uid())
    returning * into d;
  else
    update partner_deployments set status = v_status, case_item_id = v_item,
      staff_name = coalesce(nullif(trim(p->>'staff_name'),''), staff_name), staff_ref = coalesce(nullif(trim(p->>'staff_ref'),''), staff_ref),
      shift = coalesce(nullif(p->>'shift',''), shift), equipment_model = coalesce(nullif(trim(p->>'equipment_model'),''), equipment_model),
      equipment_serial = coalesce(nullif(trim(p->>'equipment_serial'),''), equipment_serial),
      delivered_at = case when v_status in ('delivered','installed','active') and resource_type = 'equipment' then coalesce(delivered_at, v_at) else delivered_at end,
      installed_at = case when v_status in ('installed','active') and resource_type = 'equipment' then coalesce(installed_at, v_at) else installed_at end,
      active_from  = case when v_status = 'active' then coalesce(active_from, v_at) else active_from end,
      ended_at     = case when v_status in ('returned','cancelled') then v_at else ended_at end,
      note = coalesce(nullif(trim(p->>'note'),''), note), updated_at = now()
    where id = d.id returning * into d;
  end if;
  v_label := pv.name || ': ' || case v_type when 'staff' then coalesce(d.staff_name, 'staff') || ' (ID ' || d.staff_ref || ')'
      else coalesce(d.equipment_model, 'equipment') || coalesce(' · serial ' || d.equipment_serial, '') end
    || ' ' || case v_status when 'active' then case v_type when 'staff' then 'on duty' else 'in use' end else v_status end;
  perform log_interaction(r.case_id, 'system', 'internal', v_label, nullif(trim(p->>'note'),''), null,
    jsonb_build_object('referral_id', p_referral, 'deployment_id', d.id, 'status', v_status));
  -- the lead follows its work orders
  if v_status in ('dispatched','delivered') and r.status in ('accepted','scheduled') then
    perform update_referral(p_referral, 'dispatched', null, null);
  elsif v_status in ('installed','active') and r.status in ('accepted','scheduled','dispatched') then
    perform update_referral(p_referral, 'in_progress', null, null);
  end if;
  return to_jsonb(d);
end $$;

-- ---------- payment schedule ----------
-- p_rows: [{label, due_on, pct}], percentages adding up to 100. Replaces the case's schedule.
create or replace function set_payment_schedule(p_case uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; x jsonb; v_seq int := 0; v_sum numeric := 0;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.stage in ('closed','cancelled') then raise exception 'Case is %; reopen it first.', c.stage; end if;
  if c.total <= 0 then raise exception 'The case has no agreed total yet'; end if;
  if c.care_type = 'post_discharge' and c.signoff_at is null then raise exception 'Record the family sign-off first'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Add at least one instalment'; end if;
  if jsonb_array_length(p_rows) > 24 then raise exception 'At most 24 instalments'; end if;
  delete from payment_schedule where case_id = p_case;
  for x in select * from jsonb_array_elements(p_rows) loop
    v_seq := v_seq + 1;
    if coalesce(nullif(trim(x->>'label'),''), '') = '' then raise exception 'Instalment %: label must not be blank', v_seq; end if;
    if nullif(x->>'due_on','') is null then raise exception 'Instalment %: due date must not be blank', v_seq; end if;
    if coalesce((x->>'pct')::numeric, 0) <= 0 then raise exception 'Instalment %: share must be greater than 0', v_seq; end if;
    insert into payment_schedule (workspace_id, case_id, seq, label, due_on, pct, created_by)
    values (c.workspace_id, p_case, v_seq, trim(x->>'label'), (x->>'due_on')::date, round((x->>'pct')::numeric, 2), app_uid());
    v_sum := v_sum + round((x->>'pct')::numeric, 2);
  end loop;
  if v_sum <> 100 then raise exception 'Instalments must add up to 100%%, now %', v_sum; end if;
  perform log_interaction(p_case, 'system', 'internal', 'Payment schedule set · ' || v_seq || ' instalment' || case when v_seq > 1 then 's' else '' end, null);
  return (select coalesce(jsonb_agg(to_jsonb(s) order by s.seq), '[]'::jsonb) from v_payment_schedule s where s.case_id = p_case);
end $$;

-- ---------- functions from the previous migration, extended ----------
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
     or new.signoff_by_name is distinct from old.signoff_by_name
     or new.journey_state is distinct from old.journey_state then
    raise exception 'This field is controlled by workflow rules. Use the action buttons on the case.' using errcode = 'P0001';
  end if;
  if old.stage in ('closed','cancelled') then
    raise exception 'Case is %; reopen it first.', old.stage using errcode = 'P0001';
  end if;
  return new;
end $$;

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
    values (v_ws, tg_table_name, v_id, 'delete', o - 'decision_maker_name' - 'decision_maker_mobile' - 'signoff_by_name' - 'treating_doctor', app_uid());
    return old;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if k in ('updated_at','ai_brief','last_seen_at') then continue; end if;
    if (o->k) is distinct from (n->k) then
      if k in ('decision_maker_name','decision_maker_mobile','signoff_by_name','treating_doctor') then
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
    decision_maker_mobile = coalesce(norm_mobile(nullif(p->>'decision_maker_mobile','')), decision_maker_mobile),
    hospital_room = coalesce(nullif(p->>'hospital_room',''), hospital_room),
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

drop function if exists set_item_scope(uuid, boolean, text, int);
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
  perform log_interaction(i.case_id, 'system', 'internal',
    'Scope: ' || i.service_name || case when not p_included then ' dropped (' || replace(v_cat, '_', ' ') || ': ' || trim(p_reason) || ')'
      when i.excluded then ' added back' else ' quantity ' || coalesce(p_qty, i.qty) end, null);
  return (select jsonb_build_object('subtotal', subtotal, 'total', total, 'signoff_at', signoff_at) from cases where id = i.case_id);
end $$;

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
    'journey', coalesce((select jsonb_object_agg(journey_state, n) from (
      select journey_state, count(*) n from pc group by journey_state) j), '{}'::jsonb),
    'drop_categories', coalesce((select jsonb_object_agg(cat, n) from (
      select coalesce(i.exclude_category, 'other') cat, count(*) n from case_items i join pc on pc.id = i.case_id
      where i.excluded group by 1) k), '{}'::jsonb),
    'drop_reasons', coalesce((select jsonb_agg(jsonb_build_object('service', i.service_name, 'category', i.exclude_category, 'reason', i.exclude_reason))
      from case_items i join pc on pc.id = i.case_id where i.excluded), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------- RLS ----------
drop policy if exists journey_history_read on case_journey_history;
create policy journey_history_read on case_journey_history for select using (workspace_id = me_ws() and can_see_case(case_id));
-- money: not for partners, field staff or the platform admin
drop policy if exists payment_schedule_read on payment_schedule;
create policy payment_schedule_read on payment_schedule for select using (
  workspace_id = me_ws() and can_see_case(case_id) and not has_role('provider','field_staff','admin'));
-- a partner sees only its own work orders
drop policy if exists deployments_read on partner_deployments;
create policy deployments_read on partner_deployments for select using (
  workspace_id = me_ws() and can_see_case(case_id) and not has_role('admin')
  and (not has_role('provider') or exists (select 1 from case_referrals r where r.id = referral_id and r.provider_id = me_provider())));

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

-- instalment amounts from the current agreed total (the last one takes the rounding), paid / overdue from collections
create or replace view v_payment_schedule with (security_invoker = true) as
with s as (
  select ps.*, c.total, c.amount_collected, c.payment_status,
    round(c.total * ps.pct / 100, 2) as raw_amount,
    row_number() over (partition by ps.case_id order by ps.seq desc) as rn_desc,
    sum(round(c.total * ps.pct / 100, 2)) over (partition by ps.case_id) as sum_raw
  from payment_schedule ps join cases c on c.id = ps.case_id
), a as (
  select s.*, case when rn_desc = 1 then raw_amount + (total - sum_raw) else raw_amount end as amount from s
), b as (
  select a.*, sum(amount) over (partition by case_id order by seq) as cumulative_due from a
)
select id, workspace_id, case_id, seq, label, due_on, pct, amount, cumulative_due, created_by, created_at,
  case when payment_status = 'waived' then 'waived'
       when amount_collected >= cumulative_due then 'paid'
       when amount_collected > cumulative_due - amount then 'part_paid'
       when due_on < (now() at time zone 'Asia/Kolkata')::date then 'overdue'
       else 'due' end as status
from b;

create or replace view v_deployments with (security_invoker = true) as
select d.*, pv.code as provider_code, pv.name as provider_name, c.case_no, i.service_name, i.service_code, i.qty as item_qty
from partner_deployments d
join case_referrals r on r.id = d.referral_id
join providers pv on pv.id = r.provider_id
join cases c on c.id = d.case_id
left join case_items i on i.id = d.case_item_id;

-- ---------- grants ----------
grant select on v_cases, v_assessments, v_payment_schedule, v_deployments, payment_schedule, partner_deployments, case_journey_history to caredesk_app;
grant usage, select on sequence case_journey_history_id_seq to caredesk_app;
revoke insert, update, delete on payment_schedule, partner_deployments, case_journey_history from caredesk_app;
grant execute on function journey_of(uuid), log_deployment(uuid, jsonb), set_payment_schedule(uuid, jsonb),
  set_intake(uuid, jsonb), record_validation(uuid, jsonb), set_item_scope(uuid, boolean, text, int, text),
  transition_metrics(timestamptz, timestamptz) to caredesk_app;

-- ---------- audit + live updates for the new tables ----------
do $$ declare t text; begin
  foreach t in array array['payment_schedule','partner_deployments'] loop
    execute format('drop trigger if exists audit_%1$s on %1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function trg_audit()', t);
  end loop;
  foreach t in array array['payment_schedule','partner_deployments','case_journey_history'] loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;

-- ---------- backfill the journey of existing cases (no history rows for the backfill) ----------
-- workflow guard, last-updated stamp and field audit stay off for this one-time fill so case lists and the audit log are not touched
alter table cases disable trigger case_guard;
alter table cases disable trigger touch_cases;
alter table cases disable trigger audit_cases;
update cases c set journey_state = j.s, journey_at = now()
from (select id, journey_of(id) s from cases) j
where j.id = c.id and c.journey_state is distinct from j.s;
alter table cases enable trigger case_guard;
alter table cases enable trigger touch_cases;
alter table cases enable trigger audit_cases;
