-- Human provider portal: one job per service unit; assigned provider field staff update only their own jobs.
alter table case_referrals add column if not exists fulfilment_managed boolean not null default false;
alter table partner_deployments add column if not exists portal_managed boolean not null default false;
alter table partner_deployments add column if not exists assigned_staff_id uuid references profiles(id);
alter table partner_deployments add column if not exists scheduled_at timestamptz;
alter table partner_deployments add column if not exists scheduled_end timestamptz;
alter table partner_deployments add column if not exists arrived_at timestamptz;
alter table partner_deployments add column if not exists completed_at timestamptz;
alter table partner_deployments add column if not exists confirmed_by text;
alter table partner_deployments add column if not exists return_confirmed_by text;
alter table partner_deployments add column if not exists return_required boolean not null default false;
alter table partner_deployments add column if not exists setup_required boolean not null default true;
alter table partner_deployments add column if not exists issue_open boolean not null default false;
alter table partner_deployments add column if not exists issue_note text;
alter table partner_deployments add column if not exists version integer not null default 1;
alter table partner_deployments drop constraint if exists partner_deployments_status_check;
alter table partner_deployments add constraint partner_deployments_status_check
 check (status in ('scheduled','dispatched','arrived','delivered','installed','active','completed','returned','cancelled'));
create index if not exists deployments_assignee on partner_deployments(workspace_id,assigned_staff_id,status);

create table if not exists provider_fulfilment_events (
 id bigint generated always as identity primary key,
 workspace_id uuid not null references workspaces(id),
 deployment_id uuid not null references partner_deployments(id),
 event_id uuid not null,
 action text not null,
 from_status text,
 to_status text not null,
 actor_id uuid not null references profiles(id),
 payload_hash text not null,
 note text,
 occurred_at timestamptz not null default now(),
 unique(deployment_id,event_id)
);
alter table provider_fulfilment_events enable row level security;
revoke all on provider_fulfilment_events from public, caredesk_app;
create unique index if not exists fulfilment_event_request on provider_fulfilment_events(workspace_id,event_id);

-- Use the existing provider_id for provider field logins, without giving them provider-manager privileges.
create or replace function trg_profile_provider() returns trigger language plpgsql as $$
begin
 if new.role = 'provider' and new.provider_id is null then raise exception 'A service-provider login needs its provider'; end if;
 if new.provider_id is not null and new.role not in ('provider','field_staff') then raise exception 'Only provider or provider field staff logins may have a provider'; end if;
 if new.provider_id is not null and not exists(select 1 from providers p where p.id=new.provider_id and p.workspace_id=new.workspace_id and p.active) then
   raise exception 'Choose an active provider in this workspace';
 end if;
 if tg_op='UPDATE' and new.provider_id is distinct from old.provider_id and not (is_service() or has_role('admin')) then
   raise exception 'Only the platform admin can change a user''s provider';
 end if;
 return new;
end $$;

create or replace function provider_portal_manage(p_referral uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from case_referrals r join providers pv on pv.id=r.provider_id
   where r.id=p_referral and r.workspace_id=me_ws() and pv.workspace_id=me_ws() and pv.code<>'SM' and (pv.active or has_role('supervisor'))
   and (has_role('supervisor') or (has_role('coordinator') and can_see_case(r.case_id))
        or (has_role('provider') and r.provider_id=me_provider())))
$$;

-- Scope minimal portal projections directly; partner field staff do not gain access to full case records.
create or replace function provider_portal_visible(p_referral uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from case_referrals r join providers pv on pv.id=r.provider_id
 where r.id=p_referral and r.workspace_id=me_ws() and pv.workspace_id=me_ws() and pv.code<>'SM'
 and (has_role('supervisor','client_manager','client_clinical','medical_desk')
   or (has_role('coordinator','agent') and can_see_case(r.case_id))
   or (has_role('provider') and r.provider_id=me_provider())
   or (has_role('field_staff') and exists(select 1 from partner_deployments d join profiles pr on pr.id=app_uid()
      where d.referral_id=r.id and d.portal_managed and d.assigned_staff_id=app_uid()
        and pr.active and pr.provider_id=r.provider_id and pr.workspace_id=r.workspace_id))))
$$;

-- A line's quantity is its agreed number of fulfilment units. Every unit needs a distinct completed job.
create or replace function provider_fulfilment_ready(p_referral uuid,p_complete boolean default false) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from case_referrals r join case_items i on i.case_id=r.case_id
     where r.id=p_referral and not i.excluded and i.category=any(r.categories))
 and not exists (
  select 1 from case_referrals r join case_items i on i.case_id=r.case_id
  where r.id=p_referral and not i.excluded and i.category=any(r.categories)
   and (select count(*) from partner_deployments d where d.referral_id=r.id and d.case_item_id=i.id
      and d.portal_managed and not d.issue_open
      and case when p_complete then d.status='returned' or (d.status='completed' and not d.return_required)
               else d.status in ('installed','active','completed','returned') end) <> i.qty
 ) and not exists (
  select 1 from partner_deployments d join case_items i on i.id=d.case_item_id
  where d.referral_id=p_referral and d.portal_managed and d.status<>'cancelled'
    and (d.issue_open or (i.excluded and not (d.status='returned' or (d.status='completed' and not d.return_required)))))
$$;

create or replace function provider_job_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare r case_referrals;
begin
 select * into r from case_referrals where id=new.referral_id;
 if (new.portal_managed or (tg_op='UPDATE' and old.portal_managed) or r.fulfilment_managed)
    and current_setting('app.provider_job',true) is distinct from new.id::text then
   raise exception 'Use the provider fulfilment workflow for managed work orders';
 end if;
 return new;
end $$;
drop trigger if exists provider_job_guard on partner_deployments;
create trigger provider_job_guard before insert or update on partner_deployments for each row execute function provider_job_guard();

create or replace function provider_referral_guard() returns trigger
language plpgsql security definer set search_path=public as $$
declare c cases;
begin
 if not new.fulfilment_managed then return new; end if;
 select * into c from cases where id=new.case_id;
 if new.status in ('scheduled','dispatched','in_progress','completed') then
   if c.stage='cancelled' or (c.care_type='post_discharge' and c.signoff_at is null) then raise exception 'Current family sign-off is required; this lead is on hold'; end if;
   if new.status='completed' and not provider_fulfilment_ready(new.id,true) then
     raise exception 'Complete every included service unit, resolve issues and confirm required returns first';
   end if;
 end if;
 return new;
end $$;
drop trigger if exists provider_referral_guard on case_referrals;
create trigger provider_referral_guard before update on case_referrals for each row execute function provider_referral_guard();

create or replace function provider_portal(p_referral uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
 if not has_role('provider','field_staff','supervisor','coordinator','agent','client_manager','client_clinical','medical_desk') then raise exception 'Not allowed for your role'; end if;
 if p_referral is not null and not provider_portal_visible(p_referral) then raise exception 'Lead not found'; end if;
 with refs as (
  select r.*, c.case_no,c.patient_id,c.address,c.pincode,c.stage,c.signoff_at,c.care_type,c.coordinator_id,pv.active provider_active,pv.name provider_name
  from case_referrals r join cases c on c.id=r.case_id join providers pv on pv.id=r.provider_id
  where r.workspace_id=me_ws() and provider_portal_visible(r.id) and (p_referral is null or r.id=p_referral)
  order by r.updated_at desc,r.id limit 100
 ), jobs as (
  select d.*,i.service_name,i.unit,pr.full_name assigned_name,r.case_no,r.provider_name,r.provider_id,pt.full_name patient_name,r.address,r.pincode,
    (not r.provider_active or r.stage in ('closed','cancelled') or r.status in ('declined','cancelled') or i.excluded or (r.care_type='post_discharge' and r.signoff_at is null)) on_hold,
    provider_portal_manage(r.id) can_manage
  from refs r join partner_deployments d on d.referral_id=r.id
   join case_items i on i.id=d.case_item_id join patients pt on pt.id=r.patient_id
   left join profiles pr on pr.id=d.assigned_staff_id
  where d.portal_managed and (not has_role('field_staff') or d.assigned_staff_id=app_uid())
 )
 select jsonb_build_object(
 'leads',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'case_id',r.case_id,'case_no',r.case_no,
  'provider_name',r.provider_name,'provider_id',r.provider_id,'status',r.status,'scheduled_at',r.scheduled_at,
  'patient_name',pt.full_name,'can_manage',provider_portal_manage(r.id),
  'on_hold',not r.provider_active or r.stage in ('closed','cancelled') or r.status in ('declined','cancelled') or (r.care_type='post_discharge' and r.signoff_at is null),
  'required',(select coalesce(sum(i.qty),0) from case_items i where i.case_id=r.case_id and not i.excluded and i.category=any(r.categories)),
  'completed',(select count(*) from partner_deployments d where d.referral_id=r.id and d.portal_managed and not d.issue_open and (d.status='returned' or (d.status='completed' and not d.return_required))),
  'items',case when has_role('field_staff') then '[]'::jsonb else
    (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.service_name,'qty',i.qty,'unit',coalesce(i.unit,s.unit),'category',i.category,
      'planned',(select count(*) from partner_deployments d where d.referral_id=r.id and d.case_item_id=i.id and d.portal_managed and d.status<>'cancelled')) order by i.created_at),
      '[]'::jsonb) from case_items i join services s on s.id=i.service_id where i.case_id=r.case_id and not i.excluded and i.category=any(r.categories)) end)
   order by r.updated_at desc) from refs r join patients pt on pt.id=r.patient_id),'[]'::jsonb),
 'jobs',coalesce((select jsonb_agg(to_jsonb(j) order by j.scheduled_at,j.id) from (select * from jobs order by scheduled_at,id limit 500) j),'[]'::jsonb),
 'staff',case when has_role('field_staff') then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'provider_id',p.provider_id) order by p.full_name)
  from profiles p where p.workspace_id=me_ws() and p.active and p.role='field_staff' and exists(select 1 from refs r where r.provider_id=p.provider_id and provider_portal_manage(r.id))),'[]'::jsonb) end,
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at desc,e.id desc) from
    (select ev.id,ev.deployment_id,ev.action,ev.from_status,ev.to_status,ev.note,ev.occurred_at,p.full_name actor_name
       from provider_fulfilment_events ev join jobs j on j.id=ev.deployment_id join profiles p on p.id=ev.actor_id
       order by ev.occurred_at desc,ev.id desc limit 200) e),'[]'::jsonb),
 'job_count',(select count(*) from jobs),'lead_limit',100) into v;
 return v;
end $$;

create or replace function plan_provider_job(p_referral uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r case_referrals;c cases;i case_items;pr profiles;ev provider_fulfilment_events;v_request uuid:=(p->>'request_id')::uuid;v_id uuid:=gen_random_uuid();v_type text:=p->>'resource_type';v_when timestamptz;v_end timestamptz;v_n int;
begin
 if not provider_portal_manage(p_referral) then raise exception 'Not allowed for your role'; end if;
 if jsonb_typeof(p) is distinct from 'object' or v_request is null then raise exception 'Request ID and a work-order object are required'; end if;
 select * into r from case_referrals where id=p_referral;
 select * into c from cases where id=r.case_id for update;
 select * into r from case_referrals where id=p_referral for update;
 select * into ev from provider_fulfilment_events where workspace_id=me_ws() and event_id=v_request;
 if ev.id is not null then
  if ev.action<>'planned' or ev.payload_hash<>md5(p::text) or not exists(select 1 from partner_deployments d where d.id=ev.deployment_id and d.referral_id=r.id) then
   raise exception 'Request ID already used with different data' using errcode='23505';
  end if;
  return (select jsonb_build_object('id',id,'version',version,'duplicate',true) from partner_deployments where id=ev.deployment_id);
 end if;
 if not exists(select 1 from providers where id=r.provider_id and active) or c.stage in ('closed','cancelled') or r.status not in ('accepted','scheduled','dispatched','in_progress') then raise exception 'Accept an active lead before planning fulfilment'; end if;
 if c.care_type='post_discharge' and c.signoff_at is null then raise exception 'Record the family sign-off first'; end if;
 select * into i from case_items where id=(p->>'case_item_id')::uuid and case_id=c.id and not excluded and category=any(r.categories);
 if i.id is null then raise exception 'Choose an included service on this provider lead'; end if;
 if v_type not in ('staff','equipment') or v_type is null then raise exception 'Choose staff or equipment'; end if;
 if (i.category in ('nursing','physio','eldercare') and v_type<>'staff')
    or (i.category in ('beds','equipment','consumables') and v_type<>'equipment') then raise exception 'Choose the resource type matching this service'; end if;
 v_when:=(p->>'scheduled_at')::timestamptz;v_end:=nullif(p->>'scheduled_end','')::timestamptz;
 if v_when is null or (v_end is not null and v_end<=v_when) then raise exception 'Choose a valid scheduled window'; end if;
 if v_type='staff' and v_end is null then raise exception 'Set the shift or visit end time'; end if;
 if nullif(p->>'assigned_staff_id','') is not null then
  select * into pr from profiles where id=(p->>'assigned_staff_id')::uuid and workspace_id=c.workspace_id and role='field_staff' and active and provider_id=r.provider_id for update;
  if pr.id is null then raise exception 'Choose active field staff from this provider'; end if;
 end if;
 if pr.id is not null and exists(select 1 from partner_deployments d where d.assigned_staff_id=pr.id and d.portal_managed
   and d.resource_type='staff' and v_type='staff' and d.status not in ('completed','returned','cancelled')
   and tstzrange(d.scheduled_at,d.scheduled_end,'[)') && tstzrange(v_when,v_end,'[)')) then raise exception 'This staff member already has an overlapping shift'; end if;
 select count(*) into v_n from partner_deployments where referral_id=r.id and case_item_id=i.id and status<>'cancelled';
 if v_n>=i.qty then raise exception 'Every agreed unit already has a work order'; end if;
 update case_referrals set fulfilment_managed=true where id=r.id;
 perform set_config('app.provider_job',v_id::text,true);
 insert into partner_deployments(id,workspace_id,case_id,referral_id,case_item_id,resource_type,status,portal_managed,assigned_staff_id,
  scheduled_at,scheduled_end,return_required,setup_required,equipment_model,staff_name,staff_ref,created_by)
 values(v_id,c.workspace_id,c.id,r.id,i.id,v_type,'scheduled',true,pr.id,v_when,v_end,
   v_type='equipment' and coalesce((p->>'return_required')::boolean,true),v_type='equipment' and coalesce((p->>'setup_required')::boolean,i.category<>'consumables'),left(p->>'equipment_model',200),pr.full_name,pr.id::text,app_uid());
 insert into provider_fulfilment_events(workspace_id,deployment_id,event_id,action,to_status,actor_id,payload_hash)
 values(c.workspace_id,v_id,v_request,'planned','scheduled',app_uid(),md5(p::text));
 if r.status='accepted' then perform update_referral(r.id,'scheduled',null,v_when); end if;
 if pr.id is not null then perform notify_user(pr.id,'New fulfilment job '||c.case_no,i.service_name,'/fulfilment','info'); end if;
 return jsonb_build_object('id',v_id,'version',1);
end $$;

create or replace function update_provider_job(p_id uuid,p_event uuid,p_version int,p_action text,p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare d partner_deployments;r case_referrals;c cases;i case_items;ev provider_fulfilment_events;pr profiles;
 v_manage boolean;v_to text;v_when timestamptz;v_end timestamptz;v_hash text:=md5(jsonb_build_object('version',p_version,'action',p_action,'p',p)::text);v_aggregate text;v_result jsonb;
begin
 if jsonb_typeof(p) is distinct from 'object' or p_event is null or p_version is null then raise exception 'Event ID and current job version are required'; end if;
 select * into d from partner_deployments where id=p_id and workspace_id=me_ws() and portal_managed;
 if d.id is null or not provider_portal_visible(d.referral_id) or (has_role('field_staff') and d.assigned_staff_id is distinct from app_uid()) then raise exception 'Job not found'; end if;
 select * into c from cases where id=d.case_id for update;
 select * into r from case_referrals where id=d.referral_id for update;
 select * into d from partner_deployments where id=p_id for update;
 v_manage:=provider_portal_manage(r.id);
 if not(v_manage or (has_role('field_staff') and d.assigned_staff_id=app_uid()
   and exists(select 1 from profiles actor_profile where actor_profile.id=app_uid() and actor_profile.active and actor_profile.provider_id=r.provider_id and actor_profile.workspace_id=r.workspace_id))) then raise exception 'Only assigned field staff or the provider manager can update this job'; end if;
 select * into ev from provider_fulfilment_events where deployment_id=p_id and event_id=p_event;
 if ev.id is not null then
  if ev.payload_hash<>v_hash then raise exception 'Event ID already used with different data' using errcode='23505'; end if;
  return jsonb_build_object('id',d.id,'version',d.version,'status',d.status,'duplicate',true);
 end if;
 if d.version<>p_version then raise exception 'Job changed; reload before updating' using errcode='23505'; end if;
 if length(coalesce(p->>'note',''))>2000 or length(coalesce(p->>'confirmed_by',''))>200 or length(coalesce(p->>'equipment_serial',''))>200 then raise exception 'Note or confirmation is too long'; end if;
 select * into i from case_items where id=d.case_item_id;
 if p_action not in ('returned','cancelled','report_issue','resolve_issue') and
   (not exists(select 1 from providers where id=r.provider_id and active) or c.stage in ('closed','cancelled') or r.status in ('cancelled','declined','completed') or i.excluded or (c.care_type='post_discharge' and c.signoff_at is null)) then raise exception 'This job is on hold or the case is closed'; end if;
 v_to:=d.status;
 if p_action='assign' then
  if not v_manage or d.status<>'scheduled' then raise exception 'Only a manager can assign a scheduled job'; end if;
  select * into pr from profiles where id=(p->>'assigned_staff_id')::uuid and workspace_id=r.workspace_id and provider_id=r.provider_id and role='field_staff' and active for update;
  if pr.id is null then raise exception 'Choose active field staff from this provider'; end if;
  if d.resource_type='staff' and exists(select 1 from partner_deployments x where x.id<>d.id and x.assigned_staff_id=pr.id and x.portal_managed
    and x.resource_type='staff' and x.status not in ('completed','returned','cancelled')
    and tstzrange(x.scheduled_at,x.scheduled_end,'[)') && tstzrange(d.scheduled_at,d.scheduled_end,'[)')) then raise exception 'This staff member already has an overlapping shift'; end if;
 elsif p_action='reschedule' then
  if not v_manage or d.status<>'scheduled' then raise exception 'Only a manager can reschedule a planned job'; end if;
  v_when:=(p->>'scheduled_at')::timestamptz;v_end:=nullif(p->>'scheduled_end','')::timestamptz;
  if v_when is null or (v_end is not null and v_end<=v_when) or (d.resource_type='staff' and v_end is null) then raise exception 'Choose a valid scheduled window'; end if;
  if d.assigned_staff_id is not null then perform 1 from profiles where id=d.assigned_staff_id for update; end if;
  if d.resource_type='staff' and exists(select 1 from partner_deployments x where x.id<>d.id and x.portal_managed and x.assigned_staff_id=d.assigned_staff_id
    and x.resource_type='staff' and x.status not in ('completed','returned','cancelled')
    and tstzrange(x.scheduled_at,x.scheduled_end,'[)') && tstzrange(v_when,v_end,'[)')) then raise exception 'This staff member already has an overlapping shift'; end if;
 elsif p_action in ('report_issue','resolve_issue') then
  if p_action='resolve_issue' and not v_manage then raise exception 'A manager must resolve the issue'; end if;
  if nullif(trim(p->>'note'),'') is null then raise exception 'Record the problem or its resolution'; end if;
 elsif p_action='cancelled' then
  if not v_manage or nullif(trim(p->>'note'),'') is null or d.status in ('completed','returned','cancelled') then raise exception 'Manager cancellation needs a reason and an open work order'; end if;
  if d.resource_type='equipment' and d.status not in ('scheduled','dispatched') then raise exception 'Confirm physical equipment return instead of cancelling delivered equipment'; end if;
  if d.status not in ('scheduled','dispatched') and (nullif(trim(p->>'confirmed_by'),'') is null or not coalesce((p->>'handover_confirmed')::boolean,false)) then raise exception 'Confirm safe handover before stopping active care'; end if;
  v_to:='cancelled';
 else
  if not exists(select 1 from profiles worker where worker.id=d.assigned_staff_id and worker.active and worker.role='field_staff' and worker.provider_id=r.provider_id and worker.workspace_id=r.workspace_id) and not (p_action='returned' and v_manage) then raise exception 'Assign field staff from this provider with an active login before dispatch'; end if;
  if d.issue_open then raise exception 'Resolve the reported issue before continuing'; end if;
  if not ((p_action='returned' and d.resource_type='equipment' and d.return_required and (c.stage='cancelled' or r.status='cancelled' or i.excluded) and d.status in ('delivered','installed','active')) or case d.status when 'scheduled' then p_action='dispatched'
     when 'dispatched' then p_action=case when d.resource_type='staff' then 'arrived' else 'delivered' end
     when 'arrived' then p_action='active' when 'delivered' then p_action=case when d.setup_required then 'installed' when d.return_required then 'active' else 'completed' end
     when 'installed' then p_action='active' when 'active' then p_action='completed'
     when 'completed' then d.return_required and p_action='returned' else false end) then raise exception 'That work-order transition is not allowed'; end if;
  if d.resource_type='equipment' and p_action='delivered' and nullif(trim(coalesce(p->>'equipment_serial',d.equipment_serial)),'') is null then raise exception 'Record the equipment serial number at delivery'; end if;
  if p_action in ('completed','returned') and (nullif(trim(p->>'confirmed_by'),'') is null or not coalesce((p->>'handover_confirmed')::boolean,false)) then raise exception 'Record recipient confirmation and completed handover'; end if;
  if p_action='completed' and d.scheduled_end>now() then raise exception 'The scheduled service period has not ended'; end if;
  v_to:=p_action;
 end if;
 perform set_config('app.provider_job',d.id::text,true);
 update partner_deployments set status=v_to,version=version+1,updated_at=now(),
  scheduled_at=case when p_action='reschedule' then v_when else scheduled_at end,scheduled_end=case when p_action='reschedule' then v_end else scheduled_end end,
  assigned_staff_id=case when p_action='assign' then pr.id else assigned_staff_id end,
  staff_name=case when p_action='assign' and resource_type='staff' then pr.full_name else staff_name end,
  staff_ref=case when p_action='assign' and resource_type='staff' then pr.id::text else staff_ref end,
  issue_open=case p_action when 'report_issue' then true when 'resolve_issue' then false else issue_open end,
  issue_note=case when p_action in ('report_issue','resolve_issue') then trim(p->>'note') else issue_note end,
  note=coalesce(nullif(trim(p->>'note'),''),note),
  equipment_serial=case when p_action='delivered' then coalesce(nullif(trim(p->>'equipment_serial'),''),equipment_serial) else equipment_serial end,
  confirmed_by=case when p_action='completed' or (p_action='cancelled' and d.status not in ('scheduled','dispatched')) then trim(p->>'confirmed_by') else confirmed_by end,
  return_confirmed_by=case when p_action='returned' then trim(p->>'confirmed_by') else return_confirmed_by end,
  dispatched_at=case when p_action='dispatched' then now() else dispatched_at end,
  arrived_at=case when p_action in ('arrived','delivered') then now() else arrived_at end,
  delivered_at=case when p_action='delivered' then now() else delivered_at end,
  installed_at=case when p_action='installed' then now() else installed_at end,
  active_from=case when p_action='active' then now() else active_from end,
  completed_at=case when p_action='completed' then now() else completed_at end,
  ended_at=case when p_action in ('returned','cancelled') or (p_action='completed' and not return_required) then now() else ended_at end
 where id=d.id;
 insert into provider_fulfilment_events(workspace_id,deployment_id,event_id,action,from_status,to_status,actor_id,payload_hash,note)
 values(r.workspace_id,d.id,p_event,p_action,d.status,v_to,app_uid(),v_hash,nullif(trim(p->>'note'),''));
 perform log_interaction(r.case_id,'system','internal','Provider fulfilment: '||p_action,nullif(trim(p->>'note'),''),null,
   jsonb_build_object('referral_id',r.id,'deployment_id',d.id,'status',v_to));
 if p_action='report_issue' then
  perform notify_role(r.workspace_id,'supervisor','Fulfilment issue '||c.case_no,'Review the provider job','/fulfilment','warn');
 end if;
 if p_action='assign' then perform notify_user(pr.id,'Fulfilment job assigned '||c.case_no,i.service_name,'/fulfilment','info'); end if;
 if c.coordinator_id is not null then perform notify_user(c.coordinator_id,'Provider progress '||c.case_no,p_action,'/fulfilment',case when p_action='report_issue' then 'warn' else 'info' end); end if;
 if c.stage not in ('closed','cancelled') and r.status not in ('completed','declined','cancelled') and p_action not in ('assign','reschedule','report_issue','cancelled') then
  v_aggregate:=case when provider_fulfilment_ready(r.id,true) then 'completed'
    when exists(select 1 from partner_deployments x where x.referral_id=r.id and x.portal_managed and x.status in ('active','completed','returned')) then 'in_progress'
    when exists(select 1 from partner_deployments x where x.referral_id=r.id and x.portal_managed and x.status in ('dispatched','arrived','delivered','installed')) then 'dispatched'
    else 'scheduled' end;
  -- Keep the shared lead workflow; a checked task context permits only this field-staff aggregation.
  if v_aggregate<>r.status or (v_aggregate='in_progress' and provider_fulfilment_ready(r.id,false)) then
    perform update_referral(r.id,v_aggregate,null,null);
  end if;
 end if;
 select jsonb_build_object('id',id,'version',version,'status',status,'duplicate',false) into v_result from partner_deployments where id=d.id;
 return v_result;
end $$;

-- The event ledger is business history, not an audit payload carrying patient or recipient names.
revoke all on function provider_portal_manage(uuid),provider_portal_visible(uuid),provider_fulfilment_ready(uuid,boolean),
 provider_job_guard(),provider_referral_guard(),provider_portal(uuid),plan_provider_job(uuid,jsonb),
 update_provider_job(uuid,uuid,integer,text,jsonb) from public;
grant execute on function provider_portal(uuid),plan_provider_job(uuid,jsonb),update_provider_job(uuid,uuid,integer,text,jsonb) to caredesk_app;
do $$ declare t text; begin
 for t in select tablename from pg_tables where schemaname='public' and tablename not in ('webhook_events','case_counters') loop
  execute format('drop trigger if exists zz_note_change on public.%I',t);
  execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()',t);
 end loop;
end $$;
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
          or (has_role('coordinator') and (pv.code = 'SM' or (r.fulfilment_managed and can_see_case(r.case_id))))
          or (has_role('field_staff') and r.fulfilment_managed and p_status in ('dispatched','in_progress','completed')
              and exists(select 1 from partner_deployments d join profiles pr on pr.id=app_uid()
                where d.referral_id=r.id and d.id::text=current_setting('app.provider_job',true)
                  and d.portal_managed and d.assigned_staff_id=app_uid() and pr.active and pr.provider_id=r.provider_id))) then
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
       select 1 from case_referrals x where x.case_id = r.case_id and (x.status not in ('in_progress','completed','declined','cancelled') or (x.fulfilment_managed and not provider_fulfilment_ready(x.id,false)))) then
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
  if v_open = 0 and v_done > 0 and v_sm = 0 and c.stage not in ('closed','cancelled') and not exists(select 1 from case_referrals x where x.case_id=r.case_id and x.fulfilment_managed and x.status='declined') then
    perform rpc_on();
    update cases set stage = 'closed', closed_at = now(), closed_by = app_uid(), service_completed_at = coalesce(service_completed_at, now()),
      sla_state = 'ok' where id = r.case_id;
    insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note)
    values (r.case_id, c.stage, 'closed', app_uid(), 'All provider services completed');
    perform log_interaction(r.case_id, 'system', 'internal', 'Case closed: all provider services completed', null);
  end if;
  return (select to_jsonb(x) from case_referrals x where id = p_id);
end $$;




-- All closure paths, including ordinary stage advancement, share the same managed-unit guard.
create or replace function provider_case_close_guard() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.stage='closed' and old.stage<>'closed' and (
   exists(select 1 from case_referrals r where r.case_id=new.id and r.fulfilment_managed and r.status<>'cancelled' and not provider_fulfilment_ready(r.id,true))
   or exists(select 1 from partner_deployments d where d.case_id=new.id and d.portal_managed and
      (d.issue_open or d.status not in ('completed','returned','cancelled') or (d.return_required and d.status='completed')))) then
  raise exception 'Provider fulfilment is incomplete: complete every unit and required return before case closure';
 end if;
 return new;
end $$;
drop trigger if exists provider_case_close_guard on cases;
create trigger provider_case_close_guard before update of stage on cases for each row execute function provider_case_close_guard();
revoke all on function provider_case_close_guard() from public;


-- Keep audit records identifier-only for physical work orders, including recipient and progress-note edits.
create or replace function provider_deployment_audit() returns trigger
language plpgsql security definer set search_path=public as $$
declare v jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
 insert into audit_log(workspace_id,table_name,record_id,action,changes,actor_id)
 values((v->>'workspace_id')::uuid,'partner_deployments',(v->>'id')::uuid,lower(tg_op),
   jsonb_build_object('referral_id',v->'referral_id','status',v->'status','version',v->'version'),app_uid());
 return case when tg_op='DELETE' then old else new end;
end $$;
drop trigger if exists audit_partner_deployments on partner_deployments;
create trigger audit_partner_deployments after insert or update or delete on partner_deployments for each row execute function provider_deployment_audit();
revoke all on function provider_deployment_audit() from public;

-- Append the new flag without changing any existing view-column order.
do $$
declare v_def text;
begin
 if not exists(select 1 from pg_attribute where attrelid='v_referrals'::regclass and attname='fulfilment_managed' and not attisdropped) then
  v_def:=rtrim(trim(pg_get_viewdef('v_referrals'::regclass,true)),';');
  execute 'create or replace view v_referrals with (security_invoker=true) as select previous.*, r.fulfilment_managed from ('||v_def||') previous join case_referrals r on r.id=previous.id';
 end if;
end $$;
grant select on v_referrals to caredesk_app;

-- Enter the managed lifecycle at human-portal acceptance, before the first job is planned.
create or replace function accept_provider_lead(p_id uuid,p_note text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r case_referrals;c cases;
begin
 if not provider_portal_manage(p_id) then raise exception 'Not allowed for your role'; end if;
 select * into r from case_referrals where id=p_id;
 select * into c from cases where id=r.case_id for update;
 select * into r from case_referrals where id=p_id for update;
 if c.stage in ('closed','cancelled') or (c.care_type='post_discharge' and c.signoff_at is null) then raise exception 'This lead is on hold'; end if;
 if r.status<>'new' then raise exception 'Lead changed; reload before accepting' using errcode='23505'; end if;
 update case_referrals set fulfilment_managed=true where id=r.id;
 return update_referral(r.id,'accepted',p_note,null);
end $$;
revoke all on function accept_provider_lead(uuid,text) from public;
grant execute on function accept_provider_lead(uuid,text) to caredesk_app;
