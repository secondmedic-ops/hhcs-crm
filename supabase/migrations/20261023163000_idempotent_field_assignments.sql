-- Idempotent field assignments, single active primary index, and visit deduplication.
-- Prevents duplicate visits for the same order and field staff, enforces ONE active primary assignment,
-- tracks backup assignments with role = 'backup', and keeps unassigned queue in sync with order_status.

-- 1. Schema columns
alter table assignments add column if not exists role text not null default 'primary' check (role in ('primary', 'backup'));
alter table assignments add column if not exists order_id uuid generated always as (case_id) stored;
alter table cases add column if not exists order_status text not null default 'unassigned';

update assignments set role = 'backup' where backup_for is not null;

update cases c set order_status = 'assigned'
where exists (
  select 1 from assignments a
  where a.case_id = c.id and a.status not in ('cancelled', 'reassigned')
);

-- 2. Clean existing duplicates
delete from assignments
where id in (
  select id from (
    select id, row_number() over (partition by case_id, staff_id order by assigned_at asc, id asc) as rn
    from assignments
  ) t
  where t.rn > 1
);

delete from assignments
where id in (
  select id from (
    select id, row_number() over (partition by case_id order by assigned_at asc, id asc) as rn
    from assignments
    where status not in ('cancelled', 'reassigned') and role = 'primary'
  ) t
  where t.rn > 1
);

-- 3. Unique partial index: exactly ONE active primary assignment per order
create unique index if not exists idx_assignments_unique_active_primary
  on assignments (order_id)
  where status not in ('cancelled', 'reassigned') and role = 'primary';

-- 4. Idempotent assign_staff function
drop function if exists assign_staff(uuid, uuid, text, timestamptz, uuid);
drop function if exists assign_staff(uuid, uuid, text, timestamptz, uuid, text);

create or replace function assign_staff(
  p_case uuid,
  p_staff uuid,
  p_task text,
  p_eta timestamptz default null,
  p_backup_for uuid default null,
  p_role text default 'primary'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c record;
  s record;
  v_existing record;
  v_assignment_id uuid;
  v_role text := coalesce(p_role, 'primary');
begin
  if not has_role('coordinator','supervisor') then
    raise exception 'Only coordinators assign field staff';
  end if;

  select * into c from cases where id = p_case for update;
  if not found then raise exception 'Case not found'; end if;

  select * into s from profiles where id = p_staff and role = 'field_staff';
  if not found then raise exception 'Not a field staff member'; end if;

  if p_backup_for is not null then
    v_role := 'backup';
  end if;

  if v_role = 'primary' then
    select * into v_existing from assignments
    where case_id = p_case
      and status not in ('cancelled', 'reassigned')
      and role = 'primary'
    for update;

    if found then
      if v_existing.staff_id = p_staff then
        if p_eta is not null and v_existing.eta is distinct from p_eta then
          update assignments set eta = p_eta where id = v_existing.id;
        end if;
        update cases set order_status = 'assigned' where id = p_case and order_status is distinct from 'assigned';
        return v_existing.id;
      else
        update assignments set status = 'reassigned' where id = v_existing.id;
        perform log_interaction(p_case, 'field', 'internal',
          'Reassigned from ' || (select full_name from profiles where id = v_existing.staff_id) || ' to ' || s.full_name, null);
      end if;
    end if;
  end if;

  insert into assignments(
    workspace_id, case_id, staff_id, task, assigned_by, eta,
    window_start, window_end, backup_for, role, status
  )
  values (
    c.workspace_id, p_case, p_staff, p_task, app_uid(), p_eta,
    coalesce(c.booked_slot, now()) - interval '2 hours',
    coalesce(c.booked_slot, now()) + interval '4 hours',
    p_backup_for, v_role, 'assigned'
  )
  returning id into v_assignment_id;

  update cases set order_status = 'assigned' where id = p_case;

  perform log_interaction(p_case, 'field', 'internal',
    case when v_role = 'backup' then 'Backup assigned ' else 'Assigned ' end || s.full_name || ' (' || p_task || ')' ||
    coalesce(' · ETA ' || to_char(p_eta at time zone 'Asia/Kolkata','HH24:MI'), ''), null);

  return v_assignment_id;
exception
  when unique_violation then
    raise exception 'Concurrent assignment in progress' using errcode = '23505';
end $$;

-- 5. Updated v_assignments view with visit_id, order_id, role and lateral subqueries
drop view if exists v_assignments cascade;
create view v_assignments with (security_invoker = true) as
select
  a.*,
  a.id as visit_id,
  s.full_name as staff_name,
  s.phone as staff_phone,
  s.provider_id as staff_provider_id,
  c.case_no,
  c.booked_slot,
  c.priority,
  c.stage,
  c.order_status,
  c.address,
  c.pincode,
  p.full_name as patient_name,
  p.age as patient_age,
  p.gender as patient_gender,
  p.landmark,
  p.lat as patient_lat,
  p.lng as patient_lng,
  z.name as zone_name,
  (select string_agg(i.service_name, ', ') from case_items i where i.case_id = c.id) as service_names,
  lat_log.latest_log_text,
  lat_log.latest_log_at,
  lat_backup.backup_assignment_id,
  lat_backup.backup_staff_id,
  lat_backup.backup_staff_name,
  lat_backup.backup_status,
  lat_backup.backup_eta
from assignments a
join profiles s on s.id = a.staff_id
join cases c on c.id = a.case_id
join patients p on p.id = c.patient_id
left join zones z on z.id = c.zone_id
left join lateral (
  select i.summary as latest_log_text, i.occurred_at as latest_log_at
  from interactions i
  where i.case_id = c.id and i.channel = 'field'
  order by i.occurred_at desc limit 1
) lat_log on true
left join lateral (
  select b.id as backup_assignment_id, b.staff_id as backup_staff_id, bp.full_name as backup_staff_name, b.status as backup_status, b.eta as backup_eta
  from assignments b
  join profiles bp on bp.id = b.staff_id
  where b.backup_for = a.id and b.status not in ('cancelled', 'reassigned')
  order by b.assigned_at desc limit 1
) lat_backup on true;

grant select on v_assignments to caredesk_app;

-- 6. Extend v_cases with order_status if not present
do $$ declare v_def text; begin
  if not exists (select 1 from pg_attribute where attrelid = 'v_cases'::regclass and attname = 'order_status' and not attisdropped) then
    v_def := rtrim(trim(pg_get_viewdef('v_cases'::regclass, true)), ';');
    execute 'create or replace view v_cases with (security_invoker = true) as select previous.*, x.order_status from ('
      || v_def || ') previous left join lateral (select c.order_status from cases c where c.id = previous.id) x on true';
  end if;
end $$;

grant select on v_cases to caredesk_app;
