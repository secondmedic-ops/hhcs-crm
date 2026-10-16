-- Home X-ray options from the supplied Hinduja patient-price sheet (16 October 2026).
-- Diagnostic is a display group: retain xray/ecg keys for routing, fulfilment and reporting.
-- Add products without overwriting existing services, prices, bookings or approval history.
-- The sheet does not specify GST basis; leave it unconfirmed.
with w as (select id from workspaces where code = 'HHC')
insert into services (workspace_id, code, name, category, price, unit, description, approved_at)
select w.id, s.code, s.name, 'xray', s.price, s.unit, s.description, now()
from w cross join (values
  ('XR-HOME', 'X-ray at Home', 2000, 'First Shot', 'Home X-ray, first shot. Hinduja patient price: INR 2,000.'),
  ('XR-ADDITIONAL', 'Additional X-ray Shot - Same Visit/Same Address', 700, '1 Additional X-ray Shoot', 'Additional X-ray shot during the same visit at the same address. Hinduja patient price: INR 700.'),
  ('XR-PRINT', 'Additional Printed X-ray Film', 200, 'additional X-ray Print', 'Additional printed X-ray film. Hinduja patient price: INR 200 per additional print.')
) as s(code, name, price, unit, description)
on conflict (workspace_id, code) do nothing;

insert into service_price_history (workspace_id, service_id, version, price, unit, tax_basis, effective_from, status, source, approved_by, activated_at)
select s.workspace_id, s.id, s.version, s.price, s.unit, s.tax_basis,
       ws_today(s.workspace_id), 'active', 'baseline', s.approved_by, coalesce(s.approved_at, s.updated_at)
from services s join workspaces w on w.id = s.workspace_id and w.code = 'HHC'
where s.code in ('XR-HOME', 'XR-ADDITIONAL', 'XR-PRINT')
  and not exists (select 1 from service_price_history h where h.service_id = s.id);
