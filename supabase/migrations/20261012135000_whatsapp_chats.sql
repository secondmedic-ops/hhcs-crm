-- =====================================================================
-- CareDesk CRM  |  WhatsApp Business (WABA) two-way chat view & templates
-- =====================================================================

-- Approved enquiry acknowledgement & address collection templates
with w as (select id from workspaces where code = 'HHC')
insert into templates (workspace_id, code, title, kind, category, body, variables, status, approved_at)
select w.id, t.code, t.title, t.kind::channel_kind, t.cat, t.body, t.vars, 'approved', now()
from w, (values
  ('T-01','Enquiry acknowledgement','whatsapp','acknowledgement',
   E'Namaste {{caller_name}}, thank you for contacting {{brand}}.\nYour enquiry is registered under Case ID *{{case_no}}*.\nOur care desk will share the rate-card estimate shortly.\nFor urgent assistance call {{support_number}}.',
   array['caller_name','brand','case_no','support_number']),
  ('T-02','Address & prescription request','whatsapp','enquiry',
   E'Namaste {{patient_name}}, regarding Case *{{case_no}}* ({{services}}):\nPlease reply to this WhatsApp message with:\n1. Complete address with landmark and pincode\n2. Preferred visit date and time slot\n3. Photo of doctor''s prescription (if applicable)\n{{brand}} · {{support_number}}',
   array['patient_name','case_no','services','brand','support_number'])
) as t(code, title, kind, cat, body, vars)
on conflict (workspace_id, code, version) do nothing;

create index if not exists idx_interactions_whatsapp on interactions(workspace_id, patient_id, occurred_at desc)
  where channel = 'whatsapp';

drop view if exists v_whatsapp_chats;
create view v_whatsapp_chats with (security_invoker = true) as
with wa as (
  select
    i.id,
    i.workspace_id,
    coalesce(i.patient_id, cs.patient_id) as patient_id,
    i.case_id,
    i.direction,
    i.actor_id,
    i.actor_label,
    i.summary,
    i.body,
    i.template_id,
    i.occurred_at,
    i.meta
  from interactions i
  left join cases cs on cs.id = i.case_id
  where i.channel = 'whatsapp'
    and coalesce(i.patient_id, cs.patient_id) is not null
),
agg as (
  select
    w.workspace_id,
    w.patient_id,
    count(*)::int as message_count,
    count(*) filter (where w.direction = 'inbound')::int as inbound_count,
    count(*) filter (where w.direction = 'outbound')::int as outbound_count,
    max(w.occurred_at) as last_message_at,
    max(w.occurred_at) filter (where w.direction = 'inbound') as last_inbound_at,
    max(w.occurred_at) filter (where w.direction = 'outbound') as last_outbound_at
  from wa w
  group by w.workspace_id, w.patient_id
),
latest as (
  select distinct on (w.workspace_id, w.patient_id)
    w.workspace_id,
    w.patient_id,
    w.id as last_message_id,
    w.case_id as last_case_id,
    w.direction as last_direction,
    w.actor_label as last_actor,
    w.summary as last_summary,
    coalesce(nullif(w.body, ''), w.summary) as last_body,
    coalesce(w.meta->>'delivery_status', case when w.direction = 'outbound' then 'sent' else 'received' end) as last_status
  from wa w
  order by w.workspace_id, w.patient_id, w.occurred_at desc, w.id desc
)
select
  p.id,
  p.id as patient_id,
  p.workspace_id,
  p.full_name as patient_name,
  p.mrn as patient_mrn,
  case when has_role('agent') then mask_mobile(p.mobile) else p.mobile end as patient_mobile,
  p.locality as patient_locality,
  p.pincode as patient_pincode,
  p.address as patient_address,
  c.id as case_id,
  c.case_no,
  c.stage as case_stage,
  c.priority,
  c.branch,
  c.services_requested,
  c.sla_state,
  c.owner_id,
  o.full_name as owner_name,
  (select min(t.due_at) from sla_timers t where t.case_id = c.id and t.status = 'running') as next_sla_due,
  (select t.policy_key from sla_timers t where t.case_id = c.id and t.status = 'running' order by t.due_at limit 1) as next_sla_key,
  l.last_message_id,
  a.last_message_at,
  l.last_direction,
  l.last_summary,
  l.last_body,
  l.last_actor,
  l.last_status,
  a.last_inbound_at,
  a.last_outbound_at,
  (a.last_inbound_at is not null and a.last_inbound_at > now() - interval '24 hours') as window_open,
  (l.last_direction = 'inbound') as needs_reply,
  a.inbound_count,
  a.outbound_count,
  a.message_count
from agg a
join latest l on l.workspace_id = a.workspace_id and l.patient_id = a.patient_id
join patients p on p.id = a.patient_id and p.workspace_id = a.workspace_id
left join lateral (
  select cs.*
  from cases cs
  where cs.patient_id = p.id
  order by (cs.id = l.last_case_id and cs.stage not in ('closed','cancelled')) desc,
           (cs.stage not in ('closed','cancelled')) desc,
           cs.created_at desc
  limit 1
) c on true
left join profiles o on o.id = c.owner_id
where has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical');

grant select on public.v_whatsapp_chats to caredesk_app;
