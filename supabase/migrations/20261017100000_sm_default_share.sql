-- =====================================================================
-- SecondMedic default share: until the B2B rates are imported, margins use SecondMedic's agreed share of the B2C rate.
--   * workspaces.settings.sm_share_pct (HHCS: 30). A line with no usable buying rate (no provider, no B2B rate for the
--     provider and unit, or priced before costs were captured) is costed at B2B = round(B2C x (100 - share) / 100, 2)
--     per unit. Example: B2C 1,000 -> B2B 700 -> SecondMedic gross margin 300 (before any discount).
--   * The same rule as the importer's "B2B = 70% of B2C", so margins do not jump when the rates arrive.
--   * Only a missing rate is filled. A real B2B rate always wins; a rate with a different unit or GST basis is still
--     reported as not comparable. A discount still comes out of the margin (net selling - buying).
--   * margin_lines gains cost_basis ('rate' | 'default_share' | null) and default_share_pct, so screens can say the
--     cost is assumed. Remove the setting (or set it to null) to go back to "cost missing".
-- Expand only.
-- =====================================================================

update workspaces set settings = settings || jsonb_build_object('sm_share_pct', 30)
 where code = 'HHC' and not (settings ? 'sm_share_pct');

/** Valid share 0-100 with at most 2 decimals, else null (no default). */
create or replace function ws_sm_share_pct(p_ws uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select case when trim(coalesce(settings->>'sm_share_pct', '')) ~ '^\d{1,3}(\.\d{1,2})?$'
               and trim(settings->>'sm_share_pct')::numeric between 0 and 100
              then trim(settings->>'sm_share_pct')::numeric end
  from workspaces where id = p_ws
$$;

drop function if exists margin_lines(uuid);
create function margin_lines(p_case uuid)
returns table (item_id uuid, service_id uuid, service_code text, service_name text, category text, unit text, qty int, included boolean,
               sell_rate numeric, price_version int, line_total numeric, discount_share numeric, net_selling numeric,
               provider_id uuid, provider_code text, provider_name text, buy_rate numeric, buying_total numeric,
               margin numeric, margin_pct numeric, cost_status text, cost_source text, captured_at timestamptz, created_at timestamptz,
               cost_basis text, default_share_pct numeric)
language sql stable security definer set search_path = public as $$
  with c as (select round(cs.discount_amount * 100) d, ws_sm_share_pct(cs.workspace_id) sp from cases cs where cs.id = p_case),
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
  ln0 as (
    select it.*, coalesce(fin.share, 0) share, it.line_total - coalesce(fin.share, 0) net,
      case when it.excluded then 'dropped'
           when it.priced_at is null then 'not_captured'
           when not it.has_cost or it.kp is null then 'no_provider'
           when it.kb is null then 'missing'
           when it.ku is distinct from it.unit then 'unit_mismatch'
           when it.kt is null or it.price_tax_basis is null or it.kt <> it.price_tax_basis then 'tax_basis'
           else 'ok' end st0
    from it left join fin on fin.id = it.id),
  -- no usable rate + a default share: B2B per unit = B2C x (100 - share) / 100, same GST basis as the selling price
  ln as (
    select ln0.*,
      (ln0.st0 in ('not_captured','no_provider','missing') and (select sp from c) is not null) assumed,
      case when ln0.st0 in ('not_captured','no_provider','missing') and (select sp from c) is not null then 'ok' else ln0.st0 end st,
      case when ln0.st0 in ('not_captured','no_provider','missing') and (select sp from c) is not null
           then round(ln0.unit_price * (100 - (select sp from c)) / 100, 2) else ln0.kb end br
    from ln0)
  select ln.id, ln.service_id, ln.service_code, ln.service_name, ln.category, ln.unit, ln.qty, not ln.excluded,
    ln.unit_price, ln.price_version, ln.line_total, case when ln.excluded then null else ln.share end, case when ln.excluded then null else ln.net end,
    ln.kp, pv.code, pv.name, ln.br,
    case when ln.br is not null and not ln.excluded then round(ln.qty * ln.br, 2) end,
    case when ln.st = 'ok' then ln.net - round(ln.qty * ln.br, 2) end,
    case when ln.st = 'ok' and ln.net <> 0 then round((ln.net - round(ln.qty * ln.br, 2)) * 100 / ln.net, 2) end,
    ln.st, ln.ks, ln.kc, ln.created_at,
    case when ln.assumed then 'default_share' when ln.st = 'ok' then 'rate' end,
    case when ln.assumed then (select sp from c) end
  from ln left join providers pv on pv.id = ln.kp
$$;

revoke execute on function margin_lines(uuid), ws_sm_share_pct(uuid) from public, caredesk_app;
