import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Audit requirements 3-7: intake, call wrap-up, hospital validation, commercial routing, central SPOC, provider fulfilment', async () => {

  const db = new PGlite();
  const dir = join(import.meta.dirname, '../../supabase/migrations');
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query("select id from workspaces where code='HHC'")).rows[0].id;
  const pv = Object.fromEntries((await db.query('select code, id from providers')).rows.map(r => [r.code, r.id]));
  const svcs = Object.fromEntries((await db.query('select code, id, category from services')).rows.map(r => [r.code, r]));

  const uid = (n) => `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const users = {
    sup: uid(1),
    agent: uid(2),
    coord1: uid(3),
    coord2: uid(4),
    nurse: uid(5),
    bmm_prov: uid(6),
    bmm_field: uid(7),
  };

  const roles = {
    sup: { role: 'supervisor' },
    agent: { role: 'agent' },
    coord1: { role: 'coordinator' },
    coord2: { role: 'coordinator' },
    nurse: { role: 'field_staff', provider_id: pv.SM },
    bmm_prov: { role: 'provider', provider_id: pv.BMM },
    bmm_field: { role: 'field_staff', provider_id: pv.BMM },
  };

  for (const [k, id] of Object.entries(users)) {
    await db.query(
      'insert into profiles(id, workspace_id, full_name, role, provider_id, active) values ($1, $2, $3, $4, $5, true)',
      [id, ws, `Test ${k}`, roles[k].role, roles[k].provider_id || null]
    );
  }

  const bmmPrices = { 'NURSE-12H': 1500, 'ATTEND-12H': 900, 'BED-ICU': 400, HFNC: 1200, 'MINI-ICU': 5000, MONITOR: 300, SUCTION: 150, 'OXY-CONC': 250, AIRBED: 100 };
  for (const [code, price] of Object.entries(bmmPrices)) {
    await db.query('update services set price = $1 where code = $2 and workspace_id = $3', [price, code, ws]);
  }

  const as = async (who, sql, args = []) => {
    await db.exec('reset role');
    await db.query(
      "select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)",
      [users[who]]
    );
    await db.exec('set role caredesk_app');
    try {
      return (await db.transaction((tx) => tx.query(sql, args))).rows;
    } finally {
      await db.exec('reset role');
    }
  };

  const fn = async (who, sql, args = []) => (await as(who, sql, args))[0]?.v;

  const setCase = async (sql, args = []) => {
    await db.exec("select set_config('request.jwt.claim.role','service_role',false); select rpc_on();");
    try {
      return (await db.query(sql, args)).rows;
    } finally {
      await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
    }
  };

  // =========================================================================
  // 1. INTAKE AND CALL WRAP-UP
  // =========================================================================
  // Case-level intake creation records all required clinical & commercial intake fields
  const enqData = {
    patient: {
      full_name: 'Harish Mehta',
      age: 68,
      gender: 'M',
      mobile: '9820011223',
      address: 'A-402 Palm Heights',
      pincode: '400058',
      locality: 'Andheri West'
    },
    caller_name: 'Rajesh Mehta',
    caller_relation: 'Son',
    caller_mobile: '9820011223',
    services_requested: 'Post-discharge ICU and nursing care',
    clinical_notes: 'Post CABG, requires continuous oxygen & monitoring',
    expected_discharge_on: '2026-10-20',
    intake_disposition: 'requirement_captured',
    action_taken: 'Enquiry qualified and initial care plan formulated',
    consent: true,
    care_type: 'post_discharge',
    service_ids: [svcs['NURSE-12H'].id, svcs['BED-ICU'].id, svcs['LAB-PANEL'].id]
  };

  const enq = await fn('agent', 'select create_enquiry($1::jsonb) v', [JSON.stringify(enqData)]);
  const caseId = enq.case_id;
  expect(caseId).toBeDefined();

  // Verify case-level intake fields
  const [caseRow] = await as('agent', 'select clinical_notes, expected_discharge_on, decision_maker_name, intake_disposition, action_taken from cases where id = $1', [caseId]);
  expect(caseRow.clinical_notes).toBe('Post CABG, requires continuous oxygen & monitoring');
  expect(new Date(caseRow.expected_discharge_on).toISOString().slice(0, 10)).toBe('2026-10-20');
  expect(caseRow.decision_maker_name).toBe('Rajesh Mehta');
  expect(caseRow.intake_disposition).toBe('requirement_captured');
  expect(caseRow.action_taken).toBe('Enquiry qualified and initial care plan formulated');

  // Verify set_intake updates action_taken and condition
  await fn('agent', 'select set_intake($1, $2::jsonb) v', [caseId, JSON.stringify({
    spoke_with: 'family_member',
    clinical_notes: 'Post CABG, stable vitals, mild dyspnea',
    expected_discharge_on: '2026-10-21',
    decision_maker_name: 'Rajesh Mehta',
    decision_maker_phone: '9820011223',
    action_taken: 'Updated discharge date after speaking with hospital coordinator'
  })]);

  const [updatedCase] = await as('agent', 'select clinical_notes, expected_discharge_on, action_taken from cases where id = $1', [caseId]);
  expect(updatedCase.clinical_notes).toBe('Post CABG, stable vitals, mild dyspnea');
  expect(new Date(updatedCase.expected_discharge_on).toISOString().slice(0, 10)).toBe('2026-10-21');
  expect(updatedCase.action_taken).toBe('Updated discharge date after speaking with hospital coordinator');

  // Verify individual call wrap-up on handled calls
  // Simulate an inbound call connected to the agent
  const [callRow] = (await db.query(`
    insert into calls (workspace_id, case_id, direction, customer_number, did_number, status, started_at, answered_at, ended_at, agent_id)
    values ($1, $2, 'inbound', '+919820011223', '+919800000000', 'completed', now() - interval '10 minutes', now() - interval '9 minutes', now(), $3)
    returning id
  `, [ws, caseId, users.agent])).rows;

  const followupTime = new Date(Date.now() + 2 * 3600000).toISOString();
  const wrapResult = await fn('agent', 'select wrap_up_call($1, $2::jsonb) v', [callRow.id, JSON.stringify({
    disposition: 'callback_requested',
    action_taken: 'Discussed rate card; son requested evening callback after consulting family',
    notes: 'Family reviewing 12h vs 24h nursing options',
    followup_at: followupTime,
    followup_owner_id: users.coord1
  })]);

  expect(wrapResult.disposition).toBe('callback_requested');
  expect(wrapResult.action_taken).toBe('Discussed rate card; son requested evening callback after consulting family');

  // Verify call record has separate wrap-up data
  const [savedCall] = await as('agent', 'select disposition, action_taken, notes, followup_at, followup_owner_id from calls where id = $1', [callRow.id]);
  expect(savedCall.disposition).toBe('callback_requested');
  expect(savedCall.action_taken).toBe('Discussed rate card; son requested evening callback after consulting family');
  expect(savedCall.notes).toBe('Family reviewing 12h vs 24h nursing options');
  expect(savedCall.followup_owner_id).toBe(users.coord1);

  // Verify callback scheduled automatically from follow-up
  const [cb] = (await db.query('select * from callbacks where call_id = $1 or number = $2 order by created_at desc limit 1', [callRow.id, '+919820011223'])).rows;
  expect(cb).toBeDefined();
  expect(new Date(cb.due_at).toISOString()).toBe(new Date(followupTime).toISOString());

  // Distinctness test: A second call on the same case has independent wrap-up
  const [call2] = (await db.query(`
    insert into calls (workspace_id, case_id, direction, did_number, customer_number, status, started_at, answered_at, ended_at, agent_id)
    values ($1, $2, 'outbound', '+919800000000', '+919820011223', 'completed', now() - interval '5 minutes', now() - interval '4 minutes', now(), $3)
    returning id
  `, [ws, caseId, users.agent])).rows;

  await fn('agent', 'select wrap_up_call($1, $2::jsonb) v', [call2.id, JSON.stringify({
    disposition: 'interested',
    action_taken: 'Hospital bedside assessment scheduled for tomorrow 11 AM',
    notes: 'Bedside nurse assigned'
  })]);

  const [savedCall2] = await as('agent', 'select disposition, action_taken from calls where id = $1', [call2.id]);
  expect(savedCall2.disposition).toBe('interested');
  expect(savedCall2.action_taken).toBe('Hospital bedside assessment scheduled for tomorrow 11 AM');

  // Case-level disposition and action_taken remain undisturbed by individual call wrap-ups
  const [caseAfterCalls] = await as('agent', 'select intake_disposition, action_taken from cases where id = $1', [caseId]);
  expect(caseAfterCalls.intake_disposition).toBe('requirement_captured');
  expect(caseAfterCalls.action_taken).toBe('Updated discharge date after speaking with hospital coordinator');

  // =========================================================================
  // 2. HOSPITAL VALIDATION
  // =========================================================================
  // Schedule hospital bedside validation (called by coordinator)
  await fn('coord1', 'select schedule_validation($1, $2, $3, $4) v', [
    caseId,
    users.nurse,
    new Date(Date.now() + 3600000).toISOString(),
    'hospital_bedside'
  ]);

  // Direct API bypass checks:
  // (a) Attempting ready without met_ward_staff MUST fail
  await expect(fn('nurse', 'select record_validation($1, $2::jsonb) v', [caseId, JSON.stringify({
    readiness: 'ready',
    met_doctor: true,
    met_ward_staff: false,
    met_family: true,
    vitals: { bp: '120/80', hr: 76, spo2: 98 },
    notes: 'Attempting bypass of ward nurse validation'
  })])).rejects.toThrow('Meet the ward nurse or staff before confirming discharge readiness');

  // (b) Attempting ready without met_doctor MUST fail
  await expect(fn('nurse', 'select record_validation($1, $2::jsonb) v', [caseId, JSON.stringify({
    readiness: 'ready',
    met_doctor: false,
    met_ward_staff: true,
    met_family: true,
    vitals: { bp: '120/80', hr: 76, spo2: 98 },
    notes: 'Attempting bypass of doctor validation'
  })])).rejects.toThrow('Meet the treating doctor before confirming discharge readiness');

  // (c) Attempting ready without met_family MUST fail
  await expect(fn('nurse', 'select record_validation($1, $2::jsonb) v', [caseId, JSON.stringify({
    readiness: 'ready',
    met_doctor: true,
    met_ward_staff: true,
    met_family: false,
    vitals: { bp: '120/80', hr: 76, spo2: 98 },
    notes: 'Attempting bypass of family validation'
  })])).rejects.toThrow('Meet the family before confirming discharge readiness');

  // (d) When all 3 are met, hospital_bedside validation succeeds
  const valSuccess = await fn('nurse', 'select record_validation($1, $2::jsonb) v', [caseId, JSON.stringify({
    readiness: 'ready',
    met_doctor: true,
    met_ward_staff: true,
    met_family: true,
    vitals: { bp: '120/80', hr: 76, spo2: 98 },
    discharge_summary_seen: true,
    equipment_needed: ['BED-ICU'],
    consumables_needed: ['GLOVES-BOX'],
    notes: 'Doctor and head nurse confirmed discharge stability'
  })]);
  expect(valSuccess.validation_status).toBe('done');

  // (e) Home visit assessment rule preservation: Home visit requires met_family but NOT doctor/ward staff
  const homeEnq = await fn('agent', 'select create_enquiry($1::jsonb) v', [JSON.stringify({
    patient: { full_name: 'Kamla Devi', age: 75, mobile: '9820099887', address: '44 Hill Road', pincode: '400050' },
    consent: true,
    care_type: 'post_discharge',
    service_ids: [svcs['VISIT-STD'].id]
  })]);
  const homeCaseId = homeEnq.case_id;
  await fn('coord1', 'select schedule_validation($1, $2, $3, $4) v', [
    homeCaseId,
    users.nurse,
    new Date(Date.now() + 3600000).toISOString(),
    'home_visit'
  ]);

  // Home visit passes with met_family: true, even when met_doctor and met_ward_staff are false
  const homeVal = await fn('nurse', 'select record_validation($1, $2::jsonb) v', [homeCaseId, JSON.stringify({
    readiness: 'ready',
    met_doctor: false,
    met_ward_staff: false,
    met_family: true,
    notes: 'Home environment assessed, space adequate'
  })]);
  expect(homeVal.validation_status).toBe('done');

  // =========================================================================
  // 3. COMMERCIAL AGREEMENT, SIGN-OFF INVALIDATION AND ROUTING
  // =========================================================================
  // Move main case to pricing stage
  await setCase("update cases set stage = 'pricing' where id = $1", [caseId]);

  // Case items: NURSE-12H (BMM), BED-ICU (BMM), LAB-PANEL (SM)
  const items = (await db.query('select id, service_id, category, excluded from case_items where case_id = $1', [caseId])).rows;
  const nurseItem = items.find(i => i.service_id === svcs['NURSE-12H'].id);
  const bedItem = items.find(i => i.service_id === svcs['BED-ICU'].id);
  const labItem = items.find(i => i.service_id === svcs['LAB-PANEL'].id);

  // Family excludes BED-ICU due to space constraints
  await fn('agent', 'select set_item_scope($1, false, $2, null, $3) v', [bedItem.id, 'Family has existing adjustable cot; bedroom door too narrow', 'space']);
  const [excludedBed] = (await db.query('select excluded, exclude_category, exclude_reason from case_items where id = $1', [bedItem.id])).rows;
  expect(excludedBed.excluded).toBe(true);
  expect(excludedBed.exclude_category).toBe('space');
  expect(excludedBed.exclude_reason).toBe('Family has existing adjustable cot; bedroom door too narrow');

  // Price approval check: quote approval before sign-off
  await setCase("update cases set quote_status = 'approved' where id = $1", [caseId]);

  // First commercial sign-off
  const signoff1 = await fn('agent', 'select record_signoff($1, $2::jsonb) v', [caseId, JSON.stringify({
    signed_by: 'Rajesh Mehta',
    mode: 'in_person',
    note: 'Agreed to nursing & lab panel',
    plan_days: 15
  })]);
  expect(signoff1.signoff_at).toBeDefined();

  // Verify routing after signoff:
  // Non-excluded items: NURSE-12H (BMM, nursing), LAB-PANEL (SM, lab).
  // Excluded item: BED-ICU (beds) - its category is NOT routed to BMM if only beds were requested!
  const referralsAfterSignoff = (await db.query('select id, provider_id, categories, status from case_referrals where case_id = $1', [caseId])).rows;
  const bmmRef = referralsAfterSignoff.find(r => r.provider_id === pv.BMM);
  const smRef = referralsAfterSignoff.find(r => r.provider_id === pv.SM);
  expect(bmmRef).toBeDefined();
  expect(bmmRef.categories).toContain('nursing');
  expect(bmmRef.categories).not.toContain('beds'); // BED-ICU was excluded, so beds category excluded!
  expect(smRef).toBeDefined();
  expect(smRef.categories).toContain('lab');

  // BMM accepts the active lead
  await fn('bmm_prov', "select update_referral($1, 'accepted') v", [bmmRef.id]);

  // Verify renewed sign-off enforcement:
  // If an item scope changes, signoff_at MUST be cleared immediately!
  await fn('agent', 'select set_item_scope($1, false, $2, null, $3) v', [labItem.id, 'Family opted out of lab panel for now', 'cost']);
  const [caseAfterChange] = (await db.query('select signoff_at from cases where id = $1', [caseId])).rows;
  expect(caseAfterChange.signoff_at).toBeNull(); // CLEARED! Renewed sign-off required!

  // Provider cannot perform actions while signoff is invalidated
  const portalOnHold = await fn('bmm_prov', 'select provider_portal($1) v', [bmmRef.id]);
  expect(portalOnHold.leads[0].on_hold).toBe(true);

  await expect(fn('bmm_prov', 'select plan_provider_job($1, $2::jsonb) v', [bmmRef.id, JSON.stringify({
    request_id: uid(9999),
    case_item_id: nurseItem.id,
    resource_type: 'staff',
    scheduled_at: new Date().toISOString(),
    scheduled_end: new Date(Date.now() + 3600000).toISOString()
  })])).rejects.toThrow('Record the family sign-off first');

  await db.query('update case_referrals set fulfilment_managed = true where id = $1', [bmmRef.id]);
  await expect(fn('bmm_prov', "select update_referral($1, 'dispatched') v", [bmmRef.id]))
    .rejects.toThrow('Current family sign-off is required; this lead is on hold');

  // Re-sign commercial agreement with renewed signoff
  await fn('agent', 'select record_signoff($1, $2::jsonb) v', [caseId, JSON.stringify({
    signed_by: 'Rajesh Mehta',
    mode: 'phone',
    note: 'Renewed signoff for nursing care only',
    plan_days: 15
  })]);
  const [caseAfterRenewedSignoff] = (await db.query('select signoff_at from cases where id = $1', [caseId])).rows;
  expect(caseAfterRenewedSignoff.signoff_at).not.toBeNull();

  // Verify SM referral cancelled because all SM items were excluded
  const referralsAfterSecondSignoff = (await db.query('select provider_id, categories, status from case_referrals where case_id = $1', [caseId])).rows;
  const smRef2 = referralsAfterSecondSignoff.find(r => r.provider_id === pv.SM);
  expect(smRef2.status).toBe('cancelled');

  // Multi-case routing tests:
  // Case A: SecondMedic-only case (diagnostics only)
  const smOnlyEnq = await fn('agent', 'select create_enquiry($1::jsonb) v', [JSON.stringify({
    patient: { full_name: 'Anil Desai', mobile: '9820011999', address: 'Bandra West', pincode: '400050' },
    consent: true,
    care_type: 'post_discharge',
    service_ids: [svcs['LAB-CBC'].id, svcs['ECG-12'].id]
  })]);
  const smCaseId = smOnlyEnq.case_id;
  await setCase("update cases set validation_status = 'done', stage = 'pricing', quote_status = 'approved' where id = $1", [smCaseId]);
  await fn('agent', 'select record_signoff($1, $2::jsonb) v', [smCaseId, JSON.stringify({ signed_by: 'Anil Desai', mode: 'phone' })]);
  const smOnlyRefs = (await db.query('select provider_id, status from case_referrals where case_id = $1', [smCaseId])).rows;
  expect(smOnlyRefs.map(r => r.provider_id)).toEqual([pv.SM]);

  // Case B: BMM-only case (nursing + equipment only)
  const bmmOnlyEnq = await fn('agent', 'select create_enquiry($1::jsonb) v', [JSON.stringify({
    patient: { full_name: 'Suresh Patel', mobile: '9820022334', address: 'Juhu Scheme', pincode: '400049' },
    consent: true,
    care_type: 'post_discharge',
    service_ids: [svcs['NURSE-12H'].id, svcs['BED-ICU'].id]
  })]);
  const bmmCaseId = bmmOnlyEnq.case_id;
  await setCase("update cases set validation_status = 'done', stage = 'pricing', quote_status = 'approved' where id = $1", [bmmCaseId]);
  await fn('agent', 'select record_signoff($1, $2::jsonb) v', [bmmCaseId, JSON.stringify({ signed_by: 'Suresh Patel', mode: 'phone' })]);
  const bmmOnlyRefs = (await db.query('select provider_id, status from case_referrals where case_id = $1', [bmmCaseId])).rows;
  expect(bmmOnlyRefs.map(r => r.provider_id)).toEqual([pv.BMM]);

  // Case C: Mixed case (diagnostics for SM, nursing for BMM)
  const mixedEnq = await fn('agent', 'select create_enquiry($1::jsonb) v', [JSON.stringify({
    patient: { full_name: 'Meena Kothari', mobile: '9820033445', address: 'Vile Parle East', pincode: '400057' },
    consent: true,
    care_type: 'post_discharge',
    service_ids: [svcs['LAB-LFT'].id, svcs['NURSE-12H'].id]
  })]);
  const mixedCaseId = mixedEnq.case_id;
  await setCase("update cases set validation_status = 'done', stage = 'pricing', quote_status = 'approved' where id = $1", [mixedCaseId]);
  await fn('agent', 'select record_signoff($1, $2::jsonb) v', [mixedCaseId, JSON.stringify({ signed_by: 'Meena Kothari', mode: 'phone' })]);
  const mixedRefs = (await db.query('select provider_id, status from case_referrals where case_id = $1', [mixedCaseId])).rows;
  expect(mixedRefs.map(r => r.provider_id).sort()).toEqual([pv.SM, pv.BMM].sort());

  // =========================================================================
  // 4. CENTRAL COORDINATION & PORTAL READINESS
  // =========================================================================
  // SecondMedic SPOC visibility check on BMM-only case:
  // Before assignment: Coordinator coord2 CANNOT see bmmCaseId (since coord2 is not coordinator_id or nurse_id)
  const canSeeBefore = await as('coord2', 'select can_see_case($1) c', [bmmCaseId]);
  expect(canSeeBefore[0].c).toBe(false);

  // Supervisor assigns coord2 as the designated Care Coordinator SPOC
  await fn('sup', 'select assign_coordinator($1, $2) v', [bmmCaseId, users.coord2]);

  // After assignment: Coordinator coord2 CAN see and monitor the complete service journey
  const canSeeAfter = await as('coord2', 'select can_see_case($1) c', [bmmCaseId]);
  expect(canSeeAfter[0].c).toBe(true);

  // Verify coord2 can inspect the case journey and details
  const [bmmCaseView] = await as('coord2', 'select case_no, journey_state, coordinator_id from v_cases where id = $1', [bmmCaseId]);
  expect(bmmCaseView.coordinator_id).toBe(users.coord2);
  expect(bmmCaseView.journey_state).toBe('commercial_approved');

  // Verify access restrictions preserved: Another coordinator (coord1) CANNOT see the case
  const coord1CanSee = await as('coord1', 'select can_see_case($1) c', [bmmCaseId]);
  expect(coord1CanSee[0].c).toBe(false);

  // Provider Fulfilment Portal readiness:
  const bmmLead = (await db.query('select id from case_referrals where case_id = $1 and provider_id = $2', [bmmCaseId, pv.BMM])).rows[0].id;
  await fn('bmm_prov', "select update_referral($1, 'accepted') v", [bmmLead]);

  const bmmItems = (await db.query('select id, service_id from case_items where case_id = $1', [bmmCaseId])).rows;
  const bmmNurseItem = bmmItems.find(i => i.service_id === svcs['NURSE-12H'].id);
  const bmmBedItem = bmmItems.find(i => i.service_id === svcs['BED-ICU'].id);

  // Plan nursing job (staff) and bed job (equipment with return_required = true)
  const nurseJob = await fn('bmm_prov', 'select plan_provider_job($1, $2::jsonb) v', [bmmLead, JSON.stringify({
    request_id: uid(8001),
    case_item_id: bmmNurseItem.id,
    resource_type: 'staff',
    assigned_staff_id: users.bmm_field,
    scheduled_at: new Date(Date.now() - 7200000).toISOString(),
    scheduled_end: new Date(Date.now() - 3600000).toISOString()
  })]);
  expect(nurseJob.id).toBeDefined();

  const bedJob = await fn('bmm_prov', 'select plan_provider_job($1, $2::jsonb) v', [bmmLead, JSON.stringify({
    request_id: uid(8002),
    case_item_id: bmmBedItem.id,
    resource_type: 'equipment',
    assigned_staff_id: users.bmm_field,
    scheduled_at: new Date(Date.now() - 3600000).toISOString(),
    return_required: true
  })]);
  expect(bedJob.id).toBeDefined();

  // BMM portal view: field staff sees both assigned jobs
  const fieldPortal = await fn('bmm_field', 'select provider_portal() v');
  expect(fieldPortal.jobs).toHaveLength(2);

  // SecondMedic SPOC (coord2) can monitor provider deployments via portal view
  const spocPortal = await fn('coord2', 'select provider_portal($1) v', [bmmLead]);
  expect(spocPortal.jobs).toHaveLength(2);

  // Field progression for nursing job: dispatched -> arrived -> active
  let serial = 9000;
  const moveJob = async (who, jobId, action, p = {}) => {
    const current = (await db.query('select version from partner_deployments where id = $1', [jobId])).rows[0].version;
    return fn(who, 'select update_provider_job($1, $2, $3, $4, $5::jsonb) v', [
      jobId, uid(serial++), current, action, JSON.stringify(p)
    ]);
  };

  await moveJob('bmm_field', nurseJob.id, 'dispatched');
  await moveJob('bmm_field', nurseJob.id, 'arrived');
  await moveJob('bmm_field', nurseJob.id, 'active');

  // Attempting completion without confirmation fails
  await expect(moveJob('bmm_field', nurseJob.id, 'completed', {})).rejects.toThrow('confirmation');

  // Complete nursing job with confirmation
  await moveJob('bmm_field', nurseJob.id, 'completed', { confirmed_by: 'Rajesh Mehta', handover_confirmed: true, note: '12h shift complete' });

  // Partial fulfilment test: BMM referral cannot complete because bed job is not fulfilled
  await expect(fn('bmm_prov', "select update_referral($1, 'completed') v", [bmmLead])).rejects.toThrow('every included service unit');

  // Issue reporting test on bed job
  await moveJob('bmm_field', bedJob.id, 'report_issue', { note: 'Lift not working; carrying ICU bed up stairs delayed' });
  const [bedJobAfterProblem] = (await db.query('select issue_open, issue_note from partner_deployments where id = $1', [bedJob.id])).rows;
  expect(bedJobAfterProblem.issue_open).toBe(true);
  expect(bedJobAfterProblem.issue_note).toBe('Lift not working; carrying ICU bed up stairs delayed');

  // Manager/provider resolves issue
  await moveJob('bmm_prov', bedJob.id, 'resolve_issue', { note: 'Service lift unlocked by building security' });

  // Advance bed job: dispatched -> delivered (with serial) -> active -> completed -> returned
  await moveJob('bmm_field', bedJob.id, 'dispatched');
  await moveJob('bmm_field', bedJob.id, 'delivered', { equipment_serial: 'BMM-BED-991' });
  await moveJob('bmm_field', bedJob.id, 'installed', { note: 'Assembled in patient room' });
  await moveJob('bmm_field', bedJob.id, 'active', { note: 'Demonstrated controls to family' });

  // Bed job completion records handover
  await moveJob('bmm_field', bedJob.id, 'completed', { confirmed_by: 'Rajesh Mehta', handover_confirmed: true });

  // Referral cannot complete while equipment is deployed and return is required
  await expect(fn('bmm_prov', "select update_referral($1, 'completed') v", [bmmLead])).rejects.toThrow('returns first');

  // Record return of equipment
  await moveJob('bmm_field', bedJob.id, 'returned', {
    confirmed_by: 'Rajesh Mehta',
    handover_confirmed: true,
    note: 'De-installed and returned in good condition'
  });

  // Now all units are fulfilled; referral is automatically marked completed
  const [refFinal] = (await db.query('select status from case_referrals where id = $1', [bmmLead])).rows;
  expect(refFinal.status).toBe('completed');

  // Verify BMM-only case automatically transitioned stage to closed
  const [bmmCaseFinal] = (await db.query('select stage, journey_state from cases where id = $1', [bmmCaseId])).rows;
  expect(bmmCaseFinal.stage).toBe('closed');
  expect(bmmCaseFinal.journey_state).toBe('closed');

  // Verify mixed case remains open while SM diagnostic services are not completed
  const [mixedCaseState] = (await db.query('select stage from cases where id = $1', [mixedCaseId])).rows;
  expect(mixedCaseState.stage).not.toBe('closed');

  // =========================================================================
  // 5. EXTERNAL BMM INTEGRATION GATING & RECONCILIATION
  // =========================================================================
  // Confirm default state of machine API is disabled
  const bmmCfg = await fn('sup', 'select bmm_settings() v');
  expect(bmmCfg.enabled).toBe(false);

  // Calling machine API while disabled throws error
  await expect(fn('bmm_prov', 'select bmm_leads() v')).rejects.toThrow('disabled');
}, 60000);
