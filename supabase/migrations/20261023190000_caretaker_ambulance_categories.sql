-- Service categories "caretaker_attendant" (Caretaker / Attendant) and "ambulance", as the rate card screens label them.
--   * services_category_check accepts both.
--   * Book My Medicare delivers both, so case routing (providers.categories) and the rate import's provider-by-category find it.
--   * rate_import_eval accepts both for new services and reads "caretaker", "attendant", "caretaker / attendant" as caretaker_attendant.
--   * care_plan_sheet lists caretaker / attendant cover with elder care (12 / 24 hours a day, every day); ambulance is per trip, not on the plan.
-- Existing services keep their category (CARETAKER-12H / 24H stay eldercare until the rate card is changed).

alter table services drop constraint if exists services_category_check;
alter table services add constraint services_category_check
  check (category in ('lab','xray','ecg','visit','nursing','physio','beds','eldercare','homecare','equipment','icu','consumables',
                      'caretaker_attendant','ambulance','other'));

update providers set categories = array(select distinct unnest(categories || array['caretaker_attendant','ambulance']))
 where code = 'BMM' and not (categories @> array['caretaker_attendant','ambulance']);

create or replace function rate_import_eval(p_ws uuid, p_rows jsonb, p_options jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  x jsonb; v_i int := 0; v_out jsonb := '[]'::jsonb; v_err text[]; v_warn text[];
  s services; pv providers; v_new jsonb; v_code text; v_name text; v_cat text; v_unit text; v_ukey text;
  v_buy numeric; v_sell numeric; v_eff date; v_txt text; v_num text; v_pcode text;
  v_old_buy provider_rates; v_same provider_rates; v_buy_status text; v_sell_status text;
  v_today date := ws_today(p_ws); v_bb text := nullif(p_options->>'buy_tax_basis', ''); v_sb text := nullif(p_options->>'sell_tax_basis', '');
  v_file_err text[] := '{}'; v_extra jsonb; v_key text; v_summary jsonb; v_any_buy boolean := false; v_any_sell boolean := false;
  v_pct numeric; v_route boolean := lower(coalesce(p_options->>'provider_by_routing', '')) in ('true','t','1','yes');
  v_derived boolean; v_rcat text; v_rn int;
  cats constant jsonb := '{"lab":"lab","sample collection":"lab","blood test":"lab","blood tests":"lab","xray":"xray","x-ray":"xray","portable x-ray":"xray",
    "ecg":"ecg","ecg at home":"ecg","visit":"visit","visit charges":"visit","nursing":"nursing","physio":"physio","physiotherapy":"physio",
    "beds":"beds","hospital beds":"beds","eldercare":"eldercare","elder care":"eldercare","homecare":"homecare","home care":"homecare",
    "other home care":"homecare","equipment":"equipment","icu":"icu","icu setup":"icu","consumables":"consumables",
    "caretaker_attendant":"caretaker_attendant","caretaker / attendant":"caretaker_attendant","caretaker and attendant":"caretaker_attendant",
    "caretaker":"caretaker_attendant","attendant":"caretaker_attendant","ambulance":"ambulance","other":"other"}';
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'No rows to check'; end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'The sheet has no rows'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'At most 2,000 rows per import'; end if;
  if v_bb is not null and v_bb not in ('incl_gst','excl_gst','no_gst') then v_file_err := v_file_err || 'Unknown GST basis for buying rates'::text; end if;
  if v_sb is not null and v_sb not in ('incl_gst','excl_gst','no_gst') then v_file_err := v_file_err || 'Unknown GST basis for selling rates'::text; end if;
  -- B2B as a share of B2C (e.g. 70 = the provider gets 70%, SecondMedic keeps 30%), for rows without their own B2B
  if nullif(trim(coalesce(p_options->>'buy_pct_of_sell', '')), '') is not null then
    if trim(p_options->>'buy_pct_of_sell') ~ '^\d{1,3}(\.\d{1,2})?$' then v_pct := trim(p_options->>'buy_pct_of_sell')::numeric; end if;
    if v_pct is null or v_pct <= 0 or v_pct > 100 then
      v_pct := null;
      v_file_err := v_file_err || 'B2B as % of B2C must be more than 0 and at most 100, with at most 2 decimals'::text;
    end if;
  end if;

  for x in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1; v_err := '{}'; v_warn := '{}'; s := null; pv := null; v_new := null;
    v_derived := false; v_buy := null; v_sell := null; v_eff := null; v_buy_status := null; v_sell_status := null; v_old_buy := null; v_same := null;
    v_code := upper(nullif(trim(coalesce(x->>'service_code', '')), ''));
    v_unit := nullif(trim(coalesce(x->>'unit', '')), ''); v_ukey := unit_key(v_unit);
    v_cat := nullif(lower(trim(coalesce(x->>'category', ''))), '');
    v_name := nullif(trim(coalesce(x->>'service_name', '')), '');

    -- service: an explicit choice, else the exact code; never a similar name
    if nullif(x->>'service_id', '') is not null then
      select * into s from services where id = (x->>'service_id')::uuid and workspace_id = p_ws;
      if s.id is null then v_err := v_err || 'The chosen service is not on this rate card'::text; end if;
    elsif v_code is not null then
      select * into s from services where workspace_id = p_ws and upper(code) = v_code;
    end if;
    if s.id is null and nullif(x->>'service_id', '') is null then
      if jsonb_typeof(x->'new_service') = 'object' then
        v_new := jsonb_build_object('code', upper(trim(coalesce(x->'new_service'->>'code', ''))), 'name', trim(coalesce(x->'new_service'->>'name', '')),
                                    'category', coalesce(cats->>lower(trim(coalesce(x->'new_service'->>'category', ''))), lower(trim(coalesce(x->'new_service'->>'category', '')))),
                                    'unit', unit_key(x->'new_service'->>'unit'));
        if (v_new->>'code') !~ '^[A-Z0-9][A-Z0-9-]{1,29}$' then v_err := v_err || 'New service code must be 2-30 letters, digits or hyphens'::text;
        elsif exists (select 1 from services where workspace_id = p_ws and upper(code) = v_new->>'code') then v_err := v_err || ('Service code ' || (v_new->>'code') || ' already exists: choose it instead');
        end if;
        if (v_new->>'name') = '' then v_err := v_err || 'New service needs a name'::text; end if;
        if (v_new->>'category') not in ('lab','xray','ecg','visit','nursing','physio','beds','eldercare','homecare','equipment','icu','consumables',
                                     'caretaker_attendant','ambulance','other') then
          v_err := v_err || 'New service needs a category from the list'::text; end if;
        if v_new->>'unit' is null then v_err := v_err || 'New service needs a unit'::text;
        elsif v_ukey is not null and v_ukey <> v_new->>'unit' then v_err := v_err || ('Unit "' || v_unit || '" differs from the new service unit "' || (v_new->>'unit') || '"'); end if;
        v_code := v_new->>'code';
      elsif v_code is not null then
        v_err := v_err || ('Unknown service code ' || v_code || ': choose the rate-card service or confirm it as a new service');
      else
        v_err := v_err || 'No service code: choose the rate-card service or add it as a new service'::text;
      end if;
    end if;
    if s.id is not null then
      v_code := s.code;
      if v_ukey is null then v_err := v_err || 'Unit is empty'::text;
      elsif v_ukey <> unit_key(s.unit) then
        v_err := v_err || ('Unit "' || v_unit || '" does not match the rate-card unit "' || s.unit || '" of ' || s.code || '. Units are never converted');
      end if;
      if v_name is not null and lower(v_name) <> lower(s.name) then v_warn := v_warn || ('Name in the file differs from the rate card ("' || s.name || '"): the code decides'); end if;
      if v_cat is not null and coalesce(cats->>v_cat, v_cat) <> s.category then v_warn := v_warn || ('Category in the file differs from the rate card (' || s.category || '): the rate card is kept'); end if;
    end if;

    -- amounts: blank = not given, 0 = zero; spreadsheet errors, text, negatives and fractions of a paisa are refused
    foreach v_txt in array array['b2b','b2c'] loop
      v_num := trim(coalesce(x->>v_txt, ''));
      if v_num = '' then continue; end if;
      if v_num like '#%' then v_err := v_err || ('Spreadsheet error ' || v_num || ' in ' || upper(v_txt) || ' rate'); continue; end if;
      v_num := regexp_replace(v_num, '(₹|rs\.?|inr|,|\s)', '', 'gi');
      if v_num ~ '^-' then v_err := v_err || (upper(v_txt) || ' rate is negative'); continue; end if;
      if v_num !~ '^\d+(\.\d{1,2})?$' then v_err := v_err || (upper(v_txt) || ' rate "' || (x->>v_txt) || '" is not an amount in rupees (at most 2 decimals)'); continue; end if;
      if v_num::numeric > 9999999.99 then v_err := v_err || (upper(v_txt) || ' rate is too large'); continue; end if;
      if v_txt = 'b2b' then v_buy := v_num::numeric; else v_sell := v_num::numeric; end if;
    end loop;
    if v_buy is null and v_sell is null and coalesce(array_length(v_err, 1), 0) = 0 then
      v_err := v_err || 'Neither a B2B nor a B2C rate is given'::text;
    end if;
    -- B2B from B2C only where the B2B cell is empty (an explicit B2B, or a B2B cell with an error, is never replaced); to the paisa
    if v_buy is null and v_sell is not null and v_pct is not null and trim(coalesce(x->>'b2b', '')) = '' then
      v_buy := round(v_sell * v_pct / 100, 2); v_derived := true;
    end if;
    if v_buy = 0 then v_warn := v_warn || 'B2B rate is zero'::text; end if;
    if v_sell = 0 then v_warn := v_warn || 'B2C rate is zero: the service shows as not priced and cannot be quoted'::text; end if;

    -- effective date: ISO, or day first (Indian format)
    v_txt := nullif(trim(coalesce(x->>'effective_from', '')), '');
    if v_txt is null then v_txt := nullif(p_options->>'effective_from', ''); end if;
    if v_txt is null then
      v_err := v_err || 'Effective From is empty'::text;
    else
      begin
        if v_txt ~ '^\d{4}-\d{2}-\d{2}' then v_eff := left(v_txt, 10)::date;
        elsif v_txt ~ '^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$' then
          v_eff := make_date(split_part(regexp_replace(v_txt, '[-/.]', '-', 'g'), '-', 3)::int,
                             split_part(regexp_replace(v_txt, '[-/.]', '-', 'g'), '-', 2)::int,
                             split_part(regexp_replace(v_txt, '[-/.]', '-', 'g'), '-', 1)::int);
        else raise exception 'bad date';
        end if;
      exception when others then
        v_eff := null; v_err := v_err || ('Effective From "' || v_txt || '" is not a date (use YYYY-MM-DD or DD-MM-YYYY)');
      end;
      if v_eff is not null and v_eff < date '2020-01-01' then v_err := v_err || 'Effective From is before 2020'::text; v_eff := null; end if;
      if v_eff is not null and v_eff > v_today + 366 then v_err := v_err || 'Effective From is more than a year ahead'::text; v_eff := null; end if;
    end if;

    -- provider: needed for a buying rate; an explicit choice, else the exact code
    v_pcode := upper(coalesce(nullif(trim(coalesce(x->>'provider_code', '')), ''), nullif(trim(coalesce(p_options->>'provider_code', '')), '')));
    if nullif(x->>'provider_id', '') is not null then
      select * into pv from providers where id = (x->>'provider_id')::uuid and workspace_id = p_ws;
      if pv.id is null then v_err := v_err || 'The chosen provider is not in this workspace'::text; end if;
    elsif v_pcode is not null then
      select * into pv from providers where workspace_id = p_ws and upper(code) = v_pcode;
      if pv.id is null then v_err := v_err || ('Unknown provider code ' || v_pcode || ': choose the provider'); end if;
    end if;
    if pv.id is not null and not pv.active then v_err := v_err || ('Provider ' || pv.code || ' is inactive'); end if;
    -- provider by category, the same rule as case routing (lab, X-ray, ECG, visit: SecondMedic; the rest: Book My Medicare)
    if v_route and v_buy is not null and pv.id is null and nullif(x->>'provider_id', '') is null and v_pcode is null then
      v_rcat := coalesce(s.category, v_new->>'category');
      select count(*) into v_rn from providers p where p.workspace_id = p_ws and p.active and v_rcat = any(p.categories);
      if v_rn = 1 then
        select * into pv from providers p where p.workspace_id = p_ws and p.active and v_rcat = any(p.categories);
      else
        v_err := v_err || ('No single provider handles ' || coalesce('the category ' || v_rcat, 'this row') || ': choose the provider');
      end if;
    end if;
    if not v_route and v_buy is not null and pv.id is null and nullif(x->>'provider_id', '') is null and v_pcode is null then
      v_err := v_err || 'A B2B rate needs the provider it is paid to'::text;
    end if;

    -- old and proposed prices
    if v_buy is not null then
      v_any_buy := true;
      if s.id is null then v_buy_status := 'new';
      elsif pv.id is not null and v_eff is not null then
        v_old_buy := rate_in_force(pv.id, s.id, s.unit, v_eff);
        select * into v_same from provider_rates where provider_id = pv.id and service_id = s.id and unit = s.unit and status = 'valid' and effective_from = v_eff;
        v_buy_status := case when v_old_buy.id is null then 'new'
                             when v_old_buy.rate = v_buy and v_old_buy.tax_basis = v_bb then 'unchanged' else 'changed' end;
        if v_eff < v_today and v_buy_status <> 'unchanged' then v_warn := v_warn || 'Back-dated B2B rate: bookings already made keep the cost they captured'::text; end if;
      end if;
    end if;
    if v_sell is not null then
      v_any_sell := true;
      if s.id is null then v_sell_status := 'new';
      else
        v_sell_status := case when s.price = v_sell and s.tax_basis is not distinct from v_sb then 'unchanged' else 'changed' end;
        if v_sell_status = 'changed' and exists (select 1 from approvals a where a.workspace_id = p_ws and a.status = 'pending'
             and ((a.kind = 'rate_change' and a.payload->>'service_id' = s.id::text)
               or (a.kind = 'rate_import' and a.payload->'changes' @> jsonb_build_array(jsonb_build_object('service_id', s.id))))) then
          v_err := v_err || ('A selling-price change for ' || s.code || ' is already waiting for approval');
        end if;
        if v_sell_status = 'changed' and exists (select 1 from service_price_history h where h.service_id = s.id and h.status = 'scheduled') then
          v_warn := v_warn || ('An approved selling price for ' || s.code || ' is already scheduled'); end if;
      end if;
      if v_eff is not null and v_eff < v_today and v_sell_status <> 'unchanged' then
        v_warn := v_warn || 'Selling date is in the past: the price applies from approval, earlier quotes keep their price'::text; end if;
    end if;
    if s.id is null and v_new is not null and v_sell is null then
      v_warn := v_warn || 'New service without a B2C rate stays off the quotable rate card until a selling price is approved'::text; end if;

    v_out := v_out || jsonb_build_object(
      'i', v_i, 'row', coalesce(x->'row', to_jsonb(v_i)), 'service_id', s.id, 'service_code', v_code, 'service_name', coalesce(s.name, v_new->>'name', v_name),
      'new_service', v_new, 'category', coalesce(s.category, v_new->>'category'), 'unit', coalesce(s.unit, v_new->>'unit', v_unit),
      'provider_id', pv.id, 'provider_code', coalesce(pv.code, v_pcode), 'effective_from', v_eff,
      'buy', jsonb_build_object('old', v_old_buy.rate, 'old_tax_basis', v_old_buy.tax_basis, 'new', v_buy, 'status', v_buy_status,
                                'derived', v_derived, 'pct', case when v_derived then v_pct end),
      'sell', jsonb_build_object('old', s.price, 'old_version', s.version, 'old_tax_basis', s.tax_basis, 'new', v_sell, 'status', v_sell_status),
      'errors', to_jsonb(v_err), 'warnings', to_jsonb(v_warn));
  end loop;

  if v_any_buy and v_bb is null then v_file_err := v_file_err || 'Choose whether the B2B rates include GST'::text; end if;
  if v_any_sell and v_sb is null then v_file_err := v_file_err || 'Choose whether the B2C rates include GST'::text; end if;

  -- across rows: duplicates, one selling price per service, one definition per new service, selling below buying
  with r as (select e, (e->>'i')::int i, coalesce(e->>'service_id', 'new:' || (e->>'service_code')) skey from jsonb_array_elements(v_out) e),
  dup as (select i, 'Duplicate row: the same service, provider, unit and date is also in row(s) ' ||
                 string_agg(o_row, ', ') as m
          from (select a.i, b.e->>'row' o_row from r a join r b on a.i <> b.i and a.skey = b.skey
                  and (a.e->>'provider_id') is not null and a.e->>'provider_id' = b.e->>'provider_id'
                  and a.e->>'effective_from' = b.e->>'effective_from'
                  and (a.e->'buy'->>'new') is not null and (b.e->'buy'->>'new') is not null) d group by i),
  sel as (select i, 'Conflicting B2C rates or dates for ' || (e->>'service_code') || ' in rows ' || rows_list as m
          from (select a.i, a.e, string_agg(distinct (b.e->>'row'), ', ') rows_list
                from r a join r b on a.skey = b.skey and (a.e->'sell'->>'new') is not null and (b.e->'sell'->>'new') is not null
                group by a.i, a.e
                having count(distinct (b.e->'sell'->>'new')::numeric) > 1 or count(distinct b.e->>'effective_from') > 1) z),
  nsv as (select a.i, 'New service ' || (a.e->>'service_code') || ' is defined differently in other rows' as m
          from r a join r b on a.i <> b.i and jsonb_typeof(a.e->'new_service') = 'object' and jsonb_typeof(b.e->'new_service') = 'object'
            and a.e->>'service_code' = b.e->>'service_code' and a.e->'new_service' <> b.e->'new_service' group by a.i, a.e),
  low as (select a.i, 'B2C ' || coalesce(sp.v, (a.e->'sell'->>'old'))::text || ' is below this B2B rate of ' || (a.e->'buy'->>'new') as m
          from r a left join lateral (select (b.e->'sell'->>'new') v from r b where b.skey = a.skey and (b.e->'sell'->>'new') is not null limit 1) sp on true
          where (a.e->'buy'->>'new') is not null
            and coalesce(sp.v::numeric, nullif((a.e->'sell'->>'old')::numeric, 0)) < (a.e->'buy'->>'new')::numeric)
  select jsonb_build_object(
      'errors', coalesce((select jsonb_object_agg(i, ms) from (select i, jsonb_agg(m) ms from (select * from dup union all select * from sel union all select * from nsv) u group by i) e), '{}'::jsonb),
      'warnings', coalesce((select jsonb_object_agg(i, ms) from (select i, jsonb_agg(m) ms from low group by i) w), '{}'::jsonb))
  into v_extra;

  select coalesce(jsonb_agg(e || jsonb_build_object(
      'errors', (e->'errors') || coalesce(v_extra->'errors'->(e->>'i'), '[]'::jsonb),
      'warnings', (e->'warnings') || coalesce(v_extra->'warnings'->(e->>'i'), '[]'::jsonb)) order by (e->>'i')::int), '[]'::jsonb)
  into v_out from jsonb_array_elements(v_out) e;

  -- the same submitted content (whatever the file name or row numbers) = the same import. Keyed on what was sent, not on
  -- what it resolved to: once an import has added its new services, the retry still finds the first import.
  v_key := md5(jsonb_build_object('o', jsonb_build_object('b', v_bb, 's', v_sb, 'pct', v_pct, 'route', v_route, 'e', nullif(p_options->>'effective_from', ''),
                                                          'p', upper(nullif(trim(coalesce(p_options->>'provider_code', '')), ''))),
    'r', (select jsonb_agg(e - 'row' order by n) from jsonb_array_elements(p_rows) with ordinality t(e, n)))::text);

  select jsonb_build_object(
    'rows', count(*), 'error_rows', count(*) filter (where jsonb_array_length(e->'errors') > 0),
    'warning_rows', count(*) filter (where jsonb_array_length(e->'warnings') > 0),
    'buy_new', count(*) filter (where e->'buy'->>'status' = 'new'), 'buy_changed', count(*) filter (where e->'buy'->>'status' = 'changed'),
    'buy_unchanged', count(*) filter (where e->'buy'->>'status' = 'unchanged'),
    'sell_new', count(*) filter (where e->'sell'->>'status' = 'new'), 'sell_changed', count(*) filter (where e->'sell'->>'status' = 'changed'),
    'sell_unchanged', count(*) filter (where e->'sell'->>'status' = 'unchanged'),
    'new_services', count(distinct e->>'service_code') filter (where jsonb_typeof(e->'new_service') = 'object'))
  into v_summary from jsonb_array_elements(v_out) e;

  return jsonb_build_object('rows', v_out, 'summary', v_summary, 'file_errors', to_jsonb(v_file_err), 'content_key', v_key,
    'ok', coalesce(array_length(v_file_err, 1), 0) = 0 and (v_summary->>'error_rows')::int = 0,
    'buy_tax_basis', v_bb, 'sell_tax_basis', v_sb, 'today', v_today,
    'buy_pct_of_sell', v_pct, 'provider_by_routing', v_route);
end $$;

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
  -- "12 hours" / "24 hours" nursing, elder care and caretaker / attendant cover is daily; Holter / ABPM "24 hours" is one test.
  with opt as (
    select s.code, s.name, s.category, s.unit, s.price, x.per_day,
      case when s.unit = 'shift' then x.per_day * v_days
           when s.unit = 'day' then v_days
           when s.unit in ('12 hours', '24 hours') and s.category in ('nursing', 'eldercare', 'caretaker_attendant') then v_days
           when s.unit in ('session', 'single session', 'package / session') then ceil(v_days * 3 / 7.0)::int
           when s.unit = 'month' then ceil(v_days / 30.0)::int
           else 1 end as qty
    from services s
    cross join lateral (select v.n as per_day from (values (1), (2)) v(n) where s.unit = 'shift'
                        union all select 1 where s.unit <> 'shift') x
    where s.workspace_id = v_ws and s.active and s.category in ('nursing','eldercare','caretaker_attendant','physio','icu','equipment','beds','homecare','consumables')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'code', code, 'name', name, 'category', category, 'unit', unit,
      'cover', case when unit = 'shift' then case per_day when 1 then '12-hour' else '24-hour' end
                    when unit in ('12 hours', '24 hours') and category in ('nursing', 'eldercare', 'caretaker_attendant') then replace(unit, ' hours', '-hour') end,
      'basis', case when unit = 'shift' then case per_day when 1 then '1 shift a day' else '2 shifts a day' end
                    when unit = 'day' then 'every day'
                    when unit in ('12 hours', '24 hours') and category in ('nursing', 'eldercare', 'caretaker_attendant') then 'every day'
                    when unit in ('session', 'single session', 'package / session') then '3 sessions a week'
                    when unit = 'month' then 'per month'
                    when unit = 'setup' then 'one-time'
                    else 'as advised' end,
      'unit_price', price, 'priced', price > 0, 'qty', qty,
      'plan_total', case when price > 0 and qty is not null then price * qty end)
    order by array_position(array['nursing','eldercare','caretaker_attendant','physio','icu','equipment','beds','homecare','consumables'], category), name, per_day), '[]'::jsonb)
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
