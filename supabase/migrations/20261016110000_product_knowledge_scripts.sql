-- =====================================================================
-- Point 10 (Hinduja MoM): service catalogue knowledge for agents + standard call scripts.
--   * service_knowledge: one row per service (service_id) or one default per category (category). Agents see the
--     service row when it exists, otherwise the category default. Read by every staff login except providers.
--   * save_service_knowledge(p jsonb): supervisor / admin edit one row (service or category).
--   * import_service_knowledge(p_rows jsonb): Excel / CSV sheet by Service Code; blank cells keep what is saved.
--   * Category defaults seeded below so agents have content before Hinduja's final 80-90 service list is imported.
--   * Scripts S-03 .. S-07 (approved). Seeded with "do nothing" on conflict, so edits made in Settings stay.
-- =====================================================================

create table if not exists service_knowledge (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  service_id    uuid references services(id) on delete cascade,
  category      text,
  summary       text,      -- what it is, in one or two lines the agent can say
  who_needs     text,      -- typical patients / situations
  ask_caller    text,      -- questions to ask before quoting
  includes      text,
  excludes      text,
  prep          text,      -- preparation at home, documents, fasting, space, power
  faq           text,      -- common questions and the approved answer
  updated_by    uuid references profiles(id),
  updated_at    timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'service_knowledge_target_check') then
    alter table service_knowledge add constraint service_knowledge_target_check
      check ((service_id is not null and category is null) or (service_id is null and category is not null));
  end if;
end $$;
create unique index if not exists service_knowledge_service on service_knowledge(workspace_id, service_id) where service_id is not null;
create unique index if not exists service_knowledge_category on service_knowledge(workspace_id, category) where category is not null;

alter table service_knowledge enable row level security;
drop policy if exists service_knowledge_read on service_knowledge;
create policy service_knowledge_read on service_knowledge for select using (workspace_id = me_ws() and not has_role('provider'));
grant select on service_knowledge to caredesk_app;
revoke insert, update, delete on service_knowledge from caredesk_app;

-- ---------- edit one row ----------
create or replace function save_service_knowledge(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws(); v_sid uuid; v_cat text; v_id uuid; f text; v_changed text[] := '{}';
  v_old service_knowledge;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed for your role'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Send the knowledge to save'; end if;
  v_sid := nullif(p->>'service_id','')::uuid;
  v_cat := nullif(trim(coalesce(p->>'category','')),'');
  if (v_sid is null) = (v_cat is null) then raise exception 'Choose one service or one category'; end if;
  if v_sid is not null and not exists (select 1 from services where id = v_sid and workspace_id = v_ws) then raise exception 'Service not found'; end if;
  if v_cat is not null and v_cat !~ '^[a-z]{2,20}$' then raise exception 'Unknown category'; end if;
  foreach f in array array['summary','who_needs','ask_caller','includes','excludes','prep','faq'] loop
    if length(coalesce(p->>f,'')) > 4000 then raise exception '% is longer than 4000 characters', f; end if;
  end loop;

  select * into v_old from service_knowledge
   where workspace_id = v_ws and ((v_sid is not null and service_id = v_sid) or (v_cat is not null and category = v_cat)) for update;
  if v_old.id is null then
    insert into service_knowledge (workspace_id, service_id, category) values (v_ws, v_sid, v_cat) returning * into v_old;
  end if;
  foreach f in array array['summary','who_needs','ask_caller','includes','excludes','prep','faq'] loop
    if p ? f and coalesce(nullif(trim(p->>f),''),'') is distinct from coalesce(to_jsonb(v_old)->>f,'') then v_changed := v_changed || f; end if;
  end loop;
  update service_knowledge set
    summary    = case when p ? 'summary'    then nullif(trim(p->>'summary'),'')    else summary end,
    who_needs  = case when p ? 'who_needs'  then nullif(trim(p->>'who_needs'),'')  else who_needs end,
    ask_caller = case when p ? 'ask_caller' then nullif(trim(p->>'ask_caller'),'') else ask_caller end,
    includes   = case when p ? 'includes'   then nullif(trim(p->>'includes'),'')   else includes end,
    excludes   = case when p ? 'excludes'   then nullif(trim(p->>'excludes'),'')   else excludes end,
    prep       = case when p ? 'prep'       then nullif(trim(p->>'prep'),'')       else prep end,
    faq        = case when p ? 'faq'        then nullif(trim(p->>'faq'),'')        else faq end,
    updated_by = app_uid(), updated_at = now()
  where id = v_old.id returning id into v_id;
  if array_length(v_changed, 1) > 0 then
    insert into audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
    values (v_ws, 'service_knowledge', v_id, 'update', jsonb_build_object('fields', to_jsonb(v_changed)), app_uid());
  end if;
  return v_id;
end $$;

-- ---------- import a sheet (rows found by Service Code) ----------
create or replace function import_service_knowledge(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws(); r jsonb; v_sid uuid; v_saved int := 0; v_skipped jsonb := '[]'::jsonb; i int := 0; f text; v_any boolean;
begin
  if not has_role('supervisor','admin') then raise exception 'Not allowed for your role'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'Send the sheet rows'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'At most 1000 rows per import'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    select id into v_sid from services where workspace_id = v_ws and upper(code) = upper(trim(coalesce(r->>'service_code','')));
    if v_sid is null then
      v_skipped := v_skipped || jsonb_build_object('row', coalesce((r->>'row')::int, i), 'code', r->>'service_code', 'reason', 'Service code not on the rate card');
      continue;
    end if;
    v_any := false;
    foreach f in array array['summary','who_needs','ask_caller','includes','excludes','prep','faq'] loop
      if length(coalesce(r->>f,'')) > 4000 then raise exception 'Row %: % is longer than 4000 characters', coalesce((r->>'row')::int, i), f; end if;
      if nullif(trim(coalesce(r->>f,'')),'') is not null then v_any := true; end if;
    end loop;
    if not v_any then
      v_skipped := v_skipped || jsonb_build_object('row', coalesce((r->>'row')::int, i), 'code', r->>'service_code', 'reason', 'No knowledge columns filled');
      continue;
    end if;
    insert into service_knowledge (workspace_id, service_id, summary, who_needs, ask_caller, includes, excludes, prep, faq, updated_by)
    values (v_ws, v_sid, nullif(trim(r->>'summary'),''), nullif(trim(r->>'who_needs'),''), nullif(trim(r->>'ask_caller'),''),
            nullif(trim(r->>'includes'),''), nullif(trim(r->>'excludes'),''), nullif(trim(r->>'prep'),''), nullif(trim(r->>'faq'),''), app_uid())
    on conflict (workspace_id, service_id) where service_id is not null do update set
      summary    = coalesce(excluded.summary, service_knowledge.summary),
      who_needs  = coalesce(excluded.who_needs, service_knowledge.who_needs),
      ask_caller = coalesce(excluded.ask_caller, service_knowledge.ask_caller),
      includes   = coalesce(excluded.includes, service_knowledge.includes),
      excludes   = coalesce(excluded.excludes, service_knowledge.excludes),
      prep       = coalesce(excluded.prep, service_knowledge.prep),
      faq        = coalesce(excluded.faq, service_knowledge.faq),
      updated_by = excluded.updated_by, updated_at = now();
    v_saved := v_saved + 1;
  end loop;
  insert into audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
  values (v_ws, 'service_knowledge', null, 'import', jsonb_build_object('saved', v_saved, 'skipped', jsonb_array_length(v_skipped)), app_uid());
  return jsonb_build_object('saved', v_saved, 'skipped', v_skipped);
end $$;

grant execute on function save_service_knowledge(jsonb), import_service_knowledge(jsonb) to caredesk_app;

-- ---------- live updates ----------
do $$ declare t text; begin
  foreach t in array array['service_knowledge'] loop
    execute format('drop trigger if exists zz_note_change on public.%I', t);
    execute format('create trigger zz_note_change after insert or update or delete on public.%I for each statement execute function public.note_change()', t);
  end loop;
end $$;

-- ---------- category defaults (no clinical advice; Hinduja to review) ----------
with w as (select id from workspaces where code = 'HHC')
insert into service_knowledge (workspace_id, category, summary, who_needs, ask_caller, includes, excludes, prep, faq)
select w.id, k.cat, k.summary, k.who, k.ask, k.inc, k.exc, k.prep, k.faq from w, (values
  ('lab',
   'Blood and urine samples collected at home by a trained phlebotomist and tested at an accredited lab. Reports are shared on the registered mobile number.',
   'Patients just discharged who need follow-up tests, bedridden or elderly patients, anyone the doctor has asked for repeat tests.',
   E'1. Which tests did the doctor write? Ask for a photo of the prescription on WhatsApp.\n2. Is fasting needed (lipid, fasting sugar)?\n3. Preferred date and morning slot.\n4. Full address with landmark and a contact number at home.',
   'Home visit by phlebotomist, sterile single-use kit, transport of the sample, report on WhatsApp / email.',
   'Interpretation of results and doctor consultation (book separately), tests not on the rate card.',
   'Fasting tests: 10 to 12 hours without food, water is allowed. Keep the prescription and any old reports ready.',
   E'When will I get the report? Within the turnaround time shown for the test.\nCan I eat before the test? Only if no fasting test is booked.'),
  ('xray',
   'Portable X-ray done at home by a radiographer with a portable unit. Images are reported by a radiologist.',
   'Bedridden or post-surgery patients who cannot travel, follow-up chest or limb X-rays advised by the doctor.',
   E'1. Which body part and view did the doctor ask for?\n2. Can the patient sit up or only lie flat?\n3. Is there a pacemaker, implant or pregnancy in the home?\n4. Floor, lift and power socket near the bed.',
   'Radiographer visit, portable X-ray, radiologist report.',
   'Contrast studies, CT, MRI and ultrasound.',
   'A 15A power socket near the bed. Remove metal (chains, clips) from the area. Others in the room step out during the exposure.',
   E'Is it safe at home? The radiographer follows radiation safety rules; family members step out during the exposure.'),
  ('ecg',
   '12-lead ECG recorded at home by a trained technician and uploaded securely for doctor interpretation.',
   'Heart patients after discharge, routine checks advised by the treating doctor, elderly patients with chest discomfort on a non-urgent basis.',
   E'1. Is the patient having chest pain or breathlessness right now? If yes, follow the emergency script (S-09).\n2. Doctor''s advice or prescription.\n3. Preferred slot and address.',
   'Technician visit, 12-lead ECG, secure upload for interpretation.',
   'Emergency care. 2D echo, Holter and stress tests.',
   'Loose clothing; avoid applying lotion on the chest that day.',
   E'Chest pain now? Do not book. Ask the caller to dial 108 and raise an emergency escalation.'),
  ('visit',
   'Visit charges added to a home service booking: standard scheduled slot or an urgent visit.',
   'Every home booking; urgent surcharge only when the caller wants a visit within about 2 hours.',
   E'1. Is a scheduled slot fine or is it urgent?\n2. Can several services be done in one visit?',
   'Travel of the field staff to the address.',
   'The service itself (charged separately).',
   'None.',
   E'Why is there an urgent charge? A technician has to be moved from the planned schedule.'),
  ('nursing',
   'Qualified nurses at home by shift (12 or 24 hours) or per visit, delivered by Book My Medicare under Hinduja''s care plan.',
   'Patients going home with wounds, drains, catheters, injections, tube feeding, oxygen or ventilator support.',
   E'1. Diagnosis and expected discharge date.\n2. Procedures needed at home (injections, dressing, feeding, suction).\n3. Shift needed: day 12 h, night 12 h or 24 h, and for how many days.\n4. Language preference and any gender preference for the nurse.',
   'Nurse for the agreed shift, care as per the doctor''s plan, daily notes.',
   'Medicines and consumables (quoted separately), doctor visits, household work.',
   'A place for the nurse to rest during a 24-hour shift. The discharge summary and prescriptions ready on day 1.',
   E'Can I change the nurse? Yes, raise it with the coordinator.\nIs food provided? Agree this with the family before the start.'),
  ('physio',
   'Physiotherapist home sessions for recovery after surgery, stroke, fractures or long hospital stays.',
   'Post-surgery, stroke, joint replacement, weakness after ICU stay.',
   E'1. Condition and what the doctor advised.\n2. Sessions per week and preferred time.\n3. Can the patient stand or walk with support?',
   'Session at home, exercise plan for the family to continue.',
   'Equipment such as walkers (rent separately).',
   'Clear space of about 2 by 2 metres around the bed or chair.',
   E'How many sessions? As advised by the doctor or physiotherapist after the first visit.'),
  ('beds',
   'Hospital beds on rent (Fowler, semi-Fowler, motorised ICU) delivered and installed by Book My Medicare.',
   'Bedridden patients, patients who need the head raised, ICU-level care at home.',
   E'1. Bed type the doctor or nurse advised.\n2. Room size, door width and floor or lift.\n3. Rental period and delivery date before discharge.',
   'Delivery, installation, demo to the family, pickup at the end.',
   'Mattress upgrades and accessories unless listed.',
   'Bed needs about 90 to 100 cm of door width and 1 m clear on both long sides. A power socket for motorised beds.',
   E'Can it be delivered before discharge? Yes, book one day ahead.'),
  ('eldercare',
   'Trained attendants / caregivers for daily living support by 12 or 24-hour shift, through Book My Medicare.',
   'Elderly or bedridden patients who need help with bathing, feeding, toileting and moving.',
   E'1. What help is needed through the day?\n2. Shift and number of days.\n3. Language preference and any gender preference.',
   'Attendant for the agreed shift, personal care support.',
   'Nursing procedures (injections, dressing), household work.',
   'A place for the attendant to rest during a 24-hour shift.',
   E'Can the attendant give injections? No, that needs a nurse.'),
  ('homecare',
   'Other home healthcare arranged through Book My Medicare on request.',
   'Needs not covered by the listed services.',
   E'1. Exactly what is needed and for how long.\n2. Doctor''s advice if any.',
   'As agreed in the quote.',
   'Anything not in the quote.',
   'As advised by the coordinator.',
   E'Not sure what is needed? Book a home assessment by the care coordinator nurse.'),
  ('icu',
   'Mini-ICU setup at home: monitor, suction, oxygen and related equipment, with nursing as per the care plan.',
   'Patients going home on oxygen, ventilator or high-flow support, or needing continuous monitoring.',
   E'1. Current support in hospital (oxygen litres, BiPAP, ventilator settings).\n2. Discharge date.\n3. Room size, power backup and earthing.',
   'Equipment setup, demo, nursing as quoted.',
   'Medicines, consumables unless quoted, doctor visits.',
   'Earthed 15A sockets, power backup, room clear of smoking and open flame.',
   E'Is a home assessment needed? Yes, the care coordinator nurse checks the room before setup.'),
  ('equipment',
   'Medical equipment on rent (oxygen concentrator, high-flow machine, monitor, suction, air mattress) through Book My Medicare.',
   'Patients the doctor has advised equipment for at home.',
   E'1. Which equipment and settings the doctor advised.\n2. Rental period and delivery date.\n3. Power backup at home.',
   'Delivery, installation, demo, pickup at the end.',
   'Consumables unless quoted.',
   'Power socket near the bed; oxygen equipment away from flame and smoking.',
   E'What if the machine stops working? Call the helpline; the provider replaces or repairs it.'),
  ('consumables',
   'Medical consumables supplied with the home care plan (gloves, syringes, oral care, barrier creams).',
   'Patients on nursing care at home.',
   E'1. Which items and quantity the nurse or doctor listed.',
   'Items as quoted.',
   'Medicines on prescription unless listed.',
   'None.',
   E'Can I buy them myself? Yes, the family may arrange them separately.')
) as k(cat, summary, who, ask, inc, exc, prep, faq)
on conflict (workspace_id, category) where category is not null do nothing;

-- ---------- call scripts S-03 .. S-07 ----------
with w as (select id from workspaces where code = 'HHC')
insert into templates (workspace_id, kind, code, title, body, status, approved_at)
select w.id, 'script', t.c, t.t, t.b, 'approved', now() from w, (values
  ('S-03', 'Callback opening (missed call)',
   E'Good {{greeting_time}}, this is {{agent_name}} calling from {{brand}}. We received a call from this number and could not answer it. Is this a good time to talk?\n1. If yes: "How can we help you today?" Then follow S-01 from the consent step.\n2. If not a good time: ask for a time and log a follow-up.\n3. If wrong person: apologise, confirm the number and close the callback as Not reached with the reason.'),
  ('S-04', 'Discharge home-care requirement capture',
   E'1. Patient name, age, hospital (Khar / Mahim), ward and room.\n2. Treating doctor and the condition in the caller''s own words. Do NOT give clinical advice.\n3. Expected discharge date and when home care should start.\n4. Needs at home: nursing (shift), attendant, physiotherapy, bed, oxygen / BiPAP / ventilator, tests, X-ray, ECG.\n5. Who decides and who pays (decision maker name, relation, mobile).\n6. Address with landmark, floor, lift, room size.\n7. Read back the summary. "Our care coordinator nurse will meet the family and the doctor to confirm the plan, and we will share a clear quote."\n8. Set the interaction reason (disposition) before ending the call.'),
  ('S-05', 'Diagnostics at home (tests, X-ray, ECG)',
   E'1. Ask for the doctor''s prescription on WhatsApp.\n2. Confirm each test, X-ray view or ECG against the rate card; read out the price from the Product knowledge panel.\n3. Fasting tests: 10 to 12 hours without food, water allowed.\n4. Offer a slot; mention the urgent visit charge only if they want it within about 2 hours.\n5. Confirm address and the person at home.\n6. "You will get a confirmation on WhatsApp and the report on this number."'),
  ('S-06', 'Price and budget conversation',
   E'1. Explain that prices come from the Hinduja rate card and the quote is itemised.\n2. Ask the budget openly: "Is there a monthly amount you would like us to plan within?" Record it in Additional information.\n3. If the quote is above budget, offer options from the care plan: 12 h instead of 24 h cover, semi-Fowler instead of motorised bed, fewer physiotherapy sessions, only where the doctor agrees.\n4. Never promise a discount. Discounts go for approval in the CRM.\n5. Agree the final list with the decision maker and confirm it in writing on WhatsApp.'),
  ('S-07', 'Closing and next steps',
   E'1. Summarise what was agreed: services, start date, case number {{case_no}}.\n2. Tell them what happens next and who will call (coordinator / technician / provider).\n3. Share the helpline number {{support_number}} for any change or concern.\n4. "Is there anything else I can help you with?"\n5. Thank the caller and set the disposition before closing the case screen.')
) as t(c, t, b)
on conflict (workspace_id, code, version) do nothing;
