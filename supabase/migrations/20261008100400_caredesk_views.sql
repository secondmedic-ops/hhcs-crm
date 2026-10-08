-- =====================================================================
-- CareDesk CRM  |  0004  Read views (security_invoker => RLS applies)
-- Agents see masked mobile numbers; everyone else sees full numbers.
-- =====================================================================

create or replace view v_cases with (security_invoker = true) as
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
  (select string_agg(i.service_name, ', ' order by i.created_at) from case_items i where i.case_id = c.id) as service_names,
  (select string_agg(distinct i.category, ',') from case_items i where i.case_id = c.id) as service_categories,
  (select min(t.due_at) from sla_timers t where t.case_id = c.id and t.status = 'running') as next_sla_due,
  (select t.policy_key from sla_timers t where t.case_id = c.id and t.status = 'running' order by t.due_at limit 1) as next_sla_key,
  (select count(*) from escalations e where e.case_id = c.id and e.status <> 'resolved') as open_escalations,
  (select count(*) from complaints k where k.case_id = c.id and k.status in ('open','acknowledged')) as open_complaints
from cases c
join patients p on p.id = c.patient_id
left join zones z on z.id = c.zone_id
left join profiles o on o.id = c.owner_id
left join profiles co on co.id = c.coordinator_id;

create or replace view v_patients with (security_invoker = true) as
select p.id, p.workspace_id, p.mrn, p.full_name, p.age, p.gender,
  case when has_role('agent') then mask_mobile(p.mobile) else p.mobile end as mobile,
  case when has_role('agent') then mask_mobile(p.alt_mobile) else p.alt_mobile end as alt_mobile,
  p.email, p.address, p.landmark, p.locality, p.pincode, p.city, p.zone_id, p.lat, p.lng,
  p.consent_verbal_at, p.consent_digital_at, p.tags, p.created_at, p.updated_at,
  z.name as zone_name,
  (select count(*) from cases c where c.patient_id = p.id) as case_count,
  (select max(c.created_at) from cases c where c.patient_id = p.id) as last_case_at,
  (select coalesce(sum(c.total),0) from cases c where c.patient_id = p.id and c.stage <> 'cancelled') as lifetime_value
from patients p left join zones z on z.id = p.zone_id;

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
  coalesce(w.settings->'did_labels'->>cl.did_number, case when cl.did_number is null then null else 'Main line' end) as line_label
from calls cl
left join workspaces w on w.id = cl.workspace_id
left join profiles pr on pr.id = cl.agent_id
left join patients p on p.id = cl.patient_id
left join cases c on c.id = cl.case_id;

create or replace view v_callbacks with (security_invoker = true) as
select cb.id, cb.workspace_id, cb.call_id, cb.reason, cb.due_at, cb.status, cb.assigned_to, cb.attempts,
  cb.last_attempt_at, cb.completed_at, cb.created_at, cb.patient_id,
  case when has_role('agent') then mask_mobile(cb.number) else cb.number end as number,
  p.full_name as patient_name, pr.full_name as assignee_name,
  (select c.id from cases c where c.patient_id = cb.patient_id and c.stage not in ('closed','cancelled') order by c.created_at desc limit 1) as open_case_id
from callbacks cb
left join patients p on p.id = cb.patient_id
left join profiles pr on pr.id = cb.assigned_to;

create or replace view v_assignments with (security_invoker = true) as
select a.*, s.full_name as staff_name, s.phone as staff_phone, c.case_no, c.booked_slot, c.priority, c.stage,
  c.address, c.pincode, p.full_name as patient_name, p.age as patient_age, p.gender as patient_gender,
  p.landmark, p.lat as patient_lat, p.lng as patient_lng, z.name as zone_name,
  (select string_agg(i.service_name, ', ') from case_items i where i.case_id = c.id) as service_names
from assignments a
join profiles s on s.id = a.staff_id
join cases c on c.id = a.case_id
join patients p on p.id = c.patient_id
left join zones z on z.id = c.zone_id;

create or replace view v_escalations with (security_invoker = true) as
select e.*, c.case_no, p.full_name as patient_name, r.full_name as raised_by_name
from escalations e
left join cases c on c.id = e.case_id
left join patients p on p.id = c.patient_id
left join profiles r on r.id = e.raised_by;

create or replace view v_approvals with (security_invoker = true) as
select a.*, c.case_no, r.full_name as requested_by_name, d.full_name as decided_by_name
from approvals a
left join cases c on c.id = a.case_id
left join profiles r on r.id = a.requested_by
left join profiles d on d.id = a.decided_by;

create or replace view v_complaints with (security_invoker = true) as
select k.*, c.case_no, p.full_name as patient_name, o.full_name as owner_name,
  (select t.due_at from sla_timers t where t.complaint_id = k.id and t.policy_key = 'complaint_resolve') as resolve_due
from complaints k
left join cases c on c.id = k.case_id
left join patients p on p.id = k.patient_id
left join profiles o on o.id = k.owner_id;

create or replace view v_audit with (security_invoker = true) as
select l.*, pr.full_name as actor_name, pr.role as actor_role
from audit_log l left join profiles pr on pr.id = l.actor_id;

create or replace view v_access with (security_invoker = true) as
select l.*, pr.full_name as user_name, pr.role as user_role
from access_log l left join profiles pr on pr.id = l.user_id;

grant select on v_cases, v_patients, v_calls, v_callbacks, v_assignments, v_escalations, v_approvals, v_complaints, v_audit, v_access to caredesk_app;
