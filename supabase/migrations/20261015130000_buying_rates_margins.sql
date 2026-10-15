-- =====================================================================
-- B2B buying rates, B2C selling-rate history, rate-sheet import, booking price snapshots and gross margins.
--   * provider_rates: what SecondMedic pays each provider per service unit, effective-dated, never overlapping for the
--     same provider / service / unit. Units must equal the rate-card unit: nothing is ever converted.
--   * services.tax_basis + service_price_history: the selling price with its GST basis and every version (scheduled,
--     active, superseded). Selling prices still change only through the Hinduja approval (decide_approval).
--   * rate_imports: Settings > Rate card > Import rates. rate_import_check() validates (read only, the preview);
--     submit_rate_import() validates again, applies the buying rates and sends the selling changes to approval as one
--     request. Same file again = the same import (content key), so a retry never applies twice.
--   * case_items keeps the selling snapshot (price, version, unit, tax basis, priced_at); case_item_costs keeps the
--     selected provider and its buying rate. A later rate change never rewrites a line: refresh_case_prices() for
--     drafts, set_item_provider() to choose / amend (amendments after agreement are supervisor-only, with a reason,
--     kept in case_item_cost_history).
--   * case_margins() / margin_report(): money in numeric, discount allocated to lines by largest remainder so the lines
--     add up to the booking total exactly; a missing cost is never zero.
-- Confidential: buying rates and margins are readable only by SecondMedic supervisors / coordinators (and
-- administrators); platform admins manage rates but see no case data; Hinduja, agents, field staff, medical desk and
-- providers see neither. None of these tables is audited into audit_log (readable by Hinduja management).
-- Expand only.
-- =====================================================================

-- ---------- helpers ----------
-- "Per day" and "day" are the same unit; "12 hours" and "shift" are not. Only case, spaces, dashes and a leading "per" are normalised.
create or replace function unit_key(p text) returns text language sql immutable as $$
  select nullif(regexp_replace(regexp_replace(lower(translate(trim(coalesce(p, '')), '–—‑', '---')), '\s+', ' ', 'g'), '^per ', ''), '')
$$;

create or replace function ws_today(p_ws uuid) returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select timezone from workspaces where id = p_ws), 'Asia/Kolkata'))::date
$$;

-- ---------- selling side: GST basis and version history ----------
alter table services add column if not exists tax_basis text;          -- incl_gst | excl_gst | no_gst; null = not confirmed
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'services_tax_basis_check') then
    alter table services add constraint services_tax_basis_check check (tax_basis is null or tax_basis in ('incl_gst','excl_gst','no_gst'));
  end if;
end $$;

-- one approval for all the selling changes of an import (same approver as a single rate change)
alter table approvals drop constraint if exists approvals_kind_check;
alter table approvals add constraint approvals_kind_check check (kind in ('discount','rate_change','rate_import','template','export'));

create table if not exists rate_imports (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  content_key   text not null,                       -- md5 of the validated rows and options: the same file = the same import
  file_name     text,
  sheet_name    text,
  options       jsonb not null default '{}'::jsonb,  -- tax bases, defaults chosen in the import screen
  rows          jsonb not null,                      -- the validated rows (buying rates included: confidential)
  summary       jsonb not null default '{}'::jsonb,
  buy_status    text not null default 'none' check (buy_status in ('none','applied')),
  sell_status   text not null default 'none' check (sell_status in ('none','awaiting_approval','approved','rejected')),
  approval_id   uuid references approvals(id),
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  sell_decided_at timestamptz
);
create unique index if not exists rate_imports_once on rate_imports(workspace_id, content_key) where sell_status <> 'rejected';

create table if not exists service_price_history (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  service_id     uuid not null references services(id) on delete cascade,
  version        int,                                -- services.version once active
  price          numeric(10,2) not null check (price >= 0),
  unit           text not null,
  tax_basis      text check (tax_basis is null or tax_basis in ('incl_gst','excl_gst','no_gst')),
  effective_from date not null,
  status         text not null check (status in ('scheduled','active','superseded','cancelled')),
  source         text not null check (source in ('baseline','rate_change','import')),
  approval_id    uuid references approvals(id),
  import_id      uuid references rate_imports(id),
  approved_by    uuid references profiles(id),
  created_at     timestamptz not null default now(),
  activated_at   timestamptz
);
create index if not exists price_history_service on service_price_history(service_id, created_at);
create index if not exists price_history_due on service_price_history(effective_from) where status = 'scheduled';

-- the price each service has today, so history starts complete (no invented prices: the current card as it stands)
insert into service_price_history (workspace_id, service_id, version, price, unit, tax_basis, effective_from, status, source, approved_by, activated_at)
select s.workspace_id, s.id, s.version, s.price, s.unit, s.tax_basis, coalesce(s.approved_at, s.updated_at)::date, 'active', 'baseline', s.approved_by, coalesce(s.approved_at, s.updated_at)
from services s
where not exists (select 1 from service_price_history h where h.service_id = s.id);

-- ---------- buying side ----------
create table if not exists provider_rates (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  provider_id    uuid not null references providers(id),
  service_id     uuid not null references services(id),
  unit           text not null,                      -- the rate-card unit of the service when the rate was set
  rate           numeric(12,2) not null check (rate >= 0),
  tax_basis      text not null check (tax_basis in ('incl_gst','excl_gst','no_gst')),
  effective_from date not null,
  effective_to   date,                               -- exclusive; null = open ended
  status         text not null default 'valid' check (status in ('valid','replaced')),
  import_id      uuid references rate_imports(id),
  note           text,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  replaced_at    timestamptz,
  check (effective_to is null or effective_to > effective_from)
);
create unique index if not exists provider_rates_one_per_day on provider_rates(provider_id, service_id, unit, effective_from) where status = 'valid';
create index if not exists provider_rates_service on provider_rates(service_id, unit) where status = 'valid';

-- two valid rates for the same provider / service / unit never cover the same day
create or replace function trg_provider_rate_overlap() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'valid' and exists (
    select 1 from provider_rates r
    where r.id <> new.id and r.status = 'valid' and r.provider_id = new.provider_id and r.service_id = new.service_id and r.unit = new.unit
      and daterange(r.effective_from, r.effective_to) && daterange(new.effective_from, new.effective_to)) then
    raise exception 'Overlapping buying rates for the same provider, service and unit' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists provider_rate_overlap on provider_rates;
create constraint trigger provider_rate_overlap after insert or update on provider_rates
  deferrable initially deferred for each row execute function trg_provider_rate_overlap();

-- ---------- booking snapshots ----------
alter table case_items add column if not exists unit text;               -- rate-card unit when priced
alter table case_items add column if not exists price_version int;       -- services.version when priced
alter table case_items add column if not exists price_tax_basis text;
alter table case_items add column if not exists priced_at timestamptz;   -- null = line made before costs were captured

create table if not exists case_item_costs (
  case_item_id     uuid primary key references case_items(id) on delete cascade,
  case_id          uuid not null references cases(id) on delete cascade,
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  provider_id      uuid references providers(id),          -- null = not chosen (no provider, or several with a rate)
  provider_rate_id uuid references provider_rates(id),
  unit             text,
  buy_rate         numeric(12,2),                            -- null = cost missing, never read as zero
  tax_basis        text,
  source           text not null check (source in ('auto','selected','refresh','amendment')),
  note             text,
  captured_by      uuid references profiles(id),
  captured_at      timestamptz not null default now()
);
create index if not exists item_costs_case on case_item_costs(case_id);

create table if not exists case_item_cost_history (
  id            bigserial primary key,
  case_item_id  uuid not null,
  case_id       uuid not null references cases(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  old           jsonb,
  new           jsonb not null,
  source        text not null,
  reason        text,
  changed_by    uuid references profiles(id),
  changed_at    timestamptz not null default now()
);
create index if not exists item_cost_history_case on case_item_cost_history(case_id, changed_at);

-- ---------- buying-rate versions ----------
-- The rate in force on a day is the valid row whose range covers it. A new version ends the one before it;
-- a version on the same day replaces that day's row (kept as 'replaced').
create or replace function put_provider_rate(p_ws uuid, p_provider uuid, p_service uuid, p_unit text, p_rate numeric, p_basis text,
                                             p_from date, p_import uuid, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_same provider_rates; v_prev provider_rates; v_next date; v_to date; v_id uuid;
begin
  select * into v_same from provider_rates where provider_id = p_provider and service_id = p_service and unit = p_unit
    and status = 'valid' and effective_from = p_from for update;
  select min(effective_from) into v_next from provider_rates where provider_id = p_provider and service_id = p_service and unit = p_unit
    and status = 'valid' and effective_from > p_from;
  if v_same.id is not null then
    v_to := v_same.effective_to;
    update provider_rates set status = 'replaced', replaced_at = now() where id = v_same.id;
  else
    select * into v_prev from provider_rates where provider_id = p_provider and service_id = p_service and unit = p_unit
      and status = 'valid' and effective_from < p_from and (effective_to is null or effective_to > p_from)
      order by effective_from desc limit 1 for update;
    v_to := least(v_next, case when v_prev.id is not null then v_prev.effective_to end);
    if v_prev.id is not null then update provider_rates set effective_to = p_from where id = v_prev.id; end if;
  end if;
  insert into provider_rates (workspace_id, provider_id, service_id, unit, rate, tax_basis, effective_from, effective_to, import_id, note, created_by)
  values (p_ws, p_provider, p_service, p_unit, p_rate, p_basis, p_from, v_to, p_import, p_note, app_uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function rate_in_force(p_provider uuid, p_service uuid, p_unit text, p_day date) returns provider_rates
language sql stable security definer set search_path = public as $$
  select * from provider_rates
  where provider_id = p_provider and service_id = p_service and unit = p_unit and status = 'valid'
    and effective_from <= p_day and (effective_to is null or effective_to > p_day)
  order by effective_from desc limit 1
$$;

/** One buying rate set by hand (Settings > Rate card > Buying rates). Same rules as an imported row. */
create or replace function set_provider_rate(p_provider uuid, p_service uuid, p_rate numeric, p_effective_from date,
                                             p_tax_basis text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare s services; pv providers;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed for your role'; end if;
  select * into s from services where id = p_service and workspace_id = me_ws();
  select * into pv from providers where id = p_provider and workspace_id = me_ws() and active;
  if s.id is null then raise exception 'Service not found'; end if;
  if pv.id is null then raise exception 'Choose an active provider'; end if;
  if p_rate is null or p_rate < 0 or p_rate <> round(p_rate, 2) or p_rate > 9999999.99 then raise exception 'Enter a buying rate of 0 or more, at most 2 decimals'; end if;
  if p_tax_basis is null or p_tax_basis not in ('incl_gst','excl_gst','no_gst') then raise exception 'Choose the GST basis of the buying rate'; end if;
  if p_effective_from is null then raise exception 'Choose the date the rate applies from'; end if;
  if p_effective_from > ws_today(s.workspace_id) + 366 then raise exception 'Effective date is more than a year ahead'; end if;
  return put_provider_rate(s.workspace_id, pv.id, s.id, s.unit, p_rate, p_tax_basis, p_effective_from, null, nullif(trim(coalesce(p_note, '')), ''));
end $$;

/** Ends a buying rate (the provider stops supplying at that rate). Later versions stay. */
create or replace function end_provider_rate(p_rate uuid, p_end date) returns void
language plpgsql security definer set search_path = public as $$
declare r provider_rates;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed for your role'; end if;
  select * into r from provider_rates where id = p_rate and workspace_id = me_ws() and status = 'valid' for update;
  if r.id is null then raise exception 'Rate not found'; end if;
  if p_end is null or p_end <= r.effective_from then raise exception 'The end date must be after the start date'; end if;
  if r.effective_to is not null and p_end >= r.effective_to then raise exception 'The rate already ends on %', r.effective_to; end if;
  update provider_rates set effective_to = p_end where id = r.id;
end $$;

-- ---------- selling price versions ----------
create or replace function apply_service_price(p_service uuid, p_price numeric, p_basis text, p_from date, p_source text,
                                               p_approval uuid, p_import uuid, p_by uuid, p_history uuid, p_activate boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v int; s services;
begin
  perform rpc_on();
  update services set price = p_price, tax_basis = coalesce(p_basis, tax_basis), version = version + 1,
    approved_by = coalesce(p_by, approved_by), approved_at = now(), active = active or p_activate
  where id = p_service returning * into s;
  v := s.version;
  update service_price_history set status = 'superseded' where service_id = p_service and status = 'active';
  if p_history is not null then
    update service_price_history set status = 'active', version = v, activated_at = now() where id = p_history;
  else
    insert into service_price_history (workspace_id, service_id, version, price, unit, tax_basis, effective_from, status, source, approval_id, import_id, approved_by, activated_at)
    values (s.workspace_id, s.id, v, p_price, s.unit, s.tax_basis, p_from, 'active', p_source, p_approval, p_import, p_by, now());
  end if;
end $$;

/** Approved selling prices whose effective date has come (cron every minute, and right after an approval). */
create or replace function activate_due_prices() returns int
language plpgsql security definer set search_path = public as $$
declare h record; n int := 0;
begin
  for h in select * from service_price_history where status = 'scheduled' and effective_from <= ws_today(workspace_id)
           order by effective_from, created_at for update skip locked loop
    perform apply_service_price(h.service_id, h.price, h.tax_basis, h.effective_from, h.source, h.approval_id, h.import_id, h.approved_by, h.id, true);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- import: validation shared by the preview and the submission ----------
-- p_rows: [{row, service_code, service_name, provider_code, category, unit, b2b, b2c, effective_from,
--           service_id?, provider_id?, new_service?: {code, name, category, unit}}]   (cell text as in the file)
-- p_options: {buy_tax_basis, sell_tax_basis, effective_from?, provider_code?}  (choices made for the whole file)
create or replace function rate_import_eval(p_ws uuid, p_rows jsonb, p_options jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  x jsonb; v_i int := 0; v_out jsonb := '[]'::jsonb; v_err text[]; v_warn text[];
  s services; pv providers; v_new jsonb; v_code text; v_name text; v_cat text; v_unit text; v_ukey text;
  v_buy numeric; v_sell numeric; v_eff date; v_txt text; v_num text; v_pcode text;
  v_old_buy provider_rates; v_same provider_rates; v_buy_status text; v_sell_status text;
  v_today date := ws_today(p_ws); v_bb text := nullif(p_options->>'buy_tax_basis', ''); v_sb text := nullif(p_options->>'sell_tax_basis', '');
  v_file_err text[] := '{}'; v_extra jsonb; v_key text; v_summary jsonb; v_any_buy boolean := false; v_any_sell boolean := false;
  cats constant jsonb := '{"lab":"lab","sample collection":"lab","blood test":"lab","blood tests":"lab","xray":"xray","x-ray":"xray","portable x-ray":"xray",
    "ecg":"ecg","ecg at home":"ecg","visit":"visit","visit charges":"visit","nursing":"nursing","physio":"physio","physiotherapy":"physio",
    "beds":"beds","hospital beds":"beds","eldercare":"eldercare","elder care":"eldercare","homecare":"homecare","home care":"homecare",
    "other home care":"homecare","equipment":"equipment","icu":"icu","icu setup":"icu","consumables":"consumables","other":"other"}';
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'No rows to check'; end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'The sheet has no rows'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'At most 2,000 rows per import'; end if;
  if v_bb is not null and v_bb not in ('incl_gst','excl_gst','no_gst') then v_file_err := v_file_err || 'Unknown GST basis for buying rates'::text; end if;
  if v_sb is not null and v_sb not in ('incl_gst','excl_gst','no_gst') then v_file_err := v_file_err || 'Unknown GST basis for selling rates'::text; end if;

  for x in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1; v_err := '{}'; v_warn := '{}'; s := null; pv := null; v_new := null;
    v_buy := null; v_sell := null; v_eff := null; v_buy_status := null; v_sell_status := null; v_old_buy := null; v_same := null;
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
        if (v_new->>'category') not in ('lab','xray','ecg','visit','nursing','physio','beds','eldercare','homecare','equipment','icu','consumables','other') then
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
    if v_buy is not null and pv.id is null and nullif(x->>'provider_id', '') is null and v_pcode is null then
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
      'buy', jsonb_build_object('old', v_old_buy.rate, 'old_tax_basis', v_old_buy.tax_basis, 'new', v_buy, 'status', v_buy_status),
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
  v_key := md5(jsonb_build_object('o', jsonb_build_object('b', v_bb, 's', v_sb, 'e', nullif(p_options->>'effective_from', ''),
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
    'buy_tax_basis', v_bb, 'sell_tax_basis', v_sb, 'today', v_today);
end $$;

/** Preview: validates the sheet without changing anything. */
create or replace function rate_import_check(p_rows jsonb, p_options jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws(); v jsonb; v_prev jsonb;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed for your role'; end if;
  v := rate_import_eval(v_ws, p_rows, coalesce(p_options, '{}'::jsonb));
  select jsonb_build_object('id', id, 'sell_status', sell_status, 'created_at', created_at) into v_prev
    from rate_imports where workspace_id = v_ws and content_key = v->>'content_key' and sell_status <> 'rejected';
  return v || jsonb_build_object('already_submitted', v_prev);
end $$;

/** Validates again, then in one transaction: new services (inactive until priced), buying rates, and one approval
 *  request for every selling change. All or nothing; the same content again returns the earlier import. */
create or replace function submit_rate_import(p_rows jsonb, p_options jsonb default '{}'::jsonb, p_file_name text default null,
                                              p_sheet text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws(); v jsonb; v_imp rate_imports; v_id uuid; e jsonb; v_sid uuid; v_svc jsonb := '{}'::jsonb;
  v_buys int := 0; v_changes jsonb := '[]'::jsonb; v_appr uuid; v_new int := 0;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed for your role'; end if;
  v := rate_import_eval(v_ws, p_rows, coalesce(p_options, '{}'::jsonb));
  select * into v_imp from rate_imports where workspace_id = v_ws and content_key = v->>'content_key' and sell_status <> 'rejected';
  if v_imp.id is not null then
    return jsonb_build_object('import_id', v_imp.id, 'duplicate', true, 'buy_status', v_imp.buy_status, 'sell_status', v_imp.sell_status,
                              'approval_id', v_imp.approval_id, 'summary', v_imp.summary);
  end if;
  if not (v->>'ok')::boolean then
    raise exception '% row(s) have errors and nothing was imported. Correct them and preview again.',
      greatest((v->'summary'->>'error_rows')::int, jsonb_array_length(v->'file_errors'));
  end if;
  if (v->'summary'->>'buy_new')::int + (v->'summary'->>'buy_changed')::int + (v->'summary'->>'sell_new')::int + (v->'summary'->>'sell_changed')::int = 0 then
    raise exception 'Nothing to change: every rate in the file is already on the rate card';
  end if;

  begin
    insert into rate_imports (workspace_id, content_key, file_name, sheet_name, options, rows, summary, created_by)
    values (v_ws, v->>'content_key', nullif(trim(coalesce(p_file_name, '')), ''), nullif(trim(coalesce(p_sheet, '')), ''),
            jsonb_build_object('buy_tax_basis', v->>'buy_tax_basis', 'sell_tax_basis', v->>'sell_tax_basis'), v->'rows', v->'summary', app_uid())
    returning id into v_id;
  exception when unique_violation then
    -- the same file submitted twice at once (double click, two tabs): the first one wins, this one reports it
    select * into v_imp from rate_imports where workspace_id = v_ws and content_key = v->>'content_key' and sell_status <> 'rejected';
    return jsonb_build_object('import_id', v_imp.id, 'duplicate', true, 'buy_status', v_imp.buy_status, 'sell_status', v_imp.sell_status,
                              'approval_id', v_imp.approval_id, 'summary', v_imp.summary);
  end;

  -- new services first (inactive, price 0): they become quotable only when their selling price is approved
  for e in select * from jsonb_array_elements(v->'rows') r where jsonb_typeof(r->'new_service') = 'object' loop
    if v_svc ? (e->'new_service'->>'code') then continue; end if;
    perform rpc_on();
    insert into services (workspace_id, code, name, category, price, unit, active, description)
    values (v_ws, e->'new_service'->>'code', e->'new_service'->>'name', e->'new_service'->>'category', 0, e->'new_service'->>'unit', false,
            'Added by rate import')
    returning id into v_sid;
    insert into service_price_history (workspace_id, service_id, version, price, unit, effective_from, status, source, import_id, activated_at)
    values (v_ws, v_sid, 1, 0, e->'new_service'->>'unit', ws_today(v_ws), 'active', 'import', v_id, now());
    v_svc := v_svc || jsonb_build_object(e->'new_service'->>'code', v_sid);
    v_new := v_new + 1;
  end loop;

  for e in select * from jsonb_array_elements(v->'rows') loop
    v_sid := coalesce((e->>'service_id')::uuid, (v_svc->>(e->>'service_code'))::uuid);
    if e->'buy'->>'status' in ('new','changed') then
      perform put_provider_rate(v_ws, (e->>'provider_id')::uuid, v_sid, (select unit from services where id = v_sid),
        (e->'buy'->>'new')::numeric, v->>'buy_tax_basis', (e->>'effective_from')::date, v_id, null);
      v_buys := v_buys + 1;
    end if;
    if e->'sell'->>'status' in ('new','changed')
       and not v_changes @> jsonb_build_array(jsonb_build_object('service_id', v_sid)) then
      v_changes := v_changes || jsonb_build_object('service_id', v_sid, 'code', e->>'service_code', 'name', e->>'service_name',
        'unit', e->>'unit', 'old_price', coalesce((e->'sell'->>'old')::numeric, 0), 'old_version', coalesce((e->'sell'->>'old_version')::int, 1),
        'old_tax_basis', e->'sell'->>'old_tax_basis', 'new_price', (e->'sell'->>'new')::numeric, 'tax_basis', v->>'sell_tax_basis',
        'effective_from', e->>'effective_from', 'new_service', jsonb_typeof(e->'new_service') = 'object');
    end if;
  end loop;

  if jsonb_array_length(v_changes) > 0 then
    insert into approvals (workspace_id, kind, title, payload, requested_by)
    values (v_ws, 'rate_import', 'Rate card import · ' || jsonb_array_length(v_changes) || ' selling price change' ||
              case when jsonb_array_length(v_changes) > 1 then 's' else '' end || coalesce(' · ' || nullif(trim(coalesce(p_file_name, '')), ''), ''),
            jsonb_build_object('import_id', v_id, 'file_name', p_file_name, 'count', jsonb_array_length(v_changes),
                               'tax_basis', v->>'sell_tax_basis', 'changes', v_changes), app_uid())
    returning id into v_appr;
    perform notify_role(v_ws, 'client_manager', 'Rate card import awaiting approval',
      jsonb_array_length(v_changes) || ' selling price change(s)', '/approvals', 'warn');
  end if;
  update rate_imports set buy_status = case when v_buys > 0 then 'applied' else 'none' end,
    sell_status = case when v_appr is not null then 'awaiting_approval' else 'none' end, approval_id = v_appr
  where id = v_id;
  return jsonb_build_object('import_id', v_id, 'duplicate', false, 'buying_applied', v_buys, 'selling_changes', jsonb_array_length(v_changes),
    'new_services', v_new, 'approval_id', v_appr,
    'buy_status', case when v_buys > 0 then 'applied' else 'none' end,
    'sell_status', case when v_appr is not null then 'awaiting_approval' else 'none' end);
end $$;

/** On approval: every selling change at once, or none if a price moved since the import was submitted. */
create or replace function apply_import_selling(p_approval approvals) returns void
language plpgsql security definer set search_path = public as $$
declare ch jsonb; s services; v_today date := ws_today(p_approval.workspace_id);
begin
  for ch in select * from jsonb_array_elements(p_approval.payload->'changes') loop
    select * into s from services where id = (ch->>'service_id')::uuid for update;
    if s.id is null then raise exception 'Service % no longer exists; reject this import', ch->>'code'; end if;
    if s.price <> (ch->>'old_price')::numeric or s.version <> (ch->>'old_version')::int then
      raise exception 'The selling price of % changed after this import was submitted (now %). Reject it and import again.', s.code, s.price;
    end if;
    if (ch->>'effective_from')::date <= v_today then
      perform apply_service_price(s.id, (ch->>'new_price')::numeric, ch->>'tax_basis', (ch->>'effective_from')::date, 'import',
        p_approval.id, (p_approval.payload->>'import_id')::uuid, app_uid(), null, true);
    else
      insert into service_price_history (workspace_id, service_id, price, unit, tax_basis, effective_from, status, source, approval_id, import_id, approved_by)
      values (s.workspace_id, s.id, (ch->>'new_price')::numeric, s.unit, ch->>'tax_basis', (ch->>'effective_from')::date, 'scheduled', 'import',
              p_approval.id, (p_approval.payload->>'import_id')::uuid, app_uid());
    end if;
  end loop;
end $$;

-- the existing approval rules and approver (Hinduja management), plus rate imports; rate changes now keep history
create or replace function decide_approval(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  if not has_role('client_manager') then raise exception 'Only a client approver can decide'; end if;
  select * into a from approvals where id = p_id for update;
  if a.status <> 'pending' then raise exception 'Already %', a.status; end if;
  update approvals set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = app_uid(), decided_at = now(), decision_note = p_note where id = p_id;
  perform rpc_on();
  if a.kind = 'discount' and a.case_id is not null then
    update cases set quote_status = case when p_approve then 'approved' else 'rejected' end where id = a.case_id;
    perform log_interaction(a.case_id, 'system', 'internal',
      'Discount ' || case when p_approve then 'APPROVED' else 'REJECTED' end || ' by client approver', p_note);
  elsif a.kind = 'rate_change' and p_approve then
    perform apply_service_price((a.payload->>'service_id')::uuid, (a.payload->>'new_price')::numeric, null, ws_today(a.workspace_id),
      'rate_change', a.id, null, app_uid(), null, false);
  elsif a.kind = 'rate_import' then
    if p_approve then perform apply_import_selling((select ap from approvals ap where ap.id = p_id)); end if;
    update rate_imports set sell_status = case when p_approve then 'approved' else 'rejected' end, sell_decided_at = now()
     where id = (a.payload->>'import_id')::uuid;
  elsif a.kind = 'template' and p_approve then
    update templates set status = 'retired' where workspace_id = a.workspace_id and code = (select code from templates where id = (a.payload->>'template_id')::uuid) and status = 'approved';
    update templates set status = 'approved', approved_by = app_uid(), approved_at = now() where id = (a.payload->>'template_id')::uuid;
  elsif a.kind = 'template' and not p_approve then
    update templates set status = 'draft' where id = (a.payload->>'template_id')::uuid;
  end if;
  perform notify_user(a.requested_by, 'Approval ' || case when p_approve then 'approved' else 'rejected' end, a.title, coalesce('/cases/' || a.case_id, '/approvals'), case when p_approve then 'ok' else 'warn' end);
end $$;

-- ---------- case items: the snapshot is taken once ----------
-- Price, version, unit and GST basis are copied when the line is added (or its service changes, or on an explicit
-- refresh). Quantity changes and drop / keep reuse the snapshot: a later rate-card change never rewrites a line.
create or replace function trg_item_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record; c record;
begin
  select * into c from cases where id = new.case_id;
  if c.stage not in ('enquiry','pricing') and not is_service() then
    raise exception 'Services can only be changed during Enquiry or Pricing';
  end if;
  if tg_op = 'INSERT' or new.service_id is distinct from old.service_id or current_setting('app.price_refresh', true) = 'on' then
    select * into s from services where id = new.service_id and workspace_id = c.workspace_id and active;
    if not found then raise exception 'Service is not on the approved rate card'; end if;
    new.unit_price := s.price;          -- any client-supplied price is ignored
    new.service_code := s.code; new.service_name := s.name; new.category := s.category;
    new.unit := s.unit; new.price_version := s.version; new.price_tax_basis := s.tax_basis; new.priced_at := now();
  else
    new.unit_price := old.unit_price; new.service_code := old.service_code; new.service_name := old.service_name;
    new.category := old.category; new.unit := old.unit; new.price_version := old.price_version;
    new.price_tax_basis := old.price_tax_basis; new.priced_at := old.priced_at;
  end if;
  new.line_total := new.unit_price * new.qty;
  return new;
end $$;

/** Copies the buying rate in force today for the line's service and unit. With no provider given: the only provider
 *  with a rate, or none when there are several (a commercial user chooses). Earlier values go to the history. */
create or replace function capture_item_cost(p_item uuid, p_provider uuid, p_source text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare it record; v_prov uuid := p_provider; r provider_rates; v_old case_item_costs; v_new case_item_costs; v_n int;
begin
  select i.*, c.workspace_id into it from case_items i join cases c on c.id = i.case_id where i.id = p_item;
  if it.id is null then return; end if;
  if v_prov is null then
    select count(*), (array_agg(p.id))[1] into v_n, v_prov from providers p
     where p.workspace_id = it.workspace_id and p.active and (rate_in_force(p.id, it.service_id, it.unit, ws_today(it.workspace_id))).id is not null;
    if v_n <> 1 then v_prov := null; end if;
  end if;
  if v_prov is not null then r := rate_in_force(v_prov, it.service_id, it.unit, ws_today(it.workspace_id)); end if;
  select * into v_old from case_item_costs where case_item_id = p_item for update;
  insert into case_item_costs (case_item_id, case_id, workspace_id, provider_id, provider_rate_id, unit, buy_rate, tax_basis, source, note, captured_by, captured_at)
  values (p_item, it.case_id, it.workspace_id, v_prov, r.id, it.unit, r.rate, r.tax_basis, p_source, nullif(trim(coalesce(p_reason, '')), ''), app_uid(), now())
  on conflict (case_item_id) do update set provider_id = excluded.provider_id, provider_rate_id = excluded.provider_rate_id, unit = excluded.unit,
    buy_rate = excluded.buy_rate, tax_basis = excluded.tax_basis, source = excluded.source, note = excluded.note,
    captured_by = excluded.captured_by, captured_at = excluded.captured_at
  returning * into v_new;
  if v_old.case_item_id is not null then
    insert into case_item_cost_history (case_item_id, case_id, workspace_id, old, new, source, reason, changed_by)
    values (p_item, it.case_id, it.workspace_id, to_jsonb(v_old), to_jsonb(v_new), p_source, nullif(trim(coalesce(p_reason, '')), ''), app_uid());
  end if;
end $$;

create or replace function trg_item_cost() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.service_id is distinct from old.service_id then
    perform capture_item_cost(new.id, null, 'auto', null);
  end if;
  return null;
end $$;
drop trigger if exists item_cost on case_items;
create trigger item_cost after insert or update of service_id on case_items for each row execute function trg_item_cost();

/** Draft quotes only (Enquiry / Pricing, not sent, not signed off): take today's selling prices and buying rates. */
create or replace function refresh_case_prices(p_case uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c cases; v_old numeric; it record; v_n int := 0;
begin
  if not is_ops() then raise exception 'Not allowed for your role'; end if;
  if not can_see_case(p_case) then raise exception 'Case not found'; end if;
  select * into c from cases where id = p_case for update;
  if c.stage not in ('enquiry','pricing') or c.quote_status = 'sent' or c.signoff_at is not null then
    raise exception 'Prices can be refreshed only on a draft quote (Enquiry or Pricing, not sent, not signed off)';
  end if;
  if exists (select 1 from case_items i join services s on s.id = i.service_id where i.case_id = p_case and not s.active) then
    raise exception 'A service on this quote is no longer on the rate card: remove it first';
  end if;
  v_old := c.total;
  perform set_config('app.price_refresh', 'on', true);
  update case_items set qty = qty where case_id = p_case;
  perform set_config('app.price_refresh', 'off', true);
  for it in select i.id, k.provider_id from case_items i left join case_item_costs k on k.case_item_id = i.id where i.case_id = p_case loop
    perform capture_item_cost(it.id, it.provider_id, 'refresh', null);
    v_n := v_n + 1;
  end loop;
  select * into c from cases where id = p_case;
  perform log_interaction(p_case, 'system', 'internal', 'Quote prices refreshed from the current rate card' ||
    case when v_old is distinct from c.total then ': total ' || v_old || ' → ' || c.total else ': no change in total' end, null);
  return jsonb_build_object('items', v_n, 'old_total', v_old, 'total', c.total);
end $$;

/** Chooses the provider whose buying rate a line uses. Once the family has agreed (signed off or booked) this is an
 *  amendment: supervisors only, with a reason, kept in case_item_cost_history. Customer prices never change here. */
create or replace function set_item_provider(p_item uuid, p_provider uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i case_items; c cases; v_frozen boolean;
begin
  if not has_role('supervisor','coordinator') then raise exception 'Not allowed for your role'; end if;
  select * into i from case_items where id = p_item;
  if i.id is null or not can_see_case(i.case_id) then raise exception 'Item not found'; end if;
  select * into c from cases where id = i.case_id;
  if i.excluded then raise exception 'This item is dropped from the plan'; end if;
  if i.priced_at is null then raise exception 'This line was priced before costs were captured: refresh the draft quote, or leave it as cost not captured'; end if;
  if not exists (select 1 from providers where id = p_provider and workspace_id = c.workspace_id and active) then raise exception 'Choose an active provider'; end if;
  v_frozen := c.stage not in ('enquiry','pricing') or c.signoff_at is not null;
  if v_frozen then
    if not has_role('supervisor') then raise exception 'Prices on this booking are agreed: only a supervisor can amend the buying cost'; end if;
    if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Give a reason for amending the buying cost'; end if;
  end if;
  perform capture_item_cost(p_item, p_provider, case when v_frozen then 'amendment' else 'selected' end, p_reason);
  return (select to_jsonb(k) - 'captured_by' from case_item_costs k where k.case_item_id = p_item);
end $$;

-- ---------- margins ----------
-- One row per case line. Booking discount -> lines in proportion to their totals, rounded to the paisa by largest
-- remainder (ties: the earlier line), so the net lines add up to cases.total exactly.
create or replace function margin_lines(p_case uuid)
returns table (item_id uuid, service_id uuid, service_code text, service_name text, category text, unit text, qty int, included boolean,
               sell_rate numeric, price_version int, line_total numeric, discount_share numeric, net_selling numeric,
               provider_id uuid, provider_code text, provider_name text, buy_rate numeric, buying_total numeric,
               margin numeric, margin_pct numeric, cost_status text, cost_source text, captured_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  with c as (select round(discount_amount * 100) d from cases where id = p_case),
  it as (select i.*, k.provider_id kp, k.buy_rate kb, k.tax_basis kt, k.unit ku, k.source ks, k.captured_at kc, (k.case_item_id is not null) has_cost
         from case_items i left join case_item_costs k on k.case_item_id = i.id where i.case_id = p_case),
  inc as (select it.id, it.line_total, sum(it.line_total) over () sub, row_number() over (order by it.created_at, it.id) rn from it where not it.excluded),
  sh as (select inc.id, inc.rn,
           case when inc.sub > 0 then floor((select d from c) * inc.line_total / inc.sub) else 0 end cents,
           case when inc.sub > 0 then (select d from c) * inc.line_total / inc.sub - floor((select d from c) * inc.line_total / inc.sub) else 0 end rem
         from inc),
  lo as (select coalesce((select d from c), 0) - coalesce(sum(cents), 0) lft from sh),
  rk as (select sh.*, row_number() over (order by rem desc, rn) rr from sh),
  fin as (select rk.id, (rk.cents + case when rk.rr <= (select lft from lo) then 1 else 0 end) / 100.0 share from rk),
  ln as (
    select it.*, coalesce(fin.share, 0) share, it.line_total - coalesce(fin.share, 0) net,
      case when it.excluded then 'dropped'
           when it.priced_at is null then 'not_captured'
           when not it.has_cost or it.kp is null then 'no_provider'
           when it.kb is null then 'missing'
           when it.ku is distinct from it.unit then 'unit_mismatch'
           when it.kt is null or it.price_tax_basis is null or it.kt <> it.price_tax_basis then 'tax_basis'
           else 'ok' end st
    from it left join fin on fin.id = it.id)
  select ln.id, ln.service_id, ln.service_code, ln.service_name, ln.category, ln.unit, ln.qty, not ln.excluded,
    ln.unit_price, ln.price_version, ln.line_total, case when ln.excluded then null else ln.share end, case when ln.excluded then null else ln.net end,
    ln.kp, pv.code, pv.name, ln.kb,
    case when ln.kb is not null and not ln.excluded then round(ln.qty * ln.kb, 2) end,
    case when ln.st = 'ok' then ln.net - round(ln.qty * ln.kb, 2) end,
    case when ln.st = 'ok' and ln.net <> 0 then round((ln.net - round(ln.qty * ln.kb, 2)) * 100 / ln.net, 2) end,
    ln.st, ln.ks, ln.kc, ln.created_at
  from ln left join providers pv on pv.id = ln.kp
$$;

/** Services & quote, commercial view: lines with provider, buying and selling, totals, the providers that have a rate
 *  for each line, and the amendment history. SecondMedic supervisors and coordinators only. */
create or replace function case_margins(p_case uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c cases; v_lines jsonb; v_tot jsonb; v_hist jsonb; v_today date;
begin
  if not has_role('supervisor','coordinator') then raise exception 'Not allowed for your role'; end if;
  if not can_see_case(p_case) then raise exception 'Case not found'; end if;
  select * into c from cases where id = p_case;
  v_today := ws_today(c.workspace_id);
  select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object('options', coalesce((
      select jsonb_agg(jsonb_build_object('provider_id', p.id, 'code', p.code, 'name', p.name, 'rate', r.rate, 'tax_basis', r.tax_basis) order by p.code)
      from providers p cross join lateral rate_in_force(p.id, l.service_id, l.unit, v_today) r
      where p.workspace_id = c.workspace_id and p.active and r.id is not null), '[]'::jsonb)) order by l.created_at, l.item_id), '[]'::jsonb)
  into v_lines from margin_lines(p_case) l;
  select jsonb_build_object(
      'lines', count(*) filter (where included),
      'net_selling', coalesce(sum(net_selling) filter (where included), 0),
      'discount', coalesce(sum(discount_share) filter (where included), 0),
      'costed_lines', count(*) filter (where cost_status = 'ok'),
      'known_net', coalesce(sum(net_selling) filter (where cost_status = 'ok'), 0),
      'known_buying', coalesce(sum(buying_total) filter (where cost_status = 'ok'), 0),
      'known_margin', coalesce(sum(margin) filter (where cost_status = 'ok'), 0),
      'status', case when count(*) filter (where included) = 0 then 'empty'
                     when count(*) filter (where included and cost_status <> 'not_captured') = 0 then 'not_captured'
                     when count(*) filter (where included and cost_status <> 'ok') = 0 then 'complete' else 'incomplete' end)
  into v_tot from margin_lines(p_case);
  if v_tot->>'status' = 'complete' then
    v_tot := v_tot || jsonb_build_object('buying', v_tot->'known_buying', 'margin', v_tot->'known_margin',
      'margin_pct', case when (v_tot->>'net_selling')::numeric <> 0 then round((v_tot->>'known_margin')::numeric * 100 / (v_tot->>'net_selling')::numeric, 2) end);
  else
    v_tot := v_tot || jsonb_build_object('buying', null, 'margin', null, 'margin_pct', null);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('at', h.changed_at, 'source', h.source, 'reason', h.reason, 'by', pr.full_name,
      'service_name', i.service_name, 'old_provider', po.code, 'old_rate', h.old->'buy_rate', 'new_provider', pn.code, 'new_rate', h.new->'buy_rate')
      order by h.changed_at desc), '[]'::jsonb)
  into v_hist
  from (select * from case_item_cost_history where case_id = p_case order by changed_at desc limit 30) h
  left join case_items i on i.id = h.case_item_id left join profiles pr on pr.id = h.changed_by
  left join providers po on po.id = (h.old->>'provider_id')::uuid left join providers pn on pn.id = (h.new->>'provider_id')::uuid;
  return jsonb_build_object('lines', v_lines, 'totals', v_tot, 'history', v_hist,
    'case_total', c.total, 'case_discount', c.discount_amount,
    'reconciles', (v_tot->>'net_selling')::numeric = c.total and (v_tot->>'discount')::numeric = c.discount_amount,
    'frozen', c.stage not in ('enquiry','pricing') or c.signoff_at is not null,
    'can_refresh', c.stage in ('enquiry','pricing') and c.quote_status <> 'sent' and c.signoff_at is null,
    'stale', exists (select 1 from case_items i join services s on s.id = i.service_id
                     where i.case_id = p_case and not i.excluded and (i.priced_at is null or s.version <> i.price_version)));
end $$;

/** MIS > Margins: bookings confirmed in the period (IST date of booking confirmation; cancelled bookings left out),
 *  projected (service not completed yet) and completed. Aggregate margin % comes from the aggregate amounts. */
create or replace function margin_report(p_from date, p_to date, p_provider uuid default null, p_service uuid default null,
                                         p_case text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := me_ws(); v_tz text; v jsonb;
begin
  if not has_role('supervisor','coordinator') then raise exception 'Not allowed for your role'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid period'; end if;
  if p_to - p_from > 400 then raise exception 'Choose a period of at most 400 days'; end if;
  select timezone into v_tz from workspaces where id = v_ws;
  with bk as (
    select c.id, c.case_no, c.stage, c.booking_confirmed_at, (c.service_completed_at is not null) completed
    from cases c
    where c.workspace_id = v_ws and c.booking_confirmed_at is not null and c.stage <> 'cancelled'
      and (c.booking_confirmed_at at time zone v_tz)::date between p_from and p_to
      and (p_case is null or trim(p_case) = '' or c.case_no ilike '%' || trim(p_case) || '%')
      and can_see_case(c.id)),
  ln as (
    select bk.*, l.* from bk cross join lateral margin_lines(bk.id) l
    where l.included and (p_provider is null or l.provider_id = p_provider) and (p_service is null or l.service_id = p_service)),
  per as (
    select id, case_no, stage, booking_confirmed_at, completed, count(*) lines,
      sum(net_selling) net, count(*) filter (where cost_status <> 'ok') open_lines,
      bool_and(cost_status = 'not_captured') legacy,
      sum(buying_total) filter (where cost_status = 'ok') kb, sum(net_selling) filter (where cost_status = 'ok') kn,
      sum(margin) filter (where cost_status = 'ok') km
    from ln group by id, case_no, stage, booking_confirmed_at, completed),
  grp as (select * from per),
  agg as (
    select jsonb_build_object(
      'bookings', count(*), 'lines', coalesce(sum(lines), 0), 'net_selling', coalesce(sum(net), 0),
      'complete', jsonb_build_object('bookings', count(*) filter (where open_lines = 0),
        'net_selling', coalesce(sum(net) filter (where open_lines = 0), 0), 'buying', coalesce(sum(kb) filter (where open_lines = 0), 0),
        'margin', coalesce(sum(km) filter (where open_lines = 0), 0),
        'margin_pct', case when coalesce(sum(net) filter (where open_lines = 0), 0) <> 0
                           then round(sum(km) filter (where open_lines = 0) * 100 / sum(net) filter (where open_lines = 0), 2) end),
      'incomplete', jsonb_build_object('bookings', count(*) filter (where open_lines > 0 and not legacy),
        'net_selling', coalesce(sum(net) filter (where open_lines > 0 and not legacy), 0),
        'known_net', coalesce(sum(kn) filter (where open_lines > 0 and not legacy), 0),
        'known_buying', coalesce(sum(kb) filter (where open_lines > 0 and not legacy), 0),
        'known_margin', coalesce(sum(km) filter (where open_lines > 0 and not legacy), 0)),
      'not_captured', jsonb_build_object('bookings', count(*) filter (where legacy), 'net_selling', coalesce(sum(net) filter (where legacy), 0))) t
    from grp)
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'basis', 'Bookings confirmed in the period (date of booking confirmation, IST). Cancelled bookings are left out. Projected = service not completed yet; completed = service completion recorded. Gross margin = net selling value after discount minus buying cost, before collections and refunds.',
    'totals', (select t from agg),
    'projected', (select jsonb_build_object('bookings', count(*), 'net_selling', coalesce(sum(net), 0), 'complete_bookings', count(*) filter (where open_lines = 0),
        'complete_net', coalesce(sum(net) filter (where open_lines = 0), 0), 'buying', coalesce(sum(kb) filter (where open_lines = 0), 0),
        'margin', coalesce(sum(km) filter (where open_lines = 0), 0),
        'margin_pct', case when coalesce(sum(net) filter (where open_lines = 0), 0) <> 0 then round(sum(km) filter (where open_lines = 0) * 100 / sum(net) filter (where open_lines = 0), 2) end)
      from per where not completed),
    'completed', (select jsonb_build_object('bookings', count(*), 'net_selling', coalesce(sum(net), 0), 'complete_bookings', count(*) filter (where open_lines = 0),
        'complete_net', coalesce(sum(net) filter (where open_lines = 0), 0), 'buying', coalesce(sum(kb) filter (where open_lines = 0), 0),
        'margin', coalesce(sum(km) filter (where open_lines = 0), 0),
        'margin_pct', case when coalesce(sum(net) filter (where open_lines = 0), 0) <> 0 then round(sum(km) filter (where open_lines = 0) * 100 / sum(net) filter (where open_lines = 0), 2) end)
      from per where completed),
    'by_provider', (select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object('provider_id', provider_id, 'code', coalesce(provider_code, '-'), 'name', coalesce(provider_name, 'Provider not chosen'),
          'lines', count(*), 'net_selling', sum(net_selling), 'costed_net', coalesce(sum(net_selling) filter (where cost_status = 'ok'), 0),
          'buying', coalesce(sum(buying_total) filter (where cost_status = 'ok'), 0), 'margin', coalesce(sum(margin) filter (where cost_status = 'ok'), 0),
          'margin_pct', case when coalesce(sum(net_selling) filter (where cost_status = 'ok'), 0) <> 0
                             then round(sum(margin) filter (where cost_status = 'ok') * 100 / sum(net_selling) filter (where cost_status = 'ok'), 2) end,
          'lines_without_cost', count(*) filter (where cost_status <> 'ok')) x
        from ln group by provider_id, provider_code, provider_name) g),
    'by_service', (select coalesce(jsonb_agg(x order by x->>'code'), '[]'::jsonb) from (
        select jsonb_build_object('service_id', service_id, 'code', service_code, 'name', service_name, 'unit', unit,
          'lines', count(*), 'qty', sum(qty), 'net_selling', sum(net_selling), 'costed_net', coalesce(sum(net_selling) filter (where cost_status = 'ok'), 0),
          'buying', coalesce(sum(buying_total) filter (where cost_status = 'ok'), 0), 'margin', coalesce(sum(margin) filter (where cost_status = 'ok'), 0),
          'margin_pct', case when coalesce(sum(net_selling) filter (where cost_status = 'ok'), 0) <> 0
                             then round(sum(margin) filter (where cost_status = 'ok') * 100 / sum(net_selling) filter (where cost_status = 'ok'), 2) end,
          'lines_without_cost', count(*) filter (where cost_status <> 'ok')) x
        from ln group by service_id, service_code, service_name, unit) g),
    'bookings', (select coalesce(jsonb_agg(jsonb_build_object('case_id', id, 'case_no', case_no, 'stage', stage, 'booked_at', booking_confirmed_at,
          'completed', completed, 'lines', lines, 'net_selling', net, 'lines_without_cost', open_lines,
          'status', case when legacy then 'not_captured' when open_lines = 0 then 'complete' else 'incomplete' end,
          'buying', case when open_lines = 0 then kb end, 'margin', case when open_lines = 0 then km end,
          'margin_pct', case when open_lines = 0 and net <> 0 then round(km * 100 / net, 2) end,
          'known_buying', case when open_lines > 0 and not legacy then coalesce(kb, 0) end) order by booking_confirmed_at desc), '[]'::jsonb)
        from (select * from per order by booking_confirmed_at desc limit 1000) b))
  into v;
  return v;
end $$;

-- ---------- row level security: costs never reach Hinduja, agents, field staff, medical desk or providers ----------
alter table provider_rates enable row level security;
alter table case_item_costs enable row level security;
alter table case_item_cost_history enable row level security;
alter table rate_imports enable row level security;
alter table service_price_history enable row level security;

drop policy if exists provider_rates_read on provider_rates;
create policy provider_rates_read on provider_rates for select using (workspace_id = me_ws() and has_role('supervisor','coordinator','admin'));
drop policy if exists item_costs_read on case_item_costs;
create policy item_costs_read on case_item_costs for select using (has_role('supervisor','coordinator') and can_see_case(case_id));
drop policy if exists item_cost_history_read on case_item_cost_history;
create policy item_cost_history_read on case_item_cost_history for select using (has_role('supervisor','coordinator') and can_see_case(case_id));
drop policy if exists rate_imports_read on rate_imports;
create policy rate_imports_read on rate_imports for select using (workspace_id = me_ws() and has_role('supervisor','admin'));
drop policy if exists price_history_read on service_price_history;
create policy price_history_read on service_price_history for select using (workspace_id = me_ws() and not has_role('provider'));

-- written only by the functions above
revoke insert, update, delete on provider_rates, case_item_costs, case_item_cost_history, rate_imports, service_price_history from caredesk_app;
grant select on provider_rates, case_item_costs, case_item_cost_history, rate_imports, service_price_history to caredesk_app;
grant usage, select on sequence case_item_cost_history_id_seq to caredesk_app;

-- internal building blocks: callable only from the checked actions
revoke execute on function put_provider_rate(uuid, uuid, uuid, text, numeric, text, date, uuid, text),
  rate_in_force(uuid, uuid, text, date), apply_service_price(uuid, numeric, text, date, text, uuid, uuid, uuid, uuid, boolean),
  activate_due_prices(), rate_import_eval(uuid, jsonb, jsonb), apply_import_selling(approvals),
  capture_item_cost(uuid, uuid, text, text), margin_lines(uuid) from public, caredesk_app;
grant execute on function unit_key(text), ws_today(uuid), set_provider_rate(uuid, uuid, numeric, date, text, text), end_provider_rate(uuid, date),
  rate_import_check(jsonb, jsonb), submit_rate_import(jsonb, jsonb, text, text), decide_approval(uuid, boolean, text),
  refresh_case_prices(uuid), set_item_provider(uuid, uuid, text), case_margins(uuid), margin_report(date, date, uuid, uuid, text) to caredesk_app;

-- ---------- live updates (table names only) ----------
do $$ declare t text; begin
  foreach t in array array['provider_rates','case_item_costs','case_item_cost_history','rate_imports','service_price_history'] loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;
