# SOP: Post-Discharge Home Care Transition

| | |
|---|---|
| Service | Hinduja Home Care Services (HHCS), operated on CareDesk by SecondMedic |
| Partners | SecondMedic (in-house diagnostics), Book My Medicare (manpower and equipment) |
| Version | 1.0, 13 Oct 2026 · draft for joint sign-off by Hinduja management and SecondMedic |
| Applies to | Every patient going home from P. D. Hinduja Hospital (Mahim, Khar) who needs care at home after discharge |

## 1. Objective

Move a patient from the hospital ward to a safe, fully equipped home setup on or before the discharge date. The service runs under one case ID from the first call to the closing visit. Each request is clinically validated at the bedside, the family signs off a priced 30-day plan, and the work is split between in-house diagnostics and a fulfilment partner. CareDesk keeps every step visible and under the platform's control.

## 2. Scope

**In scope:** nursing and attendant shifts (12-hour), ICU or hospital beds, mini-ICU setup, high-flow oxygen and other equipment, routine sample collection, portable X-ray, and the coordination needed to deploy them before discharge.

**Out of scope:** emergency transfers (use the Emergency button on the case and call 108), in-hospital billing, and insurance claims.

## 3. Roles and responsibilities

| Role (CareDesk login) | Responsibilities in this SOP |
|---|---|
| Contact centre agent (`agent`) | Takes the call and speaks to the patient or the family decision-maker. Creates the case, records consent, marks it **Post-discharge transition** and logs the **interaction reason**, the expected discharge date and the clinical status. |
| Care Coordinator, nurse (`coordinator` or `field_staff`) | Visits Hinduja and meets the treating doctor, ward staff and family. Records discharge readiness and the **recommended item list**. Then meets the decision-maker on costs, records items the family drops (with the reason) and records the **commercial sign-off**. Stays on the case until deployment. |
| Coordinator desk (`coordinator`) | Schedules the hospital visit and the nurse, sends the quote on the approved template, follows partner progress and closes SecondMedic's diagnostics work. |
| Medical desk (`medical_desk`) | Clinical triage of the intake. Can schedule or record a validation when no coordinator is free. Owns clinical escalations. |
| Supervisor (`supervisor`) | Owns the SLA breach queue and partner escalations. Can reopen, cancel or move partner leads. Reviews the transition MIS. |
| Hinduja management (`client_manager`) | Approves rate-card prices and any discount above the band. Sees every case and the MIS. Can move partner leads. |
| Hinduja clinical (`client_clinical`) | Receives critical findings and clinical escalations. Reads the transition MIS. |
| Book My Medicare (`provider`) | Accepts, schedules, dispatches and deploys manpower and equipment for the leads sent to it, and records progress notes. Sees only its own leads, never call recordings or clinical validation records. |
| SecondMedic diagnostics (field staff) | Sample collection and portable X-ray at home. Its lead follows the case stages automatically. |

## 4. Procedure

The case moves through the stages Enquiry, Pricing, Booking, Deployment, Completion, Payment and Closure. A stage cannot advance until its gate checks pass, and CareDesk enforces them.

### Step 1: Central intake and triage (stage: Enquiry)

1. Answer the call. Speak with the patient or the **family decision-maker**. If the caller is neither, take the decision-maker's name and number and call them back.
2. Create the case. Record verbal consent (the gate requires it).
3. In the **Post-discharge transition** panel, choose **Record intake**, then **Post-discharge transition**, and enter:
   - **Interaction reason**, from the fixed list: Requirement captured, Information only, Price enquiry, Follow-up requested, Not interested, Already arranged elsewhere, Wrong number, Duplicate enquiry. Free text is not accepted.
   - **Spoke with**: patient, family decision-maker, other family member or hospital staff.
   - **Decision-maker** name and relation.
   - **Hospital, ward/bed and treating doctor.**
   - **Expected discharge date.**
   - **Clinical status**: diagnosis, current support (oxygen, feeding, ventilation), mobility.
   - **Requested services**, as said by the caller, for example: two 12-hour nurses, two 12-hour attendants, HF machine, hospital bed, mini-ICU setup, routine sample collections, home X-rays.
4. Save. CareDesk sets validation to **pending** and starts the 6-hour validation SLA. Any partner lead created from the request text is put **on hold** until the family signs off.

Gate to Pricing, in addition to the standard checks: the interaction reason is "Requirement captured", the agent spoke with the patient or decision-maker, the discharge date is entered, the on-site validation is done with the patient discharge-ready, and a recommended item list exists.

### Step 2: On-site clinical validation at Hinduja (stage: Enquiry)

1. The coordinator desk chooses **Schedule visit** and picks the Care Coordinator (nurse) and the time. The nurse is notified.
Before the visit, the nurse prints the **Assessment & closure checklist** (form HHCS-CL-01: **Checklist** on the case's Post-discharge transition panel, or **Assessment checklist** in the menu for a blank form). It is prefilled with the patient, hospital, decision-maker, the recommended items and the plan prices, and covers this step (Part A: file check, doctor and ward-nurse points; Part B: equipment, manpower shifts, home measurements and power), the consultation in Step 3 (Part C: script, options table, rate card) and the sign-off (Part D: scope, items not included, against-medical-advice box, consent, signatures). The paper form is a working record: everything on it is entered on the case the same day, and the signed form goes to the coordinator desk.

2. At the hospital, the nurse:
   - meets the **treating doctor** (required before confirming readiness);
   - meets the **ward staff** for current orders, medicines and devices;
   - meets the **family** (required before confirming readiness), and checks home space, floor and lift, power backup and who will be at home.
3. The nurse chooses **Record validation visit** and records:
   - who was met, and the doctor's name;
   - **discharge readiness**: Ready, Not ready, or Deferred (with a revised date);
   - the home setup and a clinical summary;
   - the **recommended itemised list** from the rate card, with quantities for the whole plan. Example: two 12-hour nurses for 30 days = 60 shifts. A typical list has 12 items.
4. **Not ready or Deferred:** the case stays at Enquiry and validation shows "Not ready". Record a revised date and schedule a fresh visit closer to discharge.
5. **Ready:** the validation SLA is met and the 24-hour sign-off SLA starts.

### Step 3: Commercials and family negotiation (stage: Pricing)

1. Advance the case to Pricing. Prices come only from the approved rate card. An item without an approved price shows "Not priced", and no quote or sign-off is possible until Hinduja management approves its price.
2. The Care Coordinator meets the decision-maker and goes through the 30-day cost, item by item, following the script in Part C of the checklist: must-have items (the treating doctor's decision) first, then optional ones. If cost or space is a problem, offer in order: drop optional items, 12-hour instead of 24-hour cover where the doctor allows, a shorter first period with a day-15 review, a payment schedule. A must-have item is never dropped to close the sale; if the family declines one, tick "Against medical advice" in Part D and the medical desk is told.
3. Customise the scope in **Services & quote**:
   - **Drop** a recommended item the family does not want, and record why (home space, budget, family will arrange, clinically optional). For example, 12 items become 10.
   - Change quantities where the plan is shorter or lighter.
   - Dropped items stay visible but struck through, with the reason. They are excluded from the total and from partner routing.
4. A discount above the workspace band goes to Hinduja management for approval. The quote is blocked until they decide.
5. Send the quote on the approved template. It is logged on the timeline.
6. Record the **commercial sign-off**: the decision-maker's name, the mode (in person, WhatsApp, email or recorded phone call), the plan length and a note (advance paid, start date, special terms).
7. If the scope changes after sign-off and the total moves, the sign-off is cleared automatically and must be recorded again.

Gate to Booking, in addition to the standard checks: the family has signed off.

### Step 4: Bifurcated fulfilment (on sign-off)

Sign-off releases the partner leads automatically, by the categories of the agreed items:

| Work | Fulfilled by | How it moves |
|---|---|---|
| Sample collection, portable X-ray, ECG | **SecondMedic**, in-house | Follows the case stages: Booking = accepted, Deployment = scheduled, Completion = in progress, Payment onward = completed. Field visits, barcoded samples and reports run on the standard field flow. |
| Nurses, attendants, ICU and hospital beds, mini-ICU setup, HF machine, oxygen, monitors, suction, air mattress | **Book My Medicare** | Lead appears on the partner's Leads page at once and the partner is notified. The 24-hour deployment SLA starts. |

The partner receives the case ID, patient details, address, hospital, discharge date, plan length and the agreed items with quantities. Call recordings and the clinical validation record are not shared.

### Step 5: Partner governance and tracking

1. Book My Medicare moves each lead through **Accepted, Scheduled (visit time), Dispatched (staff or equipment on the way), Deployed (on duty or installed), Completed**, adding progress notes. Every step is written to the patient timeline with a time and the person who made it.
2. **Declining** needs a reason. The supervisor and the case owner are alerted at once to re-route.
3. **Temporary Excel sync**, until the partner works on the portal directly: on the Leads page, **Download open leads**, update the Status column (Accepted, Dispatched, Deployed, Completed, Declined) and a Note, then **Upload updated sheet**. Each row goes through the same rules as the buttons. Rows that cannot be applied (unknown case, step not allowed) are listed back by row number. Each upload is written to the access log.
4. The coordinator desk follows every open lead on the case page and on the Leads page until deployment, and confirms with the family on the day of discharge.
5. A case served only by Book My Medicare closes when all its leads are completed. A case with SecondMedic diagnostics closes through the standard Payment and Closure stages.

## 5. Escalation paths

SLA timers run in CareDesk. A breach raises an escalation automatically (level 1). The escalation matrix raises it to level 2 and then level 3 if it is not resolved within the matrix window.

| Trigger | Target | Level 1 | Level 2 | Level 3 |
|---|---|---|---|---|
| Validation not done 6 h after intake | SLA `validation` | Coordinator desk | Supervisor | Hinduja management |
| Patient not ready, or discharge deferred | Revised date | Coordinator re-schedules the visit; no escalation | Medical desk if deferred twice | Hinduja clinical |
| Sign-off not received 24 h after validation | SLA `signoff` | Supervisor | Hinduja management (pricing or discount) | Account review |
| Discount above band | Approval | Hinduja management approver | n/a | n/a |
| Partner has not accepted the lead | SLA `provider_accept` | Supervisor | Hinduja management | Re-route |
| Partner has not deployed 24 h after sign-off, or not by the discharge date | SLA `provider_deploy` | Supervisor | Hinduja management | Re-route to another provider |
| Partner declines | Immediate | Supervisor and case owner alerted | Hinduja management | n/a |
| Clinical deterioration or critical finding | SLA `critical_finding` (5 min) | Medical desk | Hinduja clinical (raised at level 2) | Treating doctor |
| Complaint from the family | Complaint SLAs | Supervisor | Hinduja management | n/a |

Use **Raise escalation** on the case for anything not covered above. Use **Emergency** for a medical emergency at home.

## 6. Key operational metrics

All metrics come live from the **MIS** page, in the "Post-discharge transitions" section, for any day, week, month or custom period. They are included in the Excel and PDF packs.

| Metric | Definition | Target (proposed) |
|---|---|---|
| Intake to validation TAT | Median time from case creation to the recorded hospital visit | 6 h or less |
| Validation to sign-off TAT | Median time from the validation visit to the family sign-off | 24 h or less |
| Sign-off to deployment TAT | Median time from sign-off to the first partner lead deployed | 24 h or less |
| Intake to deployment TAT | Median end to end | Before the discharge date |
| Conversion rate | Post-discharge cases signed off ÷ post-discharge intakes | Tracked monthly, baseline from the first month |
| Validation to sign-off rate | Signed off ÷ validated discharge-ready | Tracked monthly |
| Item retention | Agreed items ÷ recommended items (for example 10 of 12 = 83%) | Tracked monthly, with the drop reasons listed |
| Fulfilment SLA, per partner | Leads deployed within 24 h of sign-off ÷ leads deployed | 90% or more |
| Deployed before discharge, per partner | Leads deployed on or before the expected discharge date ÷ leads deployed | 95% or more |
| Partner decline rate | Declined ÷ leads sent | 5% or less |
| Interaction reasons | Count of each reason across all enquiries | Reviewed weekly |

The SLA targets live in Settings > SLA policies and can be changed there by Hinduja management or a supervisor.

## 7. Records and data protection

- Every action is stored against the case ID with who did it and when: intake, validation, scope changes, sign-off and partner status. Field-level changes go to the audit log. The names of the decision-maker, the signatory and the doctor are recorded there as "(personal data)", never as the values.
- Hinduja is the Data Fiduciary and SecondMedic the Data Processor (DPDP Act 2023). Partners see only what they need to deliver. Exports and Excel syncs are written to the access log.

## 8. Before go-live

1. Hinduja management approves prices for the new rate-card items: Nurse 12-hour shift, Attendant 12-hour shift, ICU bed, Mini-ICU setup, HF oxygen machine, oxygen concentrator, multipara monitor, suction machine and air mattress. These are added at ₹0 and cannot be quoted until priced.
2. Hinduja management and SecondMedic agree the SLA targets in section 6.
3. Book My Medicare staff get provider logins, or use the Excel sync in the meantime.
