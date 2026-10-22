-- Customer-confirmed: retain separate call and delivered-service feedback, and accept direct message replies.
alter table feedback_requests add column if not exists experience text not null default 'call' check (experience in ('call','service'));
alter table feedback_requests alter column call_id drop not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='feedback_experience_reference') then
    alter table feedback_requests add constraint feedback_experience_reference check (
      (experience='call' and call_id is not null) or (experience='service' and case_id is not null and call_id is null));
  end if;
end $$;
create unique index if not exists feedback_service_once on feedback_requests(case_id) where experience='service';
alter table feedback_responses add column if not exists source_channel text not null default 'form' check (source_channel in ('form','email','whatsapp'));
alter table feedback_responses add column if not exists source_message_id text;
create unique index if not exists feedback_message_once on feedback_responses(source_channel,source_message_id) where source_message_id is not null;

create or replace function request_service_feedback(p_case uuid) returns void
language plpgsql security definer set search_path=public as $$
declare c cases;
begin
  select * into c from cases where id=p_case;
  if c.id is null or c.service_completed_at is null or c.stage='cancelled'
    or exists(select 1 from case_referrals where case_id=c.id and status not in ('completed','declined','cancelled'))
    or exists(select 1 from assignments where case_id=c.id and status not in ('completed','cancelled','reassigned')) then return; end if;
  insert into feedback_requests(workspace_id,patient_id,case_id,experience,expires_at)
    values(c.workspace_id,c.patient_id,c.id,'service',now()+make_interval(hours=>feedback_expiry_hours(c.workspace_id)))
    on conflict do nothing;
end $$;
revoke all on function request_service_feedback(uuid) from public,caredesk_app;
create or replace function service_feedback_completed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_table_name='cases' then perform request_service_feedback(new.id);
  else perform request_service_feedback(new.case_id); end if;
  return new;
end $$;
revoke all on function service_feedback_completed() from public,caredesk_app;
drop trigger if exists service_feedback_request on cases;
create trigger service_feedback_request after update of service_completed_at,stage on cases for each row execute function service_feedback_completed();
drop trigger if exists referral_service_feedback_request on case_referrals;
create trigger referral_service_feedback_request after update of status on case_referrals for each row execute function service_feedback_completed();

drop policy if exists feedback_requests_read on feedback_requests;
create policy feedback_requests_read on feedback_requests for select using (
  workspace_id=me_ws() and has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical')
  and (experience='service' or exists(select 1 from calls c where c.id=call_id))
  and (case_id is null or can_see_case(case_id)) and exists(select 1 from patients p where p.id=patient_id)
);
create or replace view v_customer_feedback with (security_invoker=true) as
select r.id,r.workspace_id,r.patient_id,p.full_name as patient_name,p.mrn,
  r.call_id,r.case_id,c.case_no,r.channel,r.status,r.requested_at,r.expires_at,
  r.delivery_status,r.delivery_error,f.rating,f.comment,f.submitted_at,
  coalesce(cl.started_at,c.service_completed_at) as call_started_at,r.experience,f.source_channel
from feedback_requests r join patients p on p.id=r.patient_id
left join calls cl on cl.id=r.call_id left join cases c on c.id=r.case_id
left join feedback_responses f on f.request_id=r.id;

create or replace function feedback_issue_link(p_request uuid,p_hash text) returns timestamptz
language plpgsql security definer set search_path=public as $$
declare r feedback_requests; v_expiry timestamptz;
begin
  if not has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical') then raise exception 'Not allowed'; end if;
  select * into r from feedback_requests where id=p_request for update;
  if not found or r.workspace_id is distinct from me_ws() or (r.case_id is not null and not can_see_case(r.case_id))
    or (r.experience='call' and not exists(select 1 from calls c where c.id=r.call_id and c.workspace_id=me_ws()
      and (has_role('coordinator','supervisor','medical_desk','client_manager','client_clinical') or c.agent_id=app_uid() or c.agent_id is null)))
    then raise exception 'Feedback request not found'; end if;
  if r.status='submitted' then raise exception 'Feedback has already been submitted'; end if;
  if r.delivery_status='sending' then raise exception 'Email is being sent. Try again later'; end if;
  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid link'; end if;
  v_expiry:=now()+make_interval(hours=>feedback_expiry_hours(r.workspace_id));
  update feedback_requests set token_hash=p_hash,expires_at=v_expiry,channel='manual',delivery_status='manual',delivery_error=null where id=r.id;
  return v_expiry;
end $$;

create or replace function customer_feedback_summary() returns jsonb
language sql stable security invoker set search_path=public as $$
  select jsonb_build_object('responses',count(*) filter(where r.experience='call'),
    'average',round(avg(f.rating) filter(where r.experience='call'),2),
    'service',jsonb_build_object('responses',count(*) filter(where r.experience='service'),'average',round(avg(f.rating) filter(where r.experience='service'),2)))
  from feedback_responses f join feedback_requests r on r.id=f.request_id
$$;

create or replace function feedback_email_claim() returns jsonb
language plpgsql set search_path=public as $$
declare r record; v_token text;
begin
  if not is_service() then raise exception 'System only'; end if;
  update feedback_requests set delivery_status='unknown',delivery_error='Email outcome unconfirmed'
    where delivery_status='sending' and delivery_attempted_at<now()-interval '15 minutes';
  select q.id,p.email,q.experience,w.settings->>'feedback_reply_to' as reply_to into r from feedback_requests q join patients p on p.id=q.patient_id join workspaces w on w.id=q.workspace_id
    where q.status='pending' and q.token_hash is null and q.expires_at>now() and q.delivery_status='unconfigured'
      and coalesce(w.settings->>'feedback_auto_email','true')='true' and p.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    order by q.requested_at limit 1 for update of q skip locked;
  if not found then return null; end if;
  v_token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
  update feedback_requests set token_hash=encode(sha256(convert_to(v_token,'UTF8')),'hex'),channel='email',delivery_status='sending',delivery_attempted_at=now() where id=r.id;
  return jsonb_build_object('id',r.id,'email',r.email,'token',v_token,'experience',r.experience,'reply_to',r.reply_to);
end $$;
revoke all on function feedback_email_claim() from public,caredesk_app;

-- Called only by authenticated provider webhooks / the Worker's email handler. Never exposed as a user RPC.
create or replace function receive_feedback_reply(p_workspace uuid,p_channel text,p_sender text,p_reference uuid,p_hash text,p_rating integer,p_comment text,p_message_id text) returns jsonb
language plpgsql set search_path=public as $$
declare r feedback_requests; v_ids uuid[]; v_reason text;
begin
  if not is_service() then raise exception 'System only'; end if;
  if p_channel not in ('email','whatsapp') or coalesce(p_sender,'')='' then return jsonb_build_object('handled',false); end if;
  select array_agg(q.id) into v_ids from feedback_requests q join patients p on p.id=q.patient_id
    where q.workspace_id=p_workspace
      and ((p_channel='email' and lower(p.email)=lower(p_sender)) or (p_channel='whatsapp' and p.mobile=p_sender))
      and ((p_reference is not null and q.id=p_reference)
        or (p_reference is null and p_channel='email' and q.token_hash=p_hash)
        or (p_reference is null and p_channel='whatsapp' and q.status='pending' and q.expires_at>now()));
  if coalesce(cardinality(v_ids),0)<>1 then return jsonb_build_object('handled',false); end if;
  select * into r from feedback_requests where id=v_ids[1] for update;
  if r.status='submitted' then return jsonb_build_object('handled',true,'status','already_submitted'); end if;
  if r.expires_at<=now() then v_reason:='expired';
  elsif p_channel='email' and (p_hash is null or p_hash is distinct from r.token_hash) then v_reason:='unverified';
  elsif p_rating is null or p_rating not between 1 and 5 or length(coalesce(p_comment,''))>2000 then v_reason:='needs_rating';
  end if;
  if v_reason is null then
    insert into feedback_responses(request_id,rating,comment,source_channel,source_message_id)
      values(r.id,p_rating,nullif(btrim(p_comment),''),p_channel,p_message_id) on conflict do nothing;
    if not found then return jsonb_build_object('handled',true,'status','duplicate'); end if;
    update feedback_requests set status='submitted',submitted_at=now() where id=r.id;
  end if;
  if p_message_id is null or not exists(select 1 from interactions where workspace_id=p_workspace and meta->>'feedback_message_id'=p_message_id and channel=p_channel) then
    insert into interactions(workspace_id,case_id,patient_id,channel,direction,actor_label,summary,body,meta)
      values(r.workspace_id,r.case_id,r.patient_id,p_channel,'inbound','Customer',
        case when v_reason is null then 'Customer feedback received' else 'Feedback reply needs review: '||v_reason end,
        left(coalesce(p_comment,''),2000),jsonb_build_object('feedback_request_id',r.id,'feedback_message_id',p_message_id,'feedback_status',coalesce(v_reason,'submitted')));
  end if;
  return jsonb_build_object('handled',true,'status',coalesce(v_reason,'submitted'));
end $$;
revoke all on function receive_feedback_reply(uuid,text,text,uuid,text,integer,text,text) from public,caredesk_app;
select public.track_changes();
