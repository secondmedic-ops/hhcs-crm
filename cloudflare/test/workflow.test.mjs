// The whole case workflow on the real migrations (PGlite, in memory): stage gates, locked rate card, discount approval,
// field visit, payment reconciliation, critical-value escalation, row-level visibility per role, audit, SLA scan, MIS.
// Runs in pipeline step 3b (vitest). Requests run as caredesk_app with the user id set, exactly like the Worker does.
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('case workflow, permissions and reporting on the real migrations', async () => {
const problems = [];
const ok = () => {};
const fail = (m) => problems.push(m);
const db = new PGlite();
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));

const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
const users = {
  agent: '11111111-1111-1111-1111-111111111111',
  coord: '22222222-2222-2222-2222-222222222222',
  sup: '33333333-3333-3333-3333-333333333333',
  field: '44444444-4444-4444-4444-444444444444',
  client: '55555555-5555-5555-5555-555555555555',
  admin: '66666666-6666-6666-6666-666666666666',
  agent2: '77777777-7777-7777-7777-777777777777',
};
const roles = { agent: 'agent', coord: 'coordinator', sup: 'supervisor', field: 'field_staff', client: 'client_manager', admin: 'admin', agent2: 'agent' };
for (const [k, id] of Object.entries(users)) {
  await db.query(`insert into profiles(id, workspace_id, full_name, role, agent_code) values ($1,$2,$3,$4,$5)`,
    [id, ws, k.toUpperCase() + ' user', roles[k], k.startsWith('agent') ? 'A-0' + (k === 'agent' ? 7 : 8) : null]);
}

async function as(user, sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [users[user]]);
  await db.exec('set role caredesk_app');
  try {
    return await db.transaction(async (tx) => (await tx.query(sql, params)).rows);
  } finally { await db.exec('reset role'); }
}
async function expectError(user, sql, params, match) {
  try { await as(user, sql, params); fail('expected error: ' + match); }
  catch (e) { (e.message.includes(match) ? ok : fail)('blocked → ' + e.message.slice(0, 90)); }
}

console.log('\nScenario: one patient end to end');
const svc = Object.fromEntries((await db.query(`select code, id from services`)).rows.map(r => [r.code, r.id]));
const [{ create_enquiry: enq }] = await as('agent', `select create_enquiry($1::jsonb)`, [JSON.stringify({
  patient: { full_name: 'R. Sharma', age: 72, gender: 'M', mobile: '98200 12012', address: '12 Link Rd', pincode: '400058', locality: 'Andheri West', lat: 19.1364, lng: 72.8296 },
  caller_name: 'Amit Sharma', caller_relation: 'son', caller_mobile: '9820012012', services_requested: 'Blood tests + ECG',
  consent: true, service_ids: [svc['LAB-PANEL'], svc['ECG-12']],
})]);
/^HHC-\d{6}-00001$/.test(enq.case_no) ? ok('case ID ' + enq.case_no) : fail('case no ' + enq.case_no);
const cid = enq.case_id;

const [masked] = await as('agent', `select patient_mobile, zone_name, subtotal from v_cases where id=$1`, [cid]);
masked.patient_mobile.includes('XXX') ? ok('agent sees masked number ' + masked.patient_mobile) : fail('not masked');
masked.zone_name === 'Andheri' ? ok('zone auto-mapped from pincode') : fail('zone ' + masked.zone_name);
Number(masked.subtotal) === 3700 ? ok('subtotal from locked rate card ₹3700') : fail('subtotal ' + masked.subtotal);

await expectError('agent', `update cases set total = 1 where id=$1`, [cid], 'controlled by workflow');
await expectError('agent', `update cases set stage = 'booking' where id=$1`, [cid], 'controlled by workflow');
await as('agent', `insert into case_items(case_id, service_id, unit_price) values ($1,$2,1)`, [cid, svc['VISIT-STD']]);
const [it] = await as('agent', `select unit_price from case_items where case_id=$1 and service_code='VISIT-STD'`, [cid]);
Number(it.unit_price) === 150 ? ok('client-supplied price ignored (₹150 from rate card)') : fail('price ' + it.unit_price);

await as('agent', `select advance_case($1, null)`, [cid]); ok('enquiry → pricing');
const [d1] = await as('agent', `select set_discount($1, 15, 'Senior citizen') r`, [cid]);
d1.r.status === 'pending_approval' ? ok('15% > 10% band → approval requested') : fail(JSON.stringify(d1));
const tpl = (await db.query(`select id from templates where code='T-03'`)).rows[0].id;
await expectError('agent', `select send_quote($1,$2)`, [cid, tpl], 'approval needed');
await expectError('agent', `select decide_approval(id, true, 'x') from approvals where case_id=$1`, [cid], 'client approver');
const [{ n: notifs }] = await as('client', `select count(*)::int n from notifications where title like 'Discount approval%'`);
notifs === 1 ? ok('client approver notified') : fail('notifs ' + notifs);
await as('client', `select decide_approval(id, true, 'OK for senior') from approvals where case_id=$1 and status='pending'`, [cid]);
ok('client approved discount');
const [q] = await as('agent', `select send_quote($1,$2) r`, [cid, tpl]);
q.r.text.includes('Total payable: ₹3272.50') ? ok('quote rendered: ' + q.r.text.split('\n')[4]) : fail(q.r.text);
await as('agent', `select advance_case($1, null)`, [cid]); ok('pricing → booking');
await expectError('agent', `select advance_case($1, null)`, [cid], 'Stage gate not met');
await as('coord', `select confirm_booking($1, now() + interval '2 hours', $2)`, [cid, users.coord]);
await as('coord', `select advance_case($1, null)`, [cid]); ok('booking → deployment');
const [{ assign_staff: asg }] = await as('coord', `select assign_staff($1,$2,'phlebotomy', now() + interval '100 minutes')`, [cid, users.field]);
const fieldSees = await as('field', `select case_no from v_cases where id=$1`, [cid]);
fieldSees.length === 1 ? ok('field staff sees assigned visit') : fail('field cannot see');
const [{ n: fieldOther }] = await as('field', `select count(*)::int n from v_patients`);
fieldOther === 1 ? ok('field staff sees only their patient') : fail('field sees ' + fieldOther);
const [ci] = await as('field', `select field_update($1,'checkin','{"lat":19.1366,"lng":72.8299}'::jsonb) r`, [asg]);
ok('geo check-in, ' + ci.r.distance_m + ' m from pin');
await as('coord', `select advance_case($1, null)`, [cid]); ok('deployment → completion');
await as('field', `select upsert_sample('{"case_id":"${cid}","barcode":"BC0001","kind":"blood"}'::jsonb)`);
await as('field', `select field_update($1,'complete','{"signoff":true,"checklist":{"consent":true,"id_check":true,"procedure":true}}'::jsonb)`, [asg]);
await as('coord', `select advance_case($1, null)`, [cid]); ok('completion → payment');
await as('field', `select record_payment($1, 3272.50, 'upi', 'UPI123')`, [cid]);
await expectError('agent', `select advance_case($1, null)`, [cid], 'Reconciled');
await as('sup', `select reconcile_payment(id, true) from payments where case_id=$1`, [cid]);
await as('agent', `select advance_case($1, null)`, [cid]); ok('payment → closure (reconciled)');
await as('coord', `select upsert_sample('{"case_id":"${cid}","barcode":"BC0001","critical_flag":true,"critical_note":"K+ 6.8","report_released_at":"2026-10-07T10:00:00Z","delivered_at":"2026-10-07T11:00:00Z"}'::jsonb)`);
const [{ n: esc }] = await as('client', `select count(*)::int n from escalations where case_id=$1 and type='clinical'`, [cid]);
esc === 1 ? ok('critical value → clinical escalation') : fail('esc ' + esc);
await as('agent', `select capture_feedback($1, 5, 'Very professional')`, [cid]);
await expectError('agent2', `select advance_case($1, null)`, [cid], 'case owner');
await as('agent', `select advance_case($1, 'Done')`, [cid]); ok('closure → closed by owner');
await expectError('agent', `update cases set clinical_notes='x' where id=$1`, [cid], 'closed');

console.log('\nGovernance & visibility');
const [{ n: admPat }] = await as('admin', `select count(*)::int n from patients`);
admPat === 0 ? ok('admin sees no patient data') : fail('admin sees ' + admPat);
const [{ n: hist }] = await as('client', `select count(*)::int n from case_stage_history where case_id=$1`, [cid]);
hist === 8 ? ok('8 stamped stage changes') : fail('history ' + hist);
const audit = await as('client', `select changes from audit_log where table_name='cases' and record_id=$1 and action='update'`, [cid]);
audit.length > 5 ? ok(audit.length + ' field-level audit records (old → new)') : fail('audit ' + audit.length);
const tl = await as('client', `select channel, summary from interactions where case_id=$1 order by occurred_at`, [cid]);
ok('timeline: ' + tl.length + ' entries');
const [k] = await as('client', `select dashboard_kpis(now() - interval '1 day', now() + interval '1 day') k`);
ok('dashboard KPIs: funnel ' + JSON.stringify(k.k.funnel));
const [m] = await as('sup', `select mis_report(current_date - 1, current_date) m`);
ok('MIS: revenue ' + JSON.stringify(m.m.revenue) + ', collections ' + m.m.collections.collected);

await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false); select set_config('request.jwt.claim.sub','',false)`);
await db.query(`insert into callbacks(workspace_id, number, due_at) values ($1, '+919800000000', now() - interval '1 minute')`, [ws]);
const s = (await db.query(`select sla_scan() r`)).rows[0].r;
s.breached >= 1 ? ok('SLA scan breached ' + s.breached + ' timer(s) → auto escalation') : fail('scan ' + JSON.stringify(s));
await db.query(`select generate_mis('daily', current_date - 1, current_date - 1)`);
ok('MIS snapshot generated');
await db.exec(`reset role`);
const pid = (await db.query(`select id from patients limit 1`)).rows[0].id;
const callId = (await db.query(`insert into calls(workspace_id, direction, customer_number, patient_id, status) values ($1,'inbound','+919820012012',$2,'completed') returning id`, [ws, pid])).rows[0].id;
const [{ r: e2 }] = await as('agent', `select create_enquiry($1::jsonb) r`, [JSON.stringify({ call_id: callId, consent: true, patient: { address: 'New addr', pincode: '400050' }, services_requested: 'ECG' })]);
e2.patient_id === pid ? ok('enquiry from a known caller reuses the patient (no number needed)') : fail('patient ' + e2.patient_id);
const call2 = (await db.query(`insert into calls(workspace_id, direction, customer_number, status) values ($1,'inbound','+919811122233','completed') returning id`, [ws])).rows[0].id;
const [{ r: e3 }] = await as('agent', `select create_enquiry($1::jsonb) r`, [JSON.stringify({ call_id: call2, consent: true, patient: { full_name: 'New Caller', address: 'A', pincode: '400601' }, services_requested: 'CBC' })]);
const [np] = await as('sup', `select full_name, mobile from patients where id = $1`, [e3.patient_id]);
np.full_name === 'New Caller' && np.mobile === '+919811122233' ? ok('new caller: number taken from the call record') : fail(JSON.stringify(np));

console.log('\nProviders: lead routing, visibility, progress, import');
await db.exec(`reset role`);
const prov = Object.fromEntries((await db.query(`select code, id from providers`)).rows.map((r) => [r.code, r.id]));
users.bmm = '88888888-8888-8888-8888-888888888888';
await db.query(`insert into profiles(id, workspace_id, full_name, role, provider_id) values ($1,$2,'BMM user','provider',$3)`, [users.bmm, ws, prov.BMM]);
try { await db.query(`insert into profiles(id, workspace_id, full_name, role) values ('99999999-9999-9999-9999-999999999999',$1,'No provider','provider')`, [ws]); fail('provider login without provider accepted'); }
catch { ok('provider login needs its provider'); }
const mk = async (extra) => (await as('agent', `select create_enquiry($1::jsonb) r`, [JSON.stringify({ consent: true, ...extra })]))[0].r;
const bm = await mk({ patient: { full_name: 'Nurse Patient', mobile: '9811100001', address: 'Khar W', pincode: '400052' }, branch: 'Khar',
  additional_info: 'Bedridden, needs female nurse', services_requested: 'Nursing and physio', service_ids: [svc['NURS-HOME'], svc['PHYSIO-HOME']] });
const mix = await mk({ patient: { full_name: 'Mixed Patient', mobile: '9811100002', address: 'Mahim', pincode: '400016' }, branch: 'Mahim',
  services_requested: 'ECG and nursing', service_ids: [svc['ECG-12'], svc['NURS-HOME']] });
const txt = await mk({ patient: { full_name: 'Text Patient', mobile: '9811100003', address: 'Dadar', pincode: '400028' }, services_requested: 'Needs a hospital bed and an attendant' });
const refs = async (caseId) => (await db.query(`select pv.code, r.status, r.categories from case_referrals r join providers pv on pv.id = r.provider_id where r.case_id = $1 order by pv.code`, [caseId])).rows;
const r1 = await refs(bm.case_id), r2 = await refs(mix.case_id), r3 = await refs(txt.case_id);
r1.length === 1 && r1[0].code === 'BMM' && r1[0].categories.includes('physio') ? ok('nursing + physio -> Book My Medicare only') : fail('routing bm ' + JSON.stringify(r1));
r2.map((r) => r.code).join() === 'BMM,SM' ? ok('ECG + nursing -> SecondMedic and Book My Medicare') : fail('routing mix ' + JSON.stringify(r2));
r3.length === 1 && r3[0].code === 'BMM' && [...r3[0].categories].sort().join() === 'beds,eldercare' ? ok('free text "bed and attendant" -> Book My Medicare') : fail('routing text ' + JSON.stringify(r3));
const [{ n: smRefs }] = await as('sup', `select count(*)::int n from case_referrals r join providers p on p.id = r.provider_id where r.case_id = $1 and p.code = 'SM'`, [cid]);
smRefs === 1 ? ok('blood test + ECG case -> SecondMedic lead') : fail('sm refs ' + smRefs);
const [bmc] = await as('agent', `select branch, additional_info, provider_names from v_cases where id = $1`, [bm.case_id]);
bmc.branch === 'Khar' && bmc.additional_info.includes('female nurse') && bmc.provider_names === 'Book My Medicare' ? ok('branch, additional info and provider on the case') : fail(JSON.stringify(bmc));
const bmmCases = (await as('bmm', `select id from v_cases`)).map((r) => r.id).sort();
JSON.stringify(bmmCases) === JSON.stringify([bm.case_id, mix.case_id, txt.case_id].sort()) ? ok('Book My Medicare sees only its 3 leads') : fail('bmm sees ' + bmmCases.length);
const [bmmRef] = await as('bmm', `select patient_name, patient_mobile, case_no, additional_info from v_referrals where case_id = $1`, [bm.case_id]);
bmmRef?.patient_mobile === '+919811100001' && bmmRef.case_no && bmmRef.additional_info ? ok('provider gets case ID, patient details and requirements') : fail(JSON.stringify(bmmRef));
const [{ n: bmmRefCount }] = await as('bmm', `select count(*)::int n from case_referrals where case_id = $1`, [mix.case_id]);
bmmRefCount === 1 ? ok('provider sees its own lead only, not SecondMedic\'s') : fail('bmm sees refs ' + bmmRefCount);
const [{ n: bmmCalls }] = await as('bmm', `select count(*)::int n from calls`);
const [{ n: bmmSla }] = await as('bmm', `select count(*)::int n from sla_timers`);
bmmCalls === 0 && bmmSla === 0 ? ok('provider sees no calls / recordings and no SLA timers') : fail(`bmm calls ${bmmCalls} sla ${bmmSla}`);
for (const t of ['approvals', 'payments', 'callbacks', 'complaints', 'assignments', 'qa_reviews', 'inbound_emails', 'escalations', 'v_calls', 'v_callbacks', 'v_assignments', 'v_approvals', 'v_complaints', 'v_whatsapp_chats']) {
  const [{ n }] = await as('bmm', `select count(*)::int n from ${t}`);
  n === 0 ? ok('provider reads nothing from ' + t) : fail(`provider sees ${n} rows of ${t}`);
}
const coordSees = (await as('coord', `select id from v_cases where id = any($1::uuid[])`, [[bm.case_id, mix.case_id, cid]])).map((r) => r.id);
!coordSees.includes(bm.case_id) && coordSees.includes(mix.case_id) && coordSees.includes(cid) ? ok('SecondMedic coordinator sees SecondMedic leads only') : fail('coord sees ' + coordSees.length);
const [{ n: supAll }] = await as('sup', `select count(*)::int n from v_cases where id = any($1::uuid[])`, [[bm.case_id, mix.case_id, txt.case_id]]);
supAll === 3 ? ok('supervisor sees every lead') : fail('sup ' + supAll);
await expectError('bmm', `select advance_case($1, null)`, [bm.case_id], 'Not allowed');
const smRefId = (await db.query(`select r.id from case_referrals r join providers p on p.id = r.provider_id where r.case_id = $1 and p.code = 'SM'`, [mix.case_id])).rows[0].id;
await expectError('bmm', `select update_referral($1, 'accepted')`, [smRefId], 'Not allowed');
await expectError('bmm', `update profiles set provider_id = $1 where id = $2`, [prov.SM, users.bmm], 'Only the platform admin');
// the calling identity of a login is not self-service: an agent cannot take another agent's MyOperator id
await expectError('agent', `update profiles set myoperator_user_id = 'mo-stolen' where id = $1`, [users.agent], 'calling details');
await expectError('agent', `update profiles set active = true, agent_code = 'A-99' where id = $1`, [users.agent], 'calling details');
await as('admin', `update profiles set myoperator_user_id = 'mo-a07' where id = $1`, [users.agent]);
(await db.query(`select myoperator_user_id m from profiles where id = $1`, [users.agent])).rows[0].m === 'mo-a07'
  ? ok('admin links an agent to MyOperator') : fail('admin could not link the agent');
await db.query(`update profiles set myoperator_user_id = null where id = $1`, [users.agent]);
const bmRefId = (await db.query(`select id from case_referrals where case_id = $1`, [bm.case_id])).rows[0].id;
await expectError('bmm', `select update_referral($1, 'declined', '')`, [bmRefId], 'reason');
await as('bmm', `select update_referral($1, 'accepted', 'Nurse Sunita assigned')`, [bmRefId]);
await expectError('bmm', `select update_referral($1, 'scheduled')`, [bmRefId], 'date');
await as('bmm', `select update_referral($1, 'scheduled', null, now() + interval '1 day')`, [bmRefId]);
await as('bmm', `insert into interactions(workspace_id, case_id, channel, actor_id, summary, body) values ($1, $2, 'note', $3, 'Progress note', 'Day 1: vitals stable')`, [ws, bm.case_id, users.bmm]);
await as('bmm', `select update_referral($1, 'completed', 'Course of 5 visits done')`, [bmRefId]);
const [closed] = await as('agent', `select stage from v_cases where id = $1`, [bm.case_id]);
closed.stage === 'closed' ? ok('Book My Medicare completes -> case closes by itself') : fail('stage ' + closed.stage);
const notes = (await as('agent', `select summary from interactions where case_id = $1 order by occurred_at`, [bm.case_id])).map((r) => r.summary);
notes.some((s) => s.startsWith('Lead transferred to Book My Medicare')) && notes.some((s) => s.includes('visit scheduled')) && notes.includes('Progress note')
  && notes.some((s) => s.startsWith('Case closed')) ? ok('timeline: transfer, schedule, progress note, closure (' + notes.length + ')') : fail(JSON.stringify(notes));
await expectError('agent', `select import_cases('[]'::jsonb)`, [], 'Only a supervisor');
const rows = [
  { ref: 'OLD-1001', patient_name: 'Old Patient One', mobile: '9822200001', address: 'Khar', pincode: '400052', branch: 'khar', services: 'Nursing care 12 hrs', status: 'Completed', date: '2026-08-01', notes: 'Served by BMM' },
  { ref: 'OLD-1002', patient_name: 'Old Patient Two', mobile: '9822200002', services: 'ECG at home', status: 'Open', date: '2026-09-15' },
  { ref: 'OLD-1003', patient_name: '', mobile: '9822200003' },
];
const [{ r: imp }] = await as('sup', `select import_cases($1::jsonb) r`, [JSON.stringify(rows)]);
imp.imported === 2 && imp.errors.length === 1 && imp.errors[0].row === 3 ? ok('import: 2 rows in, 1 row reported with its error') : fail('import ' + JSON.stringify(imp));
const [{ r: imp2 }] = await as('sup', `select import_cases($1::jsonb) r`, [JSON.stringify(rows.slice(0, 2))]);
imp2.skipped === 2 && imp2.imported === 0 ? ok('import again: already-imported rows skipped') : fail('reimport ' + JSON.stringify(imp2));
const [old1] = await as('sup', `select stage, branch, external_ref, (created_at at time zone 'Asia/Kolkata')::date::text d, providers_status from v_cases where external_ref = 'OLD-1001'`);
old1?.stage === 'closed' && old1.branch === 'Khar' && old1.d === '2026-08-01' && old1.providers_status?.[0]?.status === 'completed'
  ? ok('imported case keeps old ID, date, branch, status; routed to its provider') : fail(JSON.stringify(old1));
const [old2] = await as('agent', `select stage, case_no from v_cases where external_ref = 'OLD-1002'`);
old2?.stage === 'enquiry' && /^HHC-/.test(old2.case_no) ? ok('open imported case visible to agents with a new Case ID') : fail(JSON.stringify(old2));

console.log('\nScenario: callback auto-dialer (30 / 45 / 60 min buffer, agent availability, done on connect)');
async function system(sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.role', 'service_role', false), set_config('request.jwt.claim.sub', '', false)`);
  try { return (await db.query(sql, params)).rows; }
  finally { await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`); }
}
// clean slate for the queue: earlier scenarios leave callbacks behind
await db.query(`update callbacks set status = 'done' where workspace_id = $1 and status in ('pending','in_progress')`, [ws]);
await expectError('agent', `select set_autodial(true, 30, 3)`, [], 'Only a supervisor');
await expectError('sup', `select set_autodial(true, 20, 3)`, [], '30, 45 or 60');
const [{ r: cfgSet }] = await as('sup', `select set_autodial(true, 30, 3) r`);
cfgSet.enabled && cfgSet.buffer_minutes === 30 && cfgSet.max_attempts === 3 ? ok('supervisor turns the auto-dialer on, 30 min, 3 attempts') : fail(JSON.stringify(cfgSet));
await db.query(`update profiles set myoperator_user_id = 'mo-a07', available = false where id = $1`, [users.agent]);
await db.query(`update profiles set myoperator_user_id = null, available = false where workspace_id = $1 and id <> $2`, [ws, users.agent]);
const [{ id: cbA }] = (await db.query(`insert into callbacks(workspace_id, number, reason, due_at) values ($1, '+919811100001', 'missed', now() + interval '10 minutes') returning id`, [ws])).rows;
const [qA] = (await db.query(`select extract(epoch from due_at - created_at)::int s, next_attempt_at is not null n from callbacks where id = $1`, [cbA])).rows;
qA.s === 1800 && qA.n ? ok('new missed call: due at the end of the 30-minute buffer, queued to dial now') : fail(JSON.stringify(qA));
let [{ c: claim0 }] = await system(`select autodial_claim() c`);
claim0.length === 0 ? ok('no agent Available -> nothing dialled, callback waits') : fail('dialled with nobody available ' + JSON.stringify(claim0));
const [{ r: avail }] = await as('agent', `select set_my_availability(true) r`);
avail.available && avail.linked ? ok('agent marks themselves Available (linked to MyOperator)') : fail(JSON.stringify(avail));
await expectError('client', `select set_my_availability(true)`, [], 'Not allowed');
let [{ c: claim1 }] = await system(`select autodial_claim() c`);
claim1.length === 1 && claim1[0].agent_id === users.agent && claim1[0].myoperator_user_id === 'mo-a07' && claim1[0].number === '+919811100001'
  ? ok('auto-dialer pairs the callback with the free Available agent') : fail(JSON.stringify(claim1));
const [cbRow] = (await db.query(`select status, attempts, assigned_to, auto_dialled from callbacks where id = $1`, [cbA])).rows;
const [callRow] = (await db.query(`select status, direction, callback_id, agent_id from calls where id = $1`, [claim1[0].call_id])).rows;
cbRow.status === 'in_progress' && cbRow.attempts === 1 && cbRow.auto_dialled && callRow.callback_id === cbA && callRow.direction === 'outbound'
  ? ok('callback in progress (attempt 1) with its outbound call row') : fail(JSON.stringify({ cbRow, callRow }));
await db.query(`insert into callbacks(workspace_id, number, reason, due_at) values ($1, '+919811100002', 'abandoned', now())`, [ws]);
let [{ c: claim2 }] = await system(`select autodial_claim() c`);
claim2.length === 0 ? ok('agent already on a call -> second callback is not dialled to them') : fail('double-booked ' + JSON.stringify(claim2));
// the attempt is not answered: back to the queue, next attempt spread across the buffer (30 / 3 = 10 min)
await db.query(`update calls set status = 'failed', ended_at = now() where id = $1`, [claim1[0].call_id]);
const [{ r: retry1 }] = await system(`select callback_retry($1::uuid, 'call failed') r`, [cbA]);
const [cbRetry] = (await db.query(`select status, round(extract(epoch from next_attempt_at - last_attempt_at) / 60)::int gap from callbacks where id = $1`, [cbA])).rows;
retry1 === 'pending' && cbRetry.gap === 10 ? ok('no answer -> next attempt in 10 min') : fail(JSON.stringify({ retry1, cbRetry }));
// second callback is now dialled to the free agent; the patient picks up -> done at once, pending count drops
let [{ c: claim3 }] = await system(`select autodial_claim() c`);
const cbB = claim3[0]?.callback_id;
claim3.length === 1 ? ok('agent free again -> next due callback dialled') : fail(JSON.stringify(claim3));
const [kBefore] = await as('sup', `select (dashboard_kpis(now() - interval '1 day', now() + interval '1 day')->>'callbacks_pending')::int n`);
await db.query(`update calls set status = 'answered', answered_at = now() where id = $1`, [claim3[0].call_id]);
const [{ n: closedN }] = await system(`select callback_connected($1::uuid) n`, [claim3[0].call_id]);
const [kAfter] = await as('sup', `select (dashboard_kpis(now() - interval '1 day', now() + interval '1 day')->>'callbacks_pending')::int n`);
const [cbDone] = (await db.query(`select status, completed_by from callbacks where id = $1`, [cbB])).rows;
closedN === 1 && cbDone.status === 'done' && cbDone.completed_by === users.agent && kAfter.n === kBefore.n - 1
  ? ok(`patient connected -> callback done immediately, Callbacks pending ${kBefore.n} -> ${kAfter.n}`) : fail(JSON.stringify({ closedN, cbDone, kBefore, kAfter }));
// attempts run out -> unreachable with the reason
await db.query(`update callbacks set status = 'in_progress', attempts = 3, last_attempt_at = now() where id = $1`, [cbA]);
const [{ r: retry2 }] = await system(`select callback_retry($1::uuid, 'call failed') r`, [cbA]);
const [cbGone] = (await db.query(`select status, notes from callbacks where id = $1`, [cbA])).rows;
retry2 === 'unreachable' && cbGone.status === 'unreachable' && /3 attempt/.test(cbGone.notes) ? ok('3 attempts without answer -> unreachable, reason noted') : fail(JSON.stringify({ retry2, cbGone }));
// auto-dialer off: manual queue as before, a failed manual call goes back to pending
await as('sup', `select set_autodial(false, 45, 3)`);
const [{ id: cbC }] = (await db.query(`insert into callbacks(workspace_id, number, due_at) values ($1, '+919811100003', now() + interval '10 minutes') returning id`, [ws])).rows;
const [cbManual] = (await db.query(`select extract(epoch from due_at - created_at)::int s, next_attempt_at from callbacks where id = $1`, [cbC])).rows;
let [{ c: claim4 }] = await system(`select autodial_claim() c`);
cbManual.s === 600 && cbManual.next_attempt_at === null && claim4.length === 0 ? ok('auto-dialer off -> 10-minute manual queue, nothing dialled') : fail(JSON.stringify({ cbManual, claim4 }));
await expectError('agent', `select autodial_claim()`, [], 'System only');
const [{ r: adView }] = await as('agent', `select autodial_settings() r`);
adView.enabled === false && adView.buffer_minutes === 45 && adView.agents_available === 1 ? ok('agents read the auto-dial settings and who is Available') : fail(JSON.stringify(adView));
expect(problems).toEqual([]);
}, 120000);
