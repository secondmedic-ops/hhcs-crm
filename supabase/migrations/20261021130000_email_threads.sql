-- Email communication like WhatsApp chats (21 Oct 2026): one thread per patient built from the timeline's e-mail
-- entries (interactions.channel = 'email': inbound mail from Cloudflare Email Routing, services/email.ts, and replies
-- sent from the Email page, services/emailChat.ts). Same columns and role filter as v_whatsapp_chats, plus the
-- patient's e-mail address and the subject of the last message. No new table: the timeline stays the record.
drop view if exists v_email_threads;
create view v_email_threads with (security_invoker = true) as
with em as (
  select
    i.id,
    i.workspace_id,
    coalesce(i.patient_id, cs.patient_id) as patient_id,
    i.case_id,
    i.direction,
    i.actor_label,
    i.summary,
    i.body,
    i.occurred_at,
    i.meta
  from interactions i
  left join cases cs on cs.id = i.case_id
  where i.channel = 'email'
    and coalesce(i.patient_id, cs.patient_id) is not null
),
agg as (
  select
    e.workspace_id,
    e.patient_id,
    count(*)::int as message_count,
    count(*) filter (where e.direction = 'inbound')::int as inbound_count,
    count(*) filter (where e.direction = 'outbound')::int as outbound_count,
    max(e.occurred_at) as last_message_at,
    max(e.occurred_at) filter (where e.direction = 'inbound') as last_inbound_at,
    max(e.occurred_at) filter (where e.direction = 'outbound') as last_outbound_at
  from em e
  group by e.workspace_id, e.patient_id
),
latest as (
  select distinct on (e.workspace_id, e.patient_id)
    e.workspace_id,
    e.patient_id,
    e.id as last_message_id,
    e.case_id as last_case_id,
    e.direction as last_direction,
    e.actor_label as last_actor,
    coalesce(nullif(e.meta->>'subject', ''), regexp_replace(coalesce(e.summary, ''), '^Email: ', '')) as last_subject,
    coalesce(nullif(e.body, ''), e.summary) as last_body,
    coalesce(e.meta->>'delivery_status', case when e.direction = 'outbound' then 'sent' else 'received' end) as last_status
  from em e
  order by e.workspace_id, e.patient_id, e.occurred_at desc, e.id desc
)
select
  p.id,
  p.id as patient_id,
  p.workspace_id,
  p.full_name as patient_name,
  p.mrn as patient_mrn,
  p.email as patient_email,
  case when has_role('agent') then mask_mobile(p.mobile) else p.mobile end as patient_mobile,
  c.id as case_id,
  c.case_no,
  c.stage as case_stage,
  c.priority,
  c.branch,
  c.sla_state,
  c.owner_id,
  o.full_name as owner_name,
  l.last_message_id,
  a.last_message_at,
  l.last_direction,
  l.last_subject,
  l.last_body,
  l.last_actor,
  l.last_status,
  a.last_inbound_at,
  a.last_outbound_at,
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

grant select on public.v_email_threads to caredesk_app;
