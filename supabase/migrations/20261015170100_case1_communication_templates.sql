-- =====================================================================
-- CareDesk CRM  |  Step 1, Step 3, Step 6 Communication Templates
-- S-02: Home assessment & pricing explanation call script
-- T-09: Hinduja-certified nurse home assessment appointment confirmation (WhatsApp)
-- T-10: Final bill & payment receipt dispatch (WhatsApp)
-- =====================================================================

with w as (select id from workspaces where code = 'HHC')
insert into templates (workspace_id, code, title, kind, body, status, approved_at)
select w.id, t.code, t.title, t.kind, t.body, 'approved', now()
from w, (values
  ('S-02', 'Home Assessment & Pricing Explanation', 'script',
   E'Good {{greeting_time}}, thank you for contacting Hinduja Home Care. My name is {{agent_name}}.\n1. Confirm patient name, location, and key requirements (beds, oxygen, BiPAP, nursing).\n2. EXPLAIN HOME ASSESSMENT: "To ensure your loved one''s safety, a Hinduja-certified care coordinator nurse will visit your home to assess room dimensions, electrical earthing for life support, and clinical care needs."\n3. EXPLAIN PRICING: "Our pricing is strictly itemized based on the Hinduja rate card. After the nurse assessment, you will receive a transparent quote where you can choose and approve the exact services."\n4. Book preferred assessment date & time slot.'),
  ('T-09', 'Nurse Assessment Appointment Confirmation', 'whatsapp',
   E'Namaste {{caller_name}}, your Hinduja-Certified Nurse Home Assessment has been scheduled for *{{slot}}* under Case Ref: *{{case_no}}*.\nAssigned Nurse: {{agent_name}}.\nOur nurse will evaluate equipment space, oxygen readiness, and finalize your home care plan. For assistance call {{support_number}}.'),
  ('T-10', 'Final Bill & Payment Receipt', 'whatsapp',
   E'Dear {{caller_name}}, thank you for choosing Hinduja Home Care.\nCase Ref: *{{case_no}}*\nServices Delivered: {{services}}\nTotal Billed: ₹{{total}} | Amount Paid: ₹{{amount_collected}} | Balance: ₹{{balance}}\nReceipt No: {{receipt_no}}\nPayment Status: *{{payment_status}}*. Your formal tax invoice is attached. For billing support, reply to this message.')
) as t(code, title, kind, body)
on conflict (workspace_id, code, version) do update
set title = excluded.title, kind = excluded.kind, body = excluded.body, status = 'approved', approved_at = now();

-- ---------------------------------------------------------------------
-- Template Variables & Rendering
-- Supports {{balance}}, {{amount_collected}}, {{receipt_no}}, {{payment_status}},
-- {{agent_name}}, {{greeting_time}}, {{slot}} (from booking or scheduled assessment)
-- ---------------------------------------------------------------------

create or replace function render_template(p_template uuid, p_case uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  t record;
  c record;
  p record;
  v text;
  items text;
  v_slot text;
  v_nurse text;
  v_greeting text;
  v_receipt text;
  v_balance numeric;
begin
  select * into t from templates where id = p_template;
  if not found then return null; end if;

  select * into c from cases where id = p_case;
  if not found then return t.body; end if;

  select * into p from patients where id = c.patient_id;

  select string_agg(service_name || ' ₹' || line_total, ', ' order by created_at)
  into items
  from case_items
  where case_id = p_case and not coalesce(excluded, false);

  v_slot := coalesce(
    to_char(c.booked_slot at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
    to_char((select scheduled_at from discharge_assessments where case_id = p_case and status in ('scheduled', 'done') order by created_at desc limit 1) at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
    to_char(c.preferred_slot at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM'),
    ''
  );

  select coalesce(
    (select pr.full_name from discharge_assessments da join profiles pr on pr.id = da.nurse_id where da.case_id = p_case and da.status in ('scheduled', 'done') order by da.created_at desc limit 1),
    (select pr.full_name from profiles pr where pr.id = c.coordinator_id),
    (select pr.full_name from profiles pr where pr.id = c.owner_id),
    (select pr.full_name from profiles pr where pr.id = app_uid()),
    'Care Coordinator'
  ) into v_nurse;

  v_greeting := case
    when extract(hour from now() at time zone 'Asia/Kolkata') < 12 then 'morning'
    when extract(hour from now() at time zone 'Asia/Kolkata') < 17 then 'afternoon'
    else 'evening'
  end;

  select coalesce(
    nullif((select string_agg(receipt_no, ', ' order by collected_at) from payments where case_id = p_case and receipt_no is not null and trim(receipt_no) <> ''), ''),
    '–'
  ) into v_receipt;

  v_balance := greatest(coalesce(c.total, 0) - coalesce(c.amount_collected, 0), 0);

  v := t.body;
  v := replace(v, '{{patient_name}}', coalesce(p.full_name, ''));
  v := replace(v, '{{caller_name}}', coalesce(c.caller_name, p.full_name, ''));
  v := replace(v, '{{case_no}}', coalesce(c.case_no, ''));
  v := replace(v, '{{services}}', coalesce(items, ''));
  v := replace(v, '{{subtotal}}', coalesce(c.subtotal::text, '0'));
  v := replace(v, '{{discount}}', coalesce(c.discount_amount::text, '0'));
  v := replace(v, '{{total}}', coalesce(c.total::text, '0'));
  v := replace(v, '{{slot}}', v_slot);
  v := replace(v, '{{brand}}', coalesce((select brand_name from workspaces where id = c.workspace_id), ''));
  v := replace(v, '{{support_number}}', coalesce((select support_number from workspaces where id = c.workspace_id), ''));
  v := replace(v, '{{balance}}', coalesce(v_balance::text, '0'));
  v := replace(v, '{{amount_collected}}', coalesce(c.amount_collected::text, '0'));
  v := replace(v, '{{receipt_no}}', coalesce(v_receipt, '–'));
  v := replace(v, '{{payment_status}}', coalesce(c.payment_status, 'unpaid'));
  v := replace(v, '{{agent_name}}', coalesce(v_nurse, ''));
  v := replace(v, '{{greeting_time}}', v_greeting);

  return v;
end $$;

grant execute on function render_template(uuid, uuid) to caredesk_app;
