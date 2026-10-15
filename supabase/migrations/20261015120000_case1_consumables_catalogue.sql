-- =====================================================================
-- Case 1: Consumables & Respiratory Support Catalogue
--   * Expand services_category_check on services to include 'consumables'.
--   * Update Book My Medicare (BMM) provider categories to include 'consumables'.
--   * Insert 10 missing catalogue items for Case 1 (equipment, beds, consumables) at price 0.
--   * Update care_plan_sheet(p_case, p_days) to include 'consumables' and calculate qty = 1 for box/unit.
-- =====================================================================

-- 1. Expand service category check constraint
alter table services drop constraint if exists services_category_check;
alter table services add constraint services_category_check
  check (category in ('lab','xray','ecg','visit','nursing','physio','beds','eldercare','homecare','equipment','icu','consumables','other'));

-- 2. Update Book My Medicare (BMM) provider categories
update providers
   set categories = array(select distinct unnest(categories || array['consumables']))
 where code = 'BMM' and not (categories @> array['consumables']);

-- 3. Insert 10 catalogue items (priced via Settings rate card approval)
with w as (select id from workspaces where code = 'HHC')
insert into services (workspace_id, code, name, category, price, tat_hours, description, unit, approved_at)
select w.id, s.code, s.name, s.cat, 0, 24, s.descr, s.unit, now() from w, (values
  ('BP-MONITOR',  'Blood Pressure Apparatus (Digital/Manual)',    'equipment',   'Book My Medicare: blood pressure apparatus (digital/manual)',    'day'),
  ('SPO2-PROBE',  'Pulse Oximeter / SpO2 Probe',                 'equipment',   'Book My Medicare: pulse oximeter / SpO2 probe',                 'day'),
  ('THERMO-DIG',  'Clinical Digital Thermometer',                'equipment',   'Book My Medicare: clinical digital thermometer',                'unit'),
  ('FEED-SYR-60', 'Feeding Syringe (Catheter Tip 50/60ml)',      'consumables', 'Book My Medicare: feeding syringe (catheter tip 50/60ml)',      'unit'),
  ('MOUTH-CHX',   'Chlorhexidine Mouthwash (Oral Care)',         'consumables', 'Book My Medicare: chlorhexidine mouthwash (oral care)',         'unit'),
  ('MOIST-CREAM', 'Moisturex Soft Skin Barrier Cream',           'consumables', 'Book My Medicare: moisturex soft skin barrier cream',           'unit'),
  ('CAVILON-SP',  '3M Cavilon No-Sting Barrier Film Spray',      'consumables', 'Book My Medicare: 3M Cavilon no-sting barrier film spray',      'unit'),
  ('OXY-CYL',     'Oxygen Cylinder (with Regulator & Flowmeter)', 'equipment',   'Book My Medicare: oxygen cylinder with regulator and flowmeter', 'day'),
  ('TYNA-BED',    'Tyna Bed / Positioning Alternating Mattress', 'beds',        'Book My Medicare: Tyna bed / positioning alternating mattress',  'day'),
  ('GLOVES-BOX',  'Examination Gloves Box (100 pcs)',            'consumables', 'Book My Medicare: examination gloves box (100 pcs)',            'box')
) as s(code, name, cat, descr, unit)
on conflict (workspace_id, code) do nothing;

do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'service_price_history') then
    insert into service_price_history (workspace_id, service_id, version, price, unit, tax_basis, effective_from, status, source, approved_by, activated_at)
    select s.workspace_id, s.id, s.version, s.price, s.unit, s.tax_basis, coalesce(s.approved_at, now())::date, 'active', 'baseline', s.approved_by, coalesce(s.approved_at, now())
    from services s
    where not exists (select 1 from service_price_history h where h.service_id = s.id);
  end if;
end $$;

-- 4. Update care_plan_sheet to include consumables and unit/box qty calculation
create or replace function care_plan_sheet(p_case uuid default null, p_days int default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws(); v_plan int; v_days int; v_case jsonb; v_opts jsonb;
begin
  -- staff who assess, price or oversee a transition; partners and agents use the case page, admins see no patient data
  if not has_role('coordinator','field_staff','supervisor','medical_desk','client_manager','client_clinical') then
    raise exception 'Not allowed for your role';
  end if;
  if p_case is not null then
    if not can_see_case(p_case) then raise exception 'Case not found'; end if;
    select plan_days into v_plan from cases where id = p_case;
  end if;
  v_days := coalesce(p_days, v_plan, 30);
  if v_days < 1 or v_days > 365 then raise exception 'Plan length must be 1 to 365 days'; end if;

  -- every home care item at its plan quantity; shift items twice: one 12-hour shift a day, or two for 24-hour cover
  with opt as (
    select s.code, s.name, s.category, s.unit, s.price, x.per_day,
      case s.unit when 'shift' then x.per_day * v_days
                  when 'day' then v_days
                  when 'session' then ceil(v_days * 3 / 7.0)::int
                  when 'setup' then 1
                  when 'box' then 1
                  when 'unit' then 1
                  else 1 end as qty
    from services s
    cross join lateral (select v.n as per_day from (values (1), (2)) v(n) where s.unit = 'shift'
                        union all select 1 where s.unit <> 'shift') x
    where s.workspace_id = v_ws and s.active and s.category in ('nursing','eldercare','physio','icu','equipment','beds','homecare','consumables')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'code', code, 'name', name, 'category', category, 'unit', unit,
      'cover', case when unit = 'shift' then case per_day when 1 then '12-hour' else '24-hour' end end,
      'basis', case unit when 'shift' then case per_day when 1 then '1 shift a day' else '2 shifts a day' end
                         when 'day' then 'every day' when 'session' then '3 sessions a week' when 'setup' then 'one-time'
                         else 'as advised' end,
      'unit_price', price, 'priced', price > 0, 'qty', qty,
      'plan_total', case when price > 0 and qty is not null then price * qty end)
    order by array_position(array['nursing','eldercare','physio','icu','equipment','beds','homecare','consumables'], category), name, per_day), '[]'::jsonb)
  into v_opts from opt;

  if p_case is not null then
    select jsonb_build_object(
      'plan_days', c.plan_days, 'subtotal', c.subtotal, 'discount_pct', c.discount_pct, 'discount_amount', c.discount_amount,
      'total', c.total, 'per_day', case when c.plan_days > 0 then round(c.total / c.plan_days, 2) end,
      'recommended_total', coalesce((select sum(i.line_total) from case_items i where i.case_id = c.id and i.recommended), 0),
      'dropped_total', coalesce((select sum(i.line_total) from case_items i where i.case_id = c.id and i.excluded), 0),
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'code', i.service_code, 'name', i.service_name, 'category', i.category, 'unit', s.unit,
          'unit_price', i.unit_price, 'priced', i.unit_price > 0, 'qty', i.qty, 'line_total', i.line_total,
          'recommended', i.recommended, 'excluded', i.excluded, 'exclude_reason', i.exclude_reason, 'exclude_category', i.exclude_category)
          order by i.excluded, i.recommended desc, i.created_at)
        from case_items i left join services s on s.id = i.service_id where i.case_id = c.id), '[]'::jsonb))
    into v_case from cases c where c.id = p_case;
  end if;

  return jsonb_build_object('days', v_days, 'options', v_opts, 'case', v_case);
end $$;

grant execute on function care_plan_sheet(uuid, int) to caredesk_app;

