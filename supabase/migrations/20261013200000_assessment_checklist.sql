-- Clinical assessment & commercial closure checklist (screen: src/pages/Checklist.jsx, SOP steps 2 and 3).
-- The hospital care coordinator prints it before the Hinduja visit and fills it at the bedside and with the family.
--   rate card: home ventilator added at ₹0 (not quotable until Hinduja management approves a price, like the other
--              transition items); physiotherapy is priced per session
--   care_plan_sheet(case, days): the transparent plan pricing printed on the sheet, computed here so screens never
--              multiply money. Options = every home care rate-card item at its plan quantity (12-hour and 24-hour cover
--              for shift items); case = the recommended / agreed / dropped items and totals of that case.
-- Expand only: no table or column changes.

-- ---------- rate card ----------
with w as (select id from workspaces where code = 'HHC')
insert into services (workspace_id, code, name, category, price, tat_hours, description, unit, approved_at)
select w.id, s.code, s.name, s.cat, 0, 24, s.descr, s.unit, now() from w, (values
  ('VENT-HOME', 'Home ventilator (BiPAP / ventilator), rental', 'icu', 'Book My Medicare: home ventilator with circuit and humidifier, set up by a technician', 'day')
) as s(code, name, cat, descr, unit)
on conflict (workspace_id, code) do nothing;

update services set unit = 'session' where code = 'PHYSIO-HOME' and unit = 'unit';

-- ---------- plan pricing for the checklist ----------
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
