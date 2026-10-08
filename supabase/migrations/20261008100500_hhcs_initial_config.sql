-- =====================================================================
-- CareDesk CRM  |  seed: Hinduja Home Care workspace
-- Prices are PLACEHOLDERS until Hinduja shares its approved rate card.
-- SLA and escalation values are the draft matrix from the proposal (slides 12-13).
-- =====================================================================

insert into workspaces (code, name, brand_name, support_number, support_email, discount_band_pct, settings)
values ('HHC', 'Hinduja Home Care Services', 'Hinduja Home Care', '+91 22 0000 0000', 'homecare@example.com', 10,
        '{"allow_cash": false, "languages": ["English","Hindi","Marathi"], "collection_model": "A", "did_numbers": ["+912240000000","+912240000001"], "did_labels": {"+912240000000": "Khar", "+912240000001": "Mahim"}}')
on conflict (code) do nothing;

with w as (select id from workspaces where code = 'HHC')
insert into zones (workspace_id, name, pincodes)
select w.id, z.name, z.pins from w, (values
  ('Andheri',  array['400053','400058','400059','400069','400093']),
  ('Bandra–Khar', array['400050','400051','400052']),
  ('Mahim–Dadar', array['400016','400014','400028','400025']),
  ('Powai',    array['400076','400072','400087']),
  ('Thane',    array['400601','400602','400603','400604','400606','400607','400610'])
) as z(name, pins)
on conflict (workspace_id, name) do nothing;

with w as (select id from workspaces where code = 'HHC')
insert into services (workspace_id, code, name, category, price, tat_hours, description, approved_at)
select w.id, s.code, s.name, s.cat, s.price, s.tat, s.descr, now() from w, (values
  ('LAB-CBC',   'Complete Blood Count',                 'lab',  450,  12, 'Home collection, EDTA'),
  ('LAB-LFT',   'Liver Function Test',                  'lab',  750,  24, 'Home collection, SST'),
  ('LAB-KFT',   'Kidney Function Test',                 'lab',  800,  24, 'Home collection, SST'),
  ('LAB-HBA1C', 'HbA1c',                                 'lab',  600,  24, 'Home collection, EDTA'),
  ('LAB-LIPID', 'Lipid Profile',                        'lab',  700,  24, 'Fasting 10-12 hrs'),
  ('LAB-THY',   'Thyroid Profile (T3, T4, TSH)',        'lab',  650,  24, 'Home collection'),
  ('LAB-PANEL', 'Senior Citizen Health Panel',          'lab', 2800,  36, 'CBC, LFT, KFT, Lipid, HbA1c, TSH, Vit D, B12'),
  ('ECG-12',    'ECG at home (12-lead)',                'ecg',  900,   4, 'Trained technician, secure upload for interpretation'),
  ('XR-CHEST',  'Portable X-ray · Chest PA',            'xray', 2200,  12, 'Radiographer with portable unit'),
  ('XR-LIMB',   'Portable X-ray · Limb / Joint',        'xray', 2400,  12, 'Radiographer with portable unit'),
  ('VISIT-URG', 'Urgent visit surcharge (within ~2 hrs)','visit', 300, null, 'Applies to urgent requests'),
  ('VISIT-STD', 'Home visit charge',                    'visit', 150, null, 'Standard scheduled slot')
) as s(code, name, cat, price, tat, descr)
on conflict (workspace_id, code) do nothing;

with w as (select id from workspaces where code = 'HHC')
insert into sla_policies (workspace_id, key, label, target_minutes, escalate_to, measured_by)
select w.id, s.k, s.l, s.m, s.r::app_role, s.mb from w, (values
  ('call_answer',      'Call answer ≤ 30 sec',               1,    'supervisor',     'Telephony timestamps'),
  ('missed_callback',  'Missed-call callback',               10,   'supervisor',     'Missed-call queue timer'),
  ('ack',              'Email / chat / WhatsApp acknowledgement', 5, 'coordinator',  'Ticket creation → first reply'),
  ('quote',            'Quote shared',                       10,   'coordinator',    'Enquiry → quote timestamps'),
  ('booking',          'Booking confirmation',               15,   'coordinator',    'Quote → booking timestamps'),
  ('arrival_urgent',   'Field arrival · urgent',             120,  'coordinator',    'Geo-tagged check-in'),
  ('arrival_slot',     'Field arrival · within ±15 min of slot', 15, 'coordinator',  'Geo-tagged check-in'),
  ('complaint_ack',    'Complaint acknowledgement',          15,   'supervisor',     'Complaint ticket'),
  ('complaint_resolve','Complaint resolution (routine)',     2880, 'supervisor',     'Complaint ticket'),
  ('critical_finding', 'Critical finding → Hinduja clinical', 5,   'client_clinical','Escalation log')
) as s(k, l, m, r, mb)
on conflict (workspace_id, key) do nothing;

with w as (select id from workspaces where code = 'HHC')
insert into escalation_matrix (workspace_id, type, level, owner_label, target_minutes)
select w.id, e.t, e.l, e.o, e.m from w, (values
  ('clinical', 1, 'SecondMedic medical desk, immediate', 0),
  ('clinical', 2, 'Hinduja clinical contact', 5),
  ('clinical', 3, 'Hinduja clinical head', 15),
  ('emergency',1, 'Field staff calls 108 / Hinduja emergency', 0),
  ('emergency',2, 'Hinduja clinical + coordinator', 5),
  ('emergency',3, 'Both leadership teams', 15),
  ('delay',    1, 'Coordinator, reassign / backup', 15),
  ('delay',    2, 'Hinduja coordinator (≥30 min before slot)', 30),
  ('delay',    3, 'Ops heads (both sides)', 60),
  ('complaint',1, 'Supervisor acknowledgement', 15),
  ('complaint',2, 'Hinduja service lead', 1440),
  ('complaint',3, 'Account leads', 2880),
  ('privacy',  1, 'SecondMedic security lead, immediate', 0),
  ('privacy',  2, 'Hinduja DPO / IT, same day', 480),
  ('privacy',  3, 'Per DPA & law', null)
) as e(t, l, o, m)
on conflict (workspace_id, type, level) do nothing;

with w as (select id from workspaces where code = 'HHC')
insert into templates (workspace_id, kind, code, title, body, status, approved_at)
select w.id, t.k, t.c, t.t, t.b, 'approved', now() from w, (values
  ('script',   'S-01', 'Inbound greeting & consent',
   E'Good {{greeting_time}}, thank you for calling {{brand}}. My name is {{agent_name}}.\n1. Ask caller name and relation to patient.\n2. CONSENT: "This call is recorded for quality and your records. May we record and use these details to arrange your service?", wait for a clear yes.\n3. Patient name, age, gender. Address with landmark and pincode.\n4. Services needed and preferred date/time.\n5. Any symptoms right now? If chest pain, breathlessness, collapse → follow EMERGENCY script S-09.\n6. Read back details. Quote only from the rate card on screen.\n7. Close: "You will receive the quote on WhatsApp shortly. Your reference is {{case_no}}."'),
  ('script',   'S-09', 'Emergency at home',
   E'Do NOT give clinical advice.\n1. Ask caller to dial 108 immediately, or offer to connect.\n2. Confirm address and a callback number.\n3. Raise EMERGENCY escalation in CRM (one click), Hinduja clinical is notified.\n4. Stay on the line until help is arranged.'),
  ('whatsapp', 'T-03', 'Quote',
   E'Dear {{caller_name}}, thank you for choosing {{brand}}.\nReference: {{case_no}}\nServices: {{services}}\nAmount: ₹{{subtotal}}  Discount: ₹{{discount}}\nTotal payable: ₹{{total}}\nReply YES to confirm a slot. For help call {{support_number}}.'),
  ('whatsapp', 'T-04', 'Booking confirmation',
   E'Your home visit is confirmed for {{slot}}. Reference {{case_no}}. Our technician will share an ETA before arrival., {{brand}}'),
  ('sms',      'T-05', 'Technician ETA',
   E'{{brand}}: Your technician is on the way for {{case_no}}. Expected arrival {{slot}}.'),
  ('whatsapp', 'T-06', 'Delay notice',
   E'We are sorry, your visit for {{case_no}} is running late. Our coordinator will call you with the revised time., {{brand}}'),
  ('whatsapp', 'T-07', 'Report ready',
   E'Your report for {{case_no}} is ready. It will be shared on this number securely., {{brand}}'),
  ('email',    'T-08', 'Email acknowledgement',
   E'Dear {{caller_name}},\nWe have received your message. Your reference is {{case_no}}. A coordinator will reply shortly.\n{{brand}}')
) as t(k, c, t, b)
on conflict (workspace_id, code, version) do nothing;
