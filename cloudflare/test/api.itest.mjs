import { providerFulfilmentApiTests } from './provider-fulfilment.itest.mjs';
// API checks run by the rehearsal (pipeline step 3c) against the REAL Worker on a database built from the migrations.
// Covers: login required (missing / forged / expired / wrong-audience tokens), role rules per endpoint, Row Level
// Security through the API, the case workflow, MyOperator webhooks + click-to-call, and live updates.
import { staffSessionTests } from './staff-session.itest.mjs';
import { feedbackApiTests } from './feedback.itest.mjs';
import { rateApiTests } from './rates.itest.mjs';
const WS = 'HHC';
const U = {
  agent: 'b0000000-0000-4000-8000-000000000001', agent2: 'b0000000-0000-4000-8000-000000000002',
  coord: 'b0000000-0000-4000-8000-000000000003', sup: 'b0000000-0000-4000-8000-000000000004',
  field: 'b0000000-0000-4000-8000-000000000005', client: 'b0000000-0000-4000-8000-000000000006',
  clinical: 'b0000000-0000-4000-8000-000000000007', admin: 'b0000000-0000-4000-8000-000000000008',
  medical: 'b0000000-0000-4000-8000-000000000009', nobody: 'b0000000-0000-4000-8000-000000000010',
  bmm: 'b0000000-0000-4000-8000-000000000011', administrator: 'b0000000-0000-4000-8000-000000000012',
};
const ROLE = { agent: 'agent', agent2: 'agent', coord: 'coordinator', sup: 'supervisor', field: 'field_staff', client: 'client_manager',
  clinical: 'client_clinical', admin: 'admin', medical: 'medical_desk', bmm: 'provider', administrator: 'administrator' };

export async function runApiTests({ base, token, sql, wrongKey, obdCalls, geminiCalls = [], webhookKey }) {
  const failed = [];
  let total = 0;
  const check = (cond, name, extra = '') => { total++; if (!cond) failed.push(name + (extra ? ' -> ' + extra : '')); };
  const tok = {};
  for (const k of Object.keys(U)) tok[k] = await token(U[k], `${k}@rehearsal.test`);

  const call = async (who, method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + (tok[who] || who) } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, body: json };
  };
  const batch = (who, ops) => call(who, 'POST', '/api/v1/batch', { ops });
  const sel = (table, extra = {}) => ({ kind: 'select', spec: { table, op: 'select', cols: '*', filters: [], ...extra } });
  const rpc = (who, fn, args = {}) => call(who, 'POST', `/api/v1/rpc/${fn}`, args);
  // Issue 2: an agent records the outcome of each connected call before the next one (click-to-call refuses until then)
  const wrapAll = async (who) => { for (let i = 0; i < 20; i++) { const w = (await rpc(who, 'my_pending_wrapup', {})).body?.data; if (!w) return; await rpc(who, 'wrap_up_call', { p_call: w.id, p: { disposition: 'info_only' } }); } };
  const data = (who, table, spec) => call(who, 'POST', `/api/v1/data/${table}`, { table, ...spec });
  const hook = (ev, key = webhookKey) => fetch(base + '/webhooks/myoperator', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-key': key }, body: JSON.stringify(ev) });
  const one = async (q, ...p) => (await sql.unsafe(q, p))[0];

  // ---- people
  const [{ id: ws }] = await sql`select id::text from workspaces where code = ${WS}`;
  const [{ id: bmmProvider }] = await sql`select id::text from providers where workspace_id = ${ws} and code = 'BMM'`;
  for (const [k, id] of Object.entries(U)) {
    if (k === 'nobody') continue;
    await sql`insert into profiles (id, workspace_id, full_name, email, role, agent_code, myoperator_user_id, provider_id)
      values (${id}, ${ws}, ${k.toUpperCase() + ' user'}, ${k + '@rehearsal.test'}, ${ROLE[k]}, ${k.startsWith('agent') ? 'A-0' + (k === 'agent' ? 7 : 8) : null},
        ${k === 'agent' ? 'mo-77' : null}, ${k === 'bmm' ? bmmProvider : null}) on conflict (id) do nothing`;
  }

  // ---- 1. login required
  check((await call(null, 'POST', '/api/v1/batch', { ops: [] })).status === 401, 'no token -> 401');
  check((await call(null, 'GET', '/api/v1/nothing-here')).status === 401, 'unknown path without token -> 401');
  check((await call(await token(U.agent, 'x', { key: wrongKey }), 'POST', '/api/v1/batch', { ops: [] })).status === 401, 'forged token -> 401');
  check((await call(await token(U.agent, 'x', { exp: '-1h' }), 'POST', '/api/v1/batch', { ops: [] })).status === 401, 'expired token -> 401');
  check((await call(await token(U.agent, 'x', { aud: 'anon' }), 'POST', '/api/v1/batch', { ops: [] })).status === 401, 'wrong audience -> 401');
  check((await call('agent', 'GET', '/api/v1/nothing-here')).status === 404, 'unknown path with token -> 404');
  check((await call('agent', 'GET', '/api/v1/local/users')).status === 404, 'local user list closed when login is on');
  check((await call('nobody', 'GET', '/api/v1/me')).status === 403, 'login without a CareDesk profile -> 403');
  check((await call(null, 'GET', '/api/v1/health')).status === 200, 'health is public');

  // ---- 2. who am I
  for (const k of ['agent', 'client', 'admin', 'field']) {
    const r = await call(k, 'GET', '/api/v1/me');
    check(r.status === 200 && r.body.role === ROLE[k], `/me returns role for ${k}`, JSON.stringify(r.body));
  }

  // ---- 3. role rules on endpoints
  check((await rpc('client', 'create_enquiry', { p: {} })).status === 403, 'Hinduja management cannot create enquiries');
  check((await rpc('agent', 'decide_approval', { p_id: ws, p_approve: true, p_note: 'x' })).status === 403, 'agent cannot decide approvals');
  check((await rpc('agent', 'sla_scan')).status === 403, 'system-only function not callable');
  check((await rpc('agent', 'save_service_knowledge', { p: { category: 'lab', summary: 'x' } })).status === 403, 'agent cannot edit product knowledge');
  check((await rpc('agent', 'import_service_knowledge', { p_rows: [] })).status === 403, 'agent cannot import product knowledge');
  check((await batch('agent', [sel('service_knowledge')])).status === 200, 'agent reads product knowledge');
  check((await rpc('sup', 'save_service_knowledge', { p: { category: 'lab', faq: 'Reports on WhatsApp.' } })).status === 200, 'supervisor edits product knowledge');
  check((await data('agent', 'workspaces', { op: 'update', patch: { brand_name: 'x' }, filters: [{ col: 'id', op: 'eq', val: ws }] })).status === 403, 'agent cannot change workspace settings');
  check((await batch('agent', [sel('audit_log')])).status === 403, 'agent cannot read the audit log');
  check((await batch('sup', [sel('webhook_events')])).status === 403, 'webhook events not readable as a table');
  check((await call('agent', 'GET', '/api/v1/admin/integrations')).status === 403, 'agent cannot see integration settings');
  check((await call('sup', 'GET', '/api/v1/admin/integrations')).status === 200, 'supervisor sees integration settings');
  check((await call('agent', 'POST', '/api/v1/admin/email/test', {})).status === 403 && (await call('agent', 'GET', '/api/v1/admin/email')).status === 403, 'agent cannot test or see outbound e-mail');
  check((await call('bmm', 'POST', '/api/v1/admin/email/test', {})).status === 403, 'provider cannot send a test e-mail');
  const mailSt = await call('sup', 'GET', '/api/v1/admin/email');
  check(mailSt.status === 200 && mailSt.body?.port === 465 && mailSt.body?.host === 'smtp.gmail.com' && !JSON.stringify(mailSt.body).includes('PASSWORD='), 'supervisor sees e-mail readiness (names only, no secret values)', JSON.stringify(mailSt.body));
  const mailTest = await call('sup', 'POST', '/api/v1/admin/email/test', {});
  check(mailTest.status === 200 && mailTest.body?.ok === false && /not configured/.test(mailTest.body?.message), 'e-mail test without SMTP_PASSWORD fails safely, nothing marked sent', JSON.stringify(mailTest.body));
  check((await call('sup', 'POST', '/api/v1/admin/users', { email: 'x@y.z', password: 'longenough1', full_name: 'X', role: 'agent' })).status === 403, 'only admin creates users');

  // ---- 4. names are checked, values are parameters
  check((await batch('agent', [sel('cases; drop table cases')])).status === 403, 'odd table name refused');
  const inj = await batch('sup', [sel('v_cases', { cols: 'id, (select 1)' })]);
  check(inj.status === 200 && inj.body.results[0].error, 'odd column name refused', JSON.stringify(inj.body));
  const injVal = await batch('sup', [sel('v_cases', { filters: [{ col: 'case_no', op: 'eq', val: "x' or '1'='1" }] })]);
  check(injVal.status === 200 && Array.isArray(injVal.body.results[0].data) && injVal.body.results[0].data.length === 0, 'values are parameters, not SQL');
  check((await data('agent', 'escalations', { op: 'update', patch: { status: 'resolved' } })).status === 403, 'agent update on escalations refused');
  const noFilter = await data('sup', 'escalations', { op: 'update', patch: { status: 'resolved' } });
  check(noFilter.status === 400, 'update without a filter refused', JSON.stringify(noFilter));

  // ---- arrays arrive as lists (zones.pincodes text[])
  const zn = await batch('sup', [sel('zones', { cols: 'name,pincodes', limit: 1 })]);
  check(Array.isArray(zn.body?.results?.[0]?.data?.[0]?.pincodes), 'array columns arrive as lists', JSON.stringify(zn.body?.results?.[0]?.data?.[0]));

  // ---- 5. case workflow through the API
  const svc = Object.fromEntries((await sql`select code, id::text from services`).map((r) => [r.code, r.id]));
  const e = await rpc('agent', 'create_enquiry', { p: {
    patient: { full_name: 'R. Sharma', age: 72, gender: 'M', mobile: '98200 12012', address: '12 Link Rd', pincode: '400058', locality: 'Andheri West' },
    caller_name: 'Amit Sharma', caller_relation: 'son', services_requested: 'Blood tests + ECG', consent: true, service_ids: [svc['LAB-PANEL'], svc['ECG-12']],
  } });
  check(e.status === 200 && /^HHC-\d{6}-\d{5}$/.test(e.body?.data?.case_no || ''), 'agent creates enquiry with case ID', JSON.stringify(e.body));
  const cid = e.body?.data?.case_id;
  const v = await batch('agent', [sel('v_cases', { cols: 'case_no,patient_mobile,subtotal', filters: [{ col: 'id', op: 'eq', val: cid }], mode: 'single' }),
    sel('v_cases', { count: 'exact', head: true }), { kind: 'rpc', fn: 'case_gates', args: { p_case: cid } }]);
  const vc = v.body?.results?.[0]?.data;
  check(vc && String(vc.patient_mobile).includes('XXX'), 'agent sees a masked mobile number', JSON.stringify(vc));
  check(vc && Number(vc.subtotal) === 3700, 'subtotal from the locked rate card', JSON.stringify(vc));
  check(v.body?.results?.[1]?.count >= 1 && v.body.results[1].data == null, 'count-only read');
  check(v.body?.results?.[2]?.data?.stage === 'enquiry', 'read-only action rides in a batch');
  const vs = await batch('sup', [sel('v_cases', { cols: 'patient_mobile', filters: [{ col: 'id', op: 'eq', val: cid }], mode: 'single' })]);
  check(vs.body?.results?.[0]?.data?.patient_mobile === '+919820012012', 'supervisor sees the full number');
  const ins = await data('agent', 'case_items', { op: 'insert', rows: [{ case_id: cid, service_id: svc['VISIT-STD'], unit_price: 1 }], returning: true });
  check(ins.status === 200 && Number(ins.body?.data?.[0]?.unit_price) === 150, 'price typed by the agent is replaced by the rate card', JSON.stringify(ins.body));
  check((await rpc('agent', 'advance_case', { p_case: cid, p_note: null })).status === 200, 'enquiry -> pricing');
  const d = await rpc('agent', 'set_discount', { p_case: cid, p_pct: 15, p_reason: 'Senior citizen' });
  check(d.body?.data?.status === 'pending_approval', '15% above the 10% band needs approval', JSON.stringify(d.body));
  const [tpl] = await sql`select id::text from templates where code = 'T-03'`;
  const blocked = await call('agent', 'POST', `/api/v1/cases/${cid}/quote`, { template_id: tpl.id });
  check(blocked.status === 400 && /approval/i.test(blocked.body?.message || ''), 'quote blocked until approved', JSON.stringify(blocked.body));
  const ap = await batch('client', [sel('approvals', { cols: 'id,status', filters: [{ col: 'case_id', op: 'eq', val: cid }, { col: 'status', op: 'eq', val: 'pending' }] })]);
  const apId = ap.body?.results?.[0]?.data?.[0]?.id;
  check(!!apId, 'Hinduja management sees the pending approval');
  check((await rpc('client', 'decide_approval', { p_id: apId, p_approve: true, p_note: 'OK for senior' })).status === 200, 'Hinduja management approves the discount');
  const qt = await call('agent', 'POST', `/api/v1/cases/${cid}/quote`, { template_id: tpl.id });
  check(qt.status === 200 && String(qt.body?.text || '').includes('3272.50'), 'quote sent on approved terms', JSON.stringify(qt.body).slice(0, 200));
  const esc = await data('agent', 'escalations', { op: 'insert', rows: [{ workspace_id: ws, case_id: cid, type: 'delay', level: 1, trigger_text: 'Caller asked for a supervisor', raised_by: U.agent }], returning: true });
  check(esc.status === 200 && esc.body?.data?.[0]?.id, 'agent raises an escalation', JSON.stringify(esc.body));
  const adm = await batch('admin', [sel('v_patients', { cols: 'id' })]);
  check(adm.status === 200 && adm.body.results[0].data.length === 0, 'platform admin sees no patient data');
  const fld = await batch('field', [sel('v_cases', { cols: 'id' })]);
  check(fld.status === 200 && fld.body.results[0].data.length === 0, 'field staff see only cases assigned to them');
  const bad = await rpc('agent', 'advance_case', { p_case: cid, p_note: null });
  check(bad.status === 200, 'pricing -> booking after the quote');
  const gate = await rpc('agent', 'advance_case', { p_case: cid, p_note: null });
  check(gate.status === 400 && /Stage gate/.test(gate.body?.message || ''), 'stage gate message reaches the screen', JSON.stringify(gate.body));

  // ---- 6. MyOperator webhooks
  check((await hook({ event_type: 'call.initiated' }, 'wrong')).status === 401, 'webhook with a wrong key -> 401');
  const t0 = Math.floor(Date.now() / 1000);
  const b1 = { session_id: 'sess-in-1', direction: 'inbound', customer_identifier: '+919820012012', system_identifier: '+918049368621' };
  await hook({ ...b1, event_id: 'e1', event_type: 'call.initiated', timestamp: t0, payload: { did_number: '+918049368621' } });
  let c1 = await one(`select * from calls where session_id = 'sess-in-1'`);
  check(c1?.status === 'ringing' && c1?.case_id === cid, 'incoming call matched to the patient and open case', JSON.stringify(c1 && { s: c1.status, c: c1.case_id }));
  await hook({ ...b1, event_id: 'e2', event_type: 'call.answered', timestamp: t0 + 14, payload: { legs: [{ answered_at: t0 + 14, ring_duration: 14, agent: { uuid: 'mo-77' } }] } });
  await hook({ ...b1, event_id: 'e3', event_type: 'call.end', timestamp: t0 + 285, payload: { status: 'answered', recording_filename: 'rec-1.mp3', legs: [{ talk_duration: 271, ring_duration: 14 }] } });
  await hook({ ...b1, event_id: 'e3', event_type: 'call.end', payload: {} });
  c1 = await one(`select * from calls where session_id = 'sess-in-1'`);
  check(c1.status === 'completed' && c1.talk_seconds === 271 && c1.agent_id === U.agent && c1.ring_seconds === 14, 'answered call: agent, ring and talk time, recording', JSON.stringify(c1));
  const tl = await one(`select count(*)::int n, max(evidence) ev from interactions where call_id = $1`, c1.id);
  check(tl.n === 1 && tl.ev === 'Recording 4:31', 'one timeline entry (duplicate delivery ignored)', JSON.stringify(tl));
  const b2 = { session_id: 'sess-miss-1', direction: 'inbound', customer_identifier: '9930011223', system_identifier: '+918049368621' };
  await hook({ ...b2, event_id: 'm1', event_type: 'call.initiated', timestamp: t0 });
  await hook({ ...b2, event_id: 'm2', event_type: 'call.end', timestamp: t0 + 30, payload: { status: 'missed', legs: [{ ring_duration: 30 }] } });
  const cb = await one(`select id::text, status, round(extract(epoch from due_at - now()) / 60) m from callbacks where number = '+919930011223'`);
  check(cb?.status === 'pending' && Number(cb.m) >= 9 && Number(cb.m) <= 10, 'missed call queued for callback in 10 min', JSON.stringify(cb));
  const line = await batch('sup', [sel('v_calls', { cols: 'line_label', filters: [{ col: 'session_id', op: 'eq', val: 'sess-miss-1' }], mode: 'single' })]);
  check(line.body?.results?.[0]?.data?.line_label === 'Hinduja helpline', 'call tagged with its line (Hinduja helpline)', JSON.stringify(line.body));

  // Fallback ring_seconds calculation when MyOperator payload omits ring_duration or sends 0
  const bOmit = { session_id: 'sess-omit-ring', direction: 'inbound', customer_identifier: '+919820012012', system_identifier: '+918049368621' };
  await hook({ ...bOmit, event_id: 'or1', event_type: 'call.initiated', timestamp: t0 });
  await hook({ ...bOmit, event_id: 'or2', event_type: 'call.answered', timestamp: t0 + 18, payload: { legs: [{ answered_at: t0 + 18, ring_duration: 0, agent: { uuid: 'mo-77' } }] } });
  await hook({ ...bOmit, event_id: 'or3', event_type: 'call.end', timestamp: t0 + 60, payload: { status: 'answered', legs: [{ talk_duration: 42 }] } });
  const cOmit = await one(`select * from calls where session_id = 'sess-omit-ring'`);
  check(cOmit.status === 'completed' && cOmit.ring_seconds === 18 && cOmit.talk_seconds === 42,
    'answered call with 0/missing ring_duration: fallback calculates ring_seconds as answered_at - started_at', JSON.stringify(cOmit));

  const bMissOmit = { session_id: 'sess-miss-omit', direction: 'inbound', customer_identifier: '9930011224', system_identifier: '+918049368621' };
  await hook({ ...bMissOmit, event_id: 'mo1', event_type: 'call.initiated', timestamp: t0 });
  await hook({ ...bMissOmit, event_id: 'mo2', event_type: 'call.end', timestamp: t0 + 24, payload: { status: 'missed', legs: [] } });
  const cMissOmit = await one(`select * from calls where session_id = 'sess-miss-omit'`);
  check(cMissOmit.status === 'missed' && cMissOmit.ring_seconds === 24,
    'missed call with missing ring_duration: fallback calculates ring_seconds as ended_at - started_at', JSON.stringify(cMissOmit));

  const bAbandOmit = { session_id: 'sess-aband-omit', direction: 'inbound', customer_identifier: '9930011225', system_identifier: '+918049368621' };
  await hook({ ...bAbandOmit, event_id: 'ab1', event_type: 'call.initiated', timestamp: t0 });
  await hook({ ...bAbandOmit, event_id: 'ab2', event_type: 'call.end', timestamp: t0 + 15, payload: { status: 'hangup_in_ivr', category: 'abandoned', legs: [] } });
  const cAbandOmit = await one(`select * from calls where session_id = 'sess-aband-omit'`);
  check(cAbandOmit.status === 'abandoned' && cAbandOmit.ring_seconds === 15,
    'abandoned call with missing ring_duration: fallback calculates ring_seconds as ended_at - started_at', JSON.stringify(cAbandOmit));
  // Issue 1: a withheld number is recorded with a visible reason; a stale pending callback no longer swallows a missed call
  const bHidden = { session_id: 'sess-miss-hidden', direction: 'inbound', customer_identifier: '', system_identifier: '+918049368621' };
  await hook({ ...bHidden, event_id: 'mh1', event_type: 'call.initiated', timestamp: t0 });
  await hook({ ...bHidden, event_id: 'mh2', event_type: 'call.end', timestamp: t0 + 20, payload: { status: 'missed', legs: [] } });
  const cHidden = await one(`select status, callback_note, (select count(*)::int from callbacks b where b.call_id = calls.id) n from calls where session_id = 'sess-miss-hidden'`);
  check(cHidden?.status === 'missed' && cHidden.n === 0 && cHidden.callback_note === 'No caller number: cannot call back',
    'missed call without a caller number: no callback, visible reason', JSON.stringify(cHidden));
  // a callback queued before the auto-dialer existed: never scheduled, deadline long gone, still 'pending'
  await sql`insert into callbacks (workspace_id, number, due_at, created_at) values (${ws}, '+919930055599', now() - interval '6 days', now() - interval '6 days')`;
  await sql`update callbacks set next_attempt_at = null, due_at = now() - interval '6 days' where number = '+919930055599'`;
  const bStale = { session_id: 'sess-miss-stale', direction: 'inbound', customer_identifier: '+919930055599', system_identifier: '+918049368621' };
  await hook({ ...bStale, event_id: 'ms1', event_type: 'call.initiated', timestamp: t0 });
  await hook({ ...bStale, event_id: 'ms2', event_type: 'call.end', timestamp: t0 + 20, payload: { status: 'missed', legs: [] } });
  await hook({ ...bStale, event_id: 'ms3', event_type: 'call.end', timestamp: t0 + 21, payload: { status: 'missed', legs: [] } });
  const cStale = await one(`select (select count(*)::int from callbacks b where b.call_id = calls.id) n from calls where session_id = 'sess-miss-stale'`);
  check(cStale?.n === 1, 'missed call from a number with a stale pending callback gets its own callback, once', JSON.stringify(cStale));
  await sql`update callbacks set status = 'done' where number = '+919930055599'`;
  // Issue 2: a connected call needs its outcome before the agent's next call
  const firstWrap = (await rpc('agent', 'my_pending_wrapup', {})).body?.data;
  check(firstWrap?.id && !('customer_number' in firstWrap), 'agent sees the pending wrap-up (no phone number)', JSON.stringify(firstWrap));
  const badWrap = await rpc('agent', 'wrap_up_call', { p_call: firstWrap?.id, p: { disposition: 'requirement_captured' } });
  check(badWrap.status === 400 && /outcome from the list/.test(badWrap.body?.message || ''), 'outcome must come from the fixed list', JSON.stringify(badWrap.body));
  await wrapAll('agent');
  const wrapped = await one(`select disposition, disposition_by::text b from calls where id = $1`, firstWrap?.id ?? null);
  check(wrapped?.disposition === 'info_only' && wrapped.b === U.agent, 'wrap_up_call saves the outcome to calls.disposition', JSON.stringify(wrapped));
  check((await call('agent', 'POST', '/api/v1/calls/dial', { number: '9999999999' })).status === 400, 'agent cannot dial a typed number');
  const beforeMissing = await one(`select count(*)::int n from calls`);
  check((await rpc('agent','autodial_settings',{})).body?.data?.calling_configured === false,
    'queue settings report missing calling configuration without exposing credentials');
  check((await batch('agent',[{kind:'rpc',fn:'autodial_settings',args:{}}])).body?.results?.[0]?.data?.calling_configured === false,
    'batched screen reads also report calling readiness');
  const missingDial = await call('agent', 'POST', '/api/v1/calls/dial', { callback_id: cb.id });
  check(missingDial.status === 503 && /Public IVR ID/.test(missingDial.body?.message || '')
    && (await one(`select count(*)::int n from calls`)).n === beforeMissing.n
    && (await one(`select status from callbacks where id = $1`, cb.id)).status === 'pending' && obdCalls.length === 0,
    'missing calling configuration leaves callback pending and creates no call', JSON.stringify(missingDial.body));
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'ivr-1' } });
  const unlinkedDial = await call('sup', 'POST', '/api/v1/calls/dial', { case_id: cid });
  check(unlinkedDial.status === 409 && obdCalls.length === 0 && (await one(`select count(*)::int n from calls`)).n === beforeMissing.n,
    'unlinked agent cannot start a call', JSON.stringify(unlinkedDial.body));
  check((await call('agent', 'POST', '/api/v1/calls/dial', { case_id: cid, callback_id: cb.id })).status === 400,
    'ambiguous call target rejected');
  const concurrentDials = await Promise.all([1,2].map(() => call('agent', 'POST', '/api/v1/calls/dial', { callback_id: cb.id })));
  const dial = concurrentDials.find(r => r.status === 200) || concurrentDials[0];
  check(concurrentDials.filter(r => r.status === 200).length === 1 && concurrentDials.some(r => r.status === 409),
    'concurrent manual claims create exactly one callback attempt');
  check(dial.status === 200 && dial.body?.ok && dial.body.mode === 'api' && !dial.body.number && !dial.body.provider,
    'CRM click-to-call accepted without exposing the number or provider response', JSON.stringify(dial.body));
  const obd = obdCalls[obdCalls.length - 1];
  check(obd?.body?.user_id === 'mo-77' && obd?.body?.type === '1' && obd?.body?.number === '+919930011223'
    && obd?.headers['x-api-key'] === 'obd-key' && obd?.headers['secret-key'] === 'st', 'OBD request: peer-to-peer agent id, number, keys', JSON.stringify(obd?.body));
  const b3 = { session_id: 'sess-out-1', direction: 'outbound', customer_identifier: '+919930011223' };
  await hook({ ...b3, event_id: 'o1', event_type: 'call.initiated', payload: { client_ref_id: obd?.body?.reference_id } });
  await hook({ ...b3, event_id: 'agent-only', event_type: 'call.answered', payload: { legs: [{ type: 'agent', dial_status: 'ANSWER', answered_at: t0 + 3 }] } });
  check((await one(`select status from callbacks where id=$1`, cb.id)).status === 'in_progress', 'agent answer alone does not mark the customer reached');
  const busyManual = await call('agent', 'POST', '/api/v1/calls/dial', { case_id: cid });
  check(busyManual.status === 409, 'manual calling cannot reserve an agent already on a callback');
  await hook({myoperator:{_ai:'unrelated-same-number',_cl:b3.customer_identifier,_ev:2,_su:1,_st:t0,_et:t0+120,_dr:120}});
  check((await one(`select status from callbacks where id=$1`,cb.id)).status === 'in_progress',
    'uncorrelated same-number call log cannot adopt and reach a reserved callback');
  await hook({ ...b3, event_id: 'o2', event_type: 'call.answered', timestamp: t0 + 5, payload: { legs: [{ type: 'agent', dial_status: 'ANSWER', answered_at: t0 + 2 }, { type: 'customer', phone_number: b3.customer_identifier, dial_status: 'ANSWER', answered_at: t0 + 5, ring_duration: 5 }] } });
  const live = await one(`select cb.status, cb.reached_at, k.callback_id::text cid from callbacks cb, calls k where cb.id = $1 and k.id = $2`, cb.id, dial.body?.call_id);
  check(Date.parse(live.reached_at) === (t0 + 5) * 1000, 'SLA reach time uses the customer answer, even when the earlier agent leg comes first');
  check(live?.status === 'reached' && live.cid === cb.id, 'patient connected -> callback reached at once, before the call ends (dashboard pending drops live)', JSON.stringify(live));
  await hook({ ...b3, event_id: 'o3', event_type: 'call.end', timestamp: t0 + 100, payload: { legs: [{ talk_duration: 95 }] } });
  const out = await one(`select session_id, status from calls where id = $1`, dial.body?.call_id);
  check(out?.session_id === 'sess-out-1' && out?.status === 'completed', 'webhook matched to the CRM call by reference', JSON.stringify(out));
  check((await one(`select status from callbacks where id = $1`, cb.id))?.status === 'reached', '95 s call-back keeps the item reached until the agent records an outcome');
  const closeCb = await rpc('agent', 'callback_close', { p_id: cb.id, p_outcome: 'resolved', p_note: 'Shared the report timeline' });
  check(closeCb.status === 200 && (await one(`select status, outcome from callbacks where id = $1`, cb.id))?.outcome === 'resolved',
    'agent closes the callback with an outcome', JSON.stringify(closeCb.body));
  const noAnswerCb = await one(`insert into callbacks(workspace_id,number,due_at) values ($1,'+919800001234',now()+interval '10 minutes') returning id`,ws);
  const wrapGate = await call('agent', 'POST', '/api/v1/calls/dial', { case_id: cid });
  check(wrapGate.status === 409 && /outcome/.test(wrapGate.body?.message || '') && obdCalls.at(-1)?.body?.number !== undefined,
    'click-to-call waits for the outcome of the last connected call', JSON.stringify(wrapGate.body));
  await wrapAll('agent');
  const noAnswerDial = await call('agent','POST','/api/v1/calls/dial',{callback_id:noAnswerCb.id});
  const noAnswerEvent = {session_id:'customer-no-answer',direction:'outbound',customer_identifier:'+919800001234'};
  await hook({...noAnswerEvent,event_id:'na1',event_type:'call.initiated',payload:{client_ref_id:obdCalls.at(-1).body.reference_id}});
  await hook({...noAnswerEvent,event_id:'na2',event_type:'call.answered',payload:{legs:[{type:'agent',dial_status:'ANSWER',answered_at:t0}]}});
  await hook({...noAnswerEvent,event_id:'na3',event_type:'call.end',payload:{legs:[{type:'agent',dial_status:'ANSWER',talk_duration:25},{type:'customer',dial_status:'NOANSWER',talk_duration:0}]}});
  const noAnswerState = await one(`select status,notes,reached_at from callbacks where id=$1`,noAnswerCb.id);
  check(noAnswerDial.status===200 && noAnswerState.status==='pending' && !noAnswerState.reached_at && /Customer did not connect/.test(noAnswerState.notes),
    'agent answers but customer NOANSWER never marks Reached and records the actual failure');
  check((await rpc('client', 'callback_close', { p_id: cb.id, p_outcome: 'resolved' })).status === 403,
    'Hinduja manager cannot close callbacks');
  await hook({ event_id: 'w1', event_type: 'message.received', customer_identifier: '+919811122233', system_identifier: '+918049368621',
    payload: { id: 'wamid_in_1', conversation: { customer_name: 'Meera Joshi' }, data: { context: { body: 'Need ECG at home tomorrow in Khar' } } } });
  const wa = await one(`select c.id::text as case_id, c.patient_id::text as patient_id, c.source_channel, c.case_no from cases c join patients p on p.id = c.patient_id where p.mobile = '+919811122233'`);
  check(wa?.source_channel === 'whatsapp', 'WhatsApp message opens a case', JSON.stringify(wa));
  const waListAgent = await batch('agent', [sel('v_whatsapp_chats', { filters: [{ col: 'patient_id', op: 'eq', val: wa.patient_id }], mode: 'single' })]);
  const waRowAgent = waListAgent.body?.results?.[0]?.data;
  check(waListAgent.status === 200 && waRowAgent?.needs_reply === true && waRowAgent?.window_open === true && waRowAgent?.patient_mobile === '+9198XXX XX233',
    'v_whatsapp_chats shows inbound chat awaiting reply with masked mobile for agent', JSON.stringify(waRowAgent));
  const waReply = await call('agent', 'POST', '/api/v1/whatsapp/send', { case_id: wa.case_id, text: 'Namaste Meera ji, please share your full address in Khar West.' });
  check(waReply.status === 200 && waReply.body?.id && waReply.body?.text?.includes('Khar West'), 'agent sends a free-text WhatsApp reply', JSON.stringify(waReply.body));
  const ackTimer = await one(`select status from sla_timers where case_id = $1 and policy_key = 'ack'`, wa.case_id);
  check(ackTimer?.status === 'met', 'outbound WhatsApp reply meets the 5-minute acknowledgement SLA', JSON.stringify(ackTimer));
  const waAfterReply = await batch('sup', [sel('v_whatsapp_chats', { filters: [{ col: 'patient_id', op: 'eq', val: wa.patient_id }], mode: 'single' })]);
  check(waAfterReply.body?.results?.[0]?.data?.needs_reply === false && waAfterReply.body?.results?.[0]?.data?.patient_mobile === '+919811122233',
    'v_whatsapp_chats flips needs_reply to false after reply and shows full mobile to supervisor', JSON.stringify(waAfterReply.body?.results?.[0]?.data));

  // ---- 6a2. Email page: POST /api/v1/email/send + v_email_threads (no SMTP password here: logged, never mailed)
  const mail = (who, b) => call(who, 'POST', '/api/v1/email/send', b);
  check((await mail('bmm', { case_id: wa.case_id, subject: 'x', text: 'x' })).status === 403, 'provider cannot send patient e-mail');
  check((await mail('field', { case_id: wa.case_id, subject: 'x', text: 'x' })).status === 403, 'field staff cannot send patient e-mail');
  if (!(await one(`select email from patients where id = $1`, wa.patient_id))?.email) {
    check((await mail('agent', { case_id: wa.case_id, subject: 'Visit', text: 'x' })).status === 400, 'e-mail to a patient with no address on file is refused');
  }
  check((await mail('agent', { case_id: wa.case_id, to: 'not-an-address', subject: 'x', text: 'x' })).status === 400, 'invalid e-mail address refused');
  check((await mail('agent', { case_id: wa.case_id, to: 'meera.test@example.com', subject: 'Line\nbreak', text: 'x' })).status === 400, 'subject with a line break refused');
  check((await mail('agent', { case_id: wa.case_id, to: 'meera.test@example.com', subject: 'Visit' })).status === 400, 'e-mail without a message refused');
  const em = await mail('agent', { case_id: wa.case_id, to: 'meera.test@example.com', subject: 'Your home visit', text: 'Namaste, please confirm the address.' });
  check(em.status === 200 && em.body?.delivery?.status === 'logged' && em.body?.subject === `Your home visit [${wa.case_no}]` && em.body?.to === 'meera.test@example.com',
    'agent e-mails a patient: logged without SMTP, case number in the subject', JSON.stringify(em.body));
  const emRow = await one(`select channel, direction, summary, body, meta->>'delivery_status' as st from interactions where id = $1`, em.body?.id);
  check(emRow?.channel === 'email' && emRow?.direction === 'outbound' && emRow?.st === 'logged' && emRow?.body?.includes('confirm the address'), 'e-mail copy on the timeline', JSON.stringify(emRow));
  const emThread = await batch('agent', [sel('v_email_threads', { filters: [{ col: 'patient_id', op: 'eq', val: wa.patient_id }], mode: 'single' })]);
  const emT = emThread.body?.results?.[0]?.data;
  check(emThread.status === 200 && emT?.needs_reply === false && emT?.last_subject?.startsWith('Your home visit') && emT?.case_no === wa.case_no && emT?.outbound_count >= 1,
    'v_email_threads shows the e-mail thread', JSON.stringify(emT));
  const emProv = await batch('bmm', [sel('v_email_threads')]);
  check(emProv.status === 200 && (emProv.body?.results?.[0]?.data || []).length === 0, 'provider sees no e-mail threads', JSON.stringify(emProv.body).slice(0, 200));
  const wh = await call('sup', 'GET', '/api/v1/admin/webhooks');
  check(wh.status === 200 && wh.body.length >= 8, 'webhook log visible in Settings', String(wh.body?.length));

  // ---- 6b. MyOperator connection entered in the app (Settings > Telephony)
  check((await call('agent', 'GET', '/api/v1/admin/myoperator')).status === 403, 'MyOperator settings: agents kept out');
  check((await call('sup', 'GET', '/api/v1/admin/myoperator')).status === 200, 'MyOperator settings: supervisor allowed');
  const tel = await call('sup', 'POST', '/api/v1/admin/users/telephony', { profile_id: U.agent2, myoperator_user_id: 'tmp-1', myoperator_extension: '12', phone: '9800000012' });
  check(tel.status === 200 && tel.body?.myoperator_extension === '12' && tel.body?.phone === '+919800000012', 'supervisor sets an agent\'s telephony ids', JSON.stringify(tel.body));
  check((await call('agent', 'POST', '/api/v1/admin/users/telephony', { profile_id: U.agent })).status === 403, 'agents cannot set telephony ids');
  await sql`update profiles set myoperator_user_id = null, myoperator_extension = null, phone = null where id = ${U.agent2}`;
  let mo = await call('admin', 'GET', '/api/v1/admin/myoperator');
  const mfld = (r, k) => (r.body?.fields || []).find((f) => f.key === k) || {};
  check(mo.status === 200 && mfld(mo, 'webhook_key').source === 'secret' && mo.body?.webhook?.url?.endsWith('/webhooks/myoperator'), 'MyOperator settings: secrets shown as configured', JSON.stringify(mo.body?.webhook));
  mo = await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { api_token: 'api-tok', company_id: 'co-app' } });
  check(mo.status === 200 && mfld(mo, 'api_token').source === 'app' && mfld(mo, 'api_token').value === '…-tok' && mfld(mo, 'company_id').value === 'co-app', 'MyOperator settings saved in the app (token masked)', JSON.stringify(mo.body?.fields));
  check(!JSON.stringify(mo.body).includes('api-tok'), 'saved credential never sent back to the screen');
  check((await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { nonsense: 'x' } })).status === 400, 'unknown MyOperator field refused');
  const leak = await batch('admin', [sel('integration_settings')]);
  check(!JSON.stringify(leak.body).includes('api-tok'), 'credentials table closed to screen queries', JSON.stringify(leak.body).slice(0, 160));
  const dbWall = await sql.begin(async (tx) => { await tx`set local role caredesk_app`; await tx`select settings from integration_settings`; return 'readable'; }).catch((e) => String(e.message));
  check(/permission denied/i.test(dbWall), 'database refuses the app role on the credentials table', dbWall);
  const t = await call('admin', 'POST', '/api/v1/admin/myoperator/test', {});
  check(t.status === 200 && t.body?.api?.ok && /2 MyOperator users/.test(t.body.api.message) && t.body?.click_to_call?.ok, 'Test connection: API token and click-to-call', JSON.stringify(t.body));
  const mu = await call('admin', 'GET', '/api/v1/admin/myoperator/users');
  const two = (mu.body?.users || []).find((u) => u.id === 'mo-88');
  check(mu.status === 200 && two?.suggested_profile === U.agent2 && (mu.body.users.find((u) => u.id === 'mo-77') || {}).linked_profile === U.agent, 'MyOperator users with linked and suggested logins', JSON.stringify(mu.body?.users));
  const ln = await call('admin', 'POST', '/api/v1/admin/myoperator/users', { auto: true });
  check(ln.status === 200 && ln.body?.linked === 1 && (await one(`select myoperator_user_id m from profiles where id = $1`, U.agent2))?.m === 'mo-88', 'agents linked by email in one click', JSON.stringify(ln.body));
  const gk = await call('admin', 'POST', '/api/v1/admin/myoperator', { generate_webhook_key: true });
  const newKey = gk.body?.webhook?.key;
  check(gk.status === 200 && /^hhcs_[0-9a-f]{48}$/.test(newKey || '') && gk.body.webhook.url_with_key.includes(newKey), 'new webhook key generated in the app', JSON.stringify(gk.body?.webhook));
  check((await hook({ event_type: 'call.initiated' }, 'rehearsal-hook')).status === 401, 'old webhook key stops working');
  const hookAs = (body, { key = newKey, type = 'application/json', auth } = {}) => fetch(base + '/webhooks/myoperator' + (auth ? '' : '?key=' + encodeURIComponent(key)), {
    method: 'POST', headers: { 'Content-Type': type, ...(auth ? { Authorization: 'Basic ' + btoa('myoperator:' + key) } : {}) }, body });
  await sql`update profiles set phone = '+919800000088' where id = ${U.agent2}`;
  // in-call webhook: ringing pops up for the agent being rung, then answered
  await hookAs(JSON.stringify({ uid: 'ic-1', clid: '+919876500001', call_state: 0, event: 1, users: ['+919800000088'] }));
  let ic = await one(`select id::text, status, agent_id::text a, did_number from calls where session_id = 'ic-1'`);
  check(ic?.status === 'ringing' && ic?.a === U.agent2 && ic?.did_number === '+918049368621', 'in-call webhook: ringing call for the right agent on the helpline', JSON.stringify(ic));
  await hookAs(JSON.stringify({ uid: 'ic-1', clid: '+919876500001', call_state: 1, event: 2, users: ['+919800000088'] }));
  check((await one(`select status from calls where session_id = 'ic-1'`))?.status === 'answered', 'in-call webhook: answered');
  // after-call webhook (form field "myoperator"), different call id: completes the same call
  const v1 = { _ai: 'log-1', _ci: 'co-app', _cr: '9876500001', _cl: '+919876500001', _ev: 1, _su: 1, _st: t0, _et: t0 + 130, _dr: '00:02:05',
    _dn: 'HHCS', _fn: 'rec-v1.mp3', _pm: [{ ky: 'ui', vl: 'd5.other-id' }], _ld: [{ _ds: 'ANSWER', _rr: [{ _na: 'Agent Two', _id: 'mo-88', _nr: '+919800000088' }] }] };
  const r1 = await hookAs('myoperator=' + encodeURIComponent(JSON.stringify(v1)), { type: 'application/x-www-form-urlencoded' });
  const ac = await one(`select count(*)::int n, max(status) s, max(talk_seconds) t, max(recording_filename) f, max(agent_id::text) a, max(department) d from calls where customer_number = '+919876500001'`);
  check(r1.status === 200 && ac.n === 1 && ac.s === 'completed' && ac.t === 125 && ac.f === 'rec-v1.mp3' && ac.a === U.agent2 && ac.d === 'HHCS', 'after-call webhook completes the in-call call (one row)', JSON.stringify(ac));
  // Issue 3: the in-call answer time is the Worker's clock; MyOperator's end - talk wins, so answered <= ended
  const icT = await one(`select answered_at, ended_at, talk_seconds, duration_flag from calls where customer_number = '+919876500001'`);
  check(new Date(icT.answered_at) <= new Date(icT.ended_at) && new Date(icT.ended_at) - new Date(icT.answered_at) === 125000 && icT.talk_seconds === 125,
    'in-call answer never lands after the provider end (answered = end - talk)', JSON.stringify(icT));
  const bNoTalk = { session_id: 'sess-no-talk', direction: 'inbound', customer_identifier: '+919876500003', system_identifier: '+918049368621' };
  await hookAs(JSON.stringify({ ...bNoTalk, event_id: 'nt1', event_type: 'call.initiated', timestamp: t0 }));
  await hookAs(JSON.stringify({ ...bNoTalk, event_id: 'nt2', event_type: 'call.answered', timestamp: t0 + 10, payload: { legs: [{ answered_at: t0 + 10 }] } }));
  await hookAs(JSON.stringify({ ...bNoTalk, event_id: 'nt3', event_type: 'call.end', timestamp: t0 + 70, payload: { status: 'answered', legs: [{}] } }));
  const noTalk = await one(`select status, talk_seconds, duration_flag from calls where session_id = 'sess-no-talk'`);
  check(noTalk?.status === 'completed' && noTalk.talk_seconds === 60 && noTalk.duration_flag === 'derived',
    'connected call without talk_duration: talk time derived from the provider times, never null', JSON.stringify(noTalk));
  // after-call, missed, JSON body with Basic auth -> callback queued
  await hookAs(JSON.stringify({ myoperator: JSON.stringify({ _ai: 'log-2', _cl: '+919876500002', _ev: 1, _su: 2, _st: t0, _et: t0 + 20, _ld: [] }) }), { auth: true });
  check((await one(`select status from callbacks where number = '+919876500002'`))?.status === 'pending', 'missed call from the after-call webhook goes to the callback queue (Basic auth key)');
  const unk = await hookAs(JSON.stringify({ hello: 'world' }));
  const ue = await one(`select processed, error from webhook_events where event_type = 'unknown' order by received_at desc limit 1`);
  check(unk.status === 200 && ue && !ue.processed && /not recognised/.test(ue.error || ''), 'unknown format stored for checking, not lost', JSON.stringify(ue));
  // Issue 4: Webhook health (supervisors only, read-only, no payloads or numbers)
  const whHealth = await call('sup', 'GET', '/api/v1/admin/webhooks/health');
  check(whHealth.status === 200 && whHealth.body?.last_event?.at && whHealth.body.counts?.webhook_24h > 0 && whHealth.body.rejections?.last_401_at
    && whHealth.body.failed?.some((e) => /not recognised/.test(e.error)) && whHealth.body.alert?.hours === 4
    && !/\+91\d{10}|9876500/.test(JSON.stringify(whHealth.body)), 'webhook health: last event, counts, failures, last 401, no phone numbers', JSON.stringify(whHealth.body).slice(0, 400));
  check((await call('agent', 'GET', '/api/v1/admin/webhooks/health')).status === 403 && (await call('admin', 'GET', '/api/v1/admin/webhooks/health')).status === 403,
    'webhook health is supervisor-only');
  check((await rpc('sup', 'set_webhook_alert_hours', { p_hours: 6 })).body?.data === 6 && (await rpc('agent', 'set_webhook_alert_hours', { p_hours: 2 })).status === 403,
    'supervisor sets the silence alert window');

  const vcOutcome = await batch('sup', [sel('v_calls', { cols: 'id,needs_outcome,disposition', filters: [{ col: 'session_id', op: 'eq', val: 'sess-no-talk' }], mode: 'single' })]);
  check(vcOutcome.body?.results?.[0]?.data?.needs_outcome === true, 'supervisor view: connected call without an outcome is flagged', JSON.stringify(vcOutcome.body));
  const autoMiss = await one(`select disposition, disposition_auto from calls where session_id = 'sess-miss-1'`);
  check(autoMiss?.disposition === 'missed' && autoMiss.disposition_auto, 'missed call gets its outcome automatically', JSON.stringify(autoMiss));

  await wrapAll('agent');

  // ---- 6b2. CRM-only calling: rejection, callback recovery, legacy settings and uncertain responses
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'bad' } });
  const fb = await call('agent', 'POST', '/api/v1/calls/dial', { case_id: cid });
  const rejected = await one(`select status, ended_at, raw from calls where click_to_call_ref = $1`, obdCalls.at(-1)?.body.reference_id);
  check(fb.status === 502 && !fb.body?.number && !fb.body?.mode && rejected?.status === 'failed' && rejected.ended_at
    && rejected.raw?.dial_outcome === 'rejected', 'provider rejection fails the call without an extension fallback', JSON.stringify(fb.body));
  const pendingCb = await one(`select id from callbacks where number = '+919876500002'`);
  const failedCallback = await call('agent', 'POST', '/api/v1/calls/dial', { callback_id: pendingCb.id });
  check(failedCallback.status === 502 && (await one(`select status from callbacks where id = $1`, pendingCb.id)).status === 'pending',
    'rejected callback returns to pending queue');
  // Simulate a saved setting from an older installation; it must no longer select the extension.
  await sql`update integration_settings set settings = settings || '{"dial_mode":"app"}'::jsonb where provider = 'myoperator'`;
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'ivr-1' } });
  const back = await call('agent', 'POST', '/api/v1/calls/dial', { case_id: cid });
  const rv = await one(`select count(*)::int n from access_log where action = 'reveal_number' and user_id = $1`, U.agent);
  check(back.status === 200 && back.body?.mode === 'api' && rv.n === 0 && !back.body.number,
    'old app setting ignored: API calls only, no number reveals', JSON.stringify(back.body));
  await sql`update calls set status='completed',ended_at=now() where id=${back.body.call_id}`;
  await wrapAll('agent');
  await rpc('agent', 'callback_update', { p_id: pendingCb.id, p_status: 'unreachable', p_note: 'No answer twice' });
  const dialAgain = await call('agent', 'POST', '/api/v1/calls/dial', { callback_id: pendingCb.id });
  const reopened = await one(`select cb.status, cb.completed_at, k.callback_id::text cid from callbacks cb, calls k where cb.id = $1 and k.id = $2`, pendingCb.id, dialAgain.body?.call_id);
  check(dialAgain.status === 200 && reopened?.status === 'in_progress' && !reopened.completed_at && reopened.cid === pendingCb.id,
    'unreachable callback can be called again (reopens as in progress)', JSON.stringify({ body: dialAgain.body, reopened }));
  await sql`update calls set status='completed',ended_at=now() where id=${dialAgain.body.call_id}`;
  const configured = await call('admin', 'GET', '/api/v1/admin/myoperator');
  check(!configured.body.fields.some(f => f.key === 'dial_mode'), 'extension dial mode removed from settings');
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'unknown' } });
  const attempts = obdCalls.length;
  await wrapAll('agent');
  const unknownCall = await call('agent', 'POST', '/api/v1/calls/dial', { case_id: cid });
  const unknownRow = await one(`select status, raw from calls where click_to_call_ref = $1`, obdCalls.at(-1)?.body.reference_id);
  check(unknownCall.status === 504 && obdCalls.length === attempts + 1 && unknownRow?.status === 'ringing'
    && unknownRow.raw?.dial_outcome === 'unconfirmed', 'uncertain provider result does not redial or falsely mark the call failed', JSON.stringify(unknownCall.body));
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'ivr-1' } });

  const miss = { session_id: 'dedupe-call', event_type: 'call.end', direction: 'inbound', customer_identifier: '9876500999', payload: { status: 'abandoned' } };
  await Promise.all(['d1','d2'].map(event_id => hook({ ...miss, event_id }, newKey)));
  const dupe = await one(`select count(*)::int n from callbacks where number='+919876500999'`);
  check(dupe.n === 1, 'concurrent missed/abandoned events create one callback');
  await rpc('agent','callback_close',{p_id:(await one(`select id from callbacks where number='+919876500999'`)).id,p_outcome:'not_needed'});
  await hook({ ...miss, event_id:'d3' },newKey);
  check((await one(`select count(*)::int n from callbacks where number='+919876500999'`)).n===1,'late repeat of a closed missed call does not recreate its callback');
  await hook({ ...miss, session_id:'dedupe-later-call', event_id:'d4' },newKey);
  check((await one(`select count(*)::int n from callbacks where number='+919876500999'`)).n===2,'new missed call after closure creates a new follow-up');

  // ---- 6c. call-log sync (no webhooks needed)
  check((await call('agent', 'POST', '/api/v1/admin/myoperator/sync', {})).status === 403, 'call-log sync: agents kept out');
  const sy = await call('sup', 'POST', '/api/v1/admin/myoperator/sync', {});
  check(sy.status === 200 && sy.body?.ok && sy.body.seen === 3 && sy.body.new === 3 && sy.body.failed === 0, 'call-log sync reads new calls, old and new layout (SMS log skipped)', JSON.stringify(sy.body));
  const sm = await one(`select status from callbacks where number = '+919876500077'`);
  const sc = await one(`select status, talk_seconds, recording_filename, agent_id::text a from calls where customer_number = '+919876500078'`);
  check(sm?.status === 'pending' && sc?.status === 'completed' && sc.talk_seconds === 90 && sc.recording_filename === 'rec-sync-2.mp3' && sc.a === U.agent2,
    'synced calls: missed -> callback queue; answered -> agent, talk time, recording', JSON.stringify({ sm, sc }));
  const nl = await one(`select status, department from calls where customer_number = '+919876500080'`);
  const nb = await one(`select status from callbacks where number = '+919876500080'`);
  check(nl?.status === 'missed' && nl.department === 'Sales' && nb?.status === 'pending', 'newer log layout: missed call recorded with department, callback queued', JSON.stringify({ nl, nb }));
  const sy2 = await call('sup', 'POST', '/api/v1/admin/myoperator/sync', {});
  check(sy2.status === 200 && sy2.body?.new === 0, 'second sync brings nothing twice', JSON.stringify(sy2.body));
  const ms = await call('sup', 'GET', '/api/v1/admin/myoperator');
  check(ms.body?.sync?.last_ok_at && ms.body.sync.total_new === 3 && !ms.body.sync.last_error, 'sync status shown in settings', JSON.stringify(ms.body?.sync));

  // ---- 7. live updates: a screen's WebSocket hears about another user's change
  if (typeof WebSocket !== 'undefined') {
    const heard = await new Promise((resolve) => {
      const sock = new WebSocket(base.replace(/^http/, 'ws') + '/api/v1/live', ['caredesk', tok.sup]);
      const done = (v) => { try { sock.close(); } catch {} resolve(v); };
      const timer = setTimeout(() => done(null), 8000);
      sock.onmessage = (m) => { const t = JSON.parse(String(m.data)).tables || []; if (t.includes('escalations')) { clearTimeout(timer); done(t); } };
      sock.onopen = () => data('agent', 'escalations', { op: 'insert', rows: [{ workspace_id: ws, case_id: cid, type: 'delay', level: 1, trigger_text: 'Live check', raised_by: U.agent }] });
      sock.onerror = () => { clearTimeout(timer); done(null); };
    });
    check(Array.isArray(heard), 'live update pushed to an open screen', JSON.stringify(heard));
    const refused = await new Promise((resolve) => {
      const sock = new WebSocket(base.replace(/^http/, 'ws') + '/api/v1/live', ['caredesk', 'not-a-token']);
      sock.onopen = () => { sock.close(); resolve(false); };
      sock.onerror = () => resolve(true);
      setTimeout(() => resolve(true), 5000);
    });
    check(refused, 'live socket refused without a valid login');
  }

  // ---- 7b. Book My Medicare login: its leads only, progress, no recordings
  const nurse = (await sql`select id::text from services where workspace_id = ${ws} and code = 'NURS-HOME'`)[0].id;
  const pe = await rpc('agent', 'create_enquiry', { p: { consent: true, branch: 'Mahim', additional_info: 'Needs night shift',
    patient: { full_name: 'Provider Patient', mobile: '9811177001', address: 'Mahim W', pincode: '400016' }, services_requested: 'Nursing', service_ids: [nurse] } });
  const pcid = pe.body?.data?.case_id;
  check(pe.status === 200 && pcid, 'agent registers a nursing case with branch', JSON.stringify(pe.body));
  const me = await call('bmm', 'GET', '/api/v1/me');
  check(me.status === 200 && me.body?.role === 'provider', 'Book My Medicare login works', JSON.stringify(me.body));
  const leads = await batch('bmm', [sel('v_referrals', { cols: 'id,case_no,patient_mobile,status,provider_code,branch,additional_info' }), sel('v_cases', { cols: 'id' })]);
  const lead = (leads.body?.results?.[0]?.data || []).find((r) => r.branch === 'Mahim');
  check(leads.status === 200 && lead?.status === 'new' && lead.provider_code === 'BMM' && lead.patient_mobile === '+919811177001' && lead.additional_info,
    'provider lead list: case ID, full number, requirements', JSON.stringify(leads.body?.results?.[0]?.data?.slice?.(0, 2)));
  check((leads.body?.results?.[1]?.data || []).every((r) => r.id !== cid), 'provider does not see SecondMedic-only cases');
  const callId = (await one(`select id::text from calls where recording_filename is not null limit 1`))?.id;
  check((await call('bmm', 'GET', `/api/v1/calls/${callId}/recording`)).status === 403, 'provider cannot play call recordings');
  const pkb = await batch('bmm', [sel('service_knowledge', { cols: 'id,category,service_id' })]);
  check(pkb.status === 200 && (pkb.body?.results?.[0]?.data || []).length > 0, 'Book My Medicare reads the product details it delivers', JSON.stringify(pkb.body).slice(0, 300));
  const bmmCats = (await one(`select to_json(categories) c from providers where code = 'BMM'`))?.c || [];
  check((pkb.body?.results?.[0]?.data || []).every((r) => !r.category || bmmCats.includes(r.category)),
    'provider reads only its own product categories', JSON.stringify(pkb.body?.results?.[0]?.data?.map?.((r) => r.category)));
  check((await rpc('bmm', 'save_service_knowledge', { p: { category: 'nursing', summary: 'x' } })).status === 403, 'provider cannot edit product details');
  const pcalls = await batch('bmm', [sel('v_calls', { cols: 'id' })]);
  check(pcalls.status === 403 || (pcalls.body?.results?.[0]?.data || []).length === 0, 'provider sees no calls', JSON.stringify(pcalls.body).slice(0, 120));
  check((await call('bmm', 'GET', '/api/v1/admin/webhooks')).status === 403, 'provider kept out of telephony settings');
  check((await rpc('bmm', 'advance_case', { p_case: pcid, p_note: null })).status === 403, 'provider cannot move SecondMedic stages');
  const acc = await rpc('bmm', 'update_referral', { p_id: lead?.id, p_status: 'accepted', p_note: 'Nurse assigned' });
  check(acc.status === 200 && acc.body?.data?.status === 'accepted', 'provider accepts the lead', JSON.stringify(acc.body));
  const note = await data('bmm', 'interactions', { op: 'insert', rows: [{ workspace_id: ws, case_id: pcid, channel: 'note', actor_id: U.bmm, summary: 'Progress note', body: 'Night 1 fine' }] });
  check(note.status === 200, 'provider adds a progress note', JSON.stringify(note.body));
  const done = await rpc('bmm', 'update_referral', { p_id: lead?.id, p_status: 'completed', p_note: 'Shift done' });
  const st = await batch('agent', [sel('v_cases', { cols: 'stage,provider_names', filters: [{ col: 'id', op: 'eq', val: pcid }], mode: 'single' })]);
  check(done.status === 200 && st.body?.results?.[0]?.data?.stage === 'closed', 'provider completes -> case closed for the agent too', JSON.stringify(st.body));
  // ---- 7b2. expected discharge / requested service start captured on the enquiry, corrected on the case
  const dcid = (await rpc('agent', 'create_enquiry', { p: { consent: true, services_requested: 'ECG at home', expected_discharge_on: '2026-10-18',
    requested_service_start_on: '2026-10-20', patient: { full_name: 'Dates Patient', mobile: '9811177004', address: 'Mahim W', pincode: '400016' } } })).body?.data?.case_id;
  const dsel = () => batch('agent', [sel('v_cases', { cols: 'expected_discharge_on,requested_service_start_on,stage,booked_slot', filters: [{ col: 'id', op: 'eq', val: dcid }], mode: 'single' })]);
  let dv = (await dsel()).body?.results?.[0]?.data;
  check(dv?.expected_discharge_on === '2026-10-18' && dv?.requested_service_start_on === '2026-10-20', 'enquiry saves both dates, returned as plain days', JSON.stringify(dv));
  const dset = await rpc('agent', 'set_case_requirements', { p_case: dcid, p: { expected_discharge_on: '2026-10-19' } });
  dv = (await dsel()).body?.results?.[0]?.data;
  check(dset.status === 200 && dv?.expected_discharge_on === '2026-10-19' && dv?.requested_service_start_on === '2026-10-20', 'discharge edit leaves the requested start', JSON.stringify(dv));
  check(dv?.stage === 'enquiry' && dv?.booked_slot === null, 'dates book nothing and keep the stage', JSON.stringify(dv));
  const dbad = await rpc('agent', 'set_case_requirements', { p_case: dcid, p: { requested_service_start_on: '2026-02-30' } });
  check(dbad.status >= 400 && dbad.status < 500 && /calendar date/.test(JSON.stringify(dbad.body)), 'impossible date refused', JSON.stringify(dbad.body));
  for (const who of ['field', 'bmm', 'client', 'admin']) {
    check((await rpc(who, 'set_case_requirements', { p_case: dcid, p: { requested_service_start_on: '2026-10-21' } })).status === 403, `${who} cannot change the case dates`);
  }
  check((await data('agent', 'cases', { op: 'update', patch: { requested_service_start_on: '2026-10-21' }, filters: [{ col: 'id', op: 'eq', val: dcid }] })).status === 403, 'case columns change only through the action');

  // ---- 7c. post-discharge transition: intake, validation roles, partner sync, metrics
  const tcid =(await rpc('agent', 'create_enquiry', { p: { consent: true, services_requested: 'ICU bed and a nurse',
    patient: { full_name: 'Transition Patient', mobile: '9811177003', address: 'Mahim W', pincode: '400016' } } })).body?.data?.case_id;
  const ti = await rpc('agent', 'set_intake', { p_case: tcid, p: { care_type: 'post_discharge', intake_disposition: 'requirement_captured',
    spoke_with: 'patient', expected_discharge_on: '2026-10-20', hospital_name: 'P. D. Hinduja Hospital, Mahim' } });
  check(ti.status === 200 && ti.body?.data?.validation_status === 'pending', 'agent records post-discharge intake', JSON.stringify(ti.body));
  check((await rpc('agent', 'schedule_validation', { p_case: tcid, p_nurse: U.agent, p_when: new Date().toISOString() })).status === 403, 'agent cannot schedule the hospital validation');
  check((await rpc('bmm', 'record_validation', { p_case: tcid, p: {} })).status === 403, 'provider cannot record a clinical validation');
  check((await batch('bmm', [sel('v_assessments', { cols: 'id' })])).status === 403, 'provider cannot read validation records');
  check((await rpc('agent', 'import_referral_updates', { p_rows: [] })).status === 403, 'agent cannot run the partner sync');
  const psync = await rpc('bmm', 'import_referral_updates', { p_rows: [{ case_no: 'HHC-000000-99999', status: 'accepted' }] });
  check(psync.status === 200 && psync.body?.data?.errors?.length === 1, 'partner sync reports unknown cases row by row', JSON.stringify(psync.body));
  check((await rpc('agent', 'transition_metrics', { p_from: new Date(Date.now() - 864e5).toISOString(), p_to: new Date().toISOString() })).status === 403, 'agent cannot read transition metrics');
  const tmx = await batch('client', [{ kind: 'rpc', fn: 'transition_metrics', args: { p_from: new Date(Date.now() - 864e5).toISOString(), p_to: new Date(Date.now() + 864e5).toISOString() } }]);
  check(tmx.status === 200 && tmx.body?.results?.[0]?.data?.intake >= 1, 'Hinduja management reads transition metrics', JSON.stringify(tmx.body).slice(0, 200));
  check((await rpc('bmm', 'care_plan_sheet', { p_case: tcid, p_days: 30 })).status === 403, 'partner cannot read the assessment checklist pricing');
  const cps = await batch('client', [{ kind: 'rpc', fn: 'care_plan_sheet', args: { p_case: tcid, p_days: 30 } }]);
  check(cps.status === 200 && cps.body?.results?.[0]?.data?.options?.length > 0 && cps.body.results[0].data.case?.items,
    'checklist pricing: 30-day options + case items in one read', JSON.stringify(cps.body).slice(0, 200));
  check((await rpc('agent', 'log_deployment', { p_referral: lead?.id, p: { resource_type: 'staff' } })).status === 403, 'agent cannot log partner work orders');
  check((await rpc('bmm', 'set_payment_schedule', { p_case: tcid, p_rows: [] })).status === 403, 'partner cannot set a payment schedule');
  check((await batch('bmm', [sel('v_payment_schedule', { cols: 'id' })])).status === 403, 'partner cannot read payment schedules');
  const depList = await batch('bmm', [sel('v_deployments', { cols: 'id,status,equipment_serial' }), sel('case_journey_history', { cols: 'to_state' })]);
  check(depList.status === 200, 'partner reads its work orders and the journey', JSON.stringify(depList.body).slice(0, 160));
  const jr = await batch('agent', [sel('v_cases', { cols: 'journey_state', filters: [{ col: 'id', op: 'eq', val: tcid }], mode: 'single' })]);
  check(jr.body?.results?.[0]?.data?.journey_state === 'intake_logged', 'new post-discharge case starts at Intake logged', JSON.stringify(jr.body).slice(0, 160));
  check((await rpc('agent', 'import_cases', { p_rows: [] })).status === 403, 'agents cannot import old CRM data');
  const im = await rpc('sup', 'import_cases', { p_rows: [{ ref: 'API-1', patient_name: 'Imported Via Api', mobile: '9811177002', services: 'physiotherapy', status: 'open', branch: 'Khar' }] });
  check(im.status === 200 && im.body?.data?.imported === 1, 'supervisor imports a row from the old CRM', JSON.stringify(im.body));

  // ---- 8. users
  const nu = await call('admin', 'POST', '/api/v1/admin/users', { email: 'new.agent@rehearsal.test', password: 'longenough1', full_name: 'New Agent', role: 'agent', agent_code: 'A-20' });
  check(nu.status === 200 && nu.body?.role === 'agent', 'admin creates a login and profile', JSON.stringify(nu.body));

  // ---- 8b. WABA diagnostics: roles, real configuration merge, no live sends, and QR disabled
  const wabaPath = '/api/v1/admin/myoperator/waba/test';
  check((await call(null, 'POST', wabaPath, {})).status === 401, 'WABA diagnostic needs login');
  for (const role of ['agent','coord','medical','field','client','clinical','bmm']) {
    check((await call(role, 'POST', wabaPath, {})).status === 403, role + ' cannot test WABA credentials');
  }
  for (const role of ['admin','sup','administrator']) {
    const r = await call(role, 'POST', wabaPath, {});
    check(r.status === 200 && r.body?.status === 'missing_credentials' && !r.body.ok, role + ' gets missing WABA credentials without sending');
  }
  const configWaba = await call('admin', 'POST', '/api/v1/admin/myoperator', {values:{waba_api_key:'waba-test-key',waba_phone_id:'123456789'}});
  check(configWaba.body?.waba?.status === 'configured', 'saved WABA presence is Configured, never Connected');
  const wabaTest = await call('sup', 'POST', wabaPath, {});
  check(wabaTest.status === 200 && wabaTest.body?.ok && wabaTest.body.status === 'connected' && !JSON.stringify(wabaTest.body).includes('waba-test-key'), 'read-only WABA lookup verifies saved key and matching connected phone without exposing the key', JSON.stringify(wabaTest.body));
  await call('admin', 'POST', '/api/v1/admin/myoperator', {values:{waba_api_key:'wrong-key'}});
  const badWaba = await call('admin', 'POST', wabaPath, {});
  check(badWaba.body?.status === 'configured' && badWaba.body.ok === false && /refused/.test(badWaba.body.message), 'rejected WABA key cannot report Connected');
  await call('admin', 'POST', '/api/v1/admin/myoperator', {values:{waba_api_key:'waba-test-key',waba_phone_id:'999'}});
  const wrongPhone = await call('admin', 'POST', wabaPath, {});
  check(wrongPhone.body?.ok === false && /not found/.test(wrongPhone.body.message), 'WABA lookup validates the phone ID belongs to this account');
  await call('admin', 'POST', '/api/v1/admin/myoperator', {values:{waba_api_key:'',waba_phone_id:''}});
  await sql`insert into integration_settings(provider,settings) values('whatsapp_qr','{"status":"connected","bridge_key":"obsolete-qr-key-longer-than-24"}'::jsonb)
    on conflict(provider) do update set settings=excluded.settings`;
  const wa0 = await call('agent', 'GET', '/api/v1/whatsapp/session');
  check(wa0.status === 200 && wa0.body?.status === 'missing_credentials' && !wa0.body.connected && !wa0.body.qr_enabled && !wa0.body.qr_svg, 'legacy QR state cannot report Connected or expose a QR');
  for (const action of ['start','refresh_qr','sync','logout','disconnect']) {
    check((await call('agent', 'POST', '/api/v1/whatsapp/session', {action})).status === 403, 'QR session action disabled: ' + action);
  }
  check((await hook({bridge:'whatsapp_qr',action:'poll',status:'connected'},newKey)).status === 403, 'even a webhook key cannot enable the QR bridge');
  check((await fetch(base+'/webhooks/myoperator?bridge=whatsapp_qr', {method:'POST',headers:{'x-webhook-key':'obsolete-qr-key-longer-than-24'},body:'{}'})).status === 403, 'legacy bridge credentials cannot bypass WABA compliance');
  const waSend = await call('agent', 'POST', '/api/v1/whatsapp/send', {mobile:'9820099887',patient_name:'Test contact',text:'Test message'});
  check(waSend.body?.delivery?.skipped && !waSend.body.delivery.queued, 'missing WABA credentials never fall back to QR sending');

  // ---- 9. callback auto-dialer (Hinduja MoM): settings by role, Available switch, cron dials, connect closes
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'ivr-1' } });
  check((await rpc('agent', 'set_autodial', { p_enabled: true, p_buffer_minutes: 30, p_max_attempts: 3 })).status === 403, 'agents cannot change the auto-dialer');
  check((await rpc('field', 'set_my_availability', { p_available: true })).status === 403, 'field staff have no Available switch');
  const adOn = await rpc('sup', 'set_autodial', { p_enabled: true, p_buffer_minutes: 45, p_max_attempts: 3 });
  check(adOn.status === 200 && adOn.body?.data?.enabled && adOn.body.data.buffer_minutes === 45, 'supervisor turns on the auto-dialer (45 min)', JSON.stringify(adOn.body));
  await sql`update callbacks set status = 'done' where status in ('pending','in_progress')`;
  await sql`update calls set status = 'completed' where status in ('ringing','answered')`;
  await wrapAll('agent');
  await sql`update profiles set available = false`;
  const av = await rpc('agent', 'set_my_availability', { p_available: true });
  check(av.status === 200 && av.body?.data?.available === true && av.body.data.linked === true, 'linked agent goes Available', JSON.stringify(av.body));
  await hook({ session_id: 'sess-auto-1', event_id: 'a1', event_type: 'call.end', direction: 'inbound', customer_identifier: '+919930055501',
    system_identifier: '+918049368621', timestamp: Math.floor(Date.now() / 1000), payload: { status: 'missed', legs: [] } }, newKey);
  const queued = await one(`select id::text, round(extract(epoch from due_at - created_at) / 60)::int m, next_attempt_at is not null n from callbacks where number = '+919930055501'`);
  check(queued?.m === 45 && queued.n, 'missed call -> callback due in the 45-minute buffer, queued to auto-dial', JSON.stringify(queued));
  const before = obdCalls.length;
  const cron = await fetch(base + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent('* * * * *')).catch(() => null)
    || await fetch(base + '/cdn-cgi/local/scheduled').catch(() => null);
  for (let i = 0; i < 20 && obdCalls.length === before; i++) await new Promise((r) => setTimeout(r, 250));
  const autoObd = obdCalls.at(-1);
  const autoRow = await one(`select status, attempts, auto_dialled, assigned_to::text a from callbacks where id = $1`, queued?.id ?? null);
  check(cron?.ok && obdCalls.length === before + 1 && autoObd?.body?.user_id === 'mo-77' && autoObd.body.number === '+919930055501'
    && autoRow?.status === 'in_progress' && autoRow.auto_dialled && autoRow.a === U.agent,
    'cron auto-dials the callback through the Available agent (agent-first bridge)', JSON.stringify({ cron: cron?.status, n: obdCalls.length - before, autoRow, body: autoObd?.body }));
  const duplicateAutoCall = await call('agent', 'POST', '/api/v1/calls/dial', { callback_id: queued.id });
  check(duplicateAutoCall.status === 409 && obdCalls.length === before + 1,
    'an in-progress auto-dial callback cannot be dialled again', JSON.stringify(duplicateAutoCall.body));
  const pend0 = (await rpc('sup', 'dashboard_kpis', { p_from: new Date(Date.now() - 864e5).toISOString(), p_to: new Date(Date.now() + 864e5).toISOString() })).body?.data?.callbacks_pending;
  const bA = { session_id: 'sess-auto-out', direction: 'outbound', customer_identifier: '+919930055501' };
  await hook({ ...bA, event_id: 'a2', event_type: 'call.initiated', payload: { client_ref_id: autoObd?.body?.reference_id } }, newKey);
  await hook({ ...bA, event_id: 'a3', event_type: 'call.answered', timestamp: Math.floor(Date.now() / 1000), payload: { legs: [{ type: 'customer', dial_status: 'ANSWER', answered_at: Math.floor(Date.now() / 1000), ring_duration: 4 }] } }, newKey);
  const pend1 = (await rpc('sup', 'dashboard_kpis', { p_from: new Date(Date.now() - 864e5).toISOString(), p_to: new Date(Date.now() + 864e5).toISOString() })).body?.data?.callbacks_pending;
  check(pend0 === 1 && pend1 === 0 && (await one(`select status from callbacks where id = $1`, queued?.id ?? null))?.status === 'reached',
    'patient connects -> Callbacks pending 1 -> 0 on the dashboard (reached, outcome open)', JSON.stringify({ pend0, pend1 }));
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'bad' } });
  const [{ id: retryCb }] = await sql`insert into callbacks (workspace_id, number, reason, due_at)
    values (${ws}, '+919930055502', 'missed', now() + interval '10 minutes') returning id::text`;
  await hook({ ...bA, event_id: 'a4', event_type: 'call.end', payload: { legs: [{ type: 'customer', dial_status: 'ANSWER', talk_duration: 40 }] } }, newKey);
  await wrapAll('agent');
  const rejectedManualCallback = await call('agent', 'POST', '/api/v1/calls/dial', { callback_id: retryCb });
  const retryState = await one(`select status, attempts, next_attempt_at > now() as scheduled from callbacks where id = $1`, retryCb);
  check(rejectedManualCallback.status === 502 && retryState?.status === 'pending' && retryState.attempts === 1 && retryState.scheduled,
    'rejected manual dial keeps the auto-retry scheduled', JSON.stringify({ response: rejectedManualCallback.body, retryState }));
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'ivr-1' } });
  await rpc('sup', 'set_autodial', { p_enabled: false, p_buffer_minutes: 30, p_max_attempts: 3 });

  // ---- AI call summaries: settings, status, failure kept on the call, then the full flow (Gemini and the recording are stand-ins)
  const recCall = (await one(`select id::text from calls where session_id = 'sess-in-1'`))?.id;
  check((await call('agent', 'GET', '/api/v1/admin/ai')).status === 403, 'AI settings: agents kept out');
  let aist = await call('agent', 'GET', '/api/v1/ai/status');
  check(aist.status === 200 && aist.body?.enabled === false, 'AI status: off without a key', JSON.stringify(aist.body));
  check((await call('bmm', 'GET', '/api/v1/ai/status')).status === 403, 'provider kept out of AI status');
  const noKey = await call('sup', 'POST', `/api/v1/ai/calls/${recCall}`, {});
  check(noKey.status === 503 && JSON.stringify(noKey.body).includes('Gemini API key'), 'summary without a key: says where to add it', JSON.stringify(noKey.body));
  let aiSet = await call('sup', 'POST', '/api/v1/admin/ai', { api_key: 'gm-bad' });
  check(aiSet.status === 200 && aiSet.body?.key?.set && aiSet.body.key.value === '…-bad' && !JSON.stringify(aiSet.body).includes('gm-bad'),
    'Gemini key saved in the app; only its last 4 characters come back', JSON.stringify(aiSet.body));
  check((await call('sup', 'POST', '/api/v1/admin/ai', { model: 'bad model!' })).status === 400, 'odd model name refused');
  check((await call('sup', 'POST', '/api/v1/admin/ai', { model: 'gemini-3.5-transcribe-live' })).status === 400, 'live speech model cannot replace the JSON summary model');
  const badKey = await call('sup', 'POST', `/api/v1/ai/calls/${recCall}`, {});
  const badRow = await one(`select ai_status, ai_error, ai_attempts from calls where id = $1`, recCall);
  check(badKey.status === 502 && badRow?.ai_status === 'failed' && /API key not valid/.test(badRow.ai_error || '') && badRow.ai_attempts === 0,
    'wrong key: the call shows failed with the reason; the attempt is not counted against the call', JSON.stringify({ body: badKey.body, badRow }));
  const pausedBad = (await call('sup', 'GET', '/api/v1/admin/ai')).body?.paused;
  check(pausedBad && new Date(pausedBad.paused_until) > new Date(Date.now() + 20 * 60e3), 'wrong key: automatic summaries pause (30 minutes)', JSON.stringify(pausedBad));
  // free-tier quota: a short message that says what to do, instead of Google's long text cut off before the metric
  aiSet = await call('sup', 'POST', '/api/v1/admin/ai', { api_key: 'gm-quota' });
  check(!aiSet.body?.paused, 'saving the AI settings lifts the pause', JSON.stringify(aiSet.body?.paused));
  const quota = await call('sup', 'POST', `/api/v1/ai/calls/${recCall}`, {});
  const quotaRow = await one(`select ai_status, ai_error, ai_attempts from calls where id = $1`, recCall);
  const pausedQ = (await call('sup', 'GET', '/api/v1/admin/ai')).body?.paused;
  check(quota.status === 502 && quotaRow?.ai_status === 'failed' && quotaRow.ai_attempts === 0
    && quotaRow.ai_error.startsWith('Gemini quota exceeded (GenerateContentInputTokensPerModelPerMinute-FreeTier, limit 250000).') && /free tier: turn on billing/.test(quotaRow.ai_error),
    'quota exceeded: clear reason (free tier, turn on billing) on the call', JSON.stringify({ body: quota.body, quotaRow }));
  const qs = pausedQ ? (new Date(pausedQ.paused_until) - Date.now()) / 1000 : 0;
  check(qs > 20 && qs < 40, 'quota exceeded: pause follows the retry delay Google gives (33 s)', JSON.stringify(pausedQ));
  aiSet = await call('sup', 'POST', '/api/v1/admin/ai', { api_key: 'gm-test', model: 'gemini-test' });
  const aiTest = await call('sup', 'POST', '/api/v1/admin/ai/test', {});
  check(aiTest.body?.ok === true, 'Test key: Gemini answers', JSON.stringify(aiTest.body));
  check((await call('bmm', 'POST', `/api/v1/ai/calls/${recCall}`, {})).status === 403, 'provider cannot run AI on calls');
  const g0 = geminiCalls.length;
  const aiOk = await call('sup', 'POST', `/api/v1/ai/calls/${recCall}`, {});
  const aiRow = await one(`select ai_status, ai_summary, ai_error, ai_attempts, ai_extracted->>'next_action' na from calls where id = $1`, recCall);
  check(aiOk.status === 200 && aiRow?.ai_status === 'done' && aiRow.ai_summary?.startsWith('Caller asked') && aiRow.na && !aiRow.ai_error && aiRow.ai_attempts === 1,
    'recorded call summarised: summary, next action, status done', JSON.stringify({ body: aiOk.body, aiRow }));
  const used = geminiCalls.slice(g0);
  const gen = used.find((x) => x.path.includes(':generateContent'));
  check(used.some((x) => x.path.startsWith('/upload-session/') && x.bytes === 4096) && gen?.fileUri && !gen.inline && gen.path.includes('/models/gemini-test:')
    && used.some((x) => x.method === 'DELETE' && x.path.endsWith('/files/rh1')),
    'recording sent as a file (no base64), saved model used, file deleted afterwards', JSON.stringify(used));
  check(used.every((x) => !x.url.includes('key=')), 'Gemini key never put in a URL');
  const vcall = await batch('sup', [sel('v_calls', { cols: 'ai_status,ai_summary,ai_error', filters: [{ col: 'id', op: 'eq', val: recCall }], mode: 'single' })]);
  check(vcall.body?.results?.[0]?.data?.ai_status === 'done', 'v_calls shows the AI status to the screens', JSON.stringify(vcall.body).slice(0, 200));
  check((await one(`select count(*)::int n from qa_reviews where call_id = $1 and ai_generated`, recCall))?.n >= 1, 'AI QA score stored with the summary');
  const aiStats = await call('sup', 'GET', '/api/v1/admin/ai');
  check(aiStats.body?.stats?.done >= 1 && aiStats.body.model === 'gemini-test', 'settings: last 14 days counts and the saved model', JSON.stringify(aiStats.body));
  // Live microphone capture: only the assigned agent / operational staff, append-only checkpoints, then text-only summary.
  const [{ id: liveId }] = await sql`insert into calls (workspace_id, provider, direction, customer_number, agent_id, status, started_at, answered_at)
    values (${ws}, 'myoperator', 'inbound', '+919820012020', ${U.agent}, 'answered', now(), now()) returning id::text`;
  const tokenPath = `/api/v1/ai/calls/${liveId}/live-token`;
  const transcriptPath = `/api/v1/ai/calls/${liveId}/live-transcript`;
  check((await call(null, 'POST', tokenPath, {})).status === 401, 'live token: login required');
  for (const who of ['bmm', 'admin', 'field', 'client', 'clinical']) {
    check((await call(who, 'POST', tokenPath, {})).status === 403, `live token: ${who} denied`);
    check((await call(who, 'POST', transcriptPath, { transcript: 'hidden', final: true })).status === 403, `live transcript: ${who} denied`);
  }
  check((await call('agent2', 'POST', tokenPath, {})).status === 404, 'live token: another agent cannot see the call');
  check((await call('agent2', 'POST', transcriptPath, { transcript: 'hidden', final: false })).status === 404, 'live save: another agent cannot see the call');
  const liveToken = await call('agent', 'POST', tokenPath, {});
  const minted = geminiCalls.findLast((g) => g.path === '/v1beta/auth_tokens')?.tokenConfig;
  check(liveToken.status === 200 && liveToken.body.token === 'auth_tokens/rehearsal-live' && !JSON.stringify(liveToken.body).includes('gm-test')
    && minted?.uses === 1 && minted.bidiGenerateContentSetup.model === 'models/gemini-3.5-transcribe-live'
    && minted.bidiGenerateContentSetup.generationConfig.responseModalities[0] === 'TEXT'
    && new Date(minted.newSessionExpireTime) - Date.now() < 61000, 'live token: single use, constrained REST setup, 1 minute to start, no permanent key');
  check((await call('agent', 'POST', tokenPath, { handle: 42 })).status === 400, 'live token: malformed resumption handle refused');
  const resumed = await call('agent', 'POST', tokenPath, { handle: 'resume-1' });
  check(resumed.body.setup.sessionResumption.handle === 'resume-1', 'live token: session resumption preserved');
  const speech = 'Hinduja Home Care. I need a blood test at home tomorrow.';
  check((await call('agent', 'POST', transcriptPath, { transcript: speech, final: false })).status === 200, 'live checkpoint saved');
  check((await call('agent', 'POST', transcriptPath, { transcript: 'Older words', final: false })).status === 409, 'live checkpoint: a stale or different snapshot cannot erase speech');
  check((await call('agent', 'POST', transcriptPath, { transcript: speech, final: 'yes' })).status === 400, 'live checkpoint validates final flag');
  check((await call('agent', 'POST', transcriptPath, { transcript: 'x'.repeat(100001), final: false })).status === 400, 'live checkpoint enforces size limit');
  check((await call('agent', 'POST', `/api/v1/ai/calls/${liveId}`, {})).status === 409, 'AI summary waits until the call ends');
  await sql`update calls set status = 'completed', ended_at = now() where id = ${liveId}`;
  check((await call('agent', 'POST', `/api/v1/ai/calls/${liveId}`, {})).status === 409, 'call end waits for the live transcript to finalise');
  check((await call('agent', 'POST', tokenPath, {})).status === 409, 'live token: completed calls refused');
  const beforeLiveSummary = geminiCalls.length;
  check((await call('agent', 'POST', transcriptPath, { transcript: speech, final: true })).status === 200, 'finished live transcript saved after call end');
  let liveRow;
  for (let i = 0; i < 30; i++) {
    liveRow = await one(`select ai_status, transcript, ai_summary, ai_extracted->>'transcript_source' source from calls where id = $1`, liveId);
    if (liveRow?.ai_status === 'done') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const liveRequests = geminiCalls.slice(beforeLiveSummary);
  check(liveRow?.ai_status === 'done' && liveRow.transcript === speech && liveRow.source === 'gemini-3.5-transcribe-live' && liveRow.ai_summary,
    'live transcript: automatic summary runs without a recording and preserves authoritative words', JSON.stringify(liveRow));
  check(liveRequests.some((g) => g.hasLiveTranscript) && !liveRequests.some((g) => /upload|files/.test(g.path)), 'live summary uses text only, with no recording upload');
  const liveView = await batch('agent', [sel('v_calls', { cols: 'has_live_transcript,customer_number', filters: [{ col: 'id', op: 'eq', val: liveId }], mode: 'single' })]);
  check(liveView.body.results?.[0]?.data?.has_live_transcript && liveView.body.results[0].data.customer_number !== '+919820012020', 'live v_calls keeps phone masking and exposes transcript availability');
  // the every-minute sweep: a recorded call the webhook never summarised (e.g. brought in by the call-log sync), and a short one
  const [{ id: lateCall }] = await sql`insert into calls (workspace_id, provider, direction, customer_number, status, started_at, ended_at, talk_seconds, recording_filename)
    values (${ws}, 'myoperator', 'inbound', '+919820012012', 'completed', now() - interval '3 minutes', now() - interval '2 minutes', 95, 'rec-late.mp3') returning id::text`;
  const [{ id: longCall }] = await sql`insert into calls (workspace_id, provider, direction, customer_number, status, started_at, ended_at, talk_seconds, recording_filename)
    values (${ws}, 'myoperator', 'inbound', '+919820012014', 'completed', now() - interval '6 minutes', now() - interval '5 minutes', 43904, 'rec-long.mp3') returning id::text`;
  const [{ id: shortCall }] = await sql`insert into calls (workspace_id, provider, direction, customer_number, status, started_at, ended_at, talk_seconds, recording_filename)
    values (${ws}, 'myoperator', 'inbound', '+919820012013', 'completed', now() - interval '5 minutes', now() - interval '5 minutes', 4, 'rec-short.mp3') returning id::text`;
  const tick = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('* * * * *')}`);
  const tickInfo = `scheduled ${tick.status} ${(await tick.text()).slice(0, 80)}`;
  let late = null;
  for (let i = 0; i < 40 && late?.ai_status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    late = await one(`select ai_status, ai_summary, ai_error from calls where id = $1`, lateCall);
  }
  const short = await one(`select ai_status, ai_error from calls where id = $1`, shortCall);
  check(late?.ai_status === 'done' && !!late.ai_summary, 'cron sweep summarises a recorded call the webhook missed', tickInfo + ' ' + JSON.stringify(late));
  check(short?.ai_status === 'skipped' && /talk time/.test(short.ai_error || ''), 'cron sweep skips calls under 10 seconds', JSON.stringify(short));
  const long = await one(`select ai_status, ai_error from calls where id = $1`, longCall);
  check(long?.ai_status === 'skipped' && /Over 2 hours/.test(long.ai_error || ''), 'cron sweep leaves a 12-hour "call" to a person (Gemini limits)', JSON.stringify(long));
  const again = await call('sup', 'POST', '/api/v1/admin/ai', { retry_failed: true });
  const reset = await one(`select ai_status, ai_attempts from calls where id = $1`, longCall);
  check(again.status === 200 && reset?.ai_status === null && reset.ai_attempts === 0, 'Retry failed calls: puts failed / skipped calls back in the queue', JSON.stringify(reset));
  await call('sup', 'POST', '/api/v1/admin/ai', { auto: false });
  aist = await call('agent', 'GET', '/api/v1/ai/status');
  check(aist.body?.enabled === true && aist.body.auto === false, 'auto switch off: summaries on request only', JSON.stringify(aist.body));
  // back to no AI, so later runs start from the same place
  await call('sup', 'POST', '/api/v1/admin/ai', { api_key: '', model: '', auto: true });
  check((await call('agent', 'GET', '/api/v1/ai/status')).body?.enabled === false, 'removing the saved key turns summaries off again');

  // BMM works in the CareDesk portal only: there is no partner API or integration switch (removed 20 Oct 2026).
  check((await call('bmm','GET','/api/v1/bmm/leads')).status === 404,'no BMM partner API to read leads');
  check((await call('bmm','POST',`/api/v1/bmm/leads/${cid}/status`,{})).status === 404,'no BMM partner API to send status');
  check((await rpc('admin','bmm_settings')).status === 403 && (await rpc('sup','set_bmm_integration',{p_enabled:true,p_contract_confirmed:true})).status === 403,'BMM integration settings are gone');
  // The BMM portal login (Provider) sees only its own leads, never calls or assessments.
  for (const table of ['calls','v_calls','discharge_assessments','v_assessments']) {
    check((await batch('bmm',[sel(table)])).status === 403, 'provider denied confidential table '+table);
    check((await data('bmm',table,{op:'select',cols:'*'})).status === 403, 'provider denied direct confidential read '+table);
  }
  const ownRows=await sql.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${U.bmm},true), set_config('request.jwt.claim.role','authenticated',true), set_config('role','caredesk_app',true)`;
    return { refs:await tx`select id,provider_id from case_referrals`, calls:await tx`select id from calls`, assessments:await tx`select id from discharge_assessments` };
  });
  check(ownRows.refs.length>0 && ownRows.refs.every(r=>r.provider_id===bmmProvider) && !ownRows.calls.length && !ownRows.assessments.length,'BMM provider RLS scopes referrals and hides calls/assessments');
  check((await data('bmm','profiles',{op:'update',patch:{integration_only:true},filters:[{col:'id',op:'eq',val:U.bmm}]})).status===403,'provider cannot change its own account type');
  // ---- Administrator: full access, creates staff of any role, opens staff workspaces under its own label
  const admRead = await batch('administrator', [sel('v_cases', { cols: 'id' }), sel('v_calls', { cols: 'id' }), sel('v_audit', { cols: 'id' })]);
  check(admRead.status === 200 && admRead.body.results.every((r) => (r.data || []).length > 0), 'administrator reads cases, calls and the audit trail', JSON.stringify(admRead.body).slice(0, 200));
  check((await call('administrator', 'GET', '/api/v1/admin/integrations')).status === 200 && (await call('administrator', 'GET', '/api/v1/admin/ai')).status === 200,
    'administrator opens integration and AI settings');
  const admAgent = await call('administrator', 'POST', '/api/v1/admin/users', { email: 'administrator.made.agent@rehearsal.test', password: 'longenough-1', full_name: 'Administrator Made Agent', role: 'agent' });
  check(admAgent.status === 200 && admAgent.body?.role === 'agent', 'administrator creates a staff login', JSON.stringify(admAgent.body));
  const admAdm = await call('administrator', 'POST', '/api/v1/admin/users', { email: 'second.administrator@rehearsal.test', password: 'longenough-1', full_name: 'Second Administrator', role: 'administrator' });
  check(admAdm.status === 200 && admAdm.body?.role === 'administrator', 'administrator creates another administrator', JSON.stringify(admAdm.body));
  check((await call('sup', 'POST', '/api/v1/admin/users', { email: 'x2@y.z', password: 'longenough1', full_name: 'X', role: 'agent' })).status === 403, 'a supervisor still cannot create logins');
  const admSess = await call('administrator', 'POST', '/api/v1/staff-sessions/start', { staff_id: U.coord });
  const admH = { 'X-Staff-Session': admSess.body?.id };
  const admMe = await call('administrator', 'GET', '/api/v1/me', undefined, admH);
  check(admSess.status === 200 && admMe.body?.role === 'coordinator' && admMe.body.staffSession?.supervisorName === 'ADMINISTRATOR user',
    'administrator opens a staff workspace', JSON.stringify({ s: admSess.body, me: admMe.body }));
  await call('administrator', 'POST', '/api/v1/data/interactions', { table: 'interactions', op: 'insert', rows: [{ workspace_id: ws, case_id: cid, channel: 'note', direction: 'internal', actor_id: U.coord, summary: 'Administrator workspace test' }] }, admH);
  const [admNote] = await sql`select actor_label from interactions where summary = 'Administrator workspace test'`;
  check(admNote?.actor_label === 'COORD user - Administrator (ADMINISTRATOR user)', 'administrator workspace actions read "Staff - Administrator (Name)"', JSON.stringify(admNote));
  await call('administrator', 'POST', '/api/v1/staff-sessions/end', {}, admH);
  await staffSessionTests({ call, sql, check, U, ws });
  await rateApiTests({ call, sql, check, U, ws });
  await providerFulfilmentApiTests({call,sql,check,U,ws,token,base});
  await feedbackApiTests({ call, sql, check, U, ws });
  return { total, failed };
}
