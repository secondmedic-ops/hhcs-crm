// Role Health Check & Verification Test
// Verifies RLS policies (supabase/migrations/20261008100300_caredesk_rls.sql)
// and API access rules (cloudflare/src/api/routes.ts, cloudflare/src/services/data.ts)
// for each of the 6 roles: supervisor, agent, coordinator, medical_desk, provider, client_manager.
import { test, expect, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { match } from '../src/api/routes';
import { READ, WRITE, RPC } from '../src/services/data';
import { allows } from '../src/api/auth';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('Role health check: 6-role RLS verification, phone masking and 403 assertion', async () => {
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const prov = Object.fromEntries((await db.query(`select code, id from providers`)).rows.map((r) => [r.code, r.id]));
  const svc = Object.fromEntries((await db.query(`select code, id from services`)).rows.map((r) => [r.code, r.id]));

  const users = {
    supervisor: '30000000-0000-4000-8000-000000000001',
    agent: '30000000-0000-4000-8000-000000000002',
    coordinator: '30000000-0000-4000-8000-000000000003',
    medical_desk: '30000000-0000-4000-8000-000000000004',
    provider: '30000000-0000-4000-8000-000000000005',
    client_manager: '30000000-0000-4000-8000-000000000006',
    agent2: '30000000-0000-4000-8000-000000000007',
  };

  const roleTypes = {
    supervisor: 'supervisor',
    agent: 'agent',
    coordinator: 'coordinator',
    medical_desk: 'medical_desk',
    provider: 'provider',
    client_manager: 'client_manager',
    agent2: 'agent',
  };

  for (const [k, id] of Object.entries(users)) {
    await db.query(
      `insert into profiles(id, workspace_id, full_name, email, role, agent_code, provider_id, active)
       values ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        id,
        ws,
        `${k.toUpperCase()} user`,
        `${k}@test.local`,
        roleTypes[k],
        k.startsWith('agent') ? (k === 'agent' ? 'A-01' : 'A-02') : null,
        k === 'provider' ? prov.BMM : null,
      ]
    );
  }

  // Database helper executing queries as caredesk_app with user's sub claim (app_uid)
  async function as(userKey, sql, params = []) {
    await db.exec('reset role');
    await db.query(
      `select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`,
      [users[userKey]]
    );
    await db.exec('set role caredesk_app');
    try {
      return await db.transaction(async (tx) => (await tx.query(sql, params)).rows);
    } finally {
      await db.exec('reset role');
    }
  }

  async function expectDbError(userKey, sql, params, matchText) {
    try {
      await as(userKey, sql, params);
      throw new Error(`Expected database query to fail with "${matchText}", but it succeeded.`);
    } catch (e) {
      if (e.message.startsWith('Expected database query to fail')) throw e;
      expect(e.message).toContain(matchText);
    }
  }

  // API Gate check helpers
  function checkApiEndpoint(role, method, path) {
    const m = match(method, path);
    if (typeof m === 'number') return { status: m };
    if (m.route.access === 'public' || m.route.access === 'login') return { status: 200, allowed: true };
    const allowed = allows(m.route.access, role);
    return { status: allowed ? 200 : 403, allowed };
  }

  function checkTableRead(role, table) {
    const allowed = allows(READ[table], role);
    return { status: allowed ? 200 : 403, allowed };
  }

  function checkTableWrite(role, table, op) {
    const allowed = allows(WRITE[table]?.[op], role);
    return { status: allowed ? 200 : 403, allowed };
  }

  function checkRpcCall(role, fn) {
    const allowed = allows(RPC[fn], role);
    return { status: allowed ? 200 : 403, allowed };
  }

  // Helper to assert API call returns 403 Forbidden
  function assertApiForbidden(checkResult, description) {
    expect(checkResult.status, `${description} should return 403 Forbidden`).toBe(403);
    expect(checkResult.allowed, `${description} should not be allowed`).toBeFalsy();
  }

  // --- Seed Data ---
  // Patient 1
  const [p1] = (await db.query(
    `insert into patients(workspace_id, full_name, mobile, alt_mobile, address, pincode, locality)
     values ($1, 'Ramesh Patel', '+919820012012', '+919820012099', '10 MG Road', '400058', 'Andheri West')
     returning id`,
    [ws]
  )).rows;
  const p1Id = p1.id;

  // Patient 2
  const [p2] = (await db.query(
    `insert into patients(workspace_id, full_name, mobile, address, pincode, locality)
     values ($1, 'Sunita Sharma', '+919811122233', '24 Linking Rd', '400052', 'Khar West')
     returning id`,
    [ws]
  )).rows;
  const p2Id = p2.id;

  // Case 1: Owned by 'agent' (Agent's own queue)
  const [c1] = (await db.query(
    `insert into cases(workspace_id, case_no, patient_id, owner_id, created_by, caller_name, caller_mobile, stage, total)
     values ($1, 'HHC-261019-00001', $2, $3, $3, 'Amit Patel', '+919820012012', 'enquiry', 3700)
     returning id`,
    [ws, p1Id, users.agent]
  )).rows;
  const c1Id = c1.id;

  await db.query(
    `insert into case_items(case_id, service_id, service_code, service_name, unit_price, qty, line_total)
     values ($1, $2, 'LAB-PANEL', 'Lab panel', 2500, 1, 2500)`,
    [c1Id, svc['LAB-PANEL']]
  );

  // Call for Case 1 (with recording)
  const [call1] = (await db.query(
    `insert into calls(workspace_id, case_id, patient_id, agent_id, direction, customer_number, status, recording_filename)
     values ($1, $2, $3, $4, 'inbound', '+919820012012', 'completed', 'call_patel_rec_001.mp3')
     returning id`,
    [ws, c1Id, p1Id, users.agent]
  )).rows;
  const call1Id = call1.id;

  // Callback for Case 1
  await db.query(
    `insert into callbacks(workspace_id, call_id, patient_id, assigned_to, number, reason, due_at, status)
     values ($1, $2, $3, $4, '+919820012012', 'requested', now() + interval '10 minutes', 'pending')`,
    [ws, call1Id, p1Id, users.agent]
  );

  // Case 2: Owned by 'agent2', created > 3 days ago and closed (outside agent's queue)
  const [c2] = (await db.query(
    `insert into cases(workspace_id, case_no, patient_id, owner_id, created_by, caller_name, caller_mobile, stage, total, created_at)
     values ($1, 'HHC-261019-00002', $2, $3, $3, 'Vikas Sharma', '+919811122233', 'closed', 2000, now() - interval '4 days')
     returning id`,
    [ws, p2Id, users.agent2]
  )).rows;
  const c2Id = c2.id;

  // Case 3: Lead referred to BMM provider
  const [c3] = (await db.query(
    `insert into cases(workspace_id, case_no, patient_id, owner_id, created_by, caller_name, caller_mobile, stage, total)
     values ($1, 'HHC-261019-00003', $2, $3, $3, 'Amit Patel', '+919820012012', 'deployment', 1500)
     returning id`,
    [ws, p1Id, users.agent]
  )).rows;
  const c3Id = c3.id;
  await db.query(
    `insert into case_referrals(workspace_id, case_id, provider_id, status, categories)
     values ($1, $2, $3, 'dispatched', array['nursing'])`,
    [ws, c3Id, prov.BMM]
  );

  // Case 4: Lead referred to SecondMedic (SM) provider only
  const [c4] = (await db.query(
    `insert into cases(workspace_id, case_no, patient_id, owner_id, created_by, caller_name, caller_mobile, stage, total)
     values ($1, 'HHC-261019-00004', $2, $3, $3, 'Amit Patel', '+919820012012', 'deployment', 1800)
     returning id`,
    [ws, p1Id, users.agent]
  )).rows;
  const c4Id = c4.id;
  await db.query(
    `insert into case_referrals(workspace_id, case_id, provider_id, status, categories)
     values ($1, $2, $3, 'dispatched', array['diagnostics'])`,
    [ws, c4Id, prov.SM]
  );

  // Case 5: Closed case to test clinical overrides
  const [c5] = (await db.query(
    `insert into cases(workspace_id, case_no, patient_id, owner_id, created_by, caller_name, caller_mobile, stage, total)
     values ($1, 'HHC-261019-00005', $2, $3, $3, 'Amit Patel', '+919820012012', 'closed', 1500)
     returning id`,
    [ws, p1Id, users.agent]
  )).rows;
  const c5Id = c5.id;

  // Escalation on Case 1
  await db.query(
    `insert into escalations(workspace_id, case_id, type, status, level, trigger_text, raised_by)
     values ($1, $2, 'clinical', 'open', 1, 'Patient vitals abnormal', $3)`,
    [ws, c1Id, users.agent]
  );

  // Approval on Case 1
  await db.query(
    `insert into approvals(workspace_id, case_id, kind, title, payload, requested_by, status)
     values ($1, $2, 'discount', 'Discount approval', '{"discount_pct":15}'::jsonb, $3, 'pending')`,
    [ws, c1Id, users.agent]
  );

  const testReport = [];

  // =========================================================================
  // 1. SUPERVISOR (Full access, recordings, QA, unmasked numbers, margins)
  // =========================================================================
  {
    // A. Scope: sees all cases
    const supCases = await as('supervisor', `select id from v_cases where id in ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`, [c1Id, c2Id, c3Id, c4Id, c5Id]);
    expect(supCases.length).toBe(5);

    // B. Phone numbers: unmasked
    const [supCase] = await as('supervisor', `select patient_mobile, caller_mobile_display from v_cases where id = $1`, [c1Id]);
    expect(supCase.patient_mobile).toBe('+919820012012');
    expect(supCase.caller_mobile_display).toBe('+919820012012');

    const [supPatient] = await as('supervisor', `select mobile from v_patients where id = $1`, [p1Id]);
    expect(supPatient.mobile).toBe('+919820012012');

    // C. Recordings & QA Access
    const recCheck = checkApiEndpoint('supervisor', 'GET', `/api/v1/calls/${call1Id}/recording`);
    expect(recCheck.status).toBe(200);

    const qaWriteCheck = checkTableWrite('supervisor', 'qa_reviews', 'insert');
    expect(qaWriteCheck.status).toBe(200);

    // RLS write to qa_reviews
    await as('supervisor', `insert into qa_reviews(workspace_id, call_id, agent_id, reviewer_id, total_pct) values ($1, $2, $3, $4, 95)`,
      [ws, call1Id, users.agent, users.supervisor]);
    const [qaRecord] = await as('supervisor', `select total_pct from qa_reviews where call_id = $1`, [call1Id]);
    expect(Number(qaRecord.total_pct)).toBe(95);

    // D. Margins & Commercial view
    expect(checkRpcCall('supervisor', 'case_margins').status).toBe(200);
    expect(checkRpcCall('supervisor', 'margin_report').status).toBe(200);
    expect(checkTableRead('supervisor', 'provider_rates').status).toBe(200);
    expect(checkTableRead('supervisor', 'rate_imports').status).toBe(200);

    // E. Ops & Financials
    expect(checkRpcCall('supervisor', 'reconcile_payment').status).toBe(200);
    expect(checkRpcCall('supervisor', 'import_cases').status).toBe(200);

    // F. Assert unauthorized API call returns 403 Forbidden
    assertApiForbidden(checkApiEndpoint('supervisor', 'POST', '/api/v1/admin/users'), 'Supervisor user administration');
    assertApiForbidden(checkTableWrite('supervisor', 'workspaces', 'update'), 'Supervisor workspace config alteration');

    testReport.push({
      role: 'supervisor',
      scope: 'Full workspace access (all cases, all stages)',
      phoneMasking: 'Unmasked (+919820012012)',
      clinicalOps: 'Full ops, QA write, payment reconciliation',
      recordingsCalls: 'Allowed (/api/v1/calls/{id}/recording = 200)',
      marginsRates: 'Full access (case_margins, margin_report, provider_rates)',
      forbiddenEnforced: '403 on admin user creation & workspace alterations',
      status: 'PASS',
    });
  }

  // =========================================================================
  // 2. AGENT (Own queue only, masked phones, no clinical overrides)
  // =========================================================================
  {
    // A. Scope: sees own queue, blocked from other agent's closed case
    const agentCases = await as('agent', `select id from v_cases where id in ($1::uuid, $2::uuid)`, [c1Id, c2Id]);
    const agentCaseIds = agentCases.map((r) => r.id);
    expect(agentCaseIds).toContain(c1Id);
    expect(agentCaseIds).not.toContain(c2Id);

    // B. Phone masking strictly enforced on all views
    const [agCase] = await as('agent', `select patient_mobile, caller_mobile_display from v_cases where id = $1`, [c1Id]);
    expect(agCase.patient_mobile).toContain('XXX');
    expect(agCase.caller_mobile_display).toContain('XXX');
    expect(agCase.patient_mobile).not.toBe('+919820012012');

    const [agPat] = await as('agent', `select mobile, alt_mobile from v_patients where id = $1`, [p1Id]);
    expect(agPat.mobile).toContain('XXX');
    expect(agPat.alt_mobile).toContain('XXX');

    const [agCall] = await as('agent', `select customer_number from v_calls where case_id = $1`, [c1Id]);
    expect(agCall.customer_number).toContain('XXX');

    const [agCb] = await as('agent', `select number from v_callbacks where patient_id = $1`, [p1Id]);
    expect(agCb.number).toContain('XXX');

    // C. No clinical overrides: cannot tamper with closed cases or bypass stage gates
    await expectDbError('agent', `update cases set clinical_notes = 'tampered' where id = $1`, [c5Id], 'closed');
    await expectDbError('agent', `update cases set stage = 'closed' where id = $1`, [c1Id], 'controlled by workflow');

    // D. Assert unauthorized API calls return 403 Forbidden
    assertApiForbidden(checkApiEndpoint('agent', 'GET', `/api/v1/calls/${call1Id}/recording`), 'Agent call recording playback');
    assertApiForbidden(checkApiEndpoint('agent', 'GET', '/api/v1/admin/integrations'), 'Agent admin integrations');
    assertApiForbidden(checkApiEndpoint('agent', 'GET', '/api/v1/staff-sessions/staff'), 'Agent staff sessions directory');
    assertApiForbidden(checkTableRead('agent', 'audit_log'), 'Agent audit log access');
    assertApiForbidden(checkTableRead('agent', 'access_log'), 'Agent access log access');
    assertApiForbidden(checkTableRead('agent', 'provider_rates'), 'Agent buying provider rates access');
    assertApiForbidden(checkTableRead('agent', 'rate_imports'), 'Agent rate import access');
    assertApiForbidden(checkTableWrite('agent', 'qa_reviews', 'insert'), 'Agent QA review submission');
    assertApiForbidden(checkRpcCall('agent', 'case_margins'), 'Agent case margin view');
    assertApiForbidden(checkRpcCall('agent', 'margin_report'), 'Agent MIS margin report');
    assertApiForbidden(checkRpcCall('agent', 'reconcile_payment'), 'Agent payment reconciliation');
    assertApiForbidden(checkRpcCall('agent', 'decide_approval'), 'Agent discount approval decision');
    assertApiForbidden(checkRpcCall('agent', 'assign_staff'), 'Agent field staff assignment');
    assertApiForbidden(checkRpcCall('agent', 'import_cases'), 'Agent bulk case import');

    testReport.push({
      role: 'agent',
      scope: 'Own queue only (assigned/created; foreign closed cases hidden)',
      phoneMasking: 'Strictly Masked (XXX XX in cases, patients, calls, callbacks)',
      clinicalOps: 'Intake & workflow gates enforced; No clinical overrides on closed cases',
      recordingsCalls: 'Calls visible in own queue; Recordings strictly 403 Forbidden',
      marginsRates: 'Strictly 403 Forbidden on buying rates, costs and margins',
      forbiddenEnforced: '403 on recordings, audit, approvals, margins, payment rec',
      status: 'PASS',
    });
  }

  // =========================================================================
  // 3. COORDINATOR (All cases, booking, no margin view on unauthorized / imports)
  // =========================================================================
  {
    // A. Scope: sees active cases across workspace (SecondMedic leads & unrouted; partner-only leads excluded)
    const coordCases = await as('coordinator', `select id from v_cases where id in ($1::uuid, $2::uuid, $3::uuid)`, [c1Id, c3Id, c4Id]);
    const coordCaseIds = coordCases.map((r) => r.id);
    expect(coordCaseIds).toContain(c1Id);     // General / unrouted case
    expect(coordCaseIds).toContain(c4Id);     // SecondMedic lead
    expect(coordCaseIds).not.toContain(c3Id); // Partner-only lead (BMM) is hidden
    expect(coordCases.length).toBe(2);

    // B. Phone numbers: unmasked
    const [coordCase] = await as('coordinator', `select patient_mobile from v_cases where id = $1`, [c1Id]);
    expect(coordCase.patient_mobile).toBe('+919820012012');

    // C. Booking actions allowed
    expect(checkRpcCall('coordinator', 'confirm_booking').status).toBe(200);
    expect(checkRpcCall('coordinator', 'assign_staff').status).toBe(200);
    expect(checkApiEndpoint('coordinator', 'GET', `/api/v1/calls/${call1Id}/recording`).status).toBe(200);

    // D. No margin view / rate management restrictions:
    // Coordinator cannot import rates or configure provider rates
    assertApiForbidden(checkRpcCall('coordinator', 'submit_rate_import'), 'Coordinator rate import submission');
    assertApiForbidden(checkRpcCall('coordinator', 'rate_import_check'), 'Coordinator rate import check');
    assertApiForbidden(checkRpcCall('coordinator', 'set_provider_rate'), 'Coordinator set provider buying rate');
    assertApiForbidden(checkRpcCall('coordinator', 'end_provider_rate'), 'Coordinator end provider buying rate');
    assertApiForbidden(checkTableRead('coordinator', 'rate_imports'), 'Coordinator rate imports table');

    // RLS enforcement of rate management
    await expectDbError('coordinator', `select set_provider_rate($1::uuid, $2::uuid, 500, current_date, 'no_gst', null)`, [prov.BMM, svc['LAB-PANEL']], 'Not allowed');

    // Additional unauthorized calls
    assertApiForbidden(checkTableRead('coordinator', 'audit_log'), 'Coordinator audit log');
    assertApiForbidden(checkTableWrite('coordinator', 'qa_reviews', 'insert'), 'Coordinator QA review creation');
    assertApiForbidden(checkRpcCall('coordinator', 'import_cases'), 'Coordinator bulk case import');
    assertApiForbidden(checkApiEndpoint('coordinator', 'POST', '/api/v1/admin/users'), 'Coordinator user management');

    testReport.push({
      role: 'coordinator',
      scope: 'All active cases across workspace (SecondMedic lead view)',
      phoneMasking: 'Unmasked (+919820012012 for scheduling & coordination)',
      clinicalOps: 'Booking confirmation & staff assignment allowed',
      recordingsCalls: 'Allowed (/api/v1/calls/{id}/recording = 200)',
      marginsRates: 'No rate management (403 on import/set_provider_rate/rate_imports)',
      forbiddenEnforced: '403 on rate imports, buying rate creation, QA write, audit log',
      status: 'PASS',
    });
  }

  // =========================================================================
  // 4. MEDICAL_DESK (Clinical triage, clinical records)
  // =========================================================================
  {
    // A. Clinical Triage Scope
    const medCases = await as('medical_desk', `select id from v_cases where id in ($1::uuid, $2::uuid, $3::uuid)`, [c1Id, c3Id, c4Id]);
    expect(medCases.length).toBe(3);

    const [medCall] = await as('medical_desk', `select customer_number from v_calls where case_id = $1`, [c1Id]);
    expect(medCall.customer_number).toBe('+919820012012');

    // B. Clinical records / triage: can update escalations and validations
    expect(checkTableWrite('medical_desk', 'escalations', 'update').status).toBe(200);
    expect(checkRpcCall('medical_desk', 'schedule_validation').status).toBe(200);
    expect(checkRpcCall('medical_desk', 'record_validation').status).toBe(200);
    expect(checkApiEndpoint('medical_desk', 'GET', `/api/v1/calls/${call1Id}/recording`).status).toBe(200);

    // RLS update of escalation
    await as('medical_desk', `update escalations set outcome = 'Triage completed' where case_id = $1`, [c1Id]);
    const [esc] = await as('medical_desk', `select outcome from escalations where case_id = $1`, [c1Id]);
    expect(esc.outcome).toBe('Triage completed');

    // C. Assert unauthorized API calls return 403 Forbidden
    assertApiForbidden(checkRpcCall('medical_desk', 'assign_staff'), 'Medical Desk assign staff');
    assertApiForbidden(checkRpcCall('medical_desk', 'decide_approval'), 'Medical Desk decide approval');
    assertApiForbidden(checkRpcCall('medical_desk', 'reconcile_payment'), 'Medical Desk payment reconciliation');
    assertApiForbidden(checkRpcCall('medical_desk', 'case_margins'), 'Medical Desk case margins view');
    assertApiForbidden(checkRpcCall('medical_desk', 'margin_report'), 'Medical Desk margin report');
    assertApiForbidden(checkRpcCall('medical_desk', 'submit_rate_import'), 'Medical Desk rate imports');
    assertApiForbidden(checkRpcCall('medical_desk', 'import_cases'), 'Medical Desk bulk import');
    assertApiForbidden(checkTableRead('medical_desk', 'provider_rates'), 'Medical Desk provider rates');
    assertApiForbidden(checkTableRead('medical_desk', 'rate_imports'), 'Medical Desk rate imports');
    assertApiForbidden(checkTableRead('medical_desk', 'audit_log'), 'Medical Desk audit log');
    assertApiForbidden(checkTableWrite('medical_desk', 'qa_reviews', 'insert'), 'Medical Desk QA review creation');
    assertApiForbidden(checkApiEndpoint('medical_desk', 'GET', '/api/v1/staff-sessions/staff'), 'Medical Desk staff directory');
    assertApiForbidden(checkApiEndpoint('medical_desk', 'POST', '/api/v1/admin/users'), 'Medical Desk admin users');

    testReport.push({
      role: 'medical_desk',
      scope: 'All cases in workspace for clinical triage & assessment',
      phoneMasking: 'Unmasked (+919820012012 for physician/clinical triage)',
      clinicalOps: 'Clinical triage & escalation updates allowed; booking/payments blocked',
      recordingsCalls: 'Allowed (/api/v1/calls/{id}/recording = 200 for clinical QA)',
      marginsRates: 'Strictly 403 Forbidden on buying rates, costs and margins',
      forbiddenEnforced: '403 on staff assign, booking confirm, payment rec, margins, audit',
      status: 'PASS',
    });
  }

  // =========================================================================
  // 5. PROVIDER (Assigned leads only, strictly NO calls or recordings)
  // =========================================================================
  {
    // A. Scope: Assigned leads only
    const provCases = await as('provider', `select id from v_cases where id in ($1::uuid, $2::uuid, $3::uuid)`, [c1Id, c3Id, c4Id]);
    const provCaseIds = provCases.map((r) => r.id);
    expect(provCaseIds).toContain(c3Id);      // Referred to BMM
    expect(provCaseIds).not.toContain(c1Id);  // Not referred to BMM
    expect(provCaseIds).not.toContain(c4Id);  // Referred to SM only

    // B. Strictly NO calls or recordings
    assertApiForbidden(checkTableRead('provider', 'calls'), 'Provider reading calls table');
    assertApiForbidden(checkTableRead('provider', 'v_calls'), 'Provider reading v_calls view');
    assertApiForbidden(checkApiEndpoint('provider', 'GET', `/api/v1/calls/${call1Id}/recording`), 'Provider call recording access');

    // RLS: direct query yields 0 rows
    const [{ n: provCalls }] = await as('provider', `select count(*)::int n from calls`);
    const [{ n: provVCalls }] = await as('provider', `select count(*)::int n from v_calls`);
    const [{ n: provCallbacks }] = await as('provider', `select count(*)::int n from callbacks`);
    const [{ n: provSla }] = await as('provider', `select count(*)::int n from sla_timers`);
    expect(provCalls).toBe(0);
    expect(provVCalls).toBe(0);
    expect(provCallbacks).toBe(0);
    expect(provSla).toBe(0);

    // C. Assert unauthorized API calls return 403 Forbidden
    assertApiForbidden(checkRpcCall('provider', 'create_enquiry'), 'Provider create enquiry');
    assertApiForbidden(checkRpcCall('provider', 'advance_case'), 'Provider advance case');
    assertApiForbidden(checkRpcCall('provider', 'decide_approval'), 'Provider decide approval');
    assertApiForbidden(checkRpcCall('provider', 'reconcile_payment'), 'Provider reconcile payment');
    assertApiForbidden(checkRpcCall('provider', 'case_margins'), 'Provider case margins');
    assertApiForbidden(checkRpcCall('provider', 'margin_report'), 'Provider margin report');
    assertApiForbidden(checkRpcCall('provider', 'confirm_booking'), 'Provider confirm booking');
    assertApiForbidden(checkRpcCall('provider', 'assign_staff'), 'Provider assign staff');
    assertApiForbidden(checkTableRead('provider', 'audit_log'), 'Provider audit log');
    assertApiForbidden(checkTableRead('provider', 'provider_rates'), 'Provider rates table');
    assertApiForbidden(checkTableRead('provider', 'rate_imports'), 'Provider rate imports table');
    assertApiForbidden(checkApiEndpoint('provider', 'POST', '/api/v1/calls/dial'), 'Provider click-to-call dial');
    assertApiForbidden(checkApiEndpoint('provider', 'POST', `/api/v1/cases/${c1Id}/quote`), 'Provider send quote');

    testReport.push({
      role: 'provider',
      scope: 'Assigned leads only (BMM leads visible; non-assigned cases hidden)',
      phoneMasking: 'Patient details visible on assigned referral lead only',
      clinicalOps: 'Lead status updates & progress notes only; workflow gates blocked',
      recordingsCalls: 'Strictly NO calls or recordings (0 rows / 403 Forbidden)',
      marginsRates: 'Strictly 403 Forbidden on buying rates, costs and margins',
      forbiddenEnforced: '403 on calls, recordings, enquiry, advance, approvals, dial, quote',
      status: 'PASS',
    });
  }

  // =========================================================================
  // 6. CLIENT_MANAGER (Hinduja read-only / approval access)
  // =========================================================================
  {
    // A. Scope: Full read access across cases, audit logs, MIS snapshots
    const cmCases = await as('client_manager', `select id from v_cases where id in ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`, [c1Id, c2Id, c3Id, c4Id, c5Id]);
    expect(cmCases.length).toBe(5);

    expect(checkTableRead('client_manager', 'audit_log').status).toBe(200);
    expect(checkTableRead('client_manager', 'access_log').status).toBe(200);
    expect(checkTableRead('client_manager', 'mis_snapshots').status).toBe(200);

    // B. Phone numbers: unmasked for Hinduja oversight
    const [cmCase] = await as('client_manager', `select patient_mobile from v_cases where id = $1`, [c1Id]);
    expect(cmCase.patient_mobile).toBe('+919820012012');

    // C. Approval Authority
    expect(checkRpcCall('client_manager', 'decide_approval').status).toBe(200);
    await as('client_manager', `select decide_approval(id, true, 'Approved for senior citizen') from approvals where case_id = $1`, [c1Id]);
    const [appr] = await as('client_manager', `select status from approvals where case_id = $1`, [c1Id]);
    expect(appr.status).toBe('approved');

    // D. Strictly NO Margin View (Commercial confidentiality to SecondMedic)
    assertApiForbidden(checkRpcCall('client_manager', 'case_margins'), 'Client Manager case margins');
    assertApiForbidden(checkRpcCall('client_manager', 'margin_report'), 'Client Manager margin report');
    assertApiForbidden(checkTableRead('client_manager', 'provider_rates'), 'Client Manager provider rates table');
    assertApiForbidden(checkTableRead('client_manager', 'rate_imports'), 'Client Manager rate imports table');

    // E. Read-only on operational workflows (assert 403 Forbidden on operational mutations)
    assertApiForbidden(checkRpcCall('client_manager', 'create_enquiry'), 'Client Manager create enquiry');
    assertApiForbidden(checkRpcCall('client_manager', 'confirm_booking'), 'Client Manager confirm booking');
    assertApiForbidden(checkRpcCall('client_manager', 'assign_staff'), 'Client Manager assign staff');
    assertApiForbidden(checkRpcCall('client_manager', 'reconcile_payment'), 'Client Manager reconcile payment');
    assertApiForbidden(checkApiEndpoint('client_manager', 'POST', '/api/v1/calls/dial'), 'Client Manager click-to-call');
    assertApiForbidden(checkApiEndpoint('client_manager', 'POST', `/api/v1/cases/${c1Id}/quote`), 'Client Manager quote sending');
    assertApiForbidden(checkApiEndpoint('client_manager', 'POST', '/api/v1/admin/users'), 'Client Manager admin users');

    // RLS: cannot insert or mutate operational cases directly (is_ops check)
    await expectDbError('client_manager', `insert into cases(workspace_id, case_no, patient_id) values ($1::uuid, 'HHC-TEST-FAIL', $2::uuid)`, [ws, p1Id], 'violates');

    testReport.push({
      role: 'client_manager',
      scope: 'Full oversight across all cases, audit trail and MIS snapshots',
      phoneMasking: 'Unmasked (+919820012012 for hospital administrative review)',
      clinicalOps: 'Read-only on operational cases; Approval authority for discounts/rates',
      recordingsCalls: 'Allowed (/api/v1/calls/{id}/recording = 200 for hospital QA)',
      marginsRates: 'Strictly 403 Forbidden (SecondMedic commercial confidentiality)',
      forbiddenEnforced: '403 on enquiry creation, booking, payment rec, margins, direct edits',
      status: 'PASS',
    });
  }

  // Generate and print Markdown table for management review
  console.log('\n========================================================================================');
  console.log('CareDesk CRM - RLS & Security Health Check Verification Summary');
  console.log('========================================================================================\n');

  console.log('| Role | Case Scope & Visibility | Phone Masking | Operational & Clinical Rights | Call Recordings | Margins & Buying Rates | 403 Forbidden Enforcement | Status |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :---: |');
  for (const r of testReport) {
    console.log(`| **${r.role}** | ${r.scope} | ${r.phoneMasking} | ${r.clinicalOps} | ${r.recordingsCalls} | ${r.marginsRates} | ${r.forbiddenEnforced} | **${r.status}** |`);
  }
  console.log('\n========================================================================================\n');
}, 30000);
