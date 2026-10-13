// API checks run by the rehearsal (pipeline step 3c) against the REAL Worker on a database built from the migrations.
// Covers: login required (missing / forged / expired / wrong-audience tokens), role rules per endpoint, Row Level
// Security through the API, the case workflow, MyOperator webhooks + click-to-call, and live updates.
const WS = 'HHC';
const U = {
  agent: 'b0000000-0000-4000-8000-000000000001', agent2: 'b0000000-0000-4000-8000-000000000002',
  coord: 'b0000000-0000-4000-8000-000000000003', sup: 'b0000000-0000-4000-8000-000000000004',
  field: 'b0000000-0000-4000-8000-000000000005', client: 'b0000000-0000-4000-8000-000000000006',
  clinical: 'b0000000-0000-4000-8000-000000000007', admin: 'b0000000-0000-4000-8000-000000000008',
  medical: 'b0000000-0000-4000-8000-000000000009', nobody: 'b0000000-0000-4000-8000-000000000010',
  bmm: 'b0000000-0000-4000-8000-000000000011',
};
const ROLE = { agent: 'agent', agent2: 'agent', coord: 'coordinator', sup: 'supervisor', field: 'field_staff', client: 'client_manager',
  clinical: 'client_clinical', admin: 'admin', medical: 'medical_desk', bmm: 'provider' };

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
  check((await data('agent', 'workspaces', { op: 'update', patch: { brand_name: 'x' }, filters: [{ col: 'id', op: 'eq', val: ws }] })).status === 403, 'agent cannot change workspace settings');
  check((await batch('agent', [sel('audit_log')])).status === 403, 'agent cannot read the audit log');
  check((await batch('sup', [sel('webhook_events')])).status === 403, 'webhook events not readable as a table');
  check((await call('agent', 'GET', '/api/v1/admin/integrations')).status === 403, 'agent cannot see integration settings');
  check((await call('sup', 'GET', '/api/v1/admin/integrations')).status === 200, 'supervisor sees integration settings');
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
  check((await call('agent', 'POST', '/api/v1/calls/dial', { number: '9999999999' })).status === 400, 'agent cannot dial a typed number');
  const beforeMissing = await one(`select count(*)::int n from calls`);
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
  const dial = await call('agent', 'POST', '/api/v1/calls/dial', { callback_id: cb.id });
  check(dial.status === 200 && dial.body?.ok && dial.body.mode === 'api' && !dial.body.number && !dial.body.provider,
    'CRM click-to-call accepted without exposing the number or provider response', JSON.stringify(dial.body));
  const obd = obdCalls[obdCalls.length - 1];
  check(obd?.body?.user_id === 'mo-77' && obd?.body?.type === '1' && obd?.body?.number === '+919930011223'
    && obd?.headers['x-api-key'] === 'obd-key' && obd?.headers['secret-key'] === 'st', 'OBD request: peer-to-peer agent id, number, keys', JSON.stringify(obd?.body));
  const b3 = { session_id: 'sess-out-1', direction: 'outbound', customer_identifier: '+919930011223' };
  await hook({ ...b3, event_id: 'o1', event_type: 'call.initiated', payload: { client_ref_id: obd?.body?.reference_id } });
  await hook({ ...b3, event_id: 'o2', event_type: 'call.answered', timestamp: t0 + 5, payload: { legs: [{ answered_at: t0 + 5, ring_duration: 5 }] } });
  const live = await one(`select cb.status, k.callback_id::text cid from callbacks cb, calls k where cb.id = $1 and k.id = $2`, cb.id, dial.body?.call_id);
  check(live?.status === 'done' && live.cid === cb.id, 'patient connected -> callback done at once, before the call ends (dashboard pending drops live)', JSON.stringify(live));
  await hook({ ...b3, event_id: 'o3', event_type: 'call.end', timestamp: t0 + 100, payload: { legs: [{ talk_duration: 95 }] } });
  const out = await one(`select session_id, status from calls where id = $1`, dial.body?.call_id);
  check(out?.session_id === 'sess-out-1' && out?.status === 'completed', 'webhook matched to the CRM call by reference', JSON.stringify(out));
  check((await one(`select status from callbacks where id = $1`, cb.id))?.status === 'done', 'answered call-back closes the queue item');
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
  // after-call, missed, JSON body with Basic auth -> callback queued
  await hookAs(JSON.stringify({ myoperator: JSON.stringify({ _ai: 'log-2', _cl: '+919876500002', _ev: 1, _su: 2, _st: t0, _et: t0 + 20, _ld: [] }) }), { auth: true });
  check((await one(`select status from callbacks where number = '+919876500002'`))?.status === 'pending', 'missed call from the after-call webhook goes to the callback queue (Basic auth key)');
  const unk = await hookAs(JSON.stringify({ hello: 'world' }));
  const ue = await one(`select processed, error from webhook_events where event_type = 'unknown' order by received_at desc limit 1`);
  check(unk.status === 200 && ue && !ue.processed && /not recognised/.test(ue.error || ''), 'unknown format stored for checking, not lost', JSON.stringify(ue));

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
  const configured = await call('admin', 'GET', '/api/v1/admin/myoperator');
  check(!configured.body.fields.some(f => f.key === 'dial_mode'), 'extension dial mode removed from settings');
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'unknown' } });
  const attempts = obdCalls.length;
  const unknownCall = await call('agent', 'POST', '/api/v1/calls/dial', { case_id: cid });
  const unknownRow = await one(`select status, raw from calls where click_to_call_ref = $1`, obdCalls.at(-1)?.body.reference_id);
  check(unknownCall.status === 504 && obdCalls.length === attempts + 1 && unknownRow?.status === 'ringing'
    && unknownRow.raw?.dial_outcome === 'unconfirmed', 'uncertain provider result does not redial or falsely mark the call failed', JSON.stringify(unknownCall.body));
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'ivr-1' } });

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
  // ---- 7c. post-discharge transition: intake, validation roles, partner sync, metrics
  const tcid = (await rpc('agent', 'create_enquiry', { p: { consent: true, services_requested: 'ICU bed and a nurse',
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

  // ---- 8b. WhatsApp QR login, bridge poll, outbound queue, and live inbound sync
  const wa0 = await call('agent', 'GET', '/api/v1/whatsapp/session');
  check(wa0.status === 200 && wa0.body?.status === 'disconnected', 'WhatsApp session starts disconnected', JSON.stringify(wa0.body));
  const waStart = await call('agent', 'POST', '/api/v1/whatsapp/session', { action: 'start' });
  check(waStart.status === 200 && waStart.body?.status === 'starting', 'agent requests WhatsApp QR login', JSON.stringify(waStart.body));

  const pollQr = await (await hook({ bridge: 'whatsapp_qr', action: 'poll', status: 'qr_ready', qr_svg: '<svg viewBox="0 0 10 10"></svg>' }, newKey)).json();
  check(pollQr.ok && pollQr.command === 'start', 'WhatsApp bridge receives start command and posts QR SVG', JSON.stringify(pollQr));
  const waQr = await call('agent', 'GET', '/api/v1/whatsapp/session');
  check(waQr.status === 200 && waQr.body?.status === 'qr_ready' && waQr.body.qr_svg?.includes('<svg'), 'WhatsApp session returns live QR SVG to UI', JSON.stringify(waQr.body));

  const pollConn = await (await hook({ bridge: 'whatsapp_qr', action: 'poll', status: 'connected', phone: '+919820012345', name: 'Hinduja Home Care Desk' }, newKey)).json();
  check(pollConn.ok && pollConn.status === 'connected', 'WhatsApp bridge marks session connected after QR scan', JSON.stringify(pollConn));
  const waConn = await call('agent', 'GET', '/api/v1/whatsapp/session');
  check(waConn.status === 200 && waConn.body?.connected === true && waConn.body.phone === '+919820012345', 'WhatsApp session reports connected phone', JSON.stringify(waConn.body));

  const waSend = await call('agent', 'POST', '/api/v1/whatsapp/send', { mobile: '9820099887', patient_name: 'Mrs. Meera Joshi', text: 'Namaste, confirming your home ECG slot.' });
  check(waSend.status === 200 && waSend.body?.delivery?.queued === true && waSend.body?.patient_id, 'outbound WhatsApp chat by mobile queues message for QR bridge', JSON.stringify(waSend.body));

  const pollOut = await (await hook({ bridge: 'whatsapp_qr', action: 'poll', status: 'connected' }, newKey)).json();
  const outMsg = (pollOut.outbox || []).find((m) => m.id === waSend.body?.id);
  check(!!outMsg && outMsg.mobile === '+919820099887' && outMsg.body.includes('home ECG slot'), 'WhatsApp bridge poll receives queued outbound message', JSON.stringify(pollOut.outbox));

  const ackRes = await (await hook({ bridge: 'whatsapp_qr', action: 'ack', id: waSend.body?.id, status: 'sent', message_id: 'wamid.qr.1' }, newKey)).json();
  const ackRow = await one(`select meta->>'delivery_status' as st from interactions where id = $1`, waSend.body?.id);
  check(ackRes.ok && ackRow?.st === 'sent', 'WhatsApp bridge ack marks interaction sent', JSON.stringify(ackRow));

  const syncIn = await (await hook({
    bridge: 'whatsapp_qr',
    action: 'sync_messages',
    messages: [
      { id: 'msg-in-1', mobile: '9820099887', name: 'Mrs. Meera Joshi', direction: 'inbound', text: 'Thank you, please come at 8:30 AM.', timestamp: Math.floor(Date.now() / 1000), historical: false },
    ],
  }, newKey)).json();
  check(syncIn.ok && syncIn.imported === 1, 'WhatsApp bridge syncs live inbound reply into CRM', JSON.stringify(syncIn));

  // ---- 9. callback auto-dialer (Hinduja MoM): settings by role, Available switch, cron dials, connect closes
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'ivr-1' } });
  check((await rpc('agent', 'set_autodial', { p_enabled: true, p_buffer_minutes: 30, p_max_attempts: 3 })).status === 403, 'agents cannot change the auto-dialer');
  check((await rpc('field', 'set_my_availability', { p_available: true })).status === 403, 'field staff have no Available switch');
  const adOn = await rpc('sup', 'set_autodial', { p_enabled: true, p_buffer_minutes: 45, p_max_attempts: 3 });
  check(adOn.status === 200 && adOn.body?.data?.enabled && adOn.body.data.buffer_minutes === 45, 'supervisor turns on the auto-dialer (45 min)', JSON.stringify(adOn.body));
  await sql`update callbacks set status = 'done' where status in ('pending','in_progress')`;
  await sql`update calls set status = 'completed' where status in ('ringing','answered')`;
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
  await hook({ ...bA, event_id: 'a3', event_type: 'call.answered', timestamp: Math.floor(Date.now() / 1000), payload: { legs: [{ answered_at: Math.floor(Date.now() / 1000), ring_duration: 4 }] } }, newKey);
  const pend1 = (await rpc('sup', 'dashboard_kpis', { p_from: new Date(Date.now() - 864e5).toISOString(), p_to: new Date(Date.now() + 864e5).toISOString() })).body?.data?.callbacks_pending;
  check(pend0 === 1 && pend1 === 0 && (await one(`select status from callbacks where id = $1`, queued?.id ?? null))?.status === 'done',
    'patient connects -> Callbacks pending 1 -> 0 on the dashboard', JSON.stringify({ pend0, pend1 }));
  await call('admin', 'POST', '/api/v1/admin/myoperator', { values: { public_ivr_id: 'bad' } });
  const [{ id: retryCb }] = await sql`insert into callbacks (workspace_id, number, reason, due_at)
    values (${ws}, '+919930055502', 'missed', now() + interval '10 minutes') returning id::text`;
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
  const badKey = await call('sup', 'POST', `/api/v1/ai/calls/${recCall}`, {});
  const badRow = await one(`select ai_status, ai_error, ai_attempts from calls where id = $1`, recCall);
  check(badKey.status === 502 && badRow?.ai_status === 'failed' && /API key not valid/.test(badRow.ai_error || '') && badRow.ai_attempts === 1,
    'wrong key: the call shows failed with the reason (kept for retry)', JSON.stringify({ body: badKey.body, badRow }));
  aiSet = await call('sup', 'POST', '/api/v1/admin/ai', { api_key: 'gm-test', model: 'gemini-test' });
  const aiTest = await call('sup', 'POST', '/api/v1/admin/ai/test', {});
  check(aiTest.body?.ok === true, 'Test key: Gemini answers', JSON.stringify(aiTest.body));
  check((await call('bmm', 'POST', `/api/v1/ai/calls/${recCall}`, {})).status === 403, 'provider cannot run AI on calls');
  const g0 = geminiCalls.length;
  const aiOk = await call('sup', 'POST', `/api/v1/ai/calls/${recCall}`, {});
  const aiRow = await one(`select ai_status, ai_summary, ai_error, ai_attempts, ai_extracted->>'next_action' na from calls where id = $1`, recCall);
  check(aiOk.status === 200 && aiRow?.ai_status === 'done' && aiRow.ai_summary?.startsWith('Caller asked') && aiRow.na && !aiRow.ai_error && aiRow.ai_attempts === 2,
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
  // the every-minute sweep: a recorded call the webhook never summarised (e.g. brought in by the call-log sync), and a short one
  const [{ id: lateCall }] = await sql`insert into calls (workspace_id, provider, direction, customer_number, status, started_at, ended_at, talk_seconds, recording_filename)
    values (${ws}, 'myoperator', 'inbound', '+919820012012', 'completed', now() - interval '3 minutes', now() - interval '2 minutes', 95, 'rec-late.mp3') returning id::text`;
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
  await call('sup', 'POST', '/api/v1/admin/ai', { auto: false });
  aist = await call('agent', 'GET', '/api/v1/ai/status');
  check(aist.body?.enabled === true && aist.body.auto === false, 'auto switch off: summaries on request only', JSON.stringify(aist.body));
  // back to no AI, so later runs start from the same place
  await call('sup', 'POST', '/api/v1/admin/ai', { api_key: '', model: '', auto: true });
  check((await call('agent', 'GET', '/api/v1/ai/status')).body?.enabled === false, 'removing the saved key turns summaries off again');

  return { total, failed };
}

