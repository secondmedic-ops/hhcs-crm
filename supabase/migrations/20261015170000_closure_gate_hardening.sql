-- Closure stage gate hardening and exception escalation rules
-- Hinduja Home Care SOP Step 7 & Common Process & Case Closure Rules:
-- 1. Service completion confirmed
-- 2. Zero pending referrals
-- 3. Equipment returned / active handover (no partner deployments stuck in dispatched)
-- 4. Payment settled or waived
-- 5. Exception waiver escalation check for unpaid balance or uncompleted service

-- 1. Expand escalations table constraint & matrix to allow 'operational' and 'billing' exception types,
--    and add resolution_notes column if not present.
alter table escalations drop constraint if exists escalations_type_check;
alter table escalations add constraint escalations_type_check
  check (type in ('clinical','emergency','delay','complaint','privacy','sla','operational','billing'));

alter table escalations add column if not exists resolution_notes text;
-- Who resolved it: set by the database from the signed-in user (a closure waiver needs a senior resolver).
alter table escalations add column if not exists resolved_by uuid references profiles(id);

alter table escalation_matrix drop constraint if exists escalation_matrix_type_check;
alter table escalation_matrix add constraint escalation_matrix_type_check
  check (type in ('clinical','emergency','delay','complaint','privacy','operational','billing'));

with w as (select id from workspaces where code = 'HHC')
insert into escalation_matrix (workspace_id, type, level, owner_label, target_minutes)
select w.id, e.t, e.l, e.o, e.m from w, (values
  ('operational', 1, 'Operations Coordinator', 30),
  ('operational', 2, 'Operations Supervisor', 60),
  ('operational', 3, 'Operations Head', 120),
  ('billing',     1, 'Billing Desk / Coordinator', 30),
  ('billing',     2, 'Accounts Supervisor', 60),
  ('billing',     3, 'Finance Head', 120)
) as e(t, l, o, m)
on conflict (workspace_id, type, level) do nothing;

-- Ensure resolution_notes is synchronized with outcome upon resolution.
-- raised_by / resolved_by come from the signed-in user, never from the screen (system rows keep their own values).
create or replace function trg_escalation_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and app_uid() is not null then
    new.raised_by := app_uid();
  end if;
  if new.status = 'resolved' then
    -- the resolver is whoever last resolved it or changed the resolution text (a later edit needs fresh approval)
    if tg_op = 'INSERT' then
      new.resolved_by := app_uid();
    elsif old.status is distinct from 'resolved' or new.resolution_notes is distinct from old.resolution_notes
       or new.outcome is distinct from old.outcome then
      new.resolved_by := app_uid();
    else
      new.resolved_by := old.resolved_by;
    end if;
    if new.resolved_at is null then
      new.resolved_at := now();
    end if;
    if new.resolution_notes is null and new.outcome is not null then
      new.resolution_notes := new.outcome;
    elsif new.outcome is null and new.resolution_notes is not null then
      new.outcome := new.resolution_notes;
    end if;
  else
    new.resolved_by := null;
  end if;
  return new;
end $$;

drop trigger if exists escalation_before on escalations;
create trigger escalation_before before insert or update on escalations for each row execute function trg_escalation_before();

-- Recreate view v_escalations to expose resolution_notes
drop view if exists v_escalations;
create view v_escalations with (security_invoker = true) as
select e.*, c.case_no, p.full_name as patient_name, r.full_name as raised_by_name
from escalations e
left join cases c on c.id = e.case_id
left join patients p on p.id = c.patient_id
left join profiles r on r.id = e.raised_by;

grant select on v_escalations to caredesk_app;

-- 2. Harden case_gates(p_case)
create or replace function case_gates(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c record;
  p record;
  v_to case_stage;
  checks jsonb := '[]'::jsonb;
  v_items int;
  v_lab int;
  v_samples int;
  v_checked int;
  v_open_asg int;
  v_open_cmp int;
  v_svc_done boolean;
  v_pay_done boolean;
  v_ref_done boolean;
  v_dep_done boolean;
  v_has_esc boolean;
  v_needs_esc boolean;
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

    v_svc_done := (c.service_completed_at is not null);
    v_pay_done := (c.payment_status in ('reconciled', 'waived')) or (c.total <= c.amount_collected);
    v_ref_done := not exists (
      select 1 from case_referrals
      where case_id = p_case
        and (status in ('new', 'accepted', 'scheduled', 'dispatched') or status not in ('completed', 'declined', 'cancelled'))
    );
    v_dep_done := not exists (
      select 1 from partner_deployments
      where case_id = p_case and status = 'dispatched'
    );

    v_has_esc := exists (
      select 1 from escalations e join profiles rp on rp.id = e.resolved_by
      where e.case_id = p_case and e.status = 'resolved'
        and e.type in ('operational', 'billing')
        and e.resolution_notes is not null
        -- waiver = resolved by a supervisor / Hinduja management / administrator who did not raise it
        and rp.role in ('supervisor', 'client_manager', 'administrator')
        and e.resolved_by is distinct from e.raised_by
    );

    v_needs_esc := (not v_svc_done) or (c.total > c.amount_collected and c.payment_status not in ('reconciled', 'waived'));

    checks := jsonb_build_array(
      jsonb_build_object('label','Report delivered', 'ok', c.report_status in ('delivered','na')),
      jsonb_build_object('label','No open complaints', 'ok', v_open_cmp = 0),
      jsonb_build_object('label','Feedback captured', 'ok', c.feedback_rating is not null),
      jsonb_build_object('label','Service completion', 'ok', v_svc_done or v_has_esc),
      jsonb_build_object('label','Zero pending referrals', 'ok', v_ref_done),
      jsonb_build_object('label','Equipment returned / active handover', 'ok', v_dep_done),
      jsonb_build_object('label','Payment settled or waived', 'ok', v_pay_done or v_has_esc)
    );

    if v_needs_esc or v_has_esc then
      checks := checks || jsonb_build_array(
        jsonb_build_object('label','Pending payment/service documented & supervisor approved', 'ok', v_has_esc)
      );
    end if;
  end if;

  return jsonb_build_object('stage', c.stage, 'next', v_to, 'checks', checks,
    'ready', not exists (select 1 from jsonb_array_elements(checks) x where (x->>'ok')::boolean = false));
end $$;

-- 3. advance_case and advance_stage
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
    if v_to = 'closed' then
      raise exception 'Stage gate not met: All provider leads must be completed and payment reconciled before closure (or documented via supervisor escalation).';
    end if;
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

create or replace function advance_stage(p_case uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return advance_case(p_case, p_note);
end $$;

grant execute on function case_gates(uuid) to caredesk_app;
grant execute on function advance_case(uuid, text) to caredesk_app;
grant execute on function advance_stage(uuid, text) to caredesk_app;

-- 4. Re-run change-tracking trigger DO block for monitored tables
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename not in ('webhook_events', 'case_counters') loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;
