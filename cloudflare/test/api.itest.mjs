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
};
const ROLE = { agent: 'agent', agent2: 'agent', coord: 'coordinator', sup: 'supervisor', field: 'field_staff', client: 'client_manager',
  clinical: 'client_clinical', admin: 'admin', medical: 'medical_desk' };

export async function runApiTests({ base, token, sql, wrongKey, obdCalls, webhookKey }) {
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
  for (const [k, id] of Object.entries(U)) {
    if (k === 'nobody') continue;
    await sql`insert into profiles (id, workspace_id, full_name, email, role, agent_code, myoperator_user_id)
      values (${id}, ${ws}, ${k.toUpperCase() + ' user'}, ${k + '@rehearsal.test'}, ${ROLE[k]}, ${k.startsWith('agent') ? 'A-0' + (k === 'agent' ? 7 : 8) : null},
        ${k === 'agent' ? 'mo-77' : null}) on conflict (id) do nothing`;
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
  const dial = await call('agent', 'POST', '/api/v1/calls/dial', { callback_id: cb.id });
  check(dial.status === 200 && dial.body?.ok, 'click-to-call accepted', JSON.stringify(dial.body));
  const obd = obdCalls[obdCalls.length - 1];
  check(obd?.body?.user_id === 'mo-77' && obd?.body?.number === '+919930011223' && obd?.headers['x-api-key'] === 'obd-key', 'OBD request: agent id, number, key', JSON.stringify(obd?.body));
  const b3 = { session_id: 'sess-out-1', direction: 'outbound', customer_identifier: '+919930011223' };
  await hook({ ...b3, event_id: 'o1', event_type: 'call.initiated', payload: { client_ref_id: obd?.body?.reference_id } });
  await hook({ ...b3, event_id: 'o2', event_type: 'call.answered', timestamp: t0 + 5, payload: { legs: [{ answered_at: t0 + 5, ring_duration: 5 }] } });
  await hook({ ...b3, event_id: 'o3', event_type: 'call.end', timestamp: t0 + 100, payload: { legs: [{ talk_duration: 95 }] } });
  const out = await one(`select session_id, status from calls where id = $1`, dial.body?.call_id);
  check(out?.session_id === 'sess-out-1' && out?.status === 'completed', 'webhook matched to the CRM call by reference', JSON.stringify(out));
  check((await one(`select status from callbacks where id = $1`, cb.id))?.status === 'done', 'answered call-back closes the queue item');
  await hook({ event_id: 'w1', event_type: 'message.received', customer_identifier: '+919811122233', system_identifier: '+918049368621',
    payload: { conversation: { customer_name: 'Meera Joshi' }, data: { context: { body: 'Need ECG at home tomorrow in Khar' } } } });
  const wa = await one(`select c.source_channel, c.case_no from cases c join patients p on p.id = c.patient_id where p.mobile = '+919811122233'`);
  check(wa?.source_channel === 'whatsapp', 'WhatsApp message opens a case', JSON.stringify(wa));
  const wh = await call('sup', 'GET', '/api/v1/admin/webhooks');
  check(wh.status === 200 && wh.body.length >= 8, 'webhook log visible in Settings', String(wh.body?.length));

  // ---- 6b. MyOperator connection entered in the app (Settings > Telephony)
  check((await call('sup', 'GET', '/api/v1/admin/myoperator')).status === 403, 'MyOperator settings: admin only');
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

  // ---- 8. users
  const nu = await call('admin', 'POST', '/api/v1/admin/users', { email: 'new.agent@rehearsal.test', password: 'longenough1', full_name: 'New Agent', role: 'agent', agent_code: 'A-20' });
  check(nu.status === 200 && nu.body?.role === 'agent', 'admin creates a login and profile', JSON.stringify(nu.body));

  return { total, failed };
}
