-- =====================================================================
-- Per-person live location switch for partner (BMM) field staff (21 Oct 2026).
--   * profiles.location_sharing: off by default. A partner field login (provider other than SecondMedic)
--     sends GPS only while it is on; SecondMedic field staff keep the existing My visits tracking.
--   * location_allowed(staff): the one rule, used by the staff_locations insert policy and the Worker's ping.
--   * set_location_sharing(staff, on): admin / supervisor, or that provider's own manager (provider login).
-- =====================================================================

alter table profiles add column if not exists location_sharing boolean not null default false;

create or replace function location_allowed(p_staff uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select p.location_sharing or p.provider_id is null
      or exists (select 1 from providers pv where pv.id = p.provider_id and pv.code = 'SM')
    from profiles p where p.id = p_staff and p.active), false)
$$;
revoke all on function location_allowed(uuid) from public;
grant execute on function location_allowed(uuid) to caredesk_app;

drop policy if exists staff_locations_insert on staff_locations;
create policy staff_locations_insert on staff_locations for insert with check (
  workspace_id = me_ws() and (
    (staff_id = app_uid() and location_allowed(app_uid()))
    or has_role('coordinator','supervisor','admin')
  )
);

create or replace function set_location_sharing(p_staff uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s profiles;
begin
  if p_on is null then raise exception 'Choose on or off'; end if;
  select * into s from profiles where id = p_staff and workspace_id = me_ws();
  if s.id is null or s.role <> 'field_staff' then raise exception 'Field staff login not found'; end if;
  if not (has_role('admin','supervisor') or (has_role('provider') and s.provider_id is not null and s.provider_id = me_provider())) then
    raise exception 'Only the provider manager, a supervisor or an administrator can change live location' using errcode = '42501';
  end if;
  update profiles set location_sharing = p_on where id = p_staff;
  return jsonb_build_object('id', p_staff, 'location_sharing', p_on);
end $$;
revoke all on function set_location_sharing(uuid, boolean) from public;
grant execute on function set_location_sharing(uuid, boolean) to caredesk_app;
