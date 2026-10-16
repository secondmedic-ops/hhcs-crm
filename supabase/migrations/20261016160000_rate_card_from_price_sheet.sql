-- Rate card: every priced line of "Service & Pricing - Home Care Services (Marketing).xlsx" (the Hinduja patient-price
-- sheet already used for the home X-ray lines in 20261016130000_diagnostic_xray_home.sql).
-- Before this, Settings > Rate card had none of these 61 services, so nursing, physiotherapy, equipment, beds, ECG,
-- Holter / ABPM, telemonitoring, ambulance, etc. were missing or showed "Not priced" although the sheet prices them.
--   * Price = "Proposed Hinduja Patient Price" (B2C). "BMM B2C / Listed Tariff" is never used as the selling price.
--   * Unit = the sheet's unit through unit_key() ("Per month" -> "month"), the same key the rate importer compares,
--     so a later import of the same sheet finds these rows. Units are never converted: the existing per-day / per-shift
--     placeholders (VENT-HOME, OXY-CONC, NURSE-12H, ...) are left as they are.
--   * Codes and categories as in "Service & Pricing - CareDesk import (proposed).xlsx"; the category drives routing
--     (ecg -> SecondMedic, the rest -> Book My Medicare).
--   * GST basis is not stated in the sheet: left unconfirmed. Buying (B2B) rates are not set here (they need a GST basis);
--     set them under Buying rates or with Import rates (B2B = 70% of B2C).
--   * The three X-ray lines of the sheet are already on the card (XR-HOME 2000, XR-ADDITIONAL 700, XR-PRINT 200).
-- Idempotent and expand only: a service that already exists by code, or by the same name and unit (for example
-- added by an earlier import under another code), is not added again; such a row is only priced and activated when
-- it is still at 0. A price already set is never overwritten.
-- care_plan_sheet(): plan quantities for the new units (12 hours, 24 hours, month, session variants).

-- session-only scratch table (no drop statement: the pipeline lint treats any table drop as destructive)
create temporary table if not exists _sheet (code text, name text, category text, unit text, price numeric(10,2), sheet_row int);
truncate _sheet;
insert into _sheet (code, name, category, unit, price, sheet_row) values
  ('TELEMONITORING-DAY', 'Telemonitoring', 'homecare', 'Per day', 2500, 3),
  ('TELEMONITORING-MONTH', 'Telemonitoring', 'homecare', 'Per month', 60000, 4),
  ('NURSING-IV-VISIT', 'Nursing IV', 'nursing', 'Per visit', 1500, 5),
  ('NURSING-IV-BD', 'Nursing IV', 'nursing', 'BD – twice daily', 2700, 6),
  ('NURSING-IV-TDS', 'Nursing IV', 'nursing', 'TDS – three times daily', 3750, 7),
  ('PICC-DRESSING', 'PICC Dressing', 'nursing', 'Per dressing', 6000, 8),
  ('PICC-DRESSING-ALBUMIN', 'PICC dressing with albumin infusion', 'nursing', 'Per dressing', 15000, 9),
  ('DOCTOR-VISIT-INTENSIVIST', 'Doctor Visit – Intensivist', 'homecare', 'Per visit', 5000, 10),
  ('WOUND-DRESSING-STANDARD', 'Wound Dressing – standard', 'nursing', 'Per visit', 1500, 11),
  ('WOUND-DRESSING-LARGE', 'Wound Dressing – large', 'nursing', 'Per visit', 2750, 12),
  ('PHYSIO-ORTHO-SINGLE', 'Home Physiotherapy – Ortho', 'physio', 'Single session', 2000, 13),
  ('PHYSIO-ORTHO-PACKAGE', 'Home Physiotherapy – Ortho', 'physio', 'Package / session', 1500, 14),
  ('HOLTER-24H', 'Holter Monitoring', 'homecare', '24 hours', 4000, 15),
  ('HOLTER-48H', 'Holter Monitoring', 'homecare', '48 hours', 5500, 16),
  ('HOLTER-72H', 'Holter Monitoring', 'homecare', '72 hours', 7500, 17),
  ('ABPM-24H', 'ABPM', 'homecare', '24 hours', 3750, 18),
  ('AMBULANCE', 'Ambulance', 'other', 'Starting / location based', 3000, 19),
  ('NURSING-GENERAL-12H', 'General Nursing (ANM/GNM)', 'nursing', '12 hours', 2200, 20),
  ('NURSING-ICU-12H', 'ICU Nursing (GNM/BSc/ANM)', 'nursing', '12 hours', 2300, 21),
  ('NURSING-CRITICAL-12H', 'Critical Care Nursing (Ventilator/BiPAP support)', 'nursing', '12 hours', 2600, 22),
  ('PHYSIO-NEURO', 'Home Physiotherapy – Neuro', 'physio', 'Per session', 2000, 23),
  ('PHYSIO-CARDIAC', 'Home Physiotherapy – Cardiac', 'physio', 'Per session', 2000, 24),
  ('PHYSIO-PULMONARY', 'Home Physiotherapy – Pulmonary', 'physio', 'Per session', 2000, 25),
  ('CARETAKER-12H', 'Caretaker /Attendant', 'eldercare', '12 hours', 1200, 26),
  ('CARETAKER-24H', 'Caretaker /Attendant', 'eldercare', '24 hours', 1700, 27),
  ('O2-CONC-5L-PHILIPS', 'Oxygen Concentrator 5L – Philips', 'equipment', 'Per month', 5000, 28),
  ('O2-CONC-10L', 'Oxygen Concentrator 10L', 'equipment', 'Per month', 7000, 29),
  ('PORTABLE-O2-CONC', 'Portable Oxygen Concentrator', 'equipment', 'Per month', 25000, 30),
  ('O2-CYL-JUMBO', 'Jumbo Oxygen Cylinder', 'equipment', 'Per month', 3000, 31),
  ('O2-CYL-10L', '10 Litre Oxygen Cylinder', 'equipment', 'Per month', 2000, 32),
  ('O2-CYL-20L', '20 Litre Oxygen Cylinder', 'equipment', 'Per month', 2700, 33),
  ('AIRVO-HFNC', 'AIRVO (HFNC)', 'equipment', 'Per month', 26000, 34),
  ('5-PARA-MONITOR-REGULAR', '5-Para Monitor – regular', 'equipment', 'Per month', 5500, 35),
  ('PHILIPS-VENT-EVO-OBM', 'Philips Ventilator EVO OBM', 'equipment', 'Per month', 25000, 36),
  ('ASTRAL-150-VENT', 'Astral 150 Ventilator', 'equipment', 'Per month', 25000, 37),
  ('PHILIPS-A40-BIPAP', 'Philips A40 BiPAP', 'equipment', 'Per month', 12000, 38),
  ('PHILIPS-AVAPS-BIPAP-ST', 'Philips AVAPS BiPAP with ST', 'equipment', 'Per month', 10000, 39),
  ('STELLAR-150', 'Stellar 150', 'equipment', 'Per month', 16000, 40),
  ('LUMIS-150-BIPAP', 'Lumis 150 BiPAP', 'equipment', 'Per month', 7500, 41),
  ('LUMIS-100-BIPAP', 'Lumis 100 BiPAP', 'equipment', 'Per month', 6500, 42),
  ('BMC-BIPAP', 'BMC BiPAP', 'equipment', 'Per month', 3700, 43),
  ('CPAP-AUTOSET-RESMED', 'CPAP AutoSet ResMed', 'equipment', 'Per month', 4500, 44),
  ('DREAMSTATION-CPAP', 'DreamStation CPAP', 'equipment', 'Per month', 5300, 45),
  ('SYRINGE-PUMP', 'Syringe Pump', 'equipment', 'Per month', 4500, 46),
  ('INFUSION-PUMP', 'Infusion Pump', 'equipment', 'Per month', 4500, 47),
  ('DVT-PUMP-REGULAR', 'DVT Pump – regular', 'equipment', 'Per month', 4500, 48),
  ('SUCTION-MC-SINGLE-JAR', 'Suction Machine – single jar', 'equipment', 'Per month', 2200, 49),
  ('SUCTION-MC-DOUBLE-JAR', 'Suction Machine – double jar', 'equipment', 'Per month', 3300, 50),
  ('BED-MOTOR-3FN', '3-Function Motorised Bed', 'beds', 'Per month', 6000, 51),
  ('BED-MOTOR-5FN', '5-Function Motorised Bed', 'beds', 'Per month', 9000, 52),
  ('BED-ICU-PARAMOUNT-AB5', 'Paramount AB5 ICU Bed', 'beds', 'Per month', 17000, 53),
  ('BED-MANUAL-3FN', 'Manual 3-Function Bed', 'beds', 'Per month', 4500, 54),
  ('BED-MANUAL-2FN', 'Manual 2-Function Bed', 'beds', 'Per month', 3700, 55),
  ('AIR-MATTRESS-TUBULAR-4-INCH', 'Air Mattress Tubular – 4 inch', 'equipment', 'Per month', 2500, 56),
  ('AIR-MATTRESS-TUBULAR-8-INCH', 'Air Mattress Tubular – 8 inch', 'equipment', 'Per month', 13000, 57),
  ('WHEELCHAIR-NORMAL', 'Wheelchair – normal', 'equipment', 'Per month', 1000, 58),
  ('WHEELCHAIR-COMMODE', 'Wheelchair with Commode', 'equipment', 'Per month', 1400, 59),
  ('WALKER-DOUBLE-BAR', 'Walker – double bar', 'equipment', 'Per month', 1200, 60),
  ('ECG-HOME-ACQ', 'ECG at Home – Acquisition & Digital Transfer', 'ecg', 'Per ECG', 1100, 63),
  ('ECG-HOME-INTERP', 'ECG at Home – With Physician Interpretation', 'ecg', 'Per ECG', 1250, 64),
  ('ECG-HOME-URGENT', 'ECG at Home – Urgent Physician Interpretation', 'ecg', 'Per ECG', 1500, 65)
;
update _sheet set unit = unit_key(unit);

-- 1. existing rows of the same service still unpriced (same code, or same name and unit): price and activate
with w as (select id from workspaces where code = 'HHC'),
hit as (
  select distinct on (s.id) s.id, x.price
  from services s join w on w.id = s.workspace_id
  join _sheet x on (s.code = x.code or (lower(trim(s.name)) = lower(trim(x.name)) and unit_key(s.unit) = x.unit))
  where s.price = 0 and unit_key(s.unit) = x.unit
  order by s.id, (s.code = x.code) desc
),
upd as (
  update services s set price = hit.price, active = true, version = s.version + 1, approved_at = now()
  from hit where s.id = hit.id
  returning s.*
),
old as (
  update service_price_history h set status = 'superseded'
  from upd where h.service_id = upd.id and h.status = 'active'
  returning h.id
)
insert into service_price_history (workspace_id, service_id, version, price, unit, tax_basis, effective_from, status, source, approved_by, activated_at)
select u.workspace_id, u.id, u.version, u.price, u.unit, u.tax_basis, ws_today(u.workspace_id), 'active', 'rate_change', u.approved_by, now()
from upd u;

-- 2. services not on the card yet
with w as (select id from workspaces where code = 'HHC')
insert into services (workspace_id, code, name, category, price, tat_hours, description, unit, active, approved_at)
select w.id, x.code, x.name, x.category, x.price, 24,
       'Hinduja patient price sheet (Home Care Services, row ' || x.sheet_row || ').', x.unit, true, now()
from w cross join _sheet x
where not exists (select 1 from services s where s.workspace_id = w.id
                  and (s.code = x.code or (lower(trim(s.name)) = lower(trim(x.name)) and unit_key(s.unit) = x.unit)))
on conflict (workspace_id, code) do nothing;

-- price history starts complete for the new rows
insert into service_price_history (workspace_id, service_id, version, price, unit, tax_basis, effective_from, status, source, approved_by, activated_at)
select s.workspace_id, s.id, s.version, s.price, s.unit, s.tax_basis, ws_today(s.workspace_id), 'active', 'baseline', s.approved_by, coalesce(s.approved_at, now())
from services s join workspaces w on w.id = s.workspace_id and w.code = 'HHC'
where s.code in (select code from _sheet)
  and not exists (select 1 from service_price_history h where h.service_id = s.id);

-- 3. plan quantities on the printable checklist for the new units
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

  -- every home care item at its plan quantity; shift items twice: one 12-hour shift a day, or two for 24-hour cover.
  -- "12 hours" / "24 hours" nursing and attendant cover is daily; Holter / ABPM "24 hours" is one test.
  with opt as (
    select s.code, s.name, s.category, s.unit, s.price, x.per_day,
      case when s.unit = 'shift' then x.per_day * v_days
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
      'code', code, 'name', name, 'category', category, 'unit', unit,
      'cover', case when unit = 'shift' then case per_day when 1 then '12-hour' else '24-hour' end
                    when unit in ('12 hours', '24 hours') and category in ('nursing', 'eldercare') then replace(unit, ' hours', '-hour') end,
      'basis', case when unit = 'shift' then case per_day when 1 then '1 shift a day' else '2 shifts a day' end
                    when unit = 'day' then 'every day'
                    when unit in ('12 hours', '24 hours') and category in ('nursing', 'eldercare') then 'every day'
                    when unit in ('session', 'single session', 'package / session') then '3 sessions a week'
                    when unit = 'month' then 'per month'
                    when unit = 'setup' then 'one-time'
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

