-- HHCS-side partner API, disabled until BMM confirms the exchange contract.
-- Reuses a dedicated BMM provider login, the existing JWT boundary and update_referral().
create table if not exists bmm_integration_settings (
  workspace_id uuid primary key references workspaces(id),
  enabled boolean not null default false,
  contract_confirmed boolean not null default false,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  check (not enabled or contract_confirmed)
);
create table if not exists bmm_status_events (
  workspace_id uuid not null references workspaces(id),
  event_id uuid not null,
  referral_id uuid not null references case_referrals(id),
  payload_hash text not null,
  applied_status text not null,
  applied_by uuid not null references profiles(id),
  received_at timestamptz not null default now(),
  primary key (workspace_id, event_id)
);
alter table bmm_integration_settings enable row level security;
alter table bmm_status_events enable row level security;
revoke all on bmm_integration_settings, bmm_status_events from public, caredesk_app;
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename not in ('webhook_events', 'case_counters') loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;

create or replace function bmm_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws(); v jsonb;
begin
  if not has_role('admin','supervisor') then raise exception 'Not allowed for your role'; end if;
  select jsonb_build_object('enabled', enabled, 'contract_confirmed', contract_confirmed, 'updated_at', updated_at)
    into v from bmm_integration_settings where workspace_id = v_ws;
  return coalesce(v, '{"enabled":false,"contract_confirmed":false}'::jsonb) || jsonb_build_object(
    'provider_active', exists(select 1 from providers where workspace_id = v_ws and code = 'BMM' and active),
    'provider_logins', (select count(*) from profiles p join providers pv on pv.id = p.provider_id
      where p.workspace_id = v_ws and pv.workspace_id = v_ws and pv.code = 'BMM' and pv.active and p.active and p.role = 'provider'));
end $$;

create or replace function set_bmm_integration(p_enabled boolean, p_contract_confirmed boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws();
begin
  if not has_role('admin','supervisor') then raise exception 'Not allowed for your role'; end if;
  if p_enabled is null or p_contract_confirmed is null then raise exception 'Choose the integration and contract settings'; end if;
  if p_enabled and not p_contract_confirmed then raise exception 'BMM must confirm the connection format before activation'; end if;
  if p_enabled and not exists(select 1 from profiles p join providers pv on pv.id = p.provider_id
    where p.workspace_id = v_ws and pv.workspace_id = v_ws and pv.code = 'BMM' and pv.active and p.active and p.role = 'provider') then
    raise exception 'Create an active BMM provider login before activation';
  end if;
  insert into bmm_integration_settings(workspace_id, enabled, contract_confirmed, updated_by)
    values(v_ws, p_enabled, p_contract_confirmed, app_uid())
    on conflict(workspace_id) do update set enabled = excluded.enabled, contract_confirmed = excluded.contract_confirmed,
      updated_by = excluded.updated_by, updated_at = now();
  insert into access_log(workspace_id, user_id, action, entity, entity_id, meta)
    values(v_ws, app_uid(), 'settings_changed', 'bmm_integration', v_ws::text,
      jsonb_build_object('enabled', p_enabled, 'contract_confirmed', p_contract_confirmed));
  return bmm_settings();
end $$;

-- A provider login can use this connection only for its own active BMM provider and workspace.
create or replace function bmm_provider() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select pv.id into v from profiles p join providers pv on pv.id = p.provider_id
    where p.id = app_uid() and p.active and p.role = 'provider' and pv.active and pv.code = 'BMM'
      and pv.workspace_id = p.workspace_id and p.workspace_id = me_ws();
  if v is null then raise exception 'BMM provider access required' using errcode = '42501'; end if;
  if not exists(select 1 from bmm_integration_settings where workspace_id = me_ws() and enabled and contract_confirmed) then
    raise exception 'BMM integration is disabled';
  end if;
  return v;
end $$;

-- Full paginated polling snapshot. Cancelled / withdrawn referrals return an ID-only tombstone.
-- Never returns recordings, clinical notes, prices, other providers' items or validation records.
create or replace function bmm_leads(p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_provider uuid := bmm_provider(); v jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 then raise exception 'Invalid pagination'; end if;
  with permitted as (
    select r.*, c.case_no, c.patient_id, c.address, c.pincode, c.branch, c.services_requested,
      c.expected_discharge_on, c.plan_days, c.hospital_name, c.stage = 'cancelled' as case_cancelled,
      (r.status = 'cancelled' or c.stage = 'cancelled' or (c.care_type = 'post_discharge' and c.signoff_at is null)) as withdrawn
    from case_referrals r join cases c on c.id = r.case_id
    where r.workspace_id = me_ws() and c.workspace_id = me_ws() and r.provider_id = v_provider
  ), page as (select * from permitted order by created_at, id limit p_limit offset p_offset)
  select jsonb_build_object('total', (select count(*) from permitted), 'limit', p_limit, 'offset', p_offset,
    'leads', coalesce((select jsonb_agg(
      case when r.withdrawn then jsonb_build_object('referral_id',r.id,'case_id',r.case_id,'case_no',r.case_no,
        'status',case when r.status = 'cancelled' or r.case_cancelled then 'cancelled' else 'on_hold' end,'updated_at',r.updated_at)
      else jsonb_build_object('referral_id',r.id,'case_id',r.case_id,'case_no',r.case_no,'status',r.status,
        'updated_at',r.updated_at,'scheduled_at',r.scheduled_at,'dispatched_at',r.dispatched_at,'started_at',r.started_at,
        'completed_at',r.completed_at,'last_note',r.last_note,'decline_reason',r.decline_reason,
        'patient',jsonb_build_object('name',p.full_name,'mobile',p.mobile,'address',coalesce(r.address,p.address),
          'pincode',coalesce(r.pincode,p.pincode)), 'branch',r.branch,'hospital',r.hospital_name,
        'expected_discharge_on',r.expected_discharge_on,'plan_days',r.plan_days,
        'items',coalesce((select jsonb_agg(jsonb_build_object('case_item_id',i.id,'service_code',i.service_code,
          'service_name',i.service_name,'category',i.category,'quantity',i.qty,'unit',s.unit) order by i.created_at,i.id)
          from case_items i join services s on s.id = i.service_id join providers pv on pv.id = v_provider
          where i.case_id = r.case_id and not i.excluded and i.category = any(pv.categories)), '[]'::jsonb)) end
      order by r.created_at,r.id) from page r join patients p on p.id = r.patient_id and p.workspace_id = me_ws()), '[]'::jsonb)) into v;
  insert into access_log(workspace_id,user_id,action,entity,meta)
    values(me_ws(),app_uid(),'partner_api_read','case_referrals',jsonb_build_object('offset',p_offset,'limit',p_limit));
  return v;
end $$;

create or replace function bmm_apply_status(p_id uuid, p_event_id uuid, p_expected_status text,
  p_status text, p_note text default null, p_when timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_provider uuid := bmm_provider(); r case_referrals; c cases; ev bmm_status_events;
  v_hash text; v_inserted int; v_allowed boolean;
begin
  if p_id is null or p_event_id is null or p_expected_status is null or p_status is null then raise exception 'Lead, event and statuses are required'; end if;
  if length(coalesce(p_note,'')) > 2000 then raise exception 'Progress note must be at most 2000 characters'; end if;
  select * into r from case_referrals where id = p_id and workspace_id = me_ws() and provider_id = v_provider for update;
  if not found then raise exception 'Lead not found'; end if;
  v_hash := md5(jsonb_build_object('referral_id',p_id,'expected_status',p_expected_status,'status',p_status,'note',p_note,'scheduled_at',p_when)::text);
  insert into bmm_status_events(workspace_id,event_id,referral_id,payload_hash,applied_status,applied_by)
    values(me_ws(),p_event_id,p_id,v_hash,p_status,app_uid()) on conflict(workspace_id,event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select * into ev from bmm_status_events where workspace_id = me_ws() and event_id = p_event_id;
    if ev.payload_hash <> v_hash or ev.referral_id <> p_id then raise exception 'Event ID was already used with different data' using errcode = '23505'; end if;
    return jsonb_build_object('referral_id',p_id,'event_id',p_event_id,'applied_status',ev.applied_status,'status',r.status,'duplicate',true);
  end if;
  select * into c from cases where id = r.case_id for update;
  if c.stage = 'cancelled' or (c.care_type = 'post_discharge' and c.signoff_at is null) then raise exception 'Lead is on hold or cancelled'; end if;
  if r.status <> p_expected_status then raise exception 'Lead status changed; retrieve the lead before sending a new event' using errcode = '23505'; end if;
  v_allowed := case r.status
    when 'new' then p_status in ('accepted','declined')
    when 'accepted' then p_status in ('scheduled','declined')
    when 'scheduled' then p_status in ('scheduled','dispatched','in_progress')
    when 'dispatched' then p_status = 'in_progress'
    when 'in_progress' then p_status = 'completed'
    else false end;
  if not v_allowed then raise exception 'Status transition is not allowed'; end if;
  perform update_referral(p_id,p_status,p_note,p_when);
  return jsonb_build_object('referral_id',p_id,'event_id',p_event_id,'applied_status',p_status,'status',p_status,'duplicate',false);
end $$;
-- New SECURITY DEFINER functions are callable only through the restricted Worker role.
revoke all on function bmm_settings(), set_bmm_integration(boolean,boolean), bmm_provider(), bmm_leads(int,int),
  bmm_apply_status(uuid,uuid,text,text,text,timestamptz) from public;
grant execute on function bmm_settings(), set_bmm_integration(boolean,boolean), bmm_provider(), bmm_leads(int,int),
  bmm_apply_status(uuid,uuid,text,text,text,timestamptz) to caredesk_app;
