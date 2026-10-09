-- =====================================================================
-- Hinduja requirements (Oct 2026): branches, service providers and lead routing, import from the old CRM.
--   * Branch (Khar / Mahim) and "additional information" on every case; old-CRM reference for imported cases.
--   * Providers: SecondMedic (ECG, X-ray, blood tests, visits) and Book My Medicare (nursing, physiotherapy,
--     hospital beds, elder care, other home care). A case's services decide which provider gets the lead
--     (case_referrals); the provider sees the Case ID, patient details and requirements, never call recordings.
--   * Each team sees its own leads: provider staff only their provider's cases; SecondMedic coordinators and
--     field staff the SecondMedic or not-yet-routed cases; Hinduja, supervisors and medical desk see all.
--   * import_cases(): patients and cases from the previous Hinduja Home Care CRM (Excel / CSV).
-- =====================================================================

-- ---------- columns ----------
alter table cases add column if not exists branch text;
alter table cases add column if not exists additional_info text;
alter table cases add column if not exists external_ref text;
create unique index if not exists cases_external_ref on cases(workspace_id, external_ref) where external_ref is not null;
create index if not exists cases_branch on cases(workspace_id, branch);

update workspaces set settings = settings || '{"branches": ["Khar", "Mahim"]}'::jsonb
 where code = 'HHC' and not (settings ? 'branches');

-- ---------- providers ----------
create table if not exists providers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  code          text not null,
  name          text not null,
  categories    text[] not null default '{}',          -- service categories this provider delivers
  contact_phone text,
  contact_email text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (workspace_id, code)
);

alter table profiles add column if not exists provider_id uuid references providers(id);

-- service categories for the new services
alter table services drop constraint if exists services_category_check;
alter table services add constraint services_category_check
  check (category in ('lab','xray','ecg','visit','nursing','physio','beds','eldercare','homecare','other'));

with w as (select id from workspaces where code = 'HHC')
insert into providers (workspace_id, code, name, categories)
select w.id, p.code, p.name, p.cats from w, (values
  ('SM',  'SecondMedic',       array['lab','xray','ecg','visit']),
  ('BMM', 'Book My Medicare',  array['nursing','physio','beds','eldercare','homecare'])
) as p(code, name, cats)
on conflict (workspace_id, code) do nothing;

-- Book My Medicare services: price 0 on the CareDesk rate card = quoted by Book My Medicare after assessment.
with w as (select id from workspaces where code = 'HHC')
insert into services (workspace_id, code, name, category, price, tat_hours, description, approved_at)
select w.id, s.code, s.name, s.cat, 0, s.tat, s.descr, now() from w, (values
  ('NURS-HOME',  'Nursing care at home',             'nursing',   24, 'Book My Medicare: trained nurse, per visit or shift; quoted after assessment'),
  ('PHYSIO-HOME','Physiotherapy at home',            'physio',    24, 'Book My Medicare: physiotherapist home session; quoted after assessment'),
  ('BED-HOSP',   'Hospital bed on rent',             'beds',      24, 'Book My Medicare: Fowler / semi-Fowler bed, delivered and installed'),
  ('ELDER-CARE', 'Elder care attendant',             'eldercare', 24, 'Book My Medicare: trained attendant / caretaker; quoted after assessment'),
  ('HOMECARE',   'Other home healthcare service',    'homecare',  24, 'Book My Medicare: equipment, ICU at home, other needs; quoted after assessment')
) as s(code, name, cat, tat, descr)
on conflict (workspace_id, code) do nothing;

-- ---------- lead transfers ----------
create table if not exists case_referrals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_id       uuid not null references cases(id) on delete cascade,
  provider_id   uuid not null references providers(id),
  categories    text[] not null default '{}',
  status        text not null default 'new'
                check (status in ('new','accepted','scheduled','in_progress','completed','declined','cancelled')),
  auto          boolean not null default true,          -- made by routing (false = referred by hand)
  assigned_to   uuid references profiles(id),
  scheduled_at  timestamptz,
  accepted_at   timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  decline_reason text,
  last_note     text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (case_id, provider_id)
);
create index if not exists referrals_provider on case_referrals(provider_id, status);

create or replace function me_provider() returns uuid
language sql stable security definer set search_path = public as $$
  select provider_id from profiles where id = app_uid() and active
$$;

-- provider staff must belong to a provider; only an admin moves someone between providers
create or replace function trg_profile_provider() returns trigger language plpgsql as $$
begin
  if new.role = 'provider' and new.provider_id is null then
    raise exception 'A service-provider login needs its provider (SecondMedic / Book My Medicare)' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.provider_id is distinct from old.provider_id and not (is_service() or has_role('admin')) then
    raise exception 'Only the platform admin can change a user''s provider' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists profile_provider on profiles;
create trigger profile_provider before insert or update on profiles for each row execute function trg_profile_provider();

-- service categories named in free text ("needs a nurse and a bed")
create or replace function categories_from_text(p text) returns text[] language sql immutable as $$
  select array_remove(array[
    case when p ~* '\mecg\M|electrocardio' then 'ecg' end,
    case when p ~* 'x[- ]?ray|radiograph' then 'xray' end,
    case when p ~* 'blood|\mlab\M|sample|\mcbc\M|sugar|thyroid|lipid|hba1c|\mtests?\M' then 'lab' end,
    case when p ~* 'nurs' then 'nursing' end,
    case when p ~* 'physio' then 'physio' end,
    case when p ~* '\mbeds?\M|fowler' then 'beds' end,
    case when p ~* 'elder|attendant|care ?taker|geriatric|old age' then 'eldercare' end
  ]::text[], null)
$$;

-- Send the case to the right provider(s): by its rate-card services, or by the request text when none are added.
create or replace function route_case(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c record; v_cats text[]; pr record; v_new boolean; v_ref uuid; u record; v_svc text;
begin
  if current_setting('app.routing', true) = 'off' then return; end if;
  select * into c from cases where id = p_case;
  if not found then return; end if;
  v_cats := array(select distinct category from case_items where case_id = p_case);
  if coalesce(array_length(v_cats, 1), 0) = 0 then
    v_cats := categories_from_text(coalesce(c.services_requested, '') || ' ' || coalesce(c.additional_info, ''));
  end if;
  for pr in select * from providers where workspace_id = c.workspace_id and active and categories && v_cats loop
    insert into case_referrals (workspace_id, case_id, provider_id, categories, status, created_by, completed_at)
    values (c.workspace_id, p_case, pr.id, array(select unnest(v_cats) intersect select unnest(pr.categories)),
            case c.stage when 'closed' then 'completed' when 'cancelled' then 'cancelled' else 'new' end, app_uid(),
            case when c.stage = 'closed' then coalesce(c.closed_at, now()) end)
    on conflict (case_id, provider_id) do update
      set categories = excluded.categories,
          status = case when case_referrals.status = 'cancelled' and case_referrals.auto and c.stage not in ('closed','cancelled')
                        then 'new' else case_referrals.status end,
          updated_at = now()
    returning id, (xmax = 0) into v_ref, v_new;
    if v_new and c.stage not in ('closed','cancelled') then
      v_svc := (select string_agg(initcap(x), ', ') from unnest(array(select unnest(v_cats) intersect select unnest(pr.categories))) x);
      perform log_interaction(p_case, 'system', 'internal', 'Lead transferred to ' || pr.name || ' · ' || v_svc,
        'Shared: case ID, patient details, address and requirements. Call recordings are not shared.', null,
        jsonb_build_object('referral_id', v_ref, 'provider', pr.code));
      for u in select id from profiles where provider_id = pr.id and active loop
        perform notify_user(u.id, 'New lead ' || c.case_no, v_svc, '/leads', 'info');
      end loop;
      if pr.code <> 'SM' then
        perform sla_start(c.workspace_id, 'provider_accept', p_case, null, null);
      end if;
    end if;
  end loop;
  -- leads made by routing that no longer match the services, and not yet taken up
  update case_referrals r set status = 'cancelled', updated_at = now()
   where r.case_id = p_case and r.auto and r.status = 'new'
     and not exists (select 1 from providers pv where pv.id = r.provider_id and pv.categories && v_cats);
end $$;

create or replace function trg_item_route() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform route_case(coalesce(new.case_id, old.case_id));
  return null;
end $$;
drop trigger if exists item_route on case_items;
create trigger item_route after insert or delete on case_items for each row execute function trg_item_route();

create or replace function trg_case_route() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.services_requested is distinct from old.services_requested or new.additional_info is distinct from old.additional_info) then
    perform route_case(new.id);
  end if;
  -- SecondMedic's own lead follows the case stages; a cancelled case cancels every open lead
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    if new.stage = 'cancelled' then
      update case_referrals set status = 'cancelled', updated_at = now()
       where case_id = new.id and status not in ('completed','declined','cancelled');
    else
      update case_referrals r set updated_at = now(), status = case new.stage
          when 'booking' then 'accepted' when 'deployment' then 'scheduled' when 'completion' then 'in_progress'
          when 'payment' then 'completed' when 'closure' then 'completed' when 'closed' then 'completed' else r.status end,
          completed_at = case when new.stage in ('payment','closure','closed') then coalesce(r.completed_at, now()) else r.completed_at end
       where r.case_id = new.id and r.status not in ('declined','cancelled')
         and exists (select 1 from providers pv where pv.id = r.provider_id and pv.code = 'SM');
    end if;
  end if;
  return null;
end $$;
drop trigger if exists case_route on cases;
create trigger case_route after update on cases for each row execute function trg_case_route();

-- Provider (or supervisor / Hinduja management) moves a lead along; the note goes on the patient timeline.
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
          or (has_role('coordinator') and pv.code = 'SM')) then
    raise exception 'Not allowed for your role';
  end if;
  if p_status not in ('accepted','scheduled','in_progress','completed','declined','cancelled','new') then
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
    accepted_at  = case when p_status in ('accepted','scheduled','in_progress','completed') then coalesce(accepted_at, now()) else accepted_at end,
    scheduled_at = case when p_when is not null then p_when else scheduled_at end,
    started_at   = case when p_status in ('in_progress','completed') then coalesce(started_at, now()) else started_at end,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    decline_reason = case when p_status = 'declined' then p_note else decline_reason end,
    assigned_to  = case when has_role('provider') then coalesce(assigned_to, app_uid()) else assigned_to end,
    last_note    = coalesce(nullif(trim(p_note), ''), last_note),
    updated_at   = now()
  where id = p_id;
  v_label := pv.name || ': ' || case p_status when 'accepted' then 'lead accepted' when 'scheduled' then 'visit scheduled ' ||
      to_char(coalesce(p_when, r.scheduled_at) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI')
    when 'in_progress' then 'service started' when 'completed' then 'service completed' when 'declined' then 'lead declined'
    when 'cancelled' then 'lead cancelled' else 'lead reopened' end;
  perform log_interaction(r.case_id, case when nullif(trim(p_note), '') is null then 'system' else 'note' end, 'internal', v_label, nullif(trim(p_note), ''),
    null, jsonb_build_object('referral_id', p_id, 'provider', pv.code, 'status', p_status));
  if p_status in ('accepted','scheduled','in_progress','completed') then
    perform sla_meet('provider_accept', r.case_id);
  end if;
  if p_status = 'declined' then
    perform notify_role(c.workspace_id, 'supervisor', pv.name || ' declined ' || c.case_no, p_note, '/cases/' || c.id, 'warn');
    if c.owner_id is not null then perform notify_user(c.owner_id, pv.name || ' declined ' || c.case_no, p_note, '/cases/' || c.id, 'warn'); end if;
  elsif p_status = 'completed' and c.owner_id is not null then
    perform notify_user(c.owner_id, pv.name || ' completed ' || c.case_no, p_note, '/cases/' || c.id, 'ok');
  end if;
  -- a case served only by outside providers closes when every lead is finished and at least one was delivered
  select count(*) filter (where status not in ('completed','declined','cancelled')),
         count(*) filter (where status = 'completed')
    into v_open, v_done from case_referrals where case_id = r.case_id;
  select count(*) into v_sm from case_referrals x join providers y on y.id = x.provider_id
   where x.case_id = r.case_id and y.code = 'SM' and x.status <> 'cancelled';
  if v_open = 0 and v_done > 0 and v_sm = 0 and c.stage not in ('closed','cancelled') then
    perform rpc_on();
    update cases set stage = 'closed', closed_at = now(), closed_by = app_uid(), service_completed_at = coalesce(service_completed_at, now()),
      sla_state = 'ok' where id = r.case_id;
    insert into case_stage_history(case_id, from_stage, to_stage, changed_by, note)
    values (r.case_id, c.stage, 'closed', app_uid(), 'All provider services completed');
    perform log_interaction(r.case_id, 'system', 'internal', 'Case closed: all provider services completed', null);
  end if;
  return (select to_jsonb(x) from case_referrals x where id = p_id);
end $$;

-- Send a case to a provider by hand (e.g. the caller asked for something the services list did not show).
create or replace function refer_case(p_case uuid, p_provider uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c record; pv record; v_id uuid; u record;
begin
  if not (is_ops() or has_role('client_manager')) then raise exception 'Not allowed for your role'; end if;
  select * into c from cases where id = p_case and workspace_id = me_ws();
  if not found or not can_see_case(p_case) then raise exception 'Case not found'; end if;
  if c.stage in ('closed','cancelled') then raise exception 'Case is %', c.stage; end if;
  select * into pv from providers where id = p_provider and workspace_id = c.workspace_id and active;
  if not found then raise exception 'Provider not found'; end if;
  insert into case_referrals (workspace_id, case_id, provider_id, categories, status, auto, created_by, last_note)
  values (c.workspace_id, p_case, pv.id, '{}', 'new', false, app_uid(), nullif(trim(p_note), ''))
  on conflict (case_id, provider_id) do update set status = case when case_referrals.status in ('cancelled','declined') then 'new' else case_referrals.status end,
    auto = false, last_note = coalesce(excluded.last_note, case_referrals.last_note), updated_at = now()
  returning id into v_id;
  perform log_interaction(p_case, 'system', 'internal', 'Lead transferred to ' || pv.name || ' (by hand)', nullif(trim(p_note), ''),
    null, jsonb_build_object('referral_id', v_id, 'provider', pv.code));
  for u in select id from profiles where provider_id = pv.id and active loop
    perform notify_user(u.id, 'New lead ' || c.case_no, coalesce(p_note, c.services_requested), '/leads', 'info');
  end loop;
  if pv.code <> 'SM' then perform sla_start(c.workspace_id, 'provider_accept', p_case, null, null); end if;
  return v_id;
end $$;

-- SLA: outside provider accepts a new lead
with w as (select id from workspaces where code = 'HHC')
insert into sla_policies (workspace_id, key, label, target_minutes, escalate_to, measured_by)
select w.id, 'provider_accept', 'Provider accepts lead ≤ 30 min', 30, 'supervisor'::app_role, 'Lead transfer to acceptance' from w
on conflict do nothing;

-- ---------- enquiry capture: branch, additional information, routing once all services are on ----------
create or replace function create_enquiry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_pat uuid; v_case uuid; v_no text; v_ws uuid := coalesce(me_ws(), (p->>'workspace_id')::uuid); v_branch text;
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
  -- branch: as chosen, else the IVR department of the call when it names a branch
  v_branch := nullif(trim(p->>'branch'), '');
  if v_branch is null and nullif(p->>'call_id','') is not null then
    select b into v_branch from calls cl, workspaces w, jsonb_array_elements_text(coalesce(w.settings->'branches', '[]'::jsonb)) b
     where cl.id = (p->>'call_id')::uuid and w.id = cl.workspace_id and cl.department ilike '%' || b || '%' limit 1;
  end if;
  v_pat := upsert_patient(p->'patient' || jsonb_build_object('workspace_id', v_ws));
  if (p->>'consent')::boolean then
    update patients set consent_verbal_at = coalesce(consent_verbal_at, now()),
                        consent_verbal_call_id = coalesce(nullif(p->>'call_id','')::uuid, consent_verbal_call_id)
    where id = v_pat;
  end if;
  perform set_config('app.routing', 'off', true);
  insert into cases(workspace_id, patient_id, caller_name, caller_relation, caller_mobile, source_channel, priority,
                    services_requested, clinical_notes, additional_info, branch, preferred_slot, address, pincode, owner_id)
  values (v_ws, v_pat, nullif(p->>'caller_name',''), nullif(p->>'caller_relation',''), norm_mobile(nullif(p->>'caller_mobile','')),
          coalesce(nullif(p->>'source_channel',''),'phone'), coalesce(nullif(p->>'priority',''),'routine'),
          nullif(p->>'services_requested',''), nullif(p->>'clinical_notes',''), nullif(p->>'additional_info',''), v_branch,
          nullif(p->>'preferred_slot','')::timestamptz,
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
  perform set_config('app.routing', 'on', true);
  perform route_case(v_case);
  return jsonb_build_object('case_id', v_case, 'case_no', v_no, 'patient_id', v_pat);
end $$;

-- ---------- import from the previous Hinduja Home Care CRM ----------
-- p_rows: [{ref, patient_name, mobile, alt_mobile, email, age, gender, address, locality, pincode, branch, services,
--           requirements, notes, status, date}] (max 500 per call). Each row gets a new CareDesk Case ID; the old ID is
-- kept as external_ref (a row whose ref is already imported is skipped, so a file can be imported again safely).
create or replace function import_cases(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws(); x jsonb; i int := 0; v_ok int := 0; v_skip int := 0; v_err jsonb := '[]'::jsonb;
  v_pat uuid; v_case uuid; v_mob text; v_stage case_stage; v_at timestamptz; v_status text; v_ref text; v_gender text;
begin
  if not has_role('supervisor','client_manager') then raise exception 'Only a supervisor or Hinduja management can import'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be a list'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'At most 500 rows per import step'; end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_ref := nullif(trim(x->>'ref'), '');
      if coalesce(trim(x->>'patient_name'), '') = '' then raise exception 'Patient name is missing'; end if;
      v_mob := norm_mobile(nullif(x->>'mobile', ''));
      if v_mob is null and v_ref is null then raise exception 'Needs a mobile number or the old case ID'; end if;
      if v_ref is not null and exists (select 1 from cases where workspace_id = v_ws and external_ref = v_ref) then
        v_skip := v_skip + 1; continue;
      end if;
      v_at := coalesce(nullif(x->>'date', '')::timestamptz, now());
      v_status := lower(coalesce(x->>'status', ''));
      v_stage := case when v_status ~ 'cancel|reject|lost' then 'cancelled'
                      when v_status ~ 'close|complete|done|deliver|served' then 'closed' else 'enquiry' end;
      v_gender := case upper(left(coalesce(x->>'gender', ''), 1)) when 'M' then 'M' when 'F' then 'F' when 'O' then 'O' end;
      select id into v_pat from patients where workspace_id = v_ws and v_mob is not null and mobile = v_mob;
      if v_pat is null then
        insert into patients (workspace_id, full_name, age, gender, mobile, alt_mobile, email, address, locality, pincode, created_by, created_at, tags)
        values (v_ws, trim(x->>'patient_name'), nullif(regexp_replace(coalesce(x->>'age', ''), '\D', '', 'g'), '')::int, v_gender, v_mob,
                norm_mobile(nullif(x->>'alt_mobile', '')), nullif(trim(x->>'email'), ''), nullif(trim(x->>'address'), ''),
                nullif(trim(x->>'locality'), ''), nullif(regexp_replace(coalesce(x->>'pincode', ''), '\D', '', 'g'), ''), app_uid(), v_at,
                array['imported'])
        returning id into v_pat;
      end if;
      perform set_config('app.routing', 'off', true);
      insert into cases (workspace_id, patient_id, source_channel, services_requested, additional_info, branch, external_ref,
                         address, pincode, owner_id)
      values (v_ws, v_pat, 'phone', nullif(trim(x->>'services'), ''), nullif(trim(x->>'requirements'), ''),
              nullif(initcap(trim(x->>'branch')), ''), v_ref, nullif(trim(x->>'address'), ''),
              nullif(regexp_replace(coalesce(x->>'pincode', ''), '\D', '', 'g'), ''), null)
      returning id into v_case;
      perform rpc_on();
      update cases set owner_id = null, created_at = v_at, stage = v_stage,
        closed_at = case when v_stage = 'closed' then v_at end,
        cancel_reason = case when v_stage = 'cancelled' then coalesce(nullif(x->>'status', ''), 'Imported as cancelled') end
       where id = v_case;
      insert into case_stage_history (case_id, from_stage, to_stage, changed_by, changed_at, note)
      values (v_case, null, v_stage, app_uid(), v_at, 'Imported from the previous Hinduja CRM' || coalesce(' (' || v_ref || ')', ''));
      insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, occurred_at, meta)
      values (v_ws, v_case, v_pat, 'system', 'internal', app_uid(), 'Import', 'Imported from the previous Hinduja CRM' || coalesce(' · old ID ' || v_ref, ''),
              nullif(trim(coalesce(x->>'notes', '')), ''), v_at, jsonb_build_object('import', true, 'old_status', x->>'status'));
      perform set_config('app.routing', 'on', true);
      perform route_case(v_case);
      v_ok := v_ok + 1;
    exception when others then
      perform set_config('app.routing', 'on', true);
      v_err := v_err || jsonb_build_object('row', i, 'ref', x->>'ref', 'message', sqlerrm);
    end;
  end loop;
  perform log_access('import', 'cases', null, jsonb_build_object('imported', v_ok, 'skipped', v_skip, 'errors', jsonb_array_length(v_err)));
  return jsonb_build_object('imported', v_ok, 'skipped', v_skip, 'errors', v_err);
end $$;

-- ---------- Row Level Security ----------
alter table providers enable row level security;
alter table case_referrals enable row level security;

drop policy if exists providers_read on providers;
create policy providers_read on providers for select using (workspace_id = me_ws());
drop policy if exists providers_write on providers;
create policy providers_write on providers for update using (workspace_id = me_ws() and has_role('admin','client_manager'))
  with check (workspace_id = me_ws() and has_role('admin','client_manager'));

drop policy if exists referrals_read on case_referrals;
create policy referrals_read on case_referrals for select using (
  workspace_id = me_ws() and can_see_case(case_id) and (not has_role('provider') or provider_id = me_provider()));

-- who sees which case: SecondMedic coordinators / field staff only SecondMedic or not-yet-routed cases;
-- provider staff only cases sent to their provider
create or replace function can_see_case(p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from cases c
    where c.id = p_case and c.workspace_id = me_ws() and (
      has_role('supervisor','medical_desk','client_manager','client_clinical')
      or (has_role('coordinator') and (
            not exists (select 1 from case_referrals r where r.case_id = c.id and r.status <> 'cancelled')
            or exists (select 1 from case_referrals r join providers pv on pv.id = r.provider_id
                        where r.case_id = c.id and pv.code = 'SM' and r.status <> 'cancelled')))
      or (has_role('agent') and (c.owner_id = app_uid() or c.created_by = app_uid() or c.owner_id is null
                                 or (c.stage not in ('closed','cancelled') and c.created_at > now() - interval '2 days')))
      or (has_role('field_staff') and exists (select 1 from assignments a where a.case_id = c.id and a.staff_id = app_uid()
                                              and (a.status in ('assigned','en_route','checked_in')
                                                   or (a.status = 'completed' and a.checkout_at > now() - interval '12 hours'))))
      or (has_role('provider') and exists (select 1 from case_referrals r where r.case_id = c.id and r.provider_id = me_provider()
                                                                         and r.status <> 'cancelled'))
    ))
$$;

drop policy if exists patients_read on patients;
create policy patients_read on patients for select using (
  workspace_id = me_ws() and (
    has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical')
    or (has_role('field_staff','provider') and exists (select 1 from cases c where c.patient_id = patients.id and can_see_case(c.id)))));

drop policy if exists interactions_insert on interactions;
create policy interactions_insert on interactions for insert with check (
  workspace_id = me_ws() and (is_ops() or has_role('field_staff','provider')) and channel in ('note','field') and actor_id = app_uid()
  and (case_id is null or can_see_case(case_id)));

drop policy if exists esc_read on escalations;
create policy esc_read on escalations for select using (workspace_id = me_ws() and (not has_role('admin','field_staff','provider') or raised_by = app_uid()));
drop policy if exists esc_insert on escalations;
create policy esc_insert on escalations for insert with check (workspace_id = me_ws()
  and (is_ops() or has_role('field_staff','client_manager','client_clinical') or (has_role('provider') and can_see_case(case_id))));

drop policy if exists sla_timers_read on sla_timers;
create policy sla_timers_read on sla_timers for select using (
  workspace_id = me_ws() and (case_id is null or can_see_case(case_id)) and not has_role('admin','field_staff','provider'));

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
  (select string_agg(i.service_name, ', ' order by i.created_at) from case_items i where i.case_id = c.id) as service_names,
  (select string_agg(distinct i.category, ',') from case_items i where i.case_id = c.id) as service_categories,
  (select min(t.due_at) from sla_timers t where t.case_id = c.id and t.status = 'running') as next_sla_due,
  (select t.policy_key from sla_timers t where t.case_id = c.id and t.status = 'running' order by t.due_at limit 1) as next_sla_key,
  (select count(*) from escalations e where e.case_id = c.id and e.status <> 'resolved') as open_escalations,
  (select count(*) from complaints k where k.case_id = c.id and k.status in ('open','acknowledged')) as open_complaints,
  (select string_agg(pv.name, ', ' order by pv.code desc) from case_referrals r join providers pv on pv.id = r.provider_id
    where r.case_id = c.id and r.status <> 'cancelled') as provider_names,
  (select jsonb_agg(jsonb_build_object('provider', pv.name, 'code', pv.code, 'status', r.status) order by pv.code desc)
     from case_referrals r join providers pv on pv.id = r.provider_id where r.case_id = c.id and r.status <> 'cancelled') as providers_status
from cases c
join patients p on p.id = c.patient_id
left join zones z on z.id = c.zone_id
left join profiles o on o.id = c.owner_id
left join profiles co on co.id = c.coordinator_id;

create or replace view v_referrals with (security_invoker = true) as
select r.*, pv.code as provider_code, pv.name as provider_name,
  c.case_no, c.stage as case_stage, c.priority, c.branch, c.services_requested, c.additional_info, c.clinical_notes,
  c.preferred_slot, c.address, c.pincode, c.created_at as case_created_at, c.patient_id,
  p.full_name as patient_name, p.age as patient_age, p.gender as patient_gender,
  case when has_role('agent') then mask_mobile(p.mobile) else p.mobile end as patient_mobile,
  case when has_role('agent') then mask_mobile(c.caller_mobile) else c.caller_mobile end as caller_mobile,
  c.caller_name, c.caller_relation, p.landmark, p.locality,
  a.full_name as assigned_name,
  (select string_agg(i.service_name, ', ' order by i.created_at) from case_items i
    where i.case_id = r.case_id and (i.category = any(r.categories) or cardinality(r.categories) = 0)) as service_names
from case_referrals r
join providers pv on pv.id = r.provider_id
join cases c on c.id = r.case_id
join patients p on p.id = c.patient_id
left join profiles a on a.id = r.assigned_to;

grant select on v_cases, v_referrals to caredesk_app;
grant select on providers, case_referrals to caredesk_app;
revoke insert, update, delete on case_referrals from caredesk_app;
grant execute on function route_case(uuid), update_referral(uuid, text, text, timestamptz), refer_case(uuid, uuid, text),
  import_cases(jsonb), me_provider(), categories_from_text(text) to caredesk_app;

-- live updates for the new tables
do $$ declare t text; begin
  foreach t in array array['providers', 'case_referrals'] loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;
