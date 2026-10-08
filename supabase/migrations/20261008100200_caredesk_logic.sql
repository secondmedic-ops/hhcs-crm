-- =====================================================================
-- CareDesk CRM  |  0002  Business logic: case IDs, stage gates, pricing
-- lock, discount approvals, SLA engine, audit trail, RPCs, reporting
-- =====================================================================

-- ---------- identity helpers ----------
create or replace function me_ws() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where id = app_uid()
$$;

create or replace function me_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = app_uid() and active
$$;

create or replace function has_role(variadic roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = any(roles) from profiles where id = app_uid() and active), false)
$$;

create or replace function is_service() returns boolean
language sql stable as $$
  select coalesce(app_claim_role() = 'service_role', false)
$$;

create or replace function is_ops() returns boolean
language sql stable as $$ select has_role('agent','coordinator','supervisor','medical_desk') $$;

create or replace function rpc_on() returns void language sql as $$
  select set_config('app.rpc','on',true)
$$;

create or replace function norm_mobile(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when length(regexp_replace(p,'\D','','g')) = 10 then '+91' || regexp_replace(p,'\D','','g')
    when length(regexp_replace(p,'\D','','g')) = 12 and left(regexp_replace(p,'\D','','g'),2)='91'
      then '+' || regexp_replace(p,'\D','','g')
    when length(regexp_replace(p,'\D','','g')) = 11 and left(regexp_replace(p,'\D','','g'),1)='0'
      then '+91' || right(regexp_replace(p,'\D','','g'),10)
    else '+' || regexp_replace(p,'\D','','g') end
$$;

create or replace function mask_mobile(p text) returns text
language sql immutable as $$
  select case when p is null then null
              else left(p, 5) || 'XXX XX' || right(p, 3) end
$$;

create or replace function haversine_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns int
language sql immutable as $$
  select case when lat1 is null or lat2 is null then null else
    round(2 * 6371000 * asin(sqrt(
      power(sin(radians(lat2-lat1)/2),2) +
      cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lng2-lng1)/2),2))))::int end
$$;

create or replace function zone_for_pincode(p_ws uuid, p_pin text) returns uuid
language sql stable as $$
  select id from zones where workspace_id = p_ws and active and p_pin = any(pincodes) limit 1
$$;

create or replace function notify_role(p_ws uuid, p_role app_role, p_title text, p_body text, p_link text, p_kind text default 'info')
returns void language sql security definer set search_path = public as $$
  insert into notifications(workspace_id, role, title, body, link, kind)
  values (p_ws, p_role, p_title, p_body, p_link, p_kind)
$$;

create or replace function notify_user(p_user uuid, p_title text, p_body text, p_link text, p_kind text default 'info')
returns void language sql security definer set search_path = public as $$
  insert into notifications(workspace_id, user_id, title, body, link, kind)
  select workspace_id, id, p_title, p_body, p_link, p_kind from profiles where id = p_user
$$;

create or replace function log_interaction(p_case uuid, p_channel text, p_direction text, p_summary text,
  p_body text default null, p_evidence text default null, p_meta jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ws uuid; v_pat uuid; v_label text;
begin
  select workspace_id, patient_id into v_ws, v_pat from cases where id = p_case;
  select coalesce(agent_code, full_name) into v_label from profiles where id = app_uid();
  insert into interactions(workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, evidence, meta)
  values (v_ws, p_case, v_pat, p_channel, p_direction, app_uid(), coalesce(v_label,'System'), p_summary, p_body, p_evidence, p_meta)
  returning id into v_id;
  return v_id;
end $$;

-- ---------- generic triggers ----------
create or replace function trg_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists touch_cases on cases;
create trigger touch_cases before update on cases for each row execute function trg_touch();
drop trigger if exists touch_patients on patients;
create trigger touch_patients before update on patients for each row execute function trg_touch();
drop trigger if exists touch_services on services;
create trigger touch_services before update on services for each row execute function trg_touch();

-- field-level audit trail: who changed what, old -> new
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
    values (v_ws, tg_table_name, v_id, 'delete', o, app_uid());
    return old;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if k in ('updated_at','ai_brief','last_seen_at') then continue; end if;
    if (o->k) is distinct from (n->k) then
      diff := diff || jsonb_build_object(k, jsonb_build_object('old', o->k, 'new', n->k));
    end if;
  end loop;
  if diff <> '{}'::jsonb then
    v_id := (n->>'id')::uuid; v_ws := (n->>'workspace_id')::uuid;
    insert into audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
    values (v_ws, tg_table_name, v_id, 'update', diff, app_uid());
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['cases','patients','services','templates','payments','assignments',
                           'approvals','escalations','complaints','sla_policies','escalation_matrix','profiles','samples','zones'] loop
    execute format('drop trigger if exists audit_%1$s on %1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function trg_audit()', t);
  end loop;
end $$;

-- ---------- case number HHC-YYMMDD-NNNNN ----------
create or replace function trg_case_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_code text; v_tz text; v_day date; v_seq int; p record;
begin
  select code, timezone into v_code, v_tz from workspaces where id = new.workspace_id;
  v_day := (now() at time zone v_tz)::date;
  insert into case_counters(workspace_id, day, last_value) values (new.workspace_id, v_day, 1)
  on conflict (workspace_id, day) do update set last_value = case_counters.last_value + 1
  returning last_value into v_seq;
  new.case_no := v_code || '-' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_seq::text, 5, '0');
  new.stage := 'enquiry';
  new.quote_status := 'draft';
  new.subtotal := 0; new.total := 0; new.discount_amount := 0; new.discount_pct := 0;
  new.amount_collected := 0; new.payment_status := 'unpaid';
  select * into p from patients where id = new.patient_id;
  new.address := coalesce(new.address, p.address);
  new.pincode := coalesce(new.pincode, p.pincode);
  new.zone_id := coalesce(new.zone_id, p.zone_id, zone_for_pincode(new.workspace_id, coalesce(new.pincode, p.pincode)));
  new.created_by := coalesce(new.created_by, app_uid());
  new.owner_id := coalesce(new.owner_id, app_uid());
  return new;
end $$;
drop trigger if exists case_before_insert on cases;
create trigger case_before_insert before insert on cases for each row execute function trg_case_before_insert();

create or replace function trg_patient_before() returns trigger language plpgsql as $$
begin
  new.mobile := norm_mobile(new.mobile);
  new.alt_mobile := norm_mobile(new.alt_mobile);
  if new.pincode is not null and (tg_op = 'INSERT' or new.pincode is distinct from old.pincode) then
    new.zone_id := coalesce(zone_for_pincode(new.workspace_id, new.pincode), new.zone_id);
  end if;
  if tg_op = 'INSERT' and new.mrn is null then
    new.mrn := 'P-' || to_char(now(),'YYMM') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  end if;
  return new;
end $$;
drop trigger if exists patient_before on patients;
create trigger patient_before before insert or update on patients for each row execute function trg_patient_before();

-- protected case columns can only change through RPCs (no free-text price, no stage skipping)
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
     or new.quote_sent_at is distinct from old.quote_sent_at then
    raise exception 'This field is controlled by workflow rules. Use the action buttons on the case.' using errcode = 'P0001';
  end if;
  if old.stage in ('closed','cancelled') then
    raise exception 'Case is %; reopen it first.', old.stage using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists case_guard on cases;
create trigger case_guard before update on cases for each row execute function trg_case_guard();

-- ---------- locked rate card on case items ----------
create or replace function trg_item_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record; c record;
begin
  select * into c from cases where id = new.case_id;
  if c.stage not in ('enquiry','pricing') and not is_service() then
    raise exception 'Services can only be changed during Enquiry or Pricing';
  end if;
  select * into s from services where id = new.service_id and workspace_id = c.workspace_id and active;
  if not found then raise exception 'Service is not on the approved rate card'; end if;
  new.unit_price := s.price;          -- any client-supplied price is ignored
  new.service_code := s.code; new.service_name := s.name; new.category := s.category;
  new.line_total := s.price * new.qty;
  return new;
end $$;
drop trigger if exists item_price on case_items;
create trigger item_price before insert or update on case_items for each row execute function trg_item_price();

create or replace function recalc_case(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_sub numeric; c record; v_band numeric;
begin
  select * into c from cases where id = p_case;
  select coalesce(sum(line_total),0) into v_sub from case_items where case_id = p_case;
  select discount_band_pct into v_band from workspaces where id = c.workspace_id;
  perform rpc_on();
  update cases set subtotal = v_sub,
    discount_amount = round(v_sub * discount_pct / 100, 2),
    total = v_sub - round(v_sub * discount_pct / 100, 2),
    quote_status = case when quote_status in ('sent') then 'sent'
                        when discount_pct > v_band then quote_status
                        else 'approved' end
  where id = p_case;
end $$;

create or replace function trg_item_after() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform recalc_case(coalesce(new.case_id, old.case_id));
  return null;
end $$;
drop trigger if exists item_after on case_items;
create trigger item_after after insert or update or delete on case_items for each row execute function trg_item_after();

-- ---------- SLA engine ----------
create or replace function sla_start(p_ws uuid, p_key text, p_case uuid, p_complaint uuid, p_callback uuid,
                                     p_base timestamptz default now(), p_due timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_min int;
begin
  select target_minutes into v_min from sla_policies where workspace_id = p_ws and key = p_key;
  if v_min is null and p_due is null then return; end if;
  if exists (select 1 from sla_timers where policy_key = p_key and status = 'running'
             and case_id is not distinct from p_case and complaint_id is not distinct from p_complaint
             and callback_id is not distinct from p_callback) then return; end if;
  insert into sla_timers(workspace_id, policy_key, case_id, complaint_id, callback_id, started_at, due_at)
  values (p_ws, p_key, p_case, p_complaint, p_callback, p_base, coalesce(p_due, p_base + make_interval(mins => v_min)));
end $$;

create or replace function sla_meet(p_key text, p_case uuid default null, p_complaint uuid default null, p_callback uuid default null)
returns void language sql security definer set search_path = public as $$
  update sla_timers set met_at = now(), status = case when status = 'breached' then 'breached' else 'met' end
  where policy_key = p_key and met_at is null and status in ('running','breached')
    and (p_case is null or case_id = p_case)
    and (p_complaint is null or complaint_id = p_complaint)
    and (p_callback is null or callback_id = p_callback);
$$;

create or replace function trg_case_sla() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.source_channel in ('whatsapp','email','chat') then
      perform sla_start(new.workspace_id, 'ack', new.id, null, null, new.created_at);
    end if;
    return new;
  end if;
  if new.stage = 'pricing' and old.stage = 'enquiry' then
    perform sla_start(new.workspace_id, 'quote', new.id, null, null);
  end if;
  if new.quote_sent_at is not null and old.quote_sent_at is null then
    perform sla_meet('quote', new.id);
    perform sla_start(new.workspace_id, 'booking', new.id, null, null);
  end if;
  if new.booking_confirmed_at is not null and old.booking_confirmed_at is null then
    perform sla_meet('booking', new.id);
  end if;
  if new.stage in ('closed','cancelled') then
    update sla_timers set status = 'cancelled' where case_id = new.id and status = 'running';
  end if;
  return new;
end $$;
drop trigger if exists case_sla on cases;
create trigger case_sla after insert or update on cases for each row execute function trg_case_sla();

create or replace function trg_interaction_sla() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.case_id is not null and new.direction = 'outbound' and new.channel in ('whatsapp','sms','email','chat','phone') then
    perform sla_meet('ack', new.case_id);
  end if;
  return new;
end $$;
drop trigger if exists interaction_sla on interactions;
create trigger interaction_sla after insert on interactions for each row execute function trg_interaction_sla();

create or replace function trg_callback_sla() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform sla_start(new.workspace_id, 'missed_callback', null, null, new.id, new.created_at, new.due_at);
  elsif new.status = 'done' and old.status <> 'done' then
    perform sla_meet('missed_callback', null, null, new.id);
  end if;
  return new;
end $$;
drop trigger if exists callback_sla on callbacks;
create trigger callback_sla after insert or update on callbacks for each row execute function trg_callback_sla();

create or replace function trg_complaint() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform sla_start(new.workspace_id, 'complaint_ack', new.case_id, new.id, null, new.opened_at);
    perform sla_start(new.workspace_id, 'complaint_resolve', new.case_id, new.id, null, new.opened_at);
    perform notify_role(new.workspace_id, 'supervisor', 'New complaint ' || coalesce(new.ref_no,''), new.description, '/complaints', 'warn');
    if new.severity in ('high','critical') then
      perform notify_role(new.workspace_id, 'client_manager', 'High-severity complaint ' || coalesce(new.ref_no,''), new.description, '/complaints', 'danger');
    end if;
  else
    if new.acknowledged_at is not null and old.acknowledged_at is null then perform sla_meet('complaint_ack', null, new.id); end if;
    if new.resolved_at is not null and old.resolved_at is null then perform sla_meet('complaint_resolve', null, new.id); end if;
  end if;
  return new;
end $$;

create or replace function trg_complaint_before() returns trigger language plpgsql as $$
begin
  if new.ref_no is null then
    new.ref_no := 'CMP-' || to_char(now(),'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,4));
  end if;
  if new.status = 'acknowledged' and new.acknowledged_at is null then new.acknowledged_at := now(); end if;
  if new.status in ('resolved','closed') and new.resolved_at is null then
    new.resolved_at := now(); new.acknowledged_at := coalesce(new.acknowledged_at, now());
  end if;
  return new;
end $$;
drop trigger if exists complaint_before on complaints;
create trigger complaint_before before insert or update on complaints for each row execute function trg_complaint_before();
drop trigger if exists complaint_after on complaints;
create trigger complaint_after after insert or update on complaints for each row execute function trg_complaint();

create or replace function trg_escalation() returns trigger language plpgsql security definer set search_path = public as $$
declare v_case text;
begin
  select case_no into v_case from cases where id = new.case_id;
  if tg_op = 'INSERT' then
    if new.type in ('clinical','emergency') then
      perform sla_start(new.workspace_id, 'critical_finding', new.case_id, null, null, new.raised_at);
      perform notify_role(new.workspace_id, 'client_clinical', upper(new.type) || ' escalation ' || coalesce(v_case,''), new.trigger_text, '/escalations', 'danger');
      perform notify_role(new.workspace_id, 'medical_desk', upper(new.type) || ' escalation ' || coalesce(v_case,''), new.trigger_text, '/escalations', 'danger');
    end if;
    perform notify_role(new.workspace_id, 'client_manager', 'Escalation L' || new.level || ' · ' || new.type || ' ' || coalesce(v_case,''), new.trigger_text, '/escalations', 'danger');
    perform notify_role(new.workspace_id, 'supervisor', 'Escalation L' || new.level || ' · ' || new.type || ' ' || coalesce(v_case,''), new.trigger_text, '/escalations', 'danger');
    if new.case_id is not null then
      insert into interactions(workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body)
      select new.workspace_id, c.id, c.patient_id, 'system', 'internal', new.raised_by, 'Escalation',
             'Escalation raised · ' || new.type || ' · L' || new.level, new.trigger_text
      from cases c where c.id = new.case_id;
    end if;
  elsif new.status <> old.status and new.status in ('acknowledged','resolved') and new.type in ('clinical','emergency') then
    perform sla_meet('critical_finding', new.case_id);
  end if;
  return new;
end $$;
drop trigger if exists escalation_after on escalations;
create trigger escalation_after after insert or update on escalations for each row execute function trg_escalation();

create or replace function trg_assignment() returns trigger language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from cases where id = new.case_id;
  if tg_op = 'INSERT' then
    if c.priority = 'urgent' then
      perform sla_start(new.workspace_id, 'arrival_urgent', new.case_id, null, null, c.created_at);
    elsif c.booked_slot is not null then
      perform sla_start(new.workspace_id, 'arrival_slot', new.case_id, null, null, now(),
        c.booked_slot + make_interval(mins => coalesce((select target_minutes from sla_policies where workspace_id = c.workspace_id and key = 'arrival_slot'), 15)));
    end if;
    perform notify_user(new.staff_id, 'New visit ' || c.case_no, 'Task: ' || new.task, '/my-visits', 'info');
  elsif new.checkin_at is not null and old.checkin_at is null then
    perform sla_meet('arrival_urgent', new.case_id);
    perform sla_meet('arrival_slot', new.case_id);
  end if;
  return new;
end $$;
drop trigger if exists assignment_after on assignments;
create trigger assignment_after after insert or update on assignments for each row execute function trg_assignment();

-- cron entry point (Cloudflare Worker calls this every minute with the service key)
create or replace function sla_scan() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record; n int := 0; v_case text; v_type text; p record;
begin
  for t in select * from sla_timers where status = 'running' and due_at < now() for update skip locked loop
    update sla_timers set status = 'breached', breached_at = now() where id = t.id;
    select * into p from sla_policies where workspace_id = t.workspace_id and key = t.policy_key;
    select case_no into v_case from cases where id = t.case_id;
    v_type := case when t.policy_key like 'complaint%' then 'complaint'
                   when t.policy_key like 'arrival%' or t.policy_key in ('booking','quote') then 'delay'
                   when t.policy_key = 'critical_finding' then 'clinical'
                   else 'sla' end;
    insert into escalations(workspace_id, case_id, complaint_id, type, level, trigger_text, auto_raised)
    values (t.workspace_id, t.case_id, t.complaint_id, v_type, case when t.policy_key = 'critical_finding' then 2 else 1 end,
            'SLA breached: ' || coalesce(p.label, t.policy_key) || coalesce(' on ' || v_case, ''), true);
    if t.case_id is not null then
      update cases set sla_state = 'breached' where id = t.case_id;
    end if;
    n := n + 1;
  end loop;
  -- at-risk: more than 75% of the window elapsed
  update cases c set sla_state = 'at_risk'
  where c.sla_state = 'ok' and exists (
    select 1 from sla_timers s where s.case_id = c.id and s.status = 'running'
      and now() > s.started_at + (s.due_at - s.started_at) * 0.75);
  -- level-up open escalations past their matrix window
  update escalations e set level = e.level + 1
  where e.status = 'open' and e.level < 3 and exists (
    select 1 from escalation_matrix m where m.workspace_id = e.workspace_id and m.type = e.type
      and m.level = e.level and m.target_minutes is not null
      and e.raised_at + make_interval(mins => m.target_minutes * e.level) < now());
  return jsonb_build_object('breached', n, 'at', now());
end $$;

-- ---------- stage gates ----------
create or replace function next_stage(s case_stage) returns case_stage language sql immutable as $$
  select case s when 'enquiry' then 'pricing' when 'pricing' then 'booking' when 'booking' then 'deployment'
    when 'deployment' then 'completion' when 'completion' then 'payment' when 'payment' then 'closure'
    when 'closure' then 'closed' else null end::case_stage
$$;

create or replace function case_gates(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c record; p record; v_to case_stage; checks jsonb := '[]'::jsonb;
  v_items int; v_lab int; v_samples int; v_checked int; v_open_asg int; v_open_cmp int;
begin
  select * into c from cases where id = p_case;
  if not found then raise exception 'Case not found'; end if;
  select * into p from patients where id = c.patient_id;
  v_to := next_stage(c.stage);
  select count(*), count(*) filter (where category = 'lab') into v_items, v_lab from case_items where case_id = p_case;
  if c.stage = 'enquiry' then
    checks := jsonb_build_array(
      jsonb_build_object('label','Patient name and mobile', 'ok', p.full_name is not null and p.mobile is not null),
      jsonb_build_object('label','Address and pincode', 'ok', coalesce(c.address,'') <> '' and coalesce(c.pincode,'') <> ''),
      jsonb_build_object('label','Services requested noted', 'ok', coalesce(c.services_requested,'') <> '' or v_items > 0),
      jsonb_build_object('label','Consent recorded', 'ok', p.consent_verbal_at is not null or p.consent_digital_at is not null));
  elsif c.stage = 'pricing' then
    checks := jsonb_build_array(
      jsonb_build_object('label','At least one rate-card service', 'ok', v_items > 0),
      jsonb_build_object('label','Discount approved (if above band)', 'ok', c.quote_status in ('approved','sent')),
      jsonb_build_object('label','Quote sent on approved template', 'ok', c.quote_status = 'sent'));
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

create or replace function advance_case(p_case uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g jsonb; c record; v_to case_stage;
begin
  if not (is_ops() or is_service()) then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  g := case_gates(p_case);
  v_to := (g->>'next')::case_stage;
  if v_to is null then raise exception 'Case cannot advance from %', c.stage; end if;
  if not (g->>'ready')::boolean then
    raise exception 'Stage gate not met: %', (select string_agg(x->>'label', ', ') from jsonb_array_elements(g->'checks') x where (x->>'ok')::boolean = false);
  end if;
  if v_to = 'closed' and not (c.owner_id = app_uid() or has_role('supervisor') or is_service()) then
    raise exception 'Only the case owner or a supervisor can close a case';
  end if;
  perform rpc_on();
  update cases set stage = v_to,
    closed_at = case when v_to = 'closed' then now() else closed_at end,
    closed_by = case when v_to = 'closed' then app_uid() else closed_by end,
    sla_state = case when v_to = 'closed' then 'ok' else sla_state end
  where id = p_case;
  insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note) values (p_case, c.stage, v_to, app_uid(), p_note);
  perform log_interaction(p_case, 'system', 'internal', 'Stage: ' || c.stage || ' → ' || v_to, p_note);
  return case_gates(p_case);
end $$;

create or replace function cancel_case(p_case uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A cancellation reason is required'; end if;
  select * into c from cases where id = p_case;
  if c.stage in ('closed','cancelled') then raise exception 'Case is already %', c.stage; end if;
  perform rpc_on();
  update cases set stage = 'cancelled', cancel_reason = p_reason where id = p_case;
  insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note) values (p_case, c.stage, 'cancelled', app_uid(), p_reason);
  update assignments set status = 'cancelled' where case_id = p_case and status in ('assigned','en_route');
  perform log_interaction(p_case, 'system', 'internal', 'Case cancelled', p_reason);
end $$;

create or replace function reopen_case(p_case uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c record; v_to case_stage;
begin
  if not has_role('supervisor','coordinator') then raise exception 'Only a supervisor or coordinator can reopen'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Reopen needs a reason'; end if;
  select * into c from cases where id = p_case;
  if c.stage not in ('closed','cancelled') then raise exception 'Case is not closed'; end if;
  select from_stage into v_to from case_stage_history where case_id = p_case order by changed_at desc limit 1;
  perform rpc_on();
  update cases set stage = coalesce(v_to, 'closure'), reopen_reason = p_reason, closed_at = null, closed_by = null where id = p_case;
  insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note) values (p_case, c.stage, coalesce(v_to,'closure'), app_uid(), 'Reopened: ' || p_reason);
  perform log_interaction(p_case, 'system', 'internal', 'Case reopened', p_reason);
end $$;

-- ---------- enquiry capture ----------
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
    insert into patients(workspace_id, full_name, age, gender, mobile, alt_mobile, email, address, landmark, locality, pincode, city, lat, lng, created_by)
    values (v_ws, coalesce(nullif(p->>'full_name',''),'Unknown caller'), nullif(p->>'age','')::int, nullif(p->>'gender',''), v_mob,
            nullif(p->>'alt_mobile',''), nullif(p->>'email',''), nullif(p->>'address',''), nullif(p->>'landmark',''),
            nullif(p->>'locality',''), nullif(p->>'pincode',''), coalesce(nullif(p->>'city',''),'Mumbai'),
            nullif(p->>'lat','')::float8, nullif(p->>'lng','')::float8, app_uid())
    returning id into v_id;
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

create or replace function create_enquiry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_pat uuid; v_case uuid; v_no text; v_ws uuid := coalesce(me_ws(), (p->>'workspace_id')::uuid);
begin
  if not (is_ops() or is_service()) then raise exception 'Not allowed for your role'; end if;
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
  v_pat := upsert_patient(p->'patient' || jsonb_build_object('workspace_id', v_ws));
  if (p->>'consent')::boolean then
    update patients set consent_verbal_at = coalesce(consent_verbal_at, now()),
                        consent_verbal_call_id = coalesce(nullif(p->>'call_id','')::uuid, consent_verbal_call_id)
    where id = v_pat;
  end if;
  insert into cases(workspace_id, patient_id, caller_name, caller_relation, caller_mobile, source_channel, priority,
                    services_requested, clinical_notes, preferred_slot, address, pincode, owner_id)
  values (v_ws, v_pat, nullif(p->>'caller_name',''), nullif(p->>'caller_relation',''), norm_mobile(nullif(p->>'caller_mobile','')),
          coalesce(nullif(p->>'source_channel',''),'phone'), coalesce(nullif(p->>'priority',''),'routine'),
          nullif(p->>'services_requested',''), nullif(p->>'clinical_notes',''), nullif(p->>'preferred_slot','')::timestamptz,
          nullif(p->'patient'->>'address',''), nullif(p->'patient'->>'pincode',''), coalesce(nullif(p->>'owner_id','')::uuid, app_uid()))
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
  return jsonb_build_object('case_id', v_case, 'case_no', v_no, 'patient_id', v_pat);
end $$;

create or replace function record_consent(p_patient uuid, p_kind text, p_call uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_ops() or has_role('field_staff')) then raise exception 'Not allowed'; end if;
  if p_kind = 'verbal' then
    update patients set consent_verbal_at = now(), consent_verbal_call_id = coalesce(p_call, consent_verbal_call_id) where id = p_patient;
  else
    update patients set consent_digital_at = now() where id = p_patient;
  end if;
  insert into interactions(workspace_id, patient_id, channel, direction, actor_id, summary)
  select workspace_id, id, 'system', 'internal', app_uid(), 'Consent recorded (' || p_kind || ')' from patients where id = p_patient;
end $$;

-- ---------- pricing & discount governance ----------
create or replace function set_discount(p_case uuid, p_pct numeric, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; v_band numeric; v_appr uuid;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  if c.stage not in ('enquiry','pricing') then raise exception 'Discount can only change before booking'; end if;
  if p_pct < 0 or p_pct > 100 then raise exception 'Invalid discount'; end if;
  select discount_band_pct into v_band from workspaces where id = c.workspace_id;
  perform rpc_on();
  update approvals set status = 'withdrawn' where case_id = p_case and kind = 'discount' and status = 'pending';
  update cases set discount_pct = p_pct,
    discount_amount = round(subtotal * p_pct / 100, 2),
    total = subtotal - round(subtotal * p_pct / 100, 2),
    quote_status = case when p_pct > v_band then 'pending_approval' else 'approved' end
  where id = p_case;
  if p_pct > v_band then
    insert into approvals(workspace_id, case_id, kind, title, payload, requested_by)
    values (c.workspace_id, p_case, 'discount', 'Discount ' || p_pct || '% on ' || c.case_no,
            jsonb_build_object('requested_pct', p_pct, 'band_pct', v_band, 'subtotal', c.subtotal,
                               'discount_amount', round(c.subtotal * p_pct / 100, 2), 'reason', p_reason), app_uid())
    returning id into v_appr;
    perform notify_role(c.workspace_id, 'client_manager', 'Discount approval needed · ' || c.case_no,
       p_pct || '% requested (band ' || v_band || '%)', '/approvals', 'warn');
    perform log_interaction(p_case, 'system', 'internal', 'Quote blocked: ' || p_pct || '% exceeds approved band of ' || v_band || '% · approval requested', p_reason);
    return jsonb_build_object('status','pending_approval','approval_id', v_appr);
  end if;
  perform log_interaction(p_case, 'system', 'internal', 'Discount set to ' || p_pct || '% (within band)', p_reason);
  return jsonb_build_object('status','approved');
end $$;

create or replace function decide_approval(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  if not has_role('client_manager') then raise exception 'Only a client approver can decide'; end if;
  select * into a from approvals where id = p_id for update;
  if a.status <> 'pending' then raise exception 'Already %', a.status; end if;
  update approvals set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = app_uid(), decided_at = now(), decision_note = p_note where id = p_id;
  perform rpc_on();
  if a.kind = 'discount' and a.case_id is not null then
    update cases set quote_status = case when p_approve then 'approved' else 'rejected' end where id = a.case_id;
    perform log_interaction(a.case_id, 'system', 'internal',
      'Discount ' || case when p_approve then 'APPROVED' else 'REJECTED' end || ' by client approver', p_note);
  elsif a.kind = 'rate_change' and p_approve then
    update services set price = (a.payload->>'new_price')::numeric, version = version + 1,
      approved_by = app_uid(), approved_at = now() where id = (a.payload->>'service_id')::uuid;
  elsif a.kind = 'template' and p_approve then
    update templates set status = 'retired' where workspace_id = a.workspace_id and code = (select code from templates where id = (a.payload->>'template_id')::uuid) and status = 'approved';
    update templates set status = 'approved', approved_by = app_uid(), approved_at = now() where id = (a.payload->>'template_id')::uuid;
  elsif a.kind = 'template' and not p_approve then
    update templates set status = 'draft' where id = (a.payload->>'template_id')::uuid;
  end if;
  perform notify_user(a.requested_by, 'Approval ' || case when p_approve then 'approved' else 'rejected' end, a.title, coalesce('/cases/' || a.case_id, '/approvals'), case when p_approve then 'ok' else 'warn' end);
end $$;

create or replace function request_rate_change(p_service uuid, p_new_price numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s record; v uuid;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed'; end if;
  select * into s from services where id = p_service;
  insert into approvals(workspace_id, kind, title, payload, requested_by)
  values (s.workspace_id, 'rate_change', 'Rate change · ' || s.name || ' ₹' || s.price || ' → ₹' || p_new_price,
          jsonb_build_object('service_id', s.id, 'old_price', s.price, 'new_price', p_new_price, 'reason', p_reason), app_uid())
  returning id into v;
  perform notify_role(s.workspace_id, 'client_manager', 'Rate-card change awaiting approval', s.name, '/approvals', 'warn');
  return v;
end $$;

create or replace function submit_template(p_template uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare t record; v uuid;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed'; end if;
  select * into t from templates where id = p_template;
  update templates set status = 'pending' where id = p_template;
  insert into approvals(workspace_id, kind, title, payload, requested_by)
  values (t.workspace_id, 'template', 'Template ' || t.code || ' v' || t.version || ' · ' || t.title,
          jsonb_build_object('template_id', t.id, 'body', t.body, 'kind', t.kind), app_uid())
  returning id into v;
  perform notify_role(t.workspace_id, 'client_manager', 'Template awaiting approval', t.title, '/approvals', 'warn');
  return v;
end $$;

create or replace function render_template(p_template uuid, p_case uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare t record; c record; p record; v text; items text;
begin
  select * into t from templates where id = p_template;
  select * into c from cases where id = p_case;
  select * into p from patients where id = c.patient_id;
  select string_agg(service_name || ' ₹' || line_total, ', ') into items from case_items where case_id = p_case;
  v := t.body;
  v := replace(v, '{{patient_name}}', coalesce(p.full_name,''));
  v := replace(v, '{{caller_name}}', coalesce(c.caller_name, p.full_name, ''));
  v := replace(v, '{{case_no}}', coalesce(c.case_no,''));
  v := replace(v, '{{services}}', coalesce(items,''));
  v := replace(v, '{{subtotal}}', coalesce(c.subtotal::text,''));
  v := replace(v, '{{discount}}', coalesce(c.discount_amount::text,'0'));
  v := replace(v, '{{total}}', coalesce(c.total::text,''));
  v := replace(v, '{{slot}}', coalesce(to_char(c.booked_slot at time zone 'Asia/Kolkata','DD Mon, HH12:MI AM'),''));
  v := replace(v, '{{brand}}', coalesce((select brand_name from workspaces where id = c.workspace_id),''));
  v := replace(v, '{{support_number}}', coalesce((select support_number from workspaces where id = c.workspace_id),''));
  return v;
end $$;

create or replace function send_quote(p_case uuid, p_template uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; t record; v_text text;
begin
  if not is_ops() and not is_service() then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case for update;
  select * into t from templates where id = p_template;
  if t.status <> 'approved' then raise exception 'Only approved templates can be sent'; end if;
  if c.stage <> 'pricing' then raise exception 'Move the case to Pricing first'; end if;
  if c.quote_status not in ('approved','sent') then raise exception 'Quote is %; approval needed before sending', c.quote_status; end if;
  if c.subtotal <= 0 then raise exception 'Add services from the rate card first'; end if;
  v_text := render_template(p_template, p_case);
  perform rpc_on();
  update cases set quote_status = 'sent', quote_sent_at = now(), quote_template_id = p_template where id = p_case;
  insert into interactions(workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, evidence, template_id)
  select c.workspace_id, c.id, c.patient_id, t.kind, 'outbound', app_uid(), coalesce(pr.agent_code, pr.full_name, 'System'),
         'Quote sent using approved template ' || t.code, v_text, 'Message copy', t.id
  from (select 1) x left join profiles pr on pr.id = app_uid();
  return jsonb_build_object('text', v_text, 'channel', t.kind, 'template', t.code, 'provider_template_name', t.provider_template_name);
end $$;

create or replace function confirm_booking(p_case uuid, p_slot timestamptz, p_coordinator uuid default null, p_template uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record; v_text text;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case;
  if c.stage <> 'booking' then raise exception 'Case must be in Booking'; end if;
  perform rpc_on();
  update cases set booked_slot = p_slot, booking_confirmed_at = now(),
    coordinator_id = coalesce(p_coordinator, coordinator_id) where id = p_case;
  if p_template is not null then v_text := render_template(p_template, p_case); end if;
  perform log_interaction(p_case, 'whatsapp', 'outbound',
    'Booking confirmed for ' || to_char(p_slot at time zone 'Asia/Kolkata','DD Mon HH24:MI') || ' · confirmation sent', v_text, 'Message copy');
  return jsonb_build_object('text', v_text);
end $$;

-- ---------- field ----------
create or replace function assign_staff(p_case uuid, p_staff uuid, p_task text, p_eta timestamptz default null, p_backup_for uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; v uuid; s record;
begin
  if not has_role('coordinator','supervisor') then raise exception 'Only coordinators assign field staff'; end if;
  select * into c from cases where id = p_case;
  select * into s from profiles where id = p_staff and role = 'field_staff';
  if not found then raise exception 'Not a field staff member'; end if;
  if p_backup_for is not null then
    update assignments set status = 'reassigned' where id = p_backup_for;
  end if;
  insert into assignments(workspace_id, case_id, staff_id, task, assigned_by, eta, window_start, window_end, backup_for)
  values (c.workspace_id, p_case, p_staff, p_task, app_uid(), p_eta,
          coalesce(c.booked_slot, now()) - interval '2 hours', coalesce(c.booked_slot, now()) + interval '4 hours', p_backup_for)
  returning id into v;
  perform log_interaction(p_case, 'field', 'internal',
    case when p_backup_for is null then 'Assigned ' else 'Backup assigned ' end || s.full_name || ' (' || p_task || ')' ||
    coalesce(' · ETA ' || to_char(p_eta at time zone 'Asia/Kolkata','HH24:MI'), ''), null);
  return v;
end $$;

create or replace function field_update(p_assignment uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; c record; pt record; v_dist int;
begin
  select * into a from assignments where id = p_assignment;
  if not (a.staff_id = app_uid() or has_role('coordinator','supervisor')) then raise exception 'Not your visit'; end if;
  select * into c from cases where id = a.case_id;
  select * into pt from patients where id = c.patient_id;
  if p_action = 'en_route' then
    update assignments set status = 'en_route', eta = coalesce(nullif(p->>'eta','')::timestamptz, eta) where id = p_assignment;
    perform log_interaction(a.case_id, 'field', 'internal', 'Technician en route' || coalesce(' · ETA ' || to_char((p->>'eta')::timestamptz at time zone 'Asia/Kolkata','HH24:MI'),''), null);
  elsif p_action = 'checkin' then
    v_dist := haversine_m(pt.lat, pt.lng, (p->>'lat')::float8, (p->>'lng')::float8);
    update assignments set status = 'checked_in', checkin_at = now(), checkin_lat = (p->>'lat')::float8,
      checkin_lng = (p->>'lng')::float8, checkin_distance_m = v_dist where id = p_assignment;
    perform log_interaction(a.case_id, 'field', 'internal', 'Geo-tagged check-in at patient address' ||
      coalesce(' · ' || v_dist || ' m from pin', ''), null, 'GPS ' || round((p->>'lat')::numeric,5) || ',' || round((p->>'lng')::numeric,5));
  elsif p_action = 'delay' then
    update assignments set delay_reason = p->>'reason', eta = coalesce(nullif(p->>'eta','')::timestamptz, eta) where id = p_assignment;
    insert into escalations(workspace_id, case_id, type, level, trigger_text, raised_by)
    values (a.workspace_id, a.case_id, 'delay', 1, 'Field delay: ' || coalesce(p->>'reason','not specified'), app_uid());
  elsif p_action = 'complete' then
    update assignments set status = 'completed', checkout_at = now(),
      checklist = coalesce(p->'checklist', checklist), patient_signoff = coalesce((p->>'signoff')::boolean, false)
    where id = p_assignment;
    if (p->'checklist'->>'consent')::boolean then
      update patients set consent_digital_at = coalesce(consent_digital_at, now()) where id = pt.id;
    end if;
    perform log_interaction(a.case_id, 'field', 'internal', 'Visit completed · ' || a.task || ' · patient sign-off ' ||
      case when (p->>'signoff')::boolean then 'yes' else 'no' end, null);
    if not exists (select 1 from assignments where case_id = a.case_id and status not in ('completed','cancelled','reassigned')) then
      perform rpc_on();
      update cases set service_completed_at = now() where id = a.case_id;
    end if;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return jsonb_build_object('ok', true, 'distance_m', v_dist);
end $$;

create or replace function upsert_sample(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; c record; v_crit boolean;
begin
  if not (is_ops() or has_role('field_staff')) then raise exception 'Not allowed'; end if;
  select * into c from cases where id = (p->>'case_id')::uuid;
  insert into samples(workspace_id, case_id, barcode, kind, collected_at)
  values (c.workspace_id, c.id, p->>'barcode', coalesce(p->>'kind','blood'), coalesce(nullif(p->>'collected_at','')::timestamptz, now()))
  on conflict (workspace_id, barcode) do update set kind = excluded.kind
  returning id into v;
  update samples set
    handover_at = coalesce(nullif(p->>'handover_at','')::timestamptz, handover_at),
    dispatched_at = coalesce(nullif(p->>'dispatched_at','')::timestamptz, dispatched_at),
    transport_temp_c = coalesce(nullif(p->>'transport_temp_c','')::numeric, transport_temp_c),
    received_at = coalesce(nullif(p->>'received_at','')::timestamptz, received_at),
    accessioned_at = coalesce(nullif(p->>'accessioned_at','')::timestamptz, accessioned_at),
    report_released_at = coalesce(nullif(p->>'report_released_at','')::timestamptz, report_released_at),
    delivered_at = coalesce(nullif(p->>'delivered_at','')::timestamptz, delivered_at),
    critical_flag = coalesce((p->>'critical_flag')::boolean, critical_flag),
    critical_note = coalesce(nullif(p->>'critical_note',''), critical_note),
    file_url = coalesce(nullif(p->>'file_url',''), file_url)
  where id = v returning critical_flag into v_crit;
  perform log_interaction(c.id, 'lab', 'internal', 'Chain of custody updated · ' || (p->>'barcode') ||
    coalesce(' · ' || (select string_agg(k, ', ') from jsonb_object_keys(p - 'case_id' - 'barcode' - 'kind') k), ''), null);
  if (p->>'critical_flag')::boolean and not exists (select 1 from escalations where case_id = c.id and type = 'clinical' and status <> 'resolved') then
    insert into escalations(workspace_id, case_id, type, level, trigger_text, raised_by)
    values (c.workspace_id, c.id, 'clinical', 1, 'Critical value on ' || (p->>'barcode') || ': ' || coalesce(p->>'critical_note',''), app_uid());
  end if;
  if nullif(p->>'report_released_at','') is not null then
    perform rpc_on(); update cases set report_status = 'released' where id = c.id and report_status = 'pending';
  end if;
  if nullif(p->>'delivered_at','') is not null then
    perform rpc_on(); update cases set report_status = 'delivered', report_delivered_at = now() where id = c.id;
  end if;
  return v;
end $$;

-- ---------- payments ----------
create or replace function refresh_payment_status(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_paid numeric; v_unrec int; c record;
begin
  select * into c from cases where id = p_case;
  select coalesce(sum(amount),0), count(*) filter (where not reconciled) into v_paid, v_unrec from payments where case_id = p_case;
  perform rpc_on();
  update cases set amount_collected = v_paid,
    payment_status = case
      when c.payment_status = 'waived' then 'waived'
      when v_paid < 0 then 'refund'
      when v_paid = 0 then 'unpaid'
      when v_paid < c.total then 'partial'
      when v_unrec = 0 then 'reconciled'
      else 'paid' end
  where id = p_case;
end $$;

create or replace function record_payment(p_case uuid, p_amount numeric, p_mode text, p_txn text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; v uuid; v_rcpt text;
begin
  if not (is_ops() or has_role('field_staff') or is_service()) then raise exception 'Not allowed'; end if;
  select * into c from cases where id = p_case;
  if p_mode = 'cash' and not coalesce((select (settings->>'allow_cash')::boolean from workspaces where id = c.workspace_id), false) then
    raise exception 'Cash collection is not enabled for this workspace';
  end if;
  v_rcpt := 'RCPT-' || replace(c.case_no, '-', '') || '-' || (select count(*) + 1 from payments where case_id = p_case);
  insert into payments(workspace_id, case_id, amount, mode, txn_ref, receipt_no, collected_by)
  values (c.workspace_id, p_case, p_amount, p_mode, p_txn, v_rcpt, app_uid()) returning id into v;
  perform refresh_payment_status(p_case);
  perform log_interaction(p_case, 'payment', 'internal', 'Payment ₹' || p_amount || ' via ' || upper(p_mode) || ' · receipt ' || v_rcpt, null, coalesce('Txn ' || p_txn, 'Receipt'));
  return v;
end $$;

create or replace function reconcile_payment(p_payment uuid, p_ok boolean, p_exception text default null) returns void
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if not (has_role('supervisor','coordinator') or is_service()) then raise exception 'Not allowed'; end if;
  update payments set reconciled = p_ok, reconciled_at = case when p_ok then now() end, reconciled_by = app_uid(),
    settled_at = coalesce(settled_at, case when p_ok then now() end), exception = case when p_ok then null else p_exception end
  where id = p_payment returning * into p;
  perform refresh_payment_status(p.case_id);
  perform log_interaction(p.case_id, 'payment', 'internal', case when p_ok then 'Payment reconciled' else 'Reconciliation exception: ' || coalesce(p_exception,'') end, null);
end $$;

create or replace function capture_feedback(p_case uuid, p_rating int, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_ops() then raise exception 'Not allowed'; end if;
  perform rpc_on();
  update cases set feedback_rating = p_rating, feedback_text = p_text where id = p_case;
  perform log_interaction(p_case, 'note', 'internal', 'Feedback captured · ' || p_rating || '/5', p_text);
end $$;

create or replace function set_report_status(p_case uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_ops() or is_service()) then raise exception 'Not allowed'; end if;
  perform rpc_on();
  update cases set report_status = p_status, report_delivered_at = case when p_status = 'delivered' then now() else report_delivered_at end where id = p_case;
  perform log_interaction(p_case, 'lab', 'outbound', 'Report ' || p_status, null);
end $$;

-- ---------- callbacks ----------
create or replace function callback_update(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_ops() then raise exception 'Not allowed'; end if;
  update callbacks set status = p_status, notes = coalesce(nullif(p_note,''), notes), attempts = attempts + case when p_status in ('in_progress','unreachable') then 1 else 0 end,
    last_attempt_at = now(), assigned_to = coalesce(assigned_to, app_uid()),
    completed_at = case when p_status in ('done','unreachable') then now() end,
    completed_by = case when p_status in ('done','unreachable') then app_uid() end
  where id = p_id;
end $$;

-- ---------- access / export log ----------
create or replace function log_access(p_action text, p_entity text default null, p_entity_id text default null, p_meta jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into access_log(workspace_id, user_id, action, entity, entity_id, meta)
  values (me_ws(), app_uid(), p_action, p_entity, p_entity_id, p_meta)
$$;

-- ---------- dashboards & MIS ----------
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
      from calls where workspace_id = v_ws and started_at between p_from and p_to),
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
                'abandon_pct', round(100.0 * count(*) filter (where status in ('abandoned','missed')) / nullif(count(*),0), 1))
              from calls where workspace_id = v_ws and started_at >= t1 and started_at < t2),
    'callbacks', (select jsonb_build_object('raised', count(*), 'done', count(*) filter (where status='done'),
                'within_sla', count(*) filter (where status='done' and completed_at <= due_at),
                'avg_minutes', round(avg(extract(epoch from (completed_at - created_at))/60)::numeric, 1))
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

create or replace function generate_mis(p_period text, p_from date, p_to date) returns uuid
language plpgsql security definer set search_path = public as $$
declare w record; v uuid;
begin
  if not is_service() then raise exception 'Service only'; end if;
  for w in select id from workspaces loop
    insert into mis_snapshots(workspace_id, period, period_start, period_end, data)
    values (w.id, p_period, p_from, p_to, mis_report(p_from, p_to, w.id))
    on conflict (workspace_id, period, period_start) do update set data = excluded.data, generated_at = now()
    returning id into v;
  end loop;
  return v;
end $$;
