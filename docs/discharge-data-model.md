# Discharge-to-Homecare: data model and data dictionary

CareDesk CRM, Postgres (Supabase), schema `public`. Version of 13 Oct 2026, migrations up to `20261013170000_discharge_data_model.sql`.
This page covers the tables behind the post-discharge workflow. `docs/schema.md` (generated on every ship) lists every table and column.

Conventions for every table:
- Primary keys are `uuid` (`gen_random_uuid()`) unless noted. Every table has `workspace_id → workspaces.id`, the tenant.
- Times are `timestamptz`, stored in UTC and shown in IST. Calendar dates (`date`) are IST dates.
- Money is `numeric(12,2)`. It is computed in SQL from the locked rate card and never typed in by a user.
- Row Level Security is on for every table. Screens write only through database actions (RPCs), which check the role again.
- Personal data (patient, decision-maker and doctor names and numbers, addresses, clinical notes) never goes into `audit_log` values.

## ER diagram

```
                               +------------------+
                               |    workspaces    |  tenant: Hinduja Home Care (HHC)
                               +------------------+
                                        | 1
          +-----------------------------+-----------------------------+
          | n                           | n                           | n
+------------------+          +------------------+           +------------------+
|     patients     |1        n|      cases       |n         1|    providers     |
|------------------|----------|------------------|           |------------------|
| full_name, age   |          | case_no          |           | code SM / BMM    |
| gender, mobile   |          | stage            |           | categories[]     |
| address, pincode |          | journey_state    |           +------------------+
| consent_*        |          | care_type        |                    | 1
+------------------+          | hospital_*       |                    |
          | 1                 | decision_maker_* |                    |
          |                   | intake_disposition                    |
          | n                 | expected_discharge_on                 |
+------------------+  n     1 | validation_status|                    |
|      calls       |----------| signoff_*        |                    |
|------------------|          | subtotal / total |                    |
| status, disposition         | amount_collected |                    |
| recording, ai_*  |          +------------------+                    |
+------------------+             | 1   | 1   | 1                      |
                                 |     |     +-----------------+      |
     +---------------------------+     |                       |      |
     | n                               | n                     | n    | n
+-----------------------+   +------------------+       +------------------+
| discharge_assessments |   |    case_items    |       |  case_referrals  |  one lead per provider per case
|-----------------------|   |------------------|       |------------------|
| nurse_id -> profiles  |   | service_id ->    |       | status           |
| met_doctor / family   |   |   services       |       | accepted / dispatched
| readiness             |   | qty, line_total  |       | started / completed_at
| doctor_recommendations|   | recommended      |       +------------------+
+-----------------------+   | excluded         |          | 1           | (SM lead)
                            | exclude_category |          | n           |
                            +------------------+   +---------------------+   SecondMedic in-house:
                                    | 1            | partner_deployments |   +-------------+  +-------------+
                                    +------------->|---------------------|   | assignments |  |   samples   |
                                       0..1      n | resource_type       |   |-------------|  |-------------|
                                                   | staff_ref, shift    |   | task: phleb-|  | barcode     |
                                                   | equipment_serial    |   |  otomy/xray |  | kind        |
                                                   | status, *_at        |   | checkin geo |  | file_url    |
                                                   +---------------------+   +-------------+  | (report)    |
                                                                              (n per case)    +-------------+
  cases 1 --- n payment_schedule (instalments: label, due_on, pct)                            (n per case)
  cases 1 --- n payments (collections: amount, mode, reconciled)
  cases 1 --- n case_journey_history (from_state -> to_state)
  cases 1 --- n case_stage_history (operational stage changes)
  cases 1 --- n interactions (patient timeline: every call, message, note, status change)
```

## Journey states (`case_journey` enum, `cases.journey_state`)

The database derives the state from what has happened; nobody sets it by hand. Every change is written to `case_journey_history`. The rules are checked from the top down, and the first one that matches wins.

| State | Reached when |
|---|---|
| `closed` (Discharge / closure) | Case stage is `closed`. |
| `cancelled` | Case stage is `cancelled`. |
| `active_care` | A partner work order is `active` (staff on duty, equipment in use), or the case stage is completion, payment or closure. |
| `setup_installed` | A partner work order is `installed`, or a partner lead is `in_progress` / `completed`. |
| `partner_dispatched` | A work order is `dispatched` or `delivered`, a lead is `dispatched`, or the case stage is deployment. |
| `commercial_approved` | The family has signed off (`signoff_at`), or the case stage is booking. |
| `onsite_assessed` | The hospital validation is recorded (`validation_status` = done or not_ready). |
| `intake_logged` | Default for a new case. |

The journey state sits alongside the operational `stage` (enquiry, pricing, booking, deployment, completion, payment, closure, closed, cancelled). The stage drives the stage gates and SLA timers; the journey is the patient-facing view of the same case.

## 1. Patient and case

### `patients`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| mrn | text | yes | Hospital MRN, when known |
| full_name | text | no | Personal data |
| age | integer | yes | |
| gender | text | yes | M, F, O |
| mobile, alt_mobile | text | yes | Normalised to +91. Unique per workspace. Masked for agents. |
| email | text | yes | |
| address, landmark, locality, pincode, city | text | yes | Home address for the setup |
| zone_id | uuid | yes | FK `zones.id`, mapped from the pincode |
| lat, lng | double precision | yes | For field check-in distance |
| consent_verbal_at, consent_digital_at | timestamptz | yes | DPDP consent; the Enquiry gate requires one |
| consent_verbal_call_id | uuid | yes | FK `calls.id`, the recorded consent |

### `cases` (one per episode, the spine of the workflow)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| case_no | text | yes | `HHC-YYMMDD-NNNNN`, set by trigger, unique |
| patient_id | uuid | no | FK `patients.id` |
| care_type | text | no | `standard` or `post_discharge` |
| stage | case_stage | no | Operational stage (gated) |
| journey_state | case_journey | no | Derived journey state, see above |
| journey_at | timestamptz | yes | When the journey state last changed |
| branch | text | yes | Khar, Mahim |
| hospital_name | text | yes | For example P. D. Hinduja Hospital |
| hospital_ward | text | yes | |
| hospital_room | text | yes | Room / bed number |
| treating_doctor | text | yes | Personal data (redacted in audit) |
| decision_maker_name | text | yes | Primary decision-maker. Personal data. |
| decision_maker_relation | text | yes | Son, spouse ... |
| decision_maker_mobile | text | yes | Normalised. Masked for agents (`v_cases.decision_maker_mobile_display`). Personal data. |
| caller_name, caller_relation, caller_mobile | text | yes | Who called, if not the decision-maker |
| owner_id, coordinator_id | uuid | yes | FK `profiles.id` |
| expected_discharge_on | date | yes | Updated by the validation if revised |
| plan_days | integer | no | Default 30, 1 to 365 |
| zone_id, address, pincode | | yes | Service address |

## 2. Call disposition and intake

### `calls` (MyOperator, one row per call)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| case_id, patient_id | uuid | yes | FK `cases.id`, `patients.id`; linked when the enquiry is created from the call |
| direction | text | no | inbound / outbound |
| status | text | no | Call log status: ringing, answered, missed, abandoned, completed, failed |
| disposition | text | yes | Agent's call disposition |
| agent_id | uuid | yes | FK `profiles.id` |
| started_at, answered_at, ended_at | timestamptz | | Telephony timestamps |
| ring_seconds, talk_seconds | integer | yes | |
| recording_filename | text | yes | Never visible to partners |
| ai_summary, ai_intent, ai_extracted | text / jsonb | yes | Gemini summary of the call |
| callback_id | uuid | yes | FK `callbacks.id` for missed-call callbacks |

### Intake fields on `cases`
| Column | Type | Null | Notes |
|---|---|---|---|
| intake_disposition | text | yes | Interaction reason, fixed list: requirement_captured, information_only, price_enquiry, follow_up_requested, not_interested, already_arranged, wrong_number, duplicate |
| spoke_with | text | yes | patient, decision_maker, family_member, hospital_staff |
| source_channel | text | no | phone, whatsapp, email, chat, walkin, referral |
| priority | text | no | routine, urgent |
| services_requested | text | yes | Preliminary requirements as the caller said them |
| clinical_notes | text | yes | Preliminary clinical status. Personal data. |
| expected_discharge_on | date | yes | Estimated discharge date (expected, not confirmed). Entered at enquiry (Agent console), in the intake, on Requirements > Edit, or revised by the validation |
| requested_service_start_on | date | yes | Date the patient / family wants the captured home care to begin. A request only: no booking, assignment, dispatch or stage change follows from it. Independent of callbacks, `preferred_slot` and `booked_slot` |

## 3. Clinical validation and assessment

### `discharge_assessments` (one per hospital visit; the latest one counts)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| case_id | uuid | no | FK `cases.id` |
| nurse_id | uuid | yes | FK `profiles.id`, the on-ground Care Coordinator (nurse) |
| status | text | no | scheduled, done, cancelled |
| scheduled_at, visited_at | timestamptz | yes | |
| met_doctor, met_ward_staff, met_family | boolean | no | Doctor and family are required before "ready" |
| doctor_name | text | yes | Personal data |
| readiness | text | yes | ready, not_ready, deferred |
| revised_discharge_on | date | yes | Copied to `cases.expected_discharge_on` |
| doctor_recommendations | text | yes | Validated recommendations from the treating doctor |
| home_setup_notes | text | yes | Floor, lift, room size, power |
| clinical_summary | text | yes | Coordinator notes. Clinical data, hidden from partners and agents. |
| created_by | uuid | yes | FK `profiles.id` |

The recommended item list is held in `case_items` with `recommended = true` (below).

## 4. Quotation and commercial ledger

### `services` (locked rate card)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| code | text | no | Unique per workspace, for example NURSE-12H, HFNC, XR-CHEST |
| name | text | no | |
| category | text | no | lab, xray, ecg, visit, nursing, physio, beds, eldercare, homecare, equipment, icu, consumables, caretaker_attendant, ambulance, other. Decides the provider. |
| price | numeric | no | B2C selling rate. Changed only through a rate-change or rate-import approval |
| unit | text | no | shift, day, setup, unit, or the unit of an imported service (month, 12 hours, visit, ...). Never converted |
| tax_basis | text | yes | incl_gst, excl_gst, no_gst; null = not confirmed |
| version | integer | no | Moves up with each approved price; every version is in `service_price_history` |
| active | boolean | no | |

B2B buying rates per provider are in `provider_rates`; booking costs in `case_item_costs`. Both are confidential: see `docs/RATES-AND-MARGINS.md`.

### `case_items` (itemised quotation: recommended vs agreed)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| case_id | uuid | no | FK `cases.id` |
| service_id | uuid | no | FK `services.id` |
| service_code, service_name, category | text | yes | Copied from the rate card |
| unit_price | numeric | no | From the rate card when the line is added. A client-supplied price is ignored; a later rate change does not rewrite it (explicit refresh on drafts only). |
| unit, price_version, price_tax_basis, priced_at | | yes | Snapshot taken with the price. `priced_at` null = priced before costs were captured |
| qty | integer | no | For the whole plan, for example 60 shifts |
| line_total | numeric | no | unit_price × qty |
| recommended | boolean | no | On the validated list (the original 12) |
| excluded | boolean | no | Dropped in negotiation; not in the total, not routed |
| exclude_category | text | yes | cost, space, unwilling, clinical, arranged_elsewhere, other |
| exclude_reason | text | yes | Details in the family's words |

Original list = rows with `recommended`; approved list = rows with `not excluded` (for example 12 recommended, 10 agreed). `v_cases.items_recommended` and `items_agreed` give the counts.

### Commercial fields on `cases`
| Column | Type | Null | Notes |
|---|---|---|---|
| subtotal, discount_pct, discount_amount, total | numeric | no | Computed by `recalc_case()` from the agreed items |
| quote_status | text | no | draft, pending_approval, approved, rejected, sent |
| quote_sent_at | timestamptz | yes | |
| signoff_at | timestamptz | yes | Family commercial sign-off. Cleared automatically if the total changes. |
| signoff_by_name | text | yes | Decision-maker who signed. Personal data. |
| signoff_mode | text | yes | in_person, whatsapp, email, phone |
| signoff_note | text | yes | |
| amount_collected | numeric | no | Sum of `payments` |
| payment_status | text | no | unpaid, partial, paid, reconciled, refund, waived |

### `payment_schedule` (instalments)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| case_id | uuid | no | FK `cases.id`. Unique (case_id, seq). |
| seq | integer | no | 1 to 24 |
| label | text | no | Advance, Day 10 ... |
| due_on | date | no | |
| pct | numeric(5,2) | no | Share of the agreed total. A case's rows add up to 100. |

`v_payment_schedule` adds `amount` (from the current total; the last instalment takes the rounding), `cumulative_due` and `status` (due, overdue, part_paid, paid, waived), all derived from `cases.amount_collected`.

### `payments` (collections)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| case_id | uuid | no | FK `cases.id` |
| amount | numeric | no | |
| mode | text | no | upi, link, card, cash, refund |
| txn_ref, receipt_no | text | yes | |
| collected_by | uuid | yes | FK `profiles.id` |
| reconciled, reconciled_at, reconciled_by | | | Bank / gateway reconciliation |

## 5. Work orders and partner routing

### `providers`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| code | text | no | `SM` SecondMedic (lab, xray, ecg, visit); `BMM` Book My Medicare (nursing, physio, beds, eldercare, homecare, equipment, icu) |
| categories | text[] | no | Service categories it fulfils |

### `case_referrals` (one lead per provider per case)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK. Unique (case_id, provider_id). |
| case_id | uuid | no | FK `cases.id` |
| provider_id | uuid | no | FK `providers.id` |
| categories | text[] | no | The agreed item categories this provider covers |
| status | text | no | new, accepted, scheduled, dispatched, in_progress (deployed), completed, declined, cancelled |
| auto | boolean | no | Created by routing (true) or referred by hand |
| assigned_to | uuid | yes | FK `profiles.id`, the partner user who took it |
| scheduled_at, accepted_at, dispatched_at, started_at, completed_at | timestamptz | yes | |
| decline_reason, last_note | text | yes | |

Routing: post-discharge leads are created only after the family's sign-off. SecondMedic's lead follows the case stages; Book My Medicare moves its own.

### `partner_deployments` (Book My Medicare work orders)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | PK |
| case_id | uuid | no | FK `cases.id` |
| referral_id | uuid | no | FK `case_referrals.id` (not SecondMedic) |
| case_item_id | uuid | yes | FK `case_items.id`, the agreed item it fulfils |
| resource_type | text | no | staff, equipment |
| staff_name | text | yes | Required for staff |
| staff_ref | text | yes | Partner staff ID. Required for staff. |
| shift | text | yes | day, night, 24h |
| equipment_model | text | yes | |
| equipment_serial | text | yes | Required from delivery on. Indexed for look-up. |
| status | text | no | Staff: dispatched → active → returned. Equipment: dispatched → delivered → installed → active → returned. Can be cancelled at any step; never moves backwards. |
| dispatched_at, delivered_at, installed_at, active_from, ended_at | timestamptz | yes | Delivery and setup timestamps |
| note | text | yes | |

The first dispatch moves the lead to `dispatched`; the first install or on-duty moves it to `in_progress` (deployed).

### SecondMedic in-house diagnostic orders
| Table | Key columns | Notes |
|---|---|---|
| `assignments` | case_id → cases, staff_id → profiles, task (phlebotomy, xray, ecg, visit), status (assigned, en_route, checked_in, completed ...), eta, checkin_at / lat / lng / distance_m, patient_signoff | One per field visit (blood draw, portable X-ray) |
| `samples` | case_id → cases, barcode (unique), kind (blood, urine, ecg, xray, other), collected_at → received_at → report_released_at → delivered_at, critical_flag, **file_url** (report link) | Chain of custody and the report |

## 6. Journey and audit trail

| Table | Key columns | Notes |
|---|---|---|
| `case_journey_history` | id bigserial PK, case_id → cases, from_state, to_state (case_journey), changed_by → profiles, changed_at | One row per journey change |
| `case_stage_history` | case_id → cases, from_stage, to_stage, changed_by, changed_at, note | Operational stage changes |
| `interactions` | case_id → cases, channel, summary, body, actor | Patient timeline: calls, messages, notes, every status change above |
| `audit_log` | table_name, record_id, action, changes (old → new) | Field-level audit; personal data recorded as "(personal data)" |

## Who can see what (Row Level Security)

| Data | Agent | Coordinator / nurse | Supervisor, medical desk | Hinduja management / clinical | Book My Medicare |
|---|---|---|---|---|---|
| Case, patient, intake | Own queue; mobiles masked | SecondMedic or own cases | All | All | Its leads only |
| Validation (`discharge_assessments`) | No | Yes | Yes | Yes | No |
| Items and case totals | Yes | Yes | Yes | Yes | Of cases sent to it |
| Payment schedule, payments | Yes | Yes | Yes | Yes | No |
| Work orders (`partner_deployments`) | Yes | Yes | Yes | Yes | Its own |
| Calls and recordings | Yes | Yes | Yes | Yes | Never |

## Database actions (RPCs) that write this data

| Action | Writes | Who |
|---|---|---|
| `create_enquiry`, `set_intake` | patients, cases (intake fields) | Agents, coordinators, supervisors, medical desk |
| `schedule_validation`, `record_validation` | discharge_assessments, case_items (recommended), cases | Coordinator, supervisor, medical desk; the assigned nurse |
| `set_item_scope` | case_items (excluded, category, reason, qty) | Operations |
| `send_quote`, `set_discount`, `record_signoff` | cases (quote, discount, sign-off) | Operations; discounts above the band need Hinduja approval |
| `set_payment_schedule` | payment_schedule | Operations, after sign-off |
| `record_payment`, `reconcile_payment` | payments | Operations, field staff; reconcile: coordinator / supervisor |
| `route_case` (automatic), `refer_case` | case_referrals | System on sign-off; operations by hand |
| `update_referral`, `import_referral_updates` | case_referrals | Partner (its leads), supervisor, Hinduja management |
| `log_deployment` | partner_deployments (+ lead status) | Partner (its leads), supervisor, Hinduja management |
| `assign_staff`, `field_update`, `upsert_sample` | assignments, samples | Coordinator, supervisor, field staff |
| automatic triggers | cases.journey_state, case_journey_history | Database |
