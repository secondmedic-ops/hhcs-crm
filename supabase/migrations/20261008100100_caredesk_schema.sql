-- =====================================================================
-- CareDesk CRM  |  0001  Core schema
-- Hinduja Home Care Services x SecondMedic
-- Applied by the pipeline (supabase db push), in file-name order.
-- =====================================================================

-- gen_random_uuid() is built into Postgres 13+

-- ---------- enums ----------
do $$ begin
  create type app_role as enum (
    'agent','coordinator','supervisor','field_staff','medical_desk',
    'client_manager','client_clinical','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type case_stage as enum (
    'enquiry','pricing','booking','deployment','completion','payment','closure','closed','cancelled');
exception when duplicate_object then null; end $$;

-- ---------- tenancy ----------
create table if not exists workspaces (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,                 -- 'HHC' -> case prefix
  name          text not null,
  brand_name    text not null,
  support_number text,
  support_email text,
  timezone      text not null default 'Asia/Kolkata',
  discount_band_pct numeric(5,2) not null default 10,  -- max discount without client approval
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists zones (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  pincodes      text[] not null default '{}',
  active        boolean not null default true,
  unique (workspace_id, name)
);

create table if not exists profiles (
  id            uuid primary key,                      -- = auth.users.id
  workspace_id  uuid not null references workspaces(id),
  full_name     text not null,
  email         text,
  phone         text,
  role          app_role not null default 'agent',
  agent_code    text,                                  -- A-07
  myoperator_user_id text,                             -- MyOperator panel user id (click-to-call)
  myoperator_extension text,
  zone_id       uuid references zones(id),
  skills        text[] not null default '{}',          -- phlebotomy / xray / ecg
  on_duty       boolean not null default false,
  active        boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------- master data ----------
create table if not exists services (                  -- the locked rate card
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  code          text not null,
  name          text not null,
  category      text not null check (category in ('lab','xray','ecg','visit','other')),
  price         numeric(10,2) not null check (price >= 0),
  tat_hours     int,
  description   text,
  active        boolean not null default true,
  version       int not null default 1,
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (workspace_id, code)
);

create table if not exists templates (                 -- scripts + WhatsApp/SMS/email templates
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  kind          text not null check (kind in ('script','whatsapp','sms','email')),
  code          text not null,                          -- T-03
  title         text not null,
  body          text not null,                          -- supports {{patient_name}}, {{case_no}} ...
  version       int not null default 1,
  status        text not null default 'draft' check (status in ('draft','pending','approved','retired')),
  provider_template_name text,                          -- approved WABA template name
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  unique (workspace_id, code, version)
);

create table if not exists sla_policies (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  key           text not null,
  label         text not null,
  target_minutes int not null,
  escalate_to   app_role not null default 'supervisor',
  measured_by   text,
  penalty       boolean not null default false,
  unique (workspace_id, key)
);

create table if not exists escalation_matrix (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  type          text not null check (type in ('clinical','emergency','delay','complaint','privacy')),
  level         int not null check (level between 1 and 3),
  owner_label   text not null,
  contact_name  text,
  contact_phone text,
  contact_email text,
  target_minutes int,
  unique (workspace_id, type, level)
);

-- ---------- patients & cases ----------
create table if not exists patients (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  mrn           text,
  full_name     text not null,
  age           int check (age between 0 and 130),
  gender        text check (gender in ('M','F','O')),
  mobile        text,                                   -- E.164 +91XXXXXXXXXX (null for email-only contacts)
  alt_mobile    text,
  email         text,
  address       text,
  landmark      text,
  locality      text,
  pincode       text,
  city          text default 'Mumbai',
  zone_id       uuid references zones(id),
  lat           double precision,
  lng           double precision,
  consent_verbal_at  timestamptz,
  consent_verbal_call_id uuid,
  consent_digital_at timestamptz,
  tags          text[] not null default '{}',
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, mobile)
);

create table if not exists case_counters (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  day           date not null,
  last_value    int not null default 0,
  primary key (workspace_id, day)
);

create table if not exists cases (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_no       text unique,                           -- HHC-260923-00125 (trigger)
  patient_id    uuid not null references patients(id),
  caller_name   text,
  caller_relation text,
  caller_mobile text,
  source_channel text not null default 'phone' check (source_channel in ('phone','whatsapp','email','chat','walkin','referral')),
  stage         case_stage not null default 'enquiry',
  priority      text not null default 'routine' check (priority in ('routine','urgent')),
  services_requested text,
  clinical_notes text,
  preferred_slot timestamptz,
  booked_slot   timestamptz,
  address       text,
  pincode       text,
  zone_id       uuid references zones(id),
  owner_id      uuid references profiles(id),
  coordinator_id uuid references profiles(id),
  -- commercial
  subtotal      numeric(10,2) not null default 0,
  discount_pct  numeric(5,2) not null default 0,
  discount_amount numeric(10,2) not null default 0,
  total         numeric(10,2) not null default 0,
  quote_status  text not null default 'draft' check (quote_status in ('draft','pending_approval','approved','rejected','sent')),
  quote_template_id uuid references templates(id),
  quote_sent_at timestamptz,
  booking_confirmed_at timestamptz,
  service_completed_at timestamptz,
  amount_collected numeric(10,2) not null default 0,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid','reconciled','refund','waived')),
  report_status text not null default 'pending' check (report_status in ('pending','released','delivered','na')),
  report_delivered_at timestamptz,
  feedback_rating int check (feedback_rating between 1 and 5),
  feedback_text text,
  cancel_reason text,
  reopen_reason text,
  closed_at     timestamptz,
  closed_by     uuid references profiles(id),
  sla_state     text not null default 'ok' check (sla_state in ('ok','at_risk','breached')),
  ai_brief      jsonb,                                  -- {summary,next_action,risk,generated_at}
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists cases_ws_stage on cases(workspace_id, stage);
create index if not exists cases_patient on cases(patient_id);
create index if not exists cases_owner on cases(owner_id);
create index if not exists cases_created on cases(workspace_id, created_at desc);

create table if not exists case_items (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references cases(id) on delete cascade,
  service_id    uuid not null references services(id),
  service_code  text,
  service_name  text,
  category      text,
  unit_price    numeric(10,2) not null default 0,       -- always copied from rate card by trigger
  qty           int not null default 1 check (qty > 0),
  line_total    numeric(10,2) not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists case_stage_history (
  id            bigserial primary key,
  case_id       uuid not null references cases(id) on delete cascade,
  from_stage    case_stage,
  to_stage      case_stage not null,
  changed_by    uuid references profiles(id),
  changed_at    timestamptz not null default now(),
  note          text
);

-- ---------- communications ----------
create table if not exists calls (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  provider      text not null default 'myoperator',
  provider_call_id text,                               -- MyOperator call id / ref id
  session_id    text,
  direction     text not null check (direction in ('inbound','outbound')),
  customer_number text,
  did_number    text,
  agent_id      uuid references profiles(id),
  agent_name    text,
  department    text,
  status        text not null default 'ringing' check (status in ('ringing','answered','missed','abandoned','completed','failed')),
  started_at    timestamptz not null default now(),
  answered_at   timestamptz,
  ended_at      timestamptz,
  ring_seconds  int,
  talk_seconds  int,
  recording_filename text,
  patient_id    uuid references patients(id),
  case_id       uuid references cases(id),
  disposition   text,
  notes         text,
  transcript    text,
  ai_summary    text,
  ai_sentiment  text,
  ai_intent     text,
  ai_extracted  jsonb,
  ai_flags      text[],
  ai_processed_at timestamptz,
  click_to_call_ref text,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  unique (provider, session_id)
);
create index if not exists calls_ws_started on calls(workspace_id, started_at desc);
create index if not exists calls_number on calls(customer_number);

create table if not exists webhook_events (
  event_id      text primary key,
  source        text not null,
  event_type    text,
  received_at   timestamptz not null default now(),
  processed     boolean not null default false,
  error         text,
  payload       jsonb
);

create table if not exists interactions (                 -- unified timeline
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_id       uuid references cases(id) on delete cascade,
  patient_id    uuid references patients(id) on delete cascade,
  channel       text not null check (channel in ('phone','whatsapp','sms','email','chat','note','system','crm_edit','field','lab','payment')),
  direction     text not null default 'internal' check (direction in ('inbound','outbound','internal')),
  actor_id      uuid references profiles(id),
  actor_label   text,
  summary       text not null,
  body          text,
  evidence      text,                                   -- "Recording 04:31", "Delivery receipt"
  call_id       uuid references calls(id),
  template_id   uuid references templates(id),
  occurred_at   timestamptz not null default now(),
  meta          jsonb not null default '{}'::jsonb
);
create index if not exists interactions_case on interactions(case_id, occurred_at);
create index if not exists interactions_patient on interactions(patient_id, occurred_at);

create table if not exists callbacks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  call_id       uuid references calls(id),
  number        text not null,
  patient_id    uuid references patients(id),
  reason        text not null default 'missed' check (reason in ('missed','abandoned','requested','followup')),
  due_at        timestamptz not null,
  status        text not null default 'pending' check (status in ('pending','in_progress','done','unreachable')),
  assigned_to   uuid references profiles(id),
  attempts      int not null default 0,
  last_attempt_at timestamptz,
  completed_at  timestamptz,
  completed_by  uuid references profiles(id),
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------- governance ----------
create table if not exists approvals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_id       uuid references cases(id) on delete cascade,
  kind          text not null check (kind in ('discount','rate_change','template','export')),
  title         text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn')),
  requested_by  uuid references profiles(id),
  requested_at  timestamptz not null default now(),
  decided_by    uuid references profiles(id),
  decided_at    timestamptz,
  decision_note text
);

create table if not exists sla_timers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  policy_key    text not null,
  case_id       uuid references cases(id) on delete cascade,
  complaint_id  uuid,
  callback_id   uuid references callbacks(id) on delete cascade,
  started_at    timestamptz not null default now(),
  due_at        timestamptz not null,
  met_at        timestamptz,
  breached_at   timestamptz,
  status        text not null default 'running' check (status in ('running','met','breached','cancelled'))
);
create index if not exists sla_running on sla_timers(status, due_at);

create table if not exists complaints (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  ref_no        text,
  case_id       uuid references cases(id),
  patient_id    uuid references patients(id),
  category      text not null check (category in ('service','behaviour','billing','report_delay','other')),
  severity      text not null default 'routine' check (severity in ('routine','high','critical')),
  description   text not null,
  status        text not null default 'open' check (status in ('open','acknowledged','resolved','closed')),
  owner_id      uuid references profiles(id),
  opened_by     uuid references profiles(id),
  opened_at     timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at   timestamptz,
  root_cause    text,
  resolution    text
);
alter table sla_timers drop constraint if exists sla_timers_complaint_fk;
alter table sla_timers add constraint sla_timers_complaint_fk foreign key (complaint_id) references complaints(id) on delete cascade;

create table if not exists escalations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_id       uuid references cases(id),
  complaint_id  uuid references complaints(id),
  type          text not null check (type in ('clinical','emergency','delay','complaint','privacy','sla')),
  level         int not null default 1 check (level between 1 and 3),
  trigger_text  text not null,
  raised_by     uuid references profiles(id),
  raised_at     timestamptz not null default now(),
  contacted_name text,
  contacted_at  timestamptz,
  outcome       text,
  status        text not null default 'open' check (status in ('open','acknowledged','resolved')),
  acknowledged_by uuid references profiles(id),
  acknowledged_at timestamptz,
  resolved_at   timestamptz,
  auto_raised   boolean not null default false
);

-- ---------- field, lab, payments ----------
create table if not exists assignments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_id       uuid not null references cases(id) on delete cascade,
  staff_id      uuid not null references profiles(id),
  task          text not null check (task in ('phlebotomy','xray','ecg','visit')),
  status        text not null default 'assigned' check (status in ('assigned','en_route','checked_in','completed','cancelled','reassigned')),
  assigned_by   uuid references profiles(id),
  assigned_at   timestamptz not null default now(),
  eta           timestamptz,
  window_start  timestamptz,
  window_end    timestamptz,
  checkin_at    timestamptz,
  checkin_lat   double precision,
  checkin_lng   double precision,
  checkin_distance_m int,
  checkout_at   timestamptz,
  checklist     jsonb not null default '{}'::jsonb,   -- {consent,id_check,procedure,signoff}
  patient_signoff boolean not null default false,
  backup_for    uuid references assignments(id),
  delay_reason  text
);

create table if not exists samples (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_id       uuid not null references cases(id) on delete cascade,
  barcode       text not null,
  kind          text not null default 'blood' check (kind in ('blood','urine','ecg','xray','other')),
  collected_at  timestamptz,
  handover_at   timestamptz,
  dispatched_at timestamptz,
  transport_temp_c numeric(4,1),
  received_at   timestamptz,
  accessioned_at timestamptz,
  report_released_at timestamptz,
  delivered_at  timestamptz,
  critical_flag boolean not null default false,
  critical_note text,
  file_url      text,
  unique (workspace_id, barcode)
);

create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  case_id       uuid not null references cases(id) on delete cascade,
  amount        numeric(10,2) not null check (amount <> 0),
  mode          text not null check (mode in ('upi','link','card','cash','refund')),
  txn_ref       text,
  receipt_no    text,
  collected_by  uuid references profiles(id),
  collected_at  timestamptz not null default now(),
  gateway_status text default 'captured',
  settled_at    timestamptz,
  reconciled    boolean not null default false,
  reconciled_at timestamptz,
  reconciled_by uuid references profiles(id),
  exception     text
);

-- ---------- quality, audit, reporting ----------
create table if not exists qa_reviews (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  call_id       uuid not null references calls(id) on delete cascade,
  agent_id      uuid references profiles(id),
  reviewer_id   uuid references profiles(id),
  greeting      int check (greeting between 0 and 5),
  consent       int check (consent between 0 and 5),
  price_accuracy int check (price_accuracy between 0 and 5),
  empathy       int check (empathy between 0 and 5),
  closure       int check (closure between 0 and 5),
  total_pct     numeric(5,1),
  notes         text,
  coaching_action text,
  ai_generated  boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists audit_log (
  id            bigserial primary key,
  workspace_id  uuid,
  table_name    text not null,
  record_id     uuid,
  action        text not null,
  changes       jsonb,                                  -- {field:{old,new}}
  actor_id      uuid,
  at            timestamptz not null default now()
);
create index if not exists audit_record on audit_log(record_id, at);
create index if not exists audit_ws_at on audit_log(workspace_id, at desc);

create table if not exists access_log (
  id            bigserial primary key,
  workspace_id  uuid,
  user_id       uuid,
  action        text not null,                          -- login, view_case, play_recording, export, view_patient
  entity        text,
  entity_id     text,
  meta          jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);
create index if not exists access_ws_at on access_log(workspace_id, at desc);

create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid references profiles(id) on delete cascade,  -- null = role broadcast
  role          app_role,
  kind          text not null default 'info',
  title         text not null,
  body          text,
  link          text,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists notif_user on notifications(user_id, created_at desc);

create table if not exists mis_snapshots (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  period        text not null check (period in ('daily','weekly','monthly')),
  period_start  date not null,
  period_end    date not null,
  data          jsonb not null,
  narrative     text,
  generated_at  timestamptz not null default now(),
  unique (workspace_id, period, period_start)
);

create table if not exists inbound_emails (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  message_id    text unique,
  from_address  text,
  to_address    text,
  subject       text,
  text_body     text,
  patient_id    uuid references patients(id),
  case_id       uuid references cases(id),
  received_at   timestamptz not null default now()
);
