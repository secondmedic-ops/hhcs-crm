-- =====================================================================
-- BMM service scoping and pricing guard (21 Oct 2026).
--   * Scopes Book My Medicare (BMM) catalog strictly to allocated categories:
--     nursing, physio, beds, eldercare, homecare, equipment, icu, other.
--   * Completely hides non-BMM services (lab, xray, ecg, visit) from BMM.
--   * Hides B2C selling rates, Hinduja markups, margins, and discount approvals from BMM.
--   * Exposes B2B rate (70% tariff per reference sheet) to BMM.
-- =====================================================================

update providers
set categories = array['nursing','physio','beds','eldercare','homecare','equipment','icu','other']
where code = 'BMM';

-- RLS: services read scoping for provider and provider field staff
drop policy if exists services_read on services;
create policy services_read on services for select using (
  workspace_id = me_ws() and (
    not (has_role('provider') or (has_role('field_staff') and me_provider() is not null))
    or (category = any(me_provider_categories()) and category not in ('lab','xray','ecg','visit'))
  )
);

-- RLS: case_items scoping to protect non-BMM services on split-referral cases
drop policy if exists items_read on case_items;
create policy items_read on case_items for select using (
  can_see_case(case_id) and (
    not (has_role('provider') or (has_role('field_staff') and me_provider() is not null))
    or (category = any(me_provider_categories()) and category not in ('lab','xray','ecg','visit'))
  )
);

-- RLS: approvals confidentiality - BMM never reads discount approvals or internal approvals
drop policy if exists approvals_read on approvals;
create policy approvals_read on approvals for select using (
  workspace_id = me_ws()
  and not (has_role('provider') or (has_role('field_staff') and me_provider() is not null))
  and (
    has_role('supervisor','coordinator','client_manager','admin')
    or (case_id is not null and can_see_case(case_id))
    or requested_by = app_uid()
  )
);

-- Secure view v_services: masks B2C price for partner logins, provides 70% B2B rate
create or replace view v_services with (security_invoker = true) as
select
  s.id, s.workspace_id, s.code, s.name, s.category, s.unit, s.tat_hours, s.description, s.active, s.version,
  case
    when has_role('provider') or (has_role('field_staff') and me_provider() is not null) then null
    else s.price
  end as price,
  coalesce(
    (select pr.rate from provider_rates pr
     where pr.service_id = s.id and pr.provider_id = me_provider() and pr.status = 'valid'
       and pr.effective_from <= ws_today(s.workspace_id)
       and (pr.effective_to is null or pr.effective_to > ws_today(s.workspace_id))
     order by pr.effective_from desc limit 1),
    case when has_role('provider') or (has_role('field_staff') and me_provider() is not null) then round(s.price * 0.70, 2) else null end
  ) as b2b_rate,
  case
    when has_role('provider') or (has_role('field_staff') and me_provider() is not null) then null
    else s.tax_basis
  end as tax_basis,
  s.approved_at, s.updated_at
from services s;
grant select on v_services to caredesk_app;
