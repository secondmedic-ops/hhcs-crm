-- Migration: Minimum 7-Day Billing Rule for Equipment
-- HHCS Policy: Every Homecare booking carries a mandatory minimum of 7 days
-- of service charges for EQUIPMENT, while MANPOWER services are billed only
-- for actual days/visits utilised.
--
-- Features:
-- 1. services.billing_category: 'EQUIPMENT' | 'MANPOWER' | 'OTHER' (admin-configurable).
-- 2. workspaces.settings.min_equipment_billing_days: defaults to 7 (admin-editable).
-- 3. case_items: tracks actual_days, billable_days, min_rule_applied, min_days_applied,
--    and admin override (override_min_applied, override_reason, override_by, override_at).
-- 4. trg_item_price() enforces minimum 7 days on EQUIPMENT lines unless overridden.
-- 5. RPC override_item_minimum: supervisor/admin override with mandatory audit reason.
-- 6. RPC set_min_equipment_billing_days: admin/supervisor configuration.

-- 1. Add billing_category to services
alter table services add column if not exists billing_category text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'services_billing_category_check') then
    alter table services add constraint services_billing_category_check
      check (billing_category is null or billing_category in ('EQUIPMENT', 'MANPOWER', 'OTHER'));
  end if;
end $$;

-- Baseline classification of services
update services set billing_category = case
  when category in ('equipment', 'beds')
    or code ~* 'vent|bipap|cpap|monitor|pump|suction|wheelchair|mattress|oxygen|o2|cylinder|walker|apparatus|probe' then 'EQUIPMENT'
  when category in ('nursing', 'eldercare', 'physio', 'visit')
    or code ~* 'doctor|nurse|physio|attendant|caretaker|dressing' then 'MANPOWER'
  else 'OTHER'
end
where billing_category is null;

-- 2. Set min_equipment_billing_days in workspace settings
update workspaces
   set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('min_equipment_billing_days', 7)
 where not (coalesce(settings, '{}'::jsonb) ? 'min_equipment_billing_days');

create or replace function get_min_equipment_billing_days(p_ws uuid) returns int
language sql stable security definer set search_path = public as $$
  select least(365, greatest(1, coalesce((settings->>'min_equipment_billing_days')::int, 7)))
    from workspaces where id = p_ws;
$$;

create or replace function set_min_equipment_billing_days(p_days int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ws uuid := me_ws();
  v_val int;
begin
  if not has_role('supervisor', 'admin', 'client_manager') then
    raise exception 'Only administrators, supervisors and Hinduja managers can change billing policies' using errcode = 'P0001';
  end if;

  if p_days < 1 or p_days > 90 then
    raise exception 'Minimum billing days must be between 1 and 90' using errcode = 'P0001';
  end if;

  v_val := p_days;
  update workspaces
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('min_equipment_billing_days', v_val)
   where id = v_ws;

  insert into audit_log(workspace_id, actor_id, action, entity, entity_id, meta)
  values (v_ws, app_uid(), 'settings_changed', 'min_equipment_billing_days', v_ws::text, jsonb_build_object('days', v_val));

  return jsonb_build_object('min_equipment_billing_days', v_val);
end $$;

grant execute on function set_min_equipment_billing_days(int) to caredesk_app;

create or replace function get_min_equipment_billing_days() returns int
language sql stable security definer set search_path = public as $$
  select least(365, greatest(1, coalesce((settings->>'min_equipment_billing_days')::int, 7)))
    from workspaces where id = me_ws();
$$;

grant execute on function get_min_equipment_billing_days() to caredesk_app;
grant execute on function get_min_equipment_billing_days(uuid) to caredesk_app;

create or replace function set_service_billing_category(
  p_service uuid,
  p_billing_category text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ws uuid := me_ws();
  v_cat text := upper(trim(p_billing_category));
begin
  if not has_role('supervisor', 'admin') then
    raise exception 'Only administrators and supervisors can configure service billing category' using errcode = 'P0001';
  end if;

  if v_cat not in ('EQUIPMENT', 'MANPOWER', 'OTHER') then
    raise exception 'Billing category must be EQUIPMENT, MANPOWER, or OTHER' using errcode = 'P0001';
  end if;

  update services
     set billing_category = v_cat
   where id = p_service and workspace_id = v_ws;
  if not found then raise exception 'Service not found'; end if;

  insert into audit_log(workspace_id, actor_id, action, entity, entity_id, meta)
  values (v_ws, app_uid(), 'service_category_changed', 'service', p_service::text, jsonb_build_object('billing_category', v_cat));

  return jsonb_build_object('ok', true, 'service_id', p_service, 'billing_category', v_cat);
end $$;

grant execute on function set_service_billing_category(uuid, text) to caredesk_app;

-- 3. Add minimum billing and audit columns to case_items
alter table case_items add column if not exists billing_category text;
alter table case_items add column if not exists actual_days int default 1;
alter table case_items add column if not exists billable_days int default 1;
alter table case_items add column if not exists min_rule_applied boolean not null default false;
alter table case_items add column if not exists min_days_applied int;
alter table case_items add column if not exists override_min_applied boolean not null default false;
alter table case_items add column if not exists override_reason text;
alter table case_items add column if not exists override_by uuid references profiles(id);
alter table case_items add column if not exists override_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'case_items_billing_category_check') then
    alter table case_items add constraint case_items_billing_category_check
      check (billing_category is null or billing_category in ('EQUIPMENT', 'MANPOWER', 'OTHER'));
  end if;
end $$;

-- Backfill existing lines preserving historical totals untouched
update case_items set
  billing_category = coalesce(billing_category, case
    when category in ('equipment', 'beds') then 'EQUIPMENT'
    when category in ('nursing', 'eldercare', 'physio', 'visit') then 'MANPOWER'
    else 'OTHER' end),
  actual_days = coalesce(actual_days, qty, 1),
  billable_days = coalesce(billable_days, qty, 1),
  min_rule_applied = coalesce(min_rule_applied, false),
  min_days_applied = coalesce(min_days_applied, 7)
where billing_category is null or min_days_applied is null;

-- 4. Pricing trigger enforcing 7-day equipment rule on new and updated lines
create or replace function trg_item_price() returns trigger language plpgsql security definer set search_path = public as $$
declare
  s record;
  c record;
  v_min_days int;
  v_daily numeric;
begin
  select * into c from cases where id = new.case_id;
  if c.stage not in ('enquiry','pricing') and not is_service() then
    raise exception 'Services can only be changed during Enquiry or Pricing';
  end if;

  if tg_op = 'INSERT' or new.service_id is distinct from old.service_id or current_setting('app.price_refresh', true) = 'on' then
    select * into s from services where id = new.service_id and workspace_id = c.workspace_id and active;
    if not found then raise exception 'Service is not on the approved rate card'; end if;
    new.unit_price := s.price;          -- any client-supplied price is ignored
    new.service_code := s.code;
    new.service_name := s.name;
    new.category := s.category;
    new.billing_category := coalesce(s.billing_category, case
      when s.category in ('equipment', 'beds') then 'EQUIPMENT'
      when s.category in ('nursing', 'eldercare', 'physio', 'visit') then 'MANPOWER'
      else 'OTHER' end);
    new.unit := s.unit;
    new.price_version := s.version;
    new.price_tax_basis := s.tax_basis;
    new.priced_at := now();
  else
    new.unit_price := old.unit_price;
    new.service_code := old.service_code;
    new.service_name := old.service_name;
    new.category := old.category;
    new.billing_category := coalesce(old.billing_category, case
      when old.category in ('equipment', 'beds') then 'EQUIPMENT'
      when old.category in ('nursing', 'eldercare', 'physio', 'visit') then 'MANPOWER'
      else 'OTHER' end);
    new.unit := old.unit;
    new.price_version := old.price_version;
    new.price_tax_basis := old.price_tax_basis;
    new.priced_at := old.priced_at;
  end if;

  v_min_days := get_min_equipment_billing_days(c.workspace_id);
  new.min_days_applied := v_min_days;

  -- Ensure valid device quantity (default 1)
  new.qty := greatest(1, coalesce(new.qty, 1));

  if new.billing_category = 'EQUIPMENT' then
    -- Derive daily rate: if unit is month, prorate 30 days; if day or other, unit_price
    if new.unit in ('month', 'Per month') and new.unit_price > 0 then
      v_daily := round(new.unit_price / 30.0, 2);
    else
      v_daily := new.unit_price;
    end if;

    -- If actual_days was explicitly specified, use it.
    -- If unit was monthly and actual_days not given, assume full month (30 days).
    -- Otherwise default actual_days to 1 (or new.actual_days if set).
    if new.actual_days is not null and new.actual_days > 0 then
      new.actual_days := new.actual_days;
    elsif new.unit in ('month', 'Per month') then
      new.actual_days := 30;
    else
      new.actual_days := 1;
    end if;

    if coalesce(new.override_min_applied, false) then
      new.billable_days := coalesce(new.billable_days, new.actual_days);
      new.min_rule_applied := false;
    else
      new.billable_days := greatest(new.actual_days, v_min_days);
      new.min_rule_applied := (new.billable_days > new.actual_days);
    end if;

    if new.unit in ('month', 'Per month') and new.actual_days >= 30 and not new.min_rule_applied then
      new.line_total := new.unit_price * new.qty;
    else
      new.line_total := new.billable_days * v_daily * new.qty;
    end if;

  elsif new.billing_category = 'MANPOWER' then
    -- Manpower is billed on actual usage (days, shifts, or sessions/visits)
    new.actual_days := greatest(1, coalesce(new.actual_days, new.qty, 1));
    new.billable_days := new.actual_days;
    new.min_rule_applied := false;

    if new.unit in ('visit', 'Per visit', 'session', 'Single session', 'Package / session', 'Per dressing') then
      new.line_total := new.actual_days * new.unit_price;
    else
      new.line_total := new.actual_days * new.unit_price * new.qty;
    end if;

  else -- OTHER (lab, consumables, etc.)
    new.actual_days := greatest(1, coalesce(new.actual_days, new.qty, 1));
    new.billable_days := new.actual_days;
    new.min_rule_applied := false;
    new.line_total := new.unit_price * new.qty;
  end if;

  return new;
end $$;

-- 5. Admin override RPC
create or replace function override_item_minimum(
  p_item uuid,
  p_waive boolean,
  p_days int default null,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  it record;
  c record;
  v_days int;
  v_daily numeric;
begin
  if not has_role('supervisor', 'admin', 'client_manager') then
    raise exception 'Only administrators, supervisors and Hinduja managers can override minimum billing' using errcode = 'P0001';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Override reason is mandatory' using errcode = 'P0001';
  end if;

  select * into it from case_items where id = p_item for update;
  if not found then raise exception 'Case item not found'; end if;

  select * into c from cases where id = it.case_id;

  if p_waive then
    v_days := coalesce(p_days, it.actual_days, 1);
  else
    v_days := coalesce(p_days, it.billable_days, 7);
  end if;

  if it.unit in ('month', 'Per month') and it.unit_price > 0 then
    v_daily := round(it.unit_price / 30.0, 2);
  else
    v_daily := it.unit_price;
  end if;

  update case_items set
    override_min_applied = p_waive,
    billable_days = v_days,
    min_rule_applied = case when p_waive then false else (v_days > it.actual_days) end,
    override_reason = trim(p_reason),
    override_by = app_uid(),
    override_at = now(),
    line_total = case
      when it.billing_category = 'EQUIPMENT' then v_days * v_daily * it.qty
      else line_total
    end
  where id = p_item;

  perform recalc_case(it.case_id);

  perform log_interaction(it.case_id, 'system', 'internal',
    'Minimum 7-day billing ' || case when p_waive then 'waived' else 'adjusted' end ||
    ' for ' || it.service_name || ' · ' || trim(p_reason),
    null,
    'Override details',
    jsonb_build_object('item_id', p_item, 'waived', p_waive, 'billable_days', v_days, 'reason', trim(p_reason)));

  insert into audit_log(workspace_id, actor_id, action, entity, entity_id, meta)
  values (c.workspace_id, app_uid(), 'override_minimum_billing', 'case_item', p_item::text,
    jsonb_build_object('waived', p_waive, 'billable_days', v_days, 'reason', trim(p_reason)));

  return jsonb_build_object('ok', true, 'item_id', p_item, 'billable_days', v_days, 'override_min_applied', p_waive);
end $$;

grant execute on function override_item_minimum(uuid, boolean, int, text) to caredesk_app;

-- 6. Updated care_plan_sheet reflecting minimum billing policy and breakdown
create or replace function care_plan_sheet(p_case uuid default null, p_days int default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ws uuid := me_ws();
  v_plan int;
  v_days int;
  v_case jsonb;
  v_opts jsonb;
  v_min_days int := get_min_equipment_billing_days(v_ws);
begin
  if not has_role('coordinator','field_staff','supervisor','medical_desk','client_manager','client_clinical') then
    raise exception 'Not allowed for your role';
  end if;
  if p_case is not null then
    if not can_see_case(p_case) then raise exception 'Case not found'; end if;
    select plan_days into v_plan from cases where id = p_case;
  end if;
  v_days := coalesce(p_days, v_plan, 30);
  if v_days < 1 or v_days > 365 then raise exception 'Plan length must be 1 to 365 days'; end if;

  with opt as (
    select s.code, s.name, s.category, s.billing_category, s.unit, s.price, x.per_day,
      case when s.billing_category = 'EQUIPMENT' then greatest(v_days, v_min_days)
           when s.unit = 'shift' then x.per_day * v_days
           when s.unit = 'day' then v_days
           when s.unit in ('12 hours', '24 hours') and s.category in ('nursing', 'eldercare') then v_days
           when s.unit in ('session', 'single session', 'package / session') then ceil(v_days * 3 / 7.0)::int
           when s.unit = 'month' then ceil(v_days / 30.0)::int
           else 1 end as qty
    from services s
    cross join lateral (select v.n as per_day from (values (1), (2)) v(n) where s.unit = 'shift'
                        union all select 1 where s.unit <> 'shift') x
    where s.workspace_id = v_ws and s.active and s.category in ('nursing','eldercare','physio','icu','equipment','beds','homecare','consumables')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'code', code, 'name', name, 'category', category, 'billing_category', billing_category, 'unit', unit,
      'cover', case when unit = 'shift' then case per_day when 1 then '12-hour' else '24-hour' end
                    when unit in ('12 hours', '24 hours') and category in ('nursing', 'eldercare') then replace(unit, ' hours', '-hour') end,
      'basis', case when billing_category = 'EQUIPMENT' and v_days < v_min_days then 'min ' || v_min_days || ' days'
                    when unit = 'shift' then case per_day when 1 then '1 shift a day' else '2 shifts a day' end
                    when unit = 'day' then 'every day'
                    when unit in ('12 hours', '24 hours') and category in ('nursing', 'eldercare') then 'every day'
                    when unit in ('session', 'single session', 'package / session') then '3 sessions a week'
                    when unit = 'month' then 'per month'
                    when unit = 'setup' then 'one-time'
                    else 'as advised' end,
      'unit_price', price, 'priced', price > 0, 'qty', qty,
      'plan_total', case when price > 0 and qty is not null then
        case when unit in ('month', 'Per month') and billing_category = 'EQUIPMENT' and qty < 30
          then round(price / 30.0, 2) * qty
          else price * qty
        end
      end)
    order by array_position(array['nursing','eldercare','physio','icu','equipment','beds','homecare','consumables'], category), name, per_day), '[]'::jsonb)
  into v_opts from opt;

  if p_case is not null then
    select jsonb_build_object(
      'plan_days', c.plan_days, 'subtotal', c.subtotal, 'discount_pct', c.discount_pct, 'discount_amount', c.discount_amount,
      'total', c.total, 'per_day', case when c.plan_days > 0 then round(c.total / c.plan_days, 2) end,
      'equipment_subtotal', coalesce((select sum(i.line_total) from case_items i where i.case_id = c.id and not i.excluded and i.billing_category = 'EQUIPMENT'), 0),
      'manpower_subtotal', coalesce((select sum(i.line_total) from case_items i where i.case_id = c.id and not i.excluded and i.billing_category = 'MANPOWER'), 0),
      'other_subtotal', coalesce((select sum(i.line_total) from case_items i where i.case_id = c.id and not i.excluded and coalesce(i.billing_category, 'OTHER') = 'OTHER'), 0),
      'min_advance_total', coalesce((
        select sum(case
          when i.billing_category = 'EQUIPMENT' then
            case when i.unit in ('month', 'Per month') and i.unit_price > 0
                 then round(i.unit_price / 30.0, 2) * greatest(coalesce(i.actual_days, 1), v_min_days) * i.qty
                 else i.unit_price * greatest(coalesce(i.actual_days, 1), v_min_days) * i.qty
            end
          else i.line_total
        end)
        from case_items i where i.case_id = c.id and not i.excluded
      ), 0),
      'recommended_total', coalesce((select sum(i.line_total) from case_items i where i.case_id = c.id and i.recommended), 0),
      'dropped_total', coalesce((select sum(i.line_total) from case_items i where i.case_id = c.id and i.excluded), 0),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', i.id, 'code', i.service_code, 'name', i.service_name, 'category', i.category,
          'billing_category', i.billing_category, 'unit', s.unit,
          'unit_price', i.unit_price, 'priced', i.unit_price > 0, 'qty', i.qty,
          'actual_days', i.actual_days, 'billable_days', i.billable_days,
          'min_rule_applied', i.min_rule_applied, 'min_days_applied', i.min_days_applied,
          'override_min_applied', i.override_min_applied, 'override_reason', i.override_reason,
          'line_total', i.line_total, 'recommended', i.recommended, 'excluded', i.excluded,
          'exclude_reason', i.exclude_reason, 'exclude_category', i.exclude_category)
          order by i.excluded, i.recommended desc, i.created_at)
        from case_items i left join services s on s.id = i.service_id where i.case_id = c.id), '[]'::jsonb))
    into v_case from cases c where c.id = p_case;
  end if;

  return jsonb_build_object('days', v_days, 'min_equipment_billing_days', v_min_days, 'options', v_opts, 'case', v_case);
end $$;

grant execute on function care_plan_sheet(uuid, int) to caredesk_app;

-- 7. Update set_item_scope to support actual_days
drop function if exists set_item_scope(uuid, boolean, text, int, text);
create or replace function set_item_scope(
  p_item uuid,
  p_included boolean,
  p_reason text default null,
  p_qty int default null,
  p_category text default null,
  p_actual_days int default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i record;
  c record;
  v_cat text := coalesce(nullif(p_category,''), 'other');
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  select * into i from case_items where id = p_item;
  if not found or not can_see_case(i.case_id) then raise exception 'Item not found'; end if;
  select * into c from cases where id = i.case_id;
  if c.stage not in ('enquiry','pricing') then raise exception 'Services can only be changed during Enquiry or Pricing'; end if;
  if not p_included and coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for dropping the item'; end if;
  if not p_included and v_cat not in ('cost','space','unwilling','clinical','arranged_elsewhere','other') then
    raise exception 'Unknown reason category %', v_cat;
  end if;
  if p_qty is not null and p_qty < 1 then raise exception 'Quantity must be greater than or equal to 1'; end if;
  if p_actual_days is not null and p_actual_days < 1 then raise exception 'Days must be at least 1'; end if;

  update case_items set
    excluded = not p_included,
    exclude_reason = case when p_included then null else trim(p_reason) end,
    exclude_category = case when p_included then null else v_cat end,
    qty = coalesce(p_qty, qty),
    actual_days = coalesce(p_actual_days, actual_days)
  where id = p_item;

  if c.signoff_at is not null then
    perform rpc_on();
    update cases set signoff_at = null where id = i.case_id;
    perform log_interaction(i.case_id, 'system', 'internal', 'Scope changed after sign-off · new sign-off needed', null);
  end if;

  perform log_interaction(i.case_id, 'system', 'internal',
    'Scope: ' || i.service_name || case when not p_included then ' dropped (' || replace(v_cat, '_', ' ') || ': ' || trim(p_reason) || ')'
      when i.excluded then ' added back' else ' quantity ' || coalesce(p_qty, i.qty) || case when p_actual_days is not null then ' · ' || p_actual_days || ' days' else '' end end, null);

  return (select jsonb_build_object('subtotal', subtotal, 'total', total, 'signoff_at', signoff_at) from cases where id = i.case_id);
end $$;

grant execute on function set_item_scope(uuid, boolean, text, int, text, int) to caredesk_app;
