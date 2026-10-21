-- =====================================================================
-- Live field staff tracking, breadcrumbs, geofence check and ATA tracking (21 Oct 2026).
--   * Adds actual_arrival_at (ATA) and eta_vs_ata_variance_min to assignments.
--   * Creates staff_locations table for breadcrumbs and GPS telemetry.
--   * Enhances field_update RPC to capture ATA, distance and variance.
--   * Exposes v_staff_locations view with live distance to patient.
-- =====================================================================

alter table assignments add column if not exists actual_arrival_at timestamptz;
alter table assignments add column if not exists eta_vs_ata_variance_min int;
alter table assignments drop constraint if exists assignments_task_check;
alter table assignments add constraint assignments_task_check check (task in ('phlebotomy','sample','xray','ecg','visit','nursing','physio','delivery','pickup','other'));
alter table assignments drop constraint if exists assignments_status_check;
alter table assignments add constraint assignments_status_check check (status in ('assigned','en_route','checked_in','on_site','completed','cancelled','reassigned'));

create table if not exists staff_locations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  staff_id      uuid not null references profiles(id) on delete cascade,
  assignment_id uuid references assignments(id) on delete set null,
  case_id       uuid references cases(id) on delete set null,
  lat           double precision not null,
  lng           double precision not null,
  accuracy      numeric(8,2),
  speed         numeric(8,2),
  heading       numeric(8,2),
  battery_pct   int,
  recorded_at   timestamptz not null default now()
);

create index if not exists staff_locations_staff_time on staff_locations(staff_id, recorded_at desc);
create index if not exists staff_locations_ws_time on staff_locations(workspace_id, recorded_at desc);
create index if not exists staff_locations_assignment on staff_locations(assignment_id, recorded_at desc);

alter table staff_locations enable row level security;

drop policy if exists staff_locations_insert on staff_locations;
create policy staff_locations_insert on staff_locations for insert with check (
  workspace_id = me_ws() and (
    staff_id = app_uid()
    or has_role('coordinator','supervisor','admin')
  )
);

drop policy if exists staff_locations_read on staff_locations;
create policy staff_locations_read on staff_locations for select using (
  workspace_id = me_ws() and (
    has_role('coordinator','supervisor','admin','client_manager','client_clinical','medical_desk')
    or staff_id = app_uid()
    or (has_role('provider') and exists (
      select 1 from profiles p where p.id = staff_locations.staff_id and p.provider_id = me_provider() and p.workspace_id = me_ws()
    ))
  )
);

drop policy if exists asg_read on assignments;
create policy asg_read on assignments for select using (
  workspace_id = me_ws() and (
    staff_id = app_uid()
    or has_role('coordinator','supervisor','medical_desk','client_manager','client_clinical','agent')
    or (has_role('provider') and exists (
      select 1 from profiles p where p.id = assignments.staff_id and p.provider_id = me_provider() and p.workspace_id = me_ws()
    ))
  )
);

create or replace function field_update(p_assignment uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; c record; pt record; v_dist int; v_var int; v_now timestamptz := now();
begin
  select * into a from assignments where id = p_assignment;
  if not (a.staff_id = app_uid() or has_role('coordinator','supervisor')) then raise exception 'Not your visit'; end if;
  select * into c from cases where id = a.case_id;
  select * into pt from patients where id = c.patient_id;
  if p_action = 'en_route' then
    update assignments set status = 'en_route', eta = coalesce(nullif(p->>'eta','')::timestamptz, eta) where id = p_assignment;
    perform log_interaction(a.case_id, 'field', 'internal', 'Technician en route' || coalesce(' · ETA ' || to_char((p->>'eta')::timestamptz at time zone 'Asia/Kolkata','HH24:MI'),''), null);
  elsif p_action = 'checkin' then
    if pt.lat is not null and pt.lng is not null and (p->>'lat') is not null and (p->>'lng') is not null then
      v_dist := haversine_m(pt.lat, pt.lng, (p->>'lat')::float8, (p->>'lng')::float8);
    end if;
    v_var := round(extract(epoch from (v_now - coalesce(a.eta, a.window_start, c.booked_slot))) / 60)::int;
    update assignments set status = 'checked_in', checkin_at = v_now, actual_arrival_at = coalesce(actual_arrival_at, v_now),
      checkin_lat = nullif(p->>'lat','')::float8, checkin_lng = nullif(p->>'lng','')::float8,
      checkin_distance_m = v_dist, eta_vs_ata_variance_min = v_var
    where id = p_assignment;
    if (p->>'lat') is not null and (p->>'lng') is not null then
      insert into staff_locations(workspace_id, staff_id, assignment_id, case_id, lat, lng, recorded_at)
      values (a.workspace_id, a.staff_id, a.id, a.case_id, (p->>'lat')::float8, (p->>'lng')::float8, v_now);
    end if;
    perform log_interaction(a.case_id, 'field', 'internal', 'Geo-tagged check-in at patient address' ||
      coalesce(' · ' || v_dist || ' m from pin', '') || coalesce(' · ATA ' || to_char(v_now at time zone 'Asia/Kolkata','HH24:MI'),''), null,
      case when (p->>'lat') is not null then 'GPS ' || round((p->>'lat')::numeric,5) || ',' || round((p->>'lng')::numeric,5) else null end);
  elsif p_action = 'delay' then
    update assignments set delay_reason = p->>'reason', eta = coalesce(nullif(p->>'eta','')::timestamptz, eta) where id = p_assignment;
    insert into escalations(workspace_id, case_id, type, level, trigger_text, raised_by)
    values (a.workspace_id, a.case_id, 'delay', 1, 'Field delay: ' || coalesce(p->>'reason','not specified'), app_uid());
  elsif p_action = 'complete' then
    update assignments set status = 'completed', checkout_at = v_now,
      checklist = coalesce(p->'checklist', checklist), patient_signoff = coalesce((p->>'signoff')::boolean, false)
    where id = p_assignment;
    if (p->'checklist'->>'consent')::boolean then
      update patients set consent_digital_at = coalesce(consent_digital_at, v_now) where id = pt.id;
    end if;
    perform log_interaction(a.case_id, 'field', 'internal', 'Visit completed · ' || a.task || ' · patient sign-off ' ||
      case when (p->>'signoff')::boolean then 'yes' else 'no' end, null);
    if not exists (select 1 from assignments where case_id = a.case_id and status not in ('completed','cancelled','reassigned')) then
      perform rpc_on();
      update cases set service_completed_at = v_now where id = a.case_id;
    end if;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return jsonb_build_object('ok', true, 'distance_m', v_dist, 'actual_arrival_at', v_now, 'variance_min', v_var);
end $$;

drop view if exists v_assignments cascade;
create view v_assignments with (security_invoker = true) as
select a.*, s.full_name as staff_name, s.phone as staff_phone, s.provider_id as staff_provider_id, c.case_no, c.booked_slot, c.priority, c.stage,
  c.address, c.pincode, p.full_name as patient_name, p.age as patient_age, p.gender as patient_gender,
  p.landmark, p.lat as patient_lat, p.lng as patient_lng, z.name as zone_name,
  (select string_agg(i.service_name, ', ') from case_items i where i.case_id = c.id) as service_names
from assignments a
join profiles s on s.id = a.staff_id
join cases c on c.id = a.case_id
join patients p on p.id = c.patient_id
left join zones z on z.id = c.zone_id;

create or replace view v_staff_locations with (security_invoker = true) as
select distinct on (l.staff_id)
  l.id, l.workspace_id, l.staff_id, l.assignment_id, l.case_id, l.lat, l.lng,
  l.accuracy, l.speed, l.heading, l.battery_pct, l.recorded_at,
  p.full_name as staff_name, p.role as staff_role, p.provider_id as staff_provider_id,
  c.case_no, c.booked_slot, pt.full_name as patient_name, pt.lat as patient_lat, pt.lng as patient_lng,
  a.status as assignment_status, a.eta, a.actual_arrival_at, a.checkin_distance_m,
  case when pt.lat is not null and pt.lng is not null then
    haversine_m(pt.lat, pt.lng, l.lat, l.lng)
  else null end as distance_to_patient_m
from staff_locations l
join profiles p on p.id = l.staff_id
left join assignments a on a.id = l.assignment_id
left join cases c on c.id = coalesce(l.case_id, a.case_id)
left join patients pt on pt.id = c.patient_id
order by l.staff_id, l.recorded_at desc;

grant select, insert on staff_locations to caredesk_app;
grant select on v_staff_locations to caredesk_app;
grant select on v_assignments to caredesk_app;

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename = 'staff_locations' loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each row execute function public.note_change()', t);
  end loop;
end $$;
