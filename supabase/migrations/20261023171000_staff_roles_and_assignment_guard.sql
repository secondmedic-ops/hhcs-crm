-- Migration: Staff roles, task-to-skill enforcement, single active primary assignment constraint,
-- and reassignment audit workflow.
-- Enforces:
-- 1. One active primary assignment per (case_id, task).
-- 2. Max 1 active backup assignment per (case_id, task).
-- 3. Dedicated reassign_staff RPC requiring mandatory reason, audit timeline log, and staff notification.
-- 4. Expanded roles (phlebotomist, nurse, physiotherapist, icu_nurse, eldercare_attendant,
--    delivery_executive, doctor, telecaller, lab_staff, accounts).
-- 5. Scope-limited RLS for field roles and accounts.

-- 1. Add new roles to app_role enum
alter type app_role add value if not exists 'phlebotomist';
alter type app_role add value if not exists 'nurse';
alter type app_role add value if not exists 'physiotherapist';
alter type app_role add value if not exists 'icu_nurse';
alter type app_role add value if not exists 'eldercare_attendant';
alter type app_role add value if not exists 'delivery_executive';
alter type app_role add value if not exists 'doctor';
alter type app_role add value if not exists 'telecaller';
alter type app_role add value if not exists 'lab_staff';
alter type app_role add value if not exists 'accounts';

-- 2. Schema columns
alter table assignments add column if not exists tests_list text;
alter table assignments add column if not exists fasting_required boolean default false;
alter table assignments add column if not exists tube_count int default 0;
alter table assignments add column if not exists sample_barcodes text[] default '{}';
alter table assignments add column if not exists lab_handover_at timestamptz;
alter table assignments add column if not exists override_reason text;
alter table assignments add column if not exists reassign_reason text;
alter table assignments add column if not exists reassign_note text;

alter table profiles add column if not exists pincodes text[] default '{}';
alter table profiles add column if not exists area text;
alter table profiles add column if not exists shift_timings text;

-- 3. Expand task and status check constraints
alter table assignments drop constraint if exists assignments_task_check;
alter table assignments add constraint assignments_task_check check (
  task in (
    'visit', 'phlebotomy', 'nursing', 'physio', 'icu_care', 'eldercare',
    'delivery', 'pickup', 'doctor_visit', 'ecg', 'xray'
  )
);

alter table assignments drop constraint if exists assignments_status_check;
alter table assignments add constraint assignments_status_check check (
  status in (
    'assigned', 'en_route', 'started', 'checked_in', 'reached', 'collected',
    'handed_to_lab', 'completed', 'cancelled', 'reassigned'
  )
);

-- 4. Deduplicate existing active assignments: keep earliest, mark rest as reassigned
update assignments set status = 'reassigned'
where id in (
  select id from (
    select id, row_number() over (partition by case_id, task order by assigned_at asc, id asc) as rn
    from assignments
    where role = 'primary' and status not in ('cancelled', 'reassigned', 'completed')
  ) t
  where t.rn > 1
);

update assignments set status = 'reassigned'
where id in (
  select id from (
    select id, row_number() over (partition by case_id, task order by assigned_at asc, id asc) as rn
    from assignments
    where role = 'backup' and status not in ('cancelled', 'reassigned', 'completed')
  ) t
  where t.rn > 1
);

-- 5. Drop previous single-column index on order_id and replace with per-task partial unique indices
drop index if exists idx_assignments_unique_active_primary;

create unique index if not exists idx_assignments_unique_active_task
  on assignments (case_id, task)
  where role = 'primary' and status not in ('cancelled', 'reassigned', 'completed', 'handed_to_lab');

create unique index if not exists idx_assignments_unique_active_backup
  on assignments (case_id, task)
  where role = 'backup' and status not in ('cancelled', 'reassigned', 'completed', 'handed_to_lab');

-- 6. Updated assign_staff function
drop function if exists assign_staff(uuid, uuid, text, timestamptz, uuid);
drop function if exists assign_staff(uuid, uuid, text, timestamptz, uuid, text);
drop function if exists assign_staff(uuid, uuid, text, timestamptz, uuid, text, text);

create or replace function assign_staff(
  p_case uuid,
  p_staff uuid,
  p_task text,
  p_eta timestamptz default null,
  p_backup_for uuid default null,
  p_role text default 'primary',
  p_override_reason text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c record;
  s record;
  v_existing record;
  v_existing_backup record;
  v_primary record;
  v_assignment_id uuid;
  v_role text := coalesce(p_role, 'primary');
  v_clash record;
  v_window_start timestamptz;
  v_window_end timestamptz;
begin
  if not has_role('coordinator','supervisor') then
    raise exception 'Only coordinators assign field staff';
  end if;

  select * into c from cases where id = p_case for update;
  if not found then raise exception 'Case not found'; end if;

  select * into s from profiles where id = p_staff
    and role::text in ('field_staff', 'phlebotomist', 'nurse', 'physiotherapist', 'icu_nurse', 'eldercare_attendant', 'delivery_executive', 'doctor');
  if not found then raise exception 'Not a field staff member'; end if;

  if not s.active then
    raise exception 'Staff % is inactive', s.full_name;
  end if;

  -- Skill check: staff must have skill for task
  if p_task <> 'visit' then
    if not (
      s.role::text = 'field_staff' or
      (p_task = any(coalesce(s.skills, '{}'::text[]))) or
      (p_task = 'phlebotomy' and s.role::text = 'phlebotomist') or
      (p_task = 'nursing' and s.role::text in ('nurse', 'icu_nurse')) or
      (p_task = 'physio' and s.role::text = 'physiotherapist') or
      (p_task = 'icu_care' and s.role::text = 'icu_nurse') or
      (p_task = 'eldercare' and s.role::text = 'eldercare_attendant') or
      (p_task in ('delivery', 'pickup') and s.role::text = 'delivery_executive') or
      (p_task = 'doctor_visit' and s.role::text = 'doctor')
    ) then
      raise exception 'Staff % does not have skill for task %', s.full_name, p_task;
    end if;
  end if;

  if p_backup_for is not null then
    v_role := 'backup';
  end if;

  -- Primary duplicate / conflict check
  if v_role = 'primary' then
    select * into v_existing from assignments
    where case_id = p_case
      and task = p_task
      and status not in ('cancelled', 'reassigned', 'completed')
      and role = 'primary'
    for update;

    if found then
      if v_existing.staff_id = p_staff then
        -- Idempotent: same staff, update eta if provided
        if p_eta is not null and v_existing.eta is distinct from p_eta then
          update assignments set eta = p_eta where id = v_existing.id;
        end if;
        update cases set order_status = 'assigned' where id = p_case and order_status is distinct from 'assigned';
        return v_existing.id;
      else
        -- Duplicate attempted for same task with another person!
        raise exception '% is already assigned to %. Use Reassign.',
          initcap(p_task),
          (select full_name from profiles where id = v_existing.staff_id)
          using errcode = '23505';
      end if;
    end if;
  end if;

  -- Backup check
  if v_role = 'backup' then
    select * into v_primary from assignments
    where id = p_backup_for and status not in ('cancelled', 'reassigned', 'completed');
    if not found then
      raise exception 'Primary assignment not found or already closed';
    end if;

    if v_primary.staff_id = p_staff then
      raise exception 'Backup cannot be the same person as the primary';
    end if;

    select * into v_existing_backup from assignments
    where case_id = p_case
      and task = p_task
      and role = 'backup'
      and status not in ('cancelled', 'reassigned', 'completed')
    for update;

    if found then
      if v_existing_backup.staff_id = p_staff then
        return v_existing_backup.id;
      else
        raise exception 'A backup is already assigned for %: %',
          initcap(p_task),
          (select full_name from profiles where id = v_existing_backup.staff_id)
          using errcode = '23505';
      end if;
    end if;
  end if;

  -- Schedule clash check: booked slot ± 45 minutes / SLA window
  v_window_start := coalesce(p_eta, c.booked_slot, now()) - interval '45 minutes';
  v_window_end   := coalesce(p_eta, c.booked_slot, now()) + interval '45 minutes';

  select a.*, oc.case_no as other_case_no into v_clash
  from assignments a
  join cases oc on oc.id = a.case_id
  where a.staff_id = p_staff
    and a.case_id <> p_case
    and a.status in ('assigned', 'en_route', 'started', 'checked_in', 'reached')
    and (
      (a.eta is not null and a.eta between v_window_start and v_window_end)
      or (oc.booked_slot is not null and oc.booked_slot between v_window_start and v_window_end)
    )
  limit 1;

  if found then
    if not has_role('supervisor') or coalesce(trim(p_override_reason), '') = '' then
      raise exception 'Staff clash: % already has an active visit for % at % (SLA overlap). Supervisor override with reason required.',
        s.full_name, v_clash.other_case_no, to_char(coalesce(v_clash.eta, v_clash.booked_slot) at time zone 'Asia/Kolkata', 'HH24:MI')
        using errcode = 'P0001';
    end if;
  end if;

  begin
    insert into assignments(
      workspace_id, case_id, staff_id, task, assigned_by, eta,
      window_start, window_end, backup_for, role, status, override_reason
    )
    values (
      c.workspace_id, p_case, p_staff, p_task, app_uid(), p_eta,
      coalesce(c.booked_slot, now()) - interval '2 hours',
      coalesce(c.booked_slot, now()) + interval '4 hours',
      p_backup_for, v_role, 'assigned', p_override_reason
    )
    returning id into v_assignment_id;
  exception
    when unique_violation then
      select a.*, p.full_name as existing_staff_name into v_existing
      from assignments a
      join profiles p on p.id = a.staff_id
      where a.case_id = p_case and a.task = p_task
        and a.status not in ('cancelled', 'reassigned', 'completed', 'handed_to_lab')
        and a.role = 'primary'
      limit 1;

      if v_existing.id is not null then
        raise exception '% is already assigned to %. Use Reassign.',
          initcap(replace(p_task, '_', ' ')), v_existing.existing_staff_name
          using errcode = '23505';
      else
        raise exception '% is already assigned. Use Reassign.', initcap(replace(p_task, '_', ' '))
          using errcode = '23505';
      end if;
  end;

  update cases set order_status = 'assigned' where id = p_case;

  perform log_interaction(p_case, 'field', 'internal',
    case when v_role = 'backup' then 'Backup assigned ' else 'Assigned ' end || s.full_name || ' (' || p_task || ')' ||
    coalesce(' · ETA ' || to_char(p_eta at time zone 'Asia/Kolkata','HH24:MI'), '') ||
    case when p_override_reason is not null then ' · Supervisor override: ' || p_override_reason else '' end, null);

  -- Notify assigned staff
  insert into notifications(workspace_id, user_id, kind, title, body, link)
  values (
    c.workspace_id, p_staff, 'field_assignment',
    'New ' || p_task || ' assignment · ' || c.case_no,
    'You have been assigned to ' || c.case_no || coalesce(' · ETA ' || to_char(p_eta at time zone 'Asia/Kolkata','HH24:MI'), ''),
    '/my-visits'
  );

  return v_assignment_id;
end $$;

-- 7. Dedicated reassign_staff function
create or replace function reassign_staff(
  p_case uuid,
  p_assignment uuid,
  p_staff uuid,
  p_reason text,
  p_eta timestamptz default null,
  p_note text default null,
  p_override_reason text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c record;
  s record;
  v_old record;
  v_assignment_id uuid;
  v_clash record;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_reason_label text;
begin
  if not has_role('coordinator','supervisor') then
    raise exception 'Only coordinators assign field staff';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reassignment reason is mandatory';
  end if;

  if p_reason = 'other' and coalesce(trim(p_note), '') = '' then
    raise exception 'Please specify a note for other reason';
  end if;

  select * into c from cases where id = p_case for update;
  if not found then raise exception 'Case not found'; end if;

  select * into v_old from assignments
  where id = p_assignment and case_id = p_case
  for update;
  if not found then raise exception 'Assignment not found'; end if;

  if v_old.status in ('cancelled', 'reassigned', 'completed') then
    raise exception 'Assignment is already %', v_old.status;
  end if;

  if v_old.staff_id = p_staff then
    raise exception 'Cannot reassign to the same staff member';
  end if;

  select * into s from profiles where id = p_staff
    and role::text in ('field_staff', 'phlebotomist', 'nurse', 'physiotherapist', 'icu_nurse', 'eldercare_attendant', 'delivery_executive', 'doctor');
  if not found then raise exception 'Not a field staff member'; end if;

  if not s.active then raise exception 'Staff % is inactive', s.full_name; end if;

  -- Skill check for new staff
  if v_old.task <> 'visit' then
    if not (
      s.role::text = 'field_staff' or
      (v_old.task = any(coalesce(s.skills, '{}'::text[]))) or
      (v_old.task = 'phlebotomy' and s.role::text = 'phlebotomist') or
      (v_old.task = 'nursing' and s.role::text in ('nurse', 'icu_nurse')) or
      (v_old.task = 'physio' and s.role::text = 'physiotherapist') or
      (v_old.task = 'icu_care' and s.role::text = 'icu_nurse') or
      (v_old.task = 'eldercare' and s.role::text = 'eldercare_attendant') or
      (v_old.task in ('delivery', 'pickup') and s.role::text = 'delivery_executive') or
      (v_old.task = 'doctor_visit' and s.role::text = 'doctor')
    ) then
      raise exception 'Staff % does not have skill for task %', s.full_name, v_old.task;
    end if;
  end if;

  -- Schedule clash check
  v_window_start := coalesce(p_eta, v_old.eta, c.booked_slot, now()) - interval '45 minutes';
  v_window_end   := coalesce(p_eta, v_old.eta, c.booked_slot, now()) + interval '45 minutes';

  select a.*, oc.case_no as other_case_no into v_clash
  from assignments a
  join cases oc on oc.id = a.case_id
  where a.staff_id = p_staff
    and a.case_id <> p_case
    and a.status in ('assigned', 'en_route', 'started', 'checked_in', 'reached')
    and (
      (a.eta is not null and a.eta between v_window_start and v_window_end)
      or (oc.booked_slot is not null and oc.booked_slot between v_window_start and v_window_end)
    )
  limit 1;

  if found then
    if not has_role('supervisor') or coalesce(trim(p_override_reason), '') = '' then
      raise exception 'Staff clash: % already has an active visit for % at % (SLA overlap). Supervisor override with reason required.',
        s.full_name, v_clash.other_case_no, to_char(coalesce(v_clash.eta, v_clash.booked_slot) at time zone 'Asia/Kolkata', 'HH24:MI')
        using errcode = 'P0001';
    end if;
  end if;

  -- Mark old assignment reassigned
  update assignments set
    status = 'reassigned',
    reassign_reason = p_reason,
    reassign_note = p_note
  where id = v_old.id;

  -- Insert new assignment
  insert into assignments(
    workspace_id, case_id, staff_id, task, assigned_by, eta,
    window_start, window_end, backup_for, role, status, override_reason,
    tests_list, fasting_required, tube_count
  )
  values (
    c.workspace_id, p_case, p_staff, v_old.task, app_uid(), coalesce(p_eta, v_old.eta),
    v_old.window_start, v_old.window_end, v_old.backup_for, 'primary', 'assigned', p_override_reason,
    v_old.tests_list, v_old.fasting_required, v_old.tube_count
  )
  returning id into v_assignment_id;

  v_reason_label := case p_reason
    when 'staff_unavailable' then 'Staff unavailable'
    when 'patient_request' then 'Patient request'
    when 'no_show' then 'No-show'
    else coalesce(p_note, 'Other')
  end;

  -- Case timeline & audit log
  perform log_interaction(p_case, 'field', 'internal',
    'Reassigned ' || v_old.task || ' from ' || (select full_name from profiles where id = v_old.staff_id) ||
    ' to ' || s.full_name || ' · Reason: ' || v_reason_label ||
    case when p_note is not null and p_reason <> 'other' then ' (' || p_note || ')' else '' end ||
    case when p_override_reason is not null then ' · Supervisor override: ' || p_override_reason else '' end, null);

  -- Notify previous staff
  insert into notifications(workspace_id, user_id, kind, title, body, link)
  values (
    c.workspace_id, v_old.staff_id, 'field_assignment',
    'Visit reassigned · ' || c.case_no,
    'Your ' || v_old.task || ' assignment for ' || c.case_no || ' has been reassigned (' || v_reason_label || ').',
    '/my-visits'
  );

  -- Notify new staff
  insert into notifications(workspace_id, user_id, kind, title, body, link)
  values (
    c.workspace_id, p_staff, 'field_assignment',
    'New ' || v_old.task || ' assignment · ' || c.case_no,
    'You have been reassigned to ' || c.case_no || coalesce(' · ETA ' || to_char(coalesce(p_eta, v_old.eta) at time zone 'Asia/Kolkata','HH24:MI'), ''),
    '/my-visits'
  );

  return v_assignment_id;
end $$;

-- 7b. has_role overload accepting text[] to avoid PostgreSQL unsafe enum cast in the same transaction
create or replace function has_role(variadic roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role::text = any(roles)
      or (role::text = 'administrator'
          and roles && array['supervisor','client_manager','client_clinical','coordinator','medical_desk'])
    from profiles where id = app_uid() and active), false)
$$;
grant execute on function has_role(text[]) to caredesk_app;

-- 8. Updated can_see_case function covering all field roles, telecaller, and accounts
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
      or (has_role('coordinator','field_staff','nurse','doctor','physiotherapist') and (
            c.coordinator_id = app_uid()
            or exists (select 1 from discharge_assessments d where d.case_id = c.id and d.nurse_id = app_uid() and d.status <> 'cancelled')))
      or (has_role('agent','telecaller') and (c.owner_id = app_uid() or c.created_by = app_uid() or c.owner_id is null
                                 or (c.stage not in ('closed','cancelled') and c.created_at > now() - interval '2 days')))
      or (has_role('field_staff','phlebotomist','nurse','physiotherapist','icu_nurse','eldercare_attendant','delivery_executive','doctor')
          and exists (select 1 from assignments a where a.case_id = c.id and a.staff_id = app_uid()
                      and (a.status in ('assigned','en_route','started','checked_in','reached','collected','handed_to_lab')
                           or (a.status = 'completed' and a.checkout_at > now() - interval '12 hours'))))
      or (has_role('provider') and exists (select 1 from case_referrals r where r.case_id = c.id and r.provider_id = me_provider()
                                                                         and r.status <> 'cancelled'))
      or (has_role('accounts') and (
            exists (select 1 from payments py where py.case_id = c.id)
            or c.payment_status in ('paid', 'partial', 'unpaid', 'reconciled')
          ))
      or (has_role('lab_staff') and exists (select 1 from samples sm where sm.case_id = c.id))
    ))
$$;

-- 8c. Update patients and interactions RLS policies to cover new field roles, accounts and lab staff
drop policy if exists patients_read on patients;
create policy patients_read on patients for select using (
  workspace_id = me_ws() and (
    has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical','telecaller')
    or (has_role('field_staff','phlebotomist','nurse','physiotherapist','icu_nurse','eldercare_attendant','delivery_executive','doctor','provider')
        and exists (select 1 from cases c where c.patient_id = patients.id and can_see_case(c.id)))
    or (has_role('accounts') and exists (select 1 from cases c where c.patient_id = patients.id and can_see_case(c.id)))
    or (has_role('lab_staff') and exists (select 1 from cases c where c.patient_id = patients.id and can_see_case(c.id)))
  )
);

drop policy if exists interactions_insert on interactions;
create policy interactions_insert on interactions for insert with check (
  workspace_id = me_ws()
  and (is_ops() or has_role('field_staff','phlebotomist','nurse','physiotherapist','icu_nurse','eldercare_attendant','delivery_executive','doctor','provider'))
  and channel in ('note','field')
  and actor_id = app_uid()
  and (case_id is null or can_see_case(case_id))
);

drop policy if exists esc_read on escalations;
create policy esc_read on escalations for select using (
  workspace_id = me_ws()
  and (not has_role('admin','field_staff','phlebotomist','nurse','physiotherapist','icu_nurse','eldercare_attendant','delivery_executive','doctor','provider') or raised_by = app_uid())
);

drop policy if exists esc_insert on escalations;
create policy esc_insert on escalations for insert with check (
  workspace_id = me_ws()
  and (is_ops() or has_role('field_staff','phlebotomist','nurse','physiotherapist','icu_nurse','eldercare_attendant','delivery_executive','doctor','client_manager','client_clinical') or (has_role('provider') and can_see_case(case_id)))
);

-- 8b. Update field_update RPC to handle Phlebotomy lifecycle and additional status hops
create or replace function field_update(p_assignment uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a record;
  c record;
  pt record;
  v_dist int;
  v_var int;
  v_now timestamptz := now();
  v_new_status text;
begin
  select * into a from assignments where id = p_assignment;
  if not (a.staff_id = app_uid() or has_role('coordinator','supervisor','admin')) then
    raise exception 'Not your visit';
  end if;

  select * into c from cases where id = a.case_id;
  select * into pt from patients where id = c.patient_id;

  if p_action in ('en_route', 'start', 'started') then
    v_new_status := case when p_action in ('start', 'started') then 'started' else 'en_route' end;
    update assignments
    set status = v_new_status, eta = coalesce(nullif(p->>'eta','')::timestamptz, eta)
    where id = p_assignment;

    perform log_interaction(a.case_id, 'field', 'internal',
      case when a.task = 'phlebotomy' then 'Phlebotomist started journey' else 'Technician en route' end ||
      coalesce(' · ETA ' || to_char((p->>'eta')::timestamptz at time zone 'Asia/Kolkata','HH24:MI'),''), null);

  elsif p_action in ('checkin', 'reached') then
    if pt.lat is not null and pt.lng is not null and (p->>'lat') is not null and (p->>'lng') is not null then
      v_dist := haversine_m(pt.lat, pt.lng, (p->>'lat')::float8, (p->>'lng')::float8);
    end if;
    v_var := round(extract(epoch from (v_now - coalesce(a.eta, a.window_start, c.booked_slot))) / 60)::int;
    v_new_status := case when p_action = 'reached' then 'reached' else 'checked_in' end;

    update assignments
    set status = v_new_status,
        checkin_at = v_now,
        actual_arrival_at = coalesce(actual_arrival_at, v_now),
        checkin_lat = nullif(p->>'lat','')::float8,
        checkin_lng = nullif(p->>'lng','')::float8,
        checkin_distance_m = v_dist,
        eta_vs_ata_variance_min = v_var
    where id = p_assignment;

    if (p->>'lat') is not null and (p->>'lng') is not null then
      insert into staff_locations(workspace_id, staff_id, assignment_id, case_id, lat, lng, recorded_at)
      values (a.workspace_id, a.staff_id, a.id, a.case_id, (p->>'lat')::float8, (p->>'lng')::float8, v_now);
    end if;

    perform log_interaction(a.case_id, 'field', 'internal',
      case when a.task = 'phlebotomy' then 'Phlebotomist reached patient address' else 'Geo-tagged check-in at patient address' end ||
      coalesce(' · ' || v_dist || ' m from pin', '') || coalesce(' · ATA ' || to_char(v_now at time zone 'Asia/Kolkata','HH24:MI'),''),
      null,
      case when (p->>'lat') is not null then 'GPS ' || round((p->>'lat')::numeric,5) || ',' || round((p->>'lng')::numeric,5) else null end);

  elsif p_action = 'collected' then
    update assignments
    set status = 'collected',
        tube_count = coalesce((p->>'tube_count')::int, tube_count),
        sample_barcodes = case
          when p->'sample_barcodes' is not null then array(select jsonb_array_elements_text(p->'sample_barcodes'))
          else sample_barcodes
        end,
        checklist = coalesce(p->'checklist', checklist)
    where id = p_assignment;

    perform log_interaction(a.case_id, 'field', 'internal',
      'Samples collected · ' || coalesce(p->>'tube_count', '0') || ' tubes' ||
      case when p->'sample_barcodes' is not null then ' · Barcodes: ' || (p->>'sample_barcodes') else '' end, null);

  elsif p_action in ('handed_to_lab', 'handover') then
    update assignments
    set status = 'handed_to_lab',
        lab_handover_at = coalesce((p->>'lab_handover_at')::timestamptz, v_now),
        checkout_at = v_now,
        patient_signoff = coalesce((p->>'signoff')::boolean, patient_signoff)
    where id = p_assignment;

    perform log_interaction(a.case_id, 'field', 'internal',
      'Sample handed over to lab · Handover at ' || to_char(coalesce((p->>'lab_handover_at')::timestamptz, v_now) at time zone 'Asia/Kolkata', 'HH24:MI') ||
      coalesce(' · ' || (p->>'lab_notes'), ''), null);

    if not exists (select 1 from assignments where case_id = a.case_id and status not in ('completed','handed_to_lab','cancelled','reassigned')) then
      perform rpc_on();
      update cases set service_completed_at = v_now where id = a.case_id;
    end if;

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
    if not exists (select 1 from assignments where case_id = a.case_id and status not in ('completed','handed_to_lab','cancelled','reassigned')) then
      perform rpc_on();
      update cases set service_completed_at = v_now where id = a.case_id;
    end if;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return jsonb_build_object('ok', true, 'distance_m', v_dist, 'actual_arrival_at', v_now, 'variance_min', v_var);
end $$;

grant execute on function field_update(uuid, text, jsonb) to caredesk_app;

-- 9. Recreate v_assignments view to capture new columns and roles
drop view if exists v_assignments cascade;
create view v_assignments with (security_invoker = true) as
select
  a.*,
  a.id as visit_id,
  s.full_name as staff_name,
  s.phone as staff_phone,
  s.role as staff_role,
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
grant execute on function assign_staff(uuid, uuid, text, timestamptz, uuid, text, text) to caredesk_app;
grant execute on function reassign_staff(uuid, uuid, uuid, text, timestamptz, text, text) to caredesk_app;

-- 10. Update case_gates to support all field lifecycle statuses (reached, collected, handed_to_lab)
create or replace function case_gates(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c record;
  p record;
  v_to case_stage;
  checks jsonb := '[]'::jsonb;
  v_items int;
  v_lab int;
  v_samples int;
  v_checked int;
  v_open_asg int;
  v_open_cmp int;
  v_svc_done boolean;
  v_pay_done boolean;
  v_ref_done boolean;
  v_dep_done boolean;
  v_has_esc boolean;
  v_needs_esc boolean;
begin
  select * into c from cases where id = p_case;
  if not found then raise exception 'Case not found'; end if;
  select * into p from patients where id = c.patient_id;
  v_to := next_stage(c.stage);
  select count(*) filter (where not excluded), count(*) filter (where category = 'lab' and not excluded)
    into v_items, v_lab from case_items where case_id = p_case;

  if c.stage = 'enquiry' then
    checks := jsonb_build_array(
      jsonb_build_object('label','Patient name and mobile', 'ok', p.full_name is not null and p.mobile is not null),
      jsonb_build_object('label','Address and pincode', 'ok', coalesce(c.address,'') <> '' and coalesce(c.pincode,'') <> ''),
      jsonb_build_object('label','Services requested noted', 'ok', coalesce(c.services_requested,'') <> '' or v_items > 0),
      jsonb_build_object('label','Consent recorded', 'ok', p.consent_verbal_at is not null or p.consent_digital_at is not null));
    if c.care_type = 'post_discharge' then
      checks := checks || jsonb_build_array(
        jsonb_build_object('label','Interaction reason recorded', 'ok', c.intake_disposition = 'requirement_captured'),
        jsonb_build_object('label','Spoke with patient or decision-maker', 'ok', c.spoke_with in ('patient','decision_maker')),
        jsonb_build_object('label','Expected discharge date', 'ok', c.expected_discharge_on is not null),
        jsonb_build_object('label','On-site validation done, discharge ready', 'ok', c.validation_status = 'done'),
        jsonb_build_object('label','Recommended item list', 'ok', exists (select 1 from case_items i where i.case_id = p_case and i.recommended)));
    end if;
  elsif c.stage = 'pricing' then
    checks := jsonb_build_array(
      jsonb_build_object('label','At least one rate-card service', 'ok', v_items > 0),
      jsonb_build_object('label','Discount approved (if above band)', 'ok', c.quote_status in ('approved','sent')),
      jsonb_build_object('label','Quote sent on approved template', 'ok', c.quote_status = 'sent'));
    if c.care_type = 'post_discharge' then
      checks := checks || jsonb_build_array(
        jsonb_build_object('label','Family commercial sign-off', 'ok', c.signoff_at is not null));
    end if;
  elsif c.stage = 'booking' then
    checks := jsonb_build_array(
      jsonb_build_object('label','Slot booked', 'ok', c.booked_slot is not null),
      jsonb_build_object('label','Address verified', 'ok', coalesce(c.address,'') <> ''),
      jsonb_build_object('label','Confirmation sent to patient', 'ok', c.booking_confirmed_at is not null),
      jsonb_build_object('label','Coordinator assigned', 'ok', c.coordinator_id is not null));
  elsif c.stage = 'deployment' then
    select count(*) into v_checked from assignments where case_id = p_case and status in ('checked_in', 'reached', 'collected', 'handed_to_lab', 'completed');
    checks := jsonb_build_array(
      jsonb_build_object('label','Field resource assigned', 'ok', exists(select 1 from assignments where case_id = p_case and status not in ('cancelled','reassigned'))),
      jsonb_build_object('label','Geo-tagged check-in at address', 'ok', v_checked > 0));
  elsif c.stage = 'completion' then
    select count(*) into v_open_asg from assignments where case_id = p_case and status not in ('completed','handed_to_lab','cancelled','reassigned');
    select count(*) into v_samples from samples where case_id = p_case and collected_at is not null;
    checks := jsonb_build_array(
      jsonb_build_object('label','All visits completed with patient sign-off', 'ok', v_open_asg = 0 and exists(select 1 from assignments where case_id = p_case and (status = 'completed' or status = 'handed_to_lab') and (patient_signoff or status = 'handed_to_lab'))),
      jsonb_build_object('label','Samples barcoded / ECG / X-ray captured', 'ok', v_samples > 0 or v_lab = 0));
  elsif c.stage = 'payment' then
    checks := jsonb_build_array(
      jsonb_build_object('label','Amount collected', 'ok', c.amount_collected >= c.total or c.payment_status = 'waived'),
      jsonb_build_object('label','Reconciled against gateway / bank', 'ok', c.payment_status in ('reconciled','waived') or c.total = 0));
  elsif c.stage = 'closure' then
    select count(*) into v_open_cmp from complaints where case_id = p_case and status in ('open','acknowledged');

    v_svc_done := (c.service_completed_at is not null);
    v_pay_done := (c.payment_status in ('reconciled', 'waived')) or (c.total <= c.amount_collected);
    v_ref_done := not exists (
      select 1 from case_referrals
      where case_id = p_case
        and (status in ('new', 'accepted', 'scheduled', 'dispatched') or status not in ('completed', 'declined', 'cancelled'))
    );
    v_dep_done := not exists (
      select 1 from partner_deployments
      where case_id = p_case and status = 'dispatched'
    );

    v_has_esc := exists (
      select 1 from escalations e join profiles rp on rp.id = e.resolved_by
      where e.case_id = p_case and e.status = 'resolved'
        and e.type in ('operational', 'billing')
        and e.resolution_notes is not null
        -- waiver = resolved by a supervisor / Hinduja management / administrator who did not raise it
        and rp.role in ('supervisor', 'client_manager', 'administrator')
        and e.resolved_by is distinct from e.raised_by
    );

    v_needs_esc := (not v_svc_done) or (c.total > c.amount_collected and c.payment_status not in ('reconciled', 'waived'));

    checks := jsonb_build_array(
      jsonb_build_object('label','Report delivered', 'ok', c.report_status in ('delivered','na')),
      jsonb_build_object('label','No open complaints', 'ok', v_open_cmp = 0),
      jsonb_build_object('label','Feedback captured', 'ok', c.feedback_rating is not null),
      jsonb_build_object('label','Service completion', 'ok', v_svc_done or v_has_esc),
      jsonb_build_object('label','Zero pending referrals', 'ok', v_ref_done),
      jsonb_build_object('label','Equipment returned / active handover', 'ok', v_dep_done),
      jsonb_build_object('label','Payment settled or waived', 'ok', v_pay_done or v_has_esc)
    );

    if v_needs_esc or v_has_esc then
      checks := checks || jsonb_build_array(
        jsonb_build_object('label','Pending payment/service documented & supervisor approved', 'ok', v_has_esc)
      );
    end if;
  end if;

  return jsonb_build_object('stage', c.stage, 'next', v_to, 'checks', checks,
    'ready', not exists (select 1 from jsonb_array_elements(checks) x where (x->>'ok')::boolean = false));
end $$;

grant execute on function case_gates(uuid) to caredesk_app;
