-- Call experience feedback is separate from the staff-entered service/closure rating.
create table if not exists public.feedback_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  patient_id uuid not null references patients(id),
  call_id uuid not null unique references calls(id),
  case_id uuid references cases(id),
  channel text not null default 'manual' check (channel in ('manual','email')),
  status text not null default 'pending' check (status in ('pending','submitted')),
  token_hash text unique check (token_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  delivery_status text not null default 'unconfigured' check (delivery_status in ('unconfigured','manual','sending','accepted','failed','unknown')),
  delivery_attempted_at timestamptz,
  delivery_error text
);
create table if not exists public.feedback_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references feedback_requests(id),
  rating integer not null check (rating between 1 and 5),
  comment text check (length(comment) <= 2000),
  submitted_at timestamptz not null default now()
);
create index if not exists feedback_requests_patient on feedback_requests(patient_id, requested_at desc);
create index if not exists feedback_requests_pending on feedback_requests(requested_at) where status = 'pending' and token_hash is null;
create index if not exists feedback_responses_submitted on feedback_responses(submitted_at desc);
alter table feedback_requests enable row level security;
alter table feedback_responses enable row level security;
drop policy if exists feedback_requests_read on feedback_requests;
create policy feedback_requests_read on feedback_requests for select using (
  workspace_id = me_ws() and has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical')
  and exists (select 1 from calls c where c.id = call_id)
  and (case_id is null or can_see_case(case_id))
  and exists (select 1 from patients p where p.id = patient_id)
);
drop policy if exists feedback_responses_read on feedback_responses;
create policy feedback_responses_read on feedback_responses for select using (
  exists (select 1 from feedback_requests r where r.id = request_id)
);
revoke all on feedback_requests, feedback_responses from public, caredesk_app;
grant select on feedback_requests, feedback_responses to caredesk_app;

create or replace function feedback_expiry_hours(p_workspace uuid) returns integer
language sql stable set search_path = public as $$
  select case when settings->>'feedback_expiry_hours' ~ '^[0-9]{1,3}$'
    then greatest(1, least(720, (settings->>'feedback_expiry_hours')::integer)) else 168 end
  from workspaces where id = p_workspace
$$;
revoke all on function feedback_expiry_hours(uuid) from public;
grant execute on function feedback_expiry_hours(uuid) to caredesk_app;

create or replace function request_call_feedback() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_patient uuid; v_case uuid;
begin
  if new.status <> 'completed' or new.ended_at is null or coalesce(new.talk_seconds,0) <= 0 then return new; end if;
  select c.id, c.patient_id into v_case, v_patient from cases c
    where c.id = new.case_id and c.workspace_id = new.workspace_id
      and (new.patient_id is null or new.patient_id = c.patient_id);
  v_patient := coalesce(v_patient, new.patient_id);
  if v_patient is null or (new.case_id is not null and v_case is null)
    or not exists (select 1 from patients where id = v_patient and workspace_id = new.workspace_id) then return new; end if;
  insert into feedback_requests(workspace_id, patient_id, call_id, case_id, expires_at)
    values (new.workspace_id, v_patient, new.id, v_case, now() + make_interval(hours => feedback_expiry_hours(new.workspace_id)))
    on conflict (call_id) do nothing;
  return new;
end $$;
revoke all on function request_call_feedback() from public, caredesk_app;
drop trigger if exists call_feedback_request on calls;
create trigger call_feedback_request after insert or update of status, ended_at, talk_seconds, patient_id, case_id on calls
  for each row execute function request_call_feedback();

-- RLS is deliberately applied inside this invoker function before the limited definer update.
create or replace function feedback_issue_link(p_request uuid, p_hash text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare r feedback_requests; v_expiry timestamptz;
begin
  if not has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical') then raise exception 'Not allowed'; end if;
  select * into r from feedback_requests where id = p_request for update;
  if not found or r.workspace_id is distinct from me_ws()
    or (r.case_id is not null and not can_see_case(r.case_id))
    or not exists (select 1 from calls c where c.id = r.call_id and c.workspace_id = me_ws()
      and (has_role('coordinator','supervisor','medical_desk','client_manager','client_clinical') or c.agent_id = app_uid() or c.agent_id is null))
    then raise exception 'Feedback request not found'; end if;
  if r.status = 'submitted' then raise exception 'Feedback has already been submitted'; end if;
  if r.delivery_status = 'sending' then raise exception 'Email is being sent. Try again later'; end if;
  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid link'; end if;
  v_expiry := now() + make_interval(hours => feedback_expiry_hours(r.workspace_id));
  update feedback_requests set token_hash = p_hash, expires_at = v_expiry, channel = 'manual',
    delivery_status = 'manual', delivery_error = null where id = r.id;
  return v_expiry;
end $$;
revoke all on function feedback_issue_link(uuid,text) from public;
grant execute on function feedback_issue_link(uuid,text) to caredesk_app;

create or replace view v_customer_feedback with (security_invoker = true) as
select r.id, r.workspace_id, r.patient_id, p.full_name as patient_name, p.mrn,
  r.call_id, r.case_id, c.case_no, r.channel, r.status, r.requested_at, r.expires_at,
  r.delivery_status, r.delivery_error, f.rating, f.comment, f.submitted_at,
  cl.started_at as call_started_at
from feedback_requests r join patients p on p.id = r.patient_id
join calls cl on cl.id = r.call_id left join cases c on c.id = r.case_id
left join feedback_responses f on f.request_id = r.id;
grant select on v_customer_feedback to caredesk_app;
revoke all on v_customer_feedback from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on feedback_requests, feedback_responses, v_customer_feedback from %I', r);
    end if;
  end loop;
end $$;
create or replace function customer_feedback_summary() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('responses',count(*),'average',round(avg(rating),2)) from feedback_responses
$$;
revoke all on function customer_feedback_summary() from public;
grant execute on function customer_feedback_summary() to caredesk_app;

-- One claim per minute, part of cron_minute. Sending/unknown outcomes are never automatically retried.
create or replace function feedback_email_claim() returns jsonb
language plpgsql set search_path = public as $$
declare r record; v_token text;
begin
  if not is_service() then raise exception 'System only'; end if;
  update feedback_requests set delivery_status = 'unknown', delivery_error = 'Email outcome unconfirmed'
    where delivery_status = 'sending' and delivery_attempted_at < now() - interval '15 minutes';
  select q.id, p.email into r from feedback_requests q join patients p on p.id = q.patient_id
    join workspaces w on w.id = q.workspace_id
    where q.status = 'pending' and q.token_hash is null and q.expires_at > now()
      and q.delivery_status = 'unconfigured' and coalesce(w.settings->>'feedback_auto_email','true') = 'true'
      and p.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    order by q.requested_at limit 1 for update of q skip locked;
  if not found then return null; end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  update feedback_requests set token_hash = encode(sha256(convert_to(v_token,'UTF8')),'hex'), channel = 'email',
    delivery_status = 'sending', delivery_attempted_at = now() where id = r.id;
  return jsonb_build_object('id',r.id,'email',r.email,'token',v_token);
end $$;
revoke all on function feedback_email_claim() from public, caredesk_app;

create or replace function public.cron_minute(p_autodial boolean, p_feedback_email boolean) returns jsonb
language plpgsql as $$
declare v_out jsonb := '{}'::jsonb; v_err jsonb := '{}'::jsonb;
begin
  if not is_service() then raise exception 'System only'; end if;
  begin v_out := v_out || jsonb_build_object('swept', sweep_missed_callbacks());
  exception when others then v_err := v_err || jsonb_build_object('sweep', sqlerrm); end;
  begin v_out := v_out || jsonb_build_object('silence', webhook_silence_check());
  exception when others then v_err := v_err || jsonb_build_object('silence', sqlerrm); end;
  begin v_out := v_out || jsonb_build_object('sla', sla_scan());
  exception when others then v_err := v_err || jsonb_build_object('sla', sqlerrm); end;
  begin v_out := v_out || jsonb_build_object('prices', activate_due_prices());
  exception when others then v_err := v_err || jsonb_build_object('prices', sqlerrm); end;
  if p_autodial then
    begin v_out := v_out || jsonb_build_object('claims', coalesce(autodial_claim(), '[]'::jsonb));
    exception when others then v_err := v_err || jsonb_build_object('autodial', sqlerrm); end;
  end if;
  if p_feedback_email then
    begin v_out := v_out || jsonb_build_object('feedback_email', feedback_email_claim());
    exception when others then v_err := v_err || jsonb_build_object('feedback_email', 'Feedback claim failed'); end;
  end if;
  return v_out || jsonb_build_object('claims', coalesce(v_out -> 'claims', '[]'::jsonb), 'errors', v_err);
end $$;
revoke all on function public.cron_minute(boolean,boolean) from public;
-- Keep the existing one-argument entry point unambiguous for older deployed Workers.
create or replace function public.cron_minute(p_autodial boolean default true) returns jsonb
language sql as $$ select public.cron_minute(p_autodial, false) $$;
revoke all on function public.cron_minute(boolean) from public;
select public.track_changes();
