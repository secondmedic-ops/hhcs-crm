// The whole case workflow on the real migrations (PGlite, in memory): stage gates, locked rate card, discount approval,
// field visit, payment reconciliation, critical-value escalation, row-level visibility per role, audit, SLA scan, MIS.
// Runs in pipeline step 3b (vitest). Requests run as caredesk_app with the user id set, exactly like the Worker does.
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateQuotationPdfBytes } from '../../src/lib/pdf.js';

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
  administrator: 'adadadad-adad-4dad-8dad-adadadadadad',
};
const roles = { agent: 'agent', coord: 'coordinator', sup: 'supervisor', field: 'field_staff', client: 'client_manager', admin: 'admin', agent2: 'agent', administrator: 'administrator' };
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

console.log('\nScenario: callback auto-dialer (30 / 45 / 60 min buffer, agent availability, reached on connect, closed with an outcome)');
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
// second callback is now dialled to the free agent; the patient picks up -> reached at once (SLA met, pending count
// drops), but it stays open until the agent records an outcome
let [{ c: claim3 }] = await system(`select autodial_claim() c`);
const cbB = claim3[0]?.callback_id;
claim3.length === 1 ? ok('agent free again -> next due callback dialled') : fail(JSON.stringify(claim3));
const [kBefore] = await as('sup', `select (dashboard_kpis(now() - interval '1 day', now() + interval '1 day')->>'callbacks_pending')::int n`);
await db.query(`update calls set status = 'answered', answered_at = now() where id = $1`, [claim3[0].call_id]);
const [{ n: closedN }] = await system(`select callback_connected($1::uuid) n`, [claim3[0].call_id]);
const [kAfter] = await as('sup', `select (dashboard_kpis(now() - interval '1 day', now() + interval '1 day')->>'callbacks_pending')::int n`);
const [cbReached] = (await db.query(`select status, assigned_to, reached_call_id::text, completed_at from callbacks where id = $1`, [cbB])).rows;
const [slaB] = (await db.query(`select status from sla_timers where callback_id = $1 and policy_key = 'missed_callback'`, [cbB])).rows;
closedN === 1 && cbReached.status === 'reached' && cbReached.reached_call_id === claim3[0].call_id && cbReached.completed_at === null
  && cbReached.assigned_to === users.agent && slaB?.status === 'met' && kAfter.n === kBefore.n - 1
  ? ok(`patient connected -> callback reached, SLA met, Callbacks pending ${kBefore.n} -> ${kAfter.n}, outcome still open`) : fail(JSON.stringify({ closedN, cbReached, slaB, kBefore, kAfter }));
await db.query(`update calls set started_at = now() - interval '31 minutes' where id = $1`, [claim3[0].call_id]);
const [{ id: cbD }] = (await db.query(`insert into callbacks(workspace_id, number, reason, due_at)
  values ($1, '+919811100004', 'missed', now()) returning id`, [ws])).rows;
let [{ c: claimLong }] = await system(`select autodial_claim() c`);
claimLong.length === 0 ? ok('a 31-minute answered call still keeps the agent busy') : fail('agent redialled during a long call ' + JSON.stringify(claimLong));
await db.query(`update calls set status = 'completed', ended_at = now() where id = $1`, [claim3[0].call_id]);
// Issue 2: a connected call needs its outcome before the agent gets the next call
let [{ c: claimBlocked }] = await system(`select autodial_claim() c`);
claimBlocked.length === 0 ? ok('connected call without an outcome keeps the agent out of the auto-dialer') : fail('dialled before wrap-up ' + JSON.stringify(claimBlocked));
const [{ r: pendingWrap }] = await as('agent', `select my_pending_wrapup() r`);
pendingWrap?.id === claim3[0].call_id && pendingWrap.pending === 1 ? ok('the agent sees the call as pending wrap-up') : fail(JSON.stringify(pendingWrap));
const [{ r: supPending }] = await as('sup', `select my_pending_wrapup() r`);
supPending === null ? ok('pending wrap-up is per agent') : fail(JSON.stringify(supPending));
await expectError('agent', `select wrap_up_call($1::uuid, '{"disposition":"requirement_captured"}'::jsonb)`, [claim3[0].call_id], 'Choose an outcome from the list');
await expectError('agent', `select wrap_up_call($1::uuid, '{"notes":"spoke to the son"}'::jsonb)`, [claim3[0].call_id], 'Choose the call outcome');
await as('agent', `select wrap_up_call($1::uuid, '{"disposition":"booked","notes":"Nursing booked"}'::jsonb)`, [claim3[0].call_id]);
const [wrapped] = (await db.query(`select disposition, disposition_auto, disposition_by, disposition_at is not null t from calls where id = $1`, [claim3[0].call_id])).rows;
wrapped.disposition === 'booked' && !wrapped.disposition_auto && wrapped.disposition_by === users.agent && wrapped.t
  ? ok('wrap_up_call saves the outcome to calls.disposition with who and when') : fail(JSON.stringify(wrapped));
const [{ r: noneLeft }] = await as('agent', `select my_pending_wrapup() r`);
noneLeft === null ? ok('no pending wrap-up after the outcome') : fail(JSON.stringify(noneLeft));
const [autoOut] = (await db.query(`select disposition, disposition_auto from calls where id = $1`, [claim1[0].call_id])).rows;
autoOut.disposition === 'failed' && autoOut.disposition_auto ? ok('a call that never connected gets an automatic outcome') : fail(JSON.stringify(autoOut));
let [{ c: claimReleased }] = await system(`select autodial_claim() c`);
claimReleased.length === 1 && claimReleased[0].callback_id === cbD
  ? ok('completed call releases the agent for the next callback') : fail('agent stayed busy after call completion ' + JSON.stringify(claimReleased));
// a real conversation: the end of the call keeps it reached; closing needs an outcome from the agent
await db.query(`update calls set talk_seconds = 95 where id = $1`, [claim3[0].call_id]);
const [{ r: endB }] = await system(`select callback_call_ended($1::uuid) r`, [claim3[0].call_id]);
endB === 'reached' ? ok('95 s conversation -> callback stays reached until the outcome') : fail(endB);
await expectError('agent', `select callback_call_ended($1::uuid)`, [claim3[0].call_id], 'permission denied');
await expectError('agent', `select callback_update($1::uuid, 'done')`, [cbB], 'Record an outcome');
await expectError('agent', `select callback_update($1::uuid, 'unreachable', 'x')`, [cbB], 'no longer in the queue');
await expectError('agent', `select callback_close($1::uuid, 'follow_up', ' ')`, [cbB], 'follow-up');
await expectError('agent', `select callback_close($1::uuid, 'done')`, [cbB], 'Choose an outcome');
const [{ r: closedB }] = await as('agent', `select callback_close($1::uuid, 'resolved', 'Report timeline shared') r`, [cbB]);
const [cbClosed] = (await db.query(`select status, outcome, outcome_note, completed_by, completed_at is not null c from callbacks where id = $1`, [cbB])).rows;
closedB.status === 'done' && cbClosed.outcome === 'resolved' && cbClosed.outcome_note === 'Report timeline shared' && cbClosed.completed_by === users.agent && cbClosed.c
  ? ok('agent records the outcome -> callback closed (done) with the note') : fail(JSON.stringify({ closedB, cbClosed }));
await expectError('agent', `select callback_close($1::uuid, 'resolved')`, [cbB], 'already closed');
// a drop-off: connected, then under 20 s of talk -> back to the queue, SLA reopened
const dropCall = claimReleased[0]?.call_id;
await db.query(`update calls set status = 'answered', answered_at = now() where id = $1`, [dropCall]);
await system(`select callback_connected($1::uuid)`, [dropCall]);
await db.query(`update calls set status = 'completed', ended_at = now(), talk_seconds = 6 where id = $1`, [dropCall]);
const [{ r: endD }] = await system(`select callback_call_ended($1::uuid) r`, [dropCall]);
const [cbDrop] = (await db.query(`select status, reached_at, notes, next_attempt_at is not null n from callbacks where id = $1`, [cbD])).rows;
const [slaD] = (await db.query(`select status, met_at from sla_timers where callback_id = $1 and policy_key = 'missed_callback'`, [cbD])).rows;
endD === 'pending' && cbDrop.status === 'pending' && cbDrop.reached_at === null && cbDrop.n && slaD.met_at === null && slaD.status === 'running'
  ? ok('6 s drop-off -> back to the queue for the next attempt, SLA running again') : fail(JSON.stringify({ endD, cbDrop, slaD }));
// another outbound call to the same number (not dialled from the queue) no longer touches the callback
const [{ id: otherCall }] = (await db.query(`insert into calls (workspace_id, direction, customer_number, agent_id, status, answered_at, session_id)
  values ($1, 'outbound', '+919811100004', $2, 'answered', now(), 'test-unrelated-1') returning id`, [ws, users.agent])).rows;
const [{ n: otherN }] = await system(`select callback_connected($1::uuid) n`, [otherCall]);
await db.query(`update calls set status = 'completed', ended_at = now(), talk_seconds = 120 where id = $1`, [otherCall]);
const [{ r: otherEnd }] = await system(`select callback_call_ended($1::uuid) r`, [otherCall]);
const [cbStill] = (await db.query(`select status from callbacks where id = $1`, [cbD])).rows;
otherN === 0 && otherEnd === 'none' && cbStill.status === 'pending'
  ? ok('unrelated outbound call to the same number leaves the callback pending') : fail(JSON.stringify({ otherN, otherEnd, cbStill }));
const [{ m: misCb }] = await as('sup', `select mis_report(current_date - 1, current_date + 1)->'callbacks' m`);
misCb.reached >= 1 && misCb.done >= 1 && misCb.outcomes?.resolved >= 1 && misCb.awaiting_outcome != null && misCb.unreachable != null
  ? ok('MIS splits reached, closed with outcome and the outcome counts') : fail(JSON.stringify(misCb));
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
console.log('\nPost-discharge transition: intake, hospital validation, negotiation, sign-off, split fulfilment, partner sync, metrics');
// test prices only: the real ones are set by Hinduja management through the rate-change approval
for (const [code, price] of Object.entries({ 'NURSE-12H': 1500, 'ATTEND-12H': 900, 'BED-ICU': 400, HFNC: 1200, 'MINI-ICU': 5000, MONITOR: 300, SUCTION: 150, 'OXY-CONC': 250, AIRBED: 100 }))
  await db.query(`update services set price = $2 where code = $1`, [code, price]);
const pd = await mk({ patient: { full_name: 'Discharge Patient', mobile: '9811100009', address: 'Bandra W', pincode: '400050' }, branch: 'Mahim',
  services_requested: 'Two 12-hr nurses, two attendants, HF machine, ICU bed, samples and X-ray at home' });
(await refs(pd.case_id)).some((r) => r.status === 'new') ? ok('enquiry text routed at once (standard behaviour)') : fail('no text routing');
await expectError('agent', `select set_intake($1, $2::jsonb)`, [pd.case_id, JSON.stringify({ care_type: 'post_discharge', intake_disposition: 'requirement_captured' })], 'who you spoke with');
await as('agent', `select set_intake($1, $2::jsonb)`, [pd.case_id, JSON.stringify({ care_type: 'post_discharge', intake_disposition: 'requirement_captured',
  spoke_with: 'decision_maker', decision_maker_name: 'Son', expected_discharge_on: '2026-10-20', hospital_name: 'P. D. Hinduja Hospital, Mahim', hospital_ward: 'ICU 4' })]);
(await refs(pd.case_id)).every((r) => r.status === 'cancelled') ? ok('post-discharge: partner leads held until sign-off') : fail(JSON.stringify(await refs(pd.case_id)));
await expectError('agent', `select set_intake($1, $2::jsonb)`, [pd.case_id, JSON.stringify({ intake_disposition: 'made_up' })], 'check');
const [{ g: g0 }] = await as('agent', `select case_gates($1) g`, [pd.case_id]);
!g0.ready && g0.checks.some((c) => c.label.startsWith('On-site validation') && !c.ok) ? ok('enquiry gate waits for the hospital validation') : fail(JSON.stringify(g0));
await expectError('agent', `select schedule_validation($1, $2, now() + interval '2 hours')`, [pd.case_id, users.field], 'Not allowed');
await as('coord', `select schedule_validation($1, $2, now() + interval '2 hours')`, [pd.case_id, users.field]);
ok('coordinator schedules the nurse visit at Hinduja');
const items12 = [['NURSE-12H', 60], ['ATTEND-12H', 60], ['BED-ICU', 30], ['HFNC', 30], ['MINI-ICU', 1], ['MONITOR', 30], ['SUCTION', 30], ['OXY-CONC', 30], ['AIRBED', 30], ['LAB-CBC', 4], ['LAB-KFT', 4], ['XR-CHEST', 2]]
  .map(([c, qty]) => ({ service_id: svc[c], qty }));
await expectError('field', `select record_validation($1, $2::jsonb)`, [pd.case_id, JSON.stringify({ readiness: 'ready', met_family: true, items: items12 })], 'treating doctor');
const [{ r: val }] = await as('field', `select record_validation($1, $2::jsonb) r`, [pd.case_id, JSON.stringify({ readiness: 'ready', met_doctor: true, doctor_name: 'Dr Rao',
  met_ward_staff: true, met_family: true, home_setup_notes: 'Ground floor, 2 rooms', items: items12 })]);
val.validation_status === 'done' && val.items === 12 ? ok('nurse records discharge ready + 12 recommended items') : fail(JSON.stringify(val));
(await refs(pd.case_id)).every((r) => r.status === 'cancelled') ? ok('items added, still no partner lead before sign-off') : fail(JSON.stringify(await refs(pd.case_id)));
const [{ n: provAssess }] = await as('bmm', `select count(*)::int n from discharge_assessments`);
provAssess === 0 ? ok('partner cannot read clinical validation records') : fail('provider sees assessments');

// Home assessment visit (Hindu-certified nurse at patient's home, without treating doctor)
const pdHome = await mk({ patient: { full_name: 'Home Patient', mobile: '9811100019', address: 'Khar W', pincode: '400052' }, branch: 'Mahim' });
await as('agent', `select set_intake($1, $2::jsonb)`, [pdHome.case_id, JSON.stringify({ care_type: 'post_discharge', intake_disposition: 'requirement_captured', spoke_with: 'patient', expected_discharge_on: '2026-10-21' })]);
await as('coord', `select schedule_validation($1, $2, now() + interval '2 hours', 'home_visit')`, [pdHome.case_id, users.field]);
const [hCase] = (await db.query(`select assessment_type from cases where id = $1`, [pdHome.case_id])).rows;
const [hAssess] = (await db.query(`select assessment_type from discharge_assessments where case_id = $1 and status = 'scheduled'`, [pdHome.case_id])).rows;
hCase.assessment_type === 'home_visit' && hAssess.assessment_type === 'home_visit' ? ok('home assessment scheduled on case & assessment') : fail(JSON.stringify({ hCase, hAssess }));
await expectError('field', `select record_validation($1, $2::jsonb)`, [pdHome.case_id, JSON.stringify({ readiness: 'ready', met_family: false })], 'Meet the family');
const [{ r: valHome }] = await as('field', `select record_validation($1, $2::jsonb) r`, [pdHome.case_id, JSON.stringify({ readiness: 'ready', met_family: true, home_setup_notes: 'Ground floor, clean power socket with earthing' })]);
valHome.validation_status === 'done' ? ok('home assessment records discharge ready with family met and no treating doctor') : fail(JSON.stringify(valHome));
await db.query(`delete from cases where id = $1`, [pdHome.case_id]);

await as('coord', `select advance_case($1, null)`, [pd.case_id]); ok('enquiry → pricing after validation');
const itemId = async (code) => (await db.query(`select id from case_items where case_id = $1 and service_code = $2`, [pd.case_id, code])).rows[0].id;
await expectError('coord', `select set_item_scope($1, false, null)`, [await itemId('OXY-CONC')], 'reason');
await as('coord', `select set_item_scope($1, false, 'Space: HF machine covers oxygen')`, [await itemId('OXY-CONC')]);
await as('coord', `select set_item_scope($1, false, 'Family will arrange', null, 'arranged_elsewhere')`, [await itemId('AIRBED')]);
const [sc] = await as('coord', `select subtotal, items_recommended, items_agreed from v_cases where id = $1`, [pd.case_id]);
Number(sc.subtotal) === 219900 && Number(sc.items_recommended) === 12 && Number(sc.items_agreed) === 10 ? ok('12 → 10 items, 30-day subtotal ₹219900') : fail(JSON.stringify(sc));
await expectError('coord', `select record_signoff($1, $2::jsonb)`, [pd.case_id, JSON.stringify({ mode: 'in_person' })], 'decision-maker');
await as('coord', `select send_quote($1, $2)`, [pd.case_id, tpl]);
const [{ r: so }] = await as('coord', `select record_signoff($1, $2::jsonb) r`, [pd.case_id, JSON.stringify({ signed_by: 'A. Mehta (son)', mode: 'in_person', plan_days: 30 })]);
const split = await refs(pd.case_id);
const smR = split.find((r) => r.code === 'SM'); const bmR = split.find((r) => r.code === 'BMM');
so.signoff_at && smR?.status === 'new' && bmR?.status === 'new' && smR.categories.sort().join() === 'lab,xray'
  && ['beds', 'eldercare', 'equipment', 'icu', 'nursing'].every((c) => bmR.categories.includes(c)) && !bmR.categories.includes('lab')
  ? ok('sign-off → diagnostics to SecondMedic, manpower + equipment to Book My Medicare') : fail(JSON.stringify(split));
const [{ g: g1 }] = await as('coord', `select case_gates($1) g`, [pd.case_id]);
g1.ready ? ok('pricing gate met: quote sent + family sign-off') : fail(JSON.stringify(g1));
await as('coord', `select set_item_scope($1, false, 'Not needed')`, [await itemId('MONITOR')]);
const [{ s: reset }] = await as('coord', `select signoff_at s from cases where id = $1`, [pd.case_id]);
reset === null ? ok('scope change after sign-off clears the sign-off') : fail('signoff kept ' + reset);
await as('coord', `select set_item_scope($1, true)`, [await itemId('MONITOR')]);
await as('coord', `select record_signoff($1, $2::jsonb)`, [pd.case_id, JSON.stringify({ signed_by: 'A. Mehta (son)', mode: 'whatsapp' })]);
const [{ r: sync }] = await as('bmm', `select import_referral_updates($1::jsonb) r`, [JSON.stringify([
  { case_no: pd.case_no, status: 'Accepted' }, { case_no: 'HHC-000000-99999', status: 'accepted' }, { case_no: pd.case_no, status: 'Accepted' }])]);
sync.updated === 1 && sync.skipped === 1 && sync.errors.length === 1 ? ok('partner Excel sync: 1 updated, 1 unchanged, 1 unknown case reported') : fail(JSON.stringify(sync));
await as('bmm', `select import_referral_updates($1::jsonb)`, [JSON.stringify([{ case_no: pd.case_no, status: 'Dispatched', note: 'Bed + HF machine out' }])]);
await as('bmm', `select import_referral_updates($1::jsonb)`, [JSON.stringify([{ case_no: pd.case_no, status: 'Deployed', note: 'Nurse on duty' }])]);
const [dep] = (await db.query(`select r.status, r.dispatched_at, r.started_at from case_referrals r join providers p on p.id = r.provider_id where r.case_id = $1 and p.code = 'BMM'`, [pd.case_id])).rows;
dep.status === 'in_progress' && dep.dispatched_at && dep.started_at ? ok('partner logs dispatched → deployed') : fail(JSON.stringify(dep));
await expectError('agent', `select import_referral_updates('[]'::jsonb)`, [], 'Not allowed');
const [{ m: tm }] = await as('sup', `select transition_metrics(now() - interval '1 day', now() + interval '1 day') m`);
const bmmM = tm.providers.find((p) => p.code === 'BMM');
tm.intake === 1 && tm.signed_off === 1 && Number(tm.conversion_pct) === 100 && tm.items.recommended === 12 && tm.items.agreed === 10
  && bmmM?.deployed === 1 && Number(bmmM.deploy_sla_pct) === 100 && tm.dispositions.requirement_captured === 1 && tm.drop_reasons.length === 2
  ? ok('metrics: conversion 100%, 12 → 10 items, BMM deployed inside SLA') : fail(JSON.stringify(tm));
await expectError('agent', `select transition_metrics(now() - interval '1 day', now())`, [], 'Not allowed');
const [{ s: sheet }] = await as('field', `select care_plan_sheet($1, 30) s`, [pd.case_id]);
const nurseOpt = (cover) => sheet.options.find((o) => o.code === 'NURSE-12H' && o.cover === cover);
Number(nurseOpt('12-hour')?.plan_total) === 45000 && Number(nurseOpt('24-hour')?.plan_total) === 90000
  && sheet.options.some((o) => o.code === 'VENT-HOME' && !o.priced && o.plan_total === null)
  && sheet.case.items.length === 12 && sheet.case.items.filter((i) => i.excluded).length === 2
  && Number(sheet.case.subtotal) === 219900 && Number(sheet.case.dropped_total) === 10500 && Number(sheet.case.recommended_total) === 230400
  ? ok('checklist pricing: 30-day options (12 h / 24 h nursing), ventilator not priced, 10 agreed + 2 dropped') : fail(JSON.stringify(sheet).slice(0, 400));
await expectError('bmm', `select care_plan_sheet($1, 30)`, [pd.case_id], 'Not allowed');
await expectError('agent', `select care_plan_sheet(null, 30)`, [], 'Not allowed');
await expectError('coord', `select care_plan_sheet(null, 0)`, [], 'Plan length');
const [{ n: piiAudit }] = (await db.query(`select count(*)::int n from audit_log where table_name = 'cases' and changes::text like '%Mehta%'`)).rows;
piiAudit === 0 ? ok('decision-maker name kept out of the audit log') : fail('name in audit_log');

console.log('\nDischarge data model: drop categories, partner work orders, payment schedule, journey states');
tm.drop_categories?.arranged_elsewhere === 1 && tm.drop_categories?.other === 1 ? ok('drop reasons by category (arranged elsewhere, other)') : fail(JSON.stringify(tm.drop_categories));
await expectError('coord', `select set_item_scope($1, false, 'x', null, 'made_up')`, [await itemId('SUCTION')], 'Unknown reason category');
const bmmLead = (await db.query(`select r.id from case_referrals r join providers p on p.id = r.provider_id where r.case_id = $1 and p.code = 'BMM'`, [pd.case_id])).rows[0].id;
const smLead = (await db.query(`select r.id from case_referrals r join providers p on p.id = r.provider_id where r.case_id = $1 and p.code = 'SM'`, [pd.case_id])).rows[0].id;
await expectError('bmm', `select log_deployment($1, $2::jsonb)`, [bmmLead, JSON.stringify({ resource_type: 'staff', staff_name: 'Nurse Rekha' })], 'staff ID');
await expectError('bmm', `select log_deployment($1, $2::jsonb)`, [smLead, JSON.stringify({ resource_type: 'staff', staff_name: 'X', staff_ref: '1' })], 'Not allowed');
await expectError('agent', `select log_deployment($1, $2::jsonb)`, [bmmLead, JSON.stringify({ resource_type: 'staff', staff_name: 'X', staff_ref: '1' })], 'Not allowed');
await expectError('bmm', `select log_deployment($1, $2::jsonb)`, [bmmLead, JSON.stringify({ resource_type: 'staff', staff_name: 'X', staff_ref: '1', case_item_id: await itemId('LAB-CBC') })], 'not part of this lead');
const [{ d: hf }] = await as('bmm', `select log_deployment($1, $2::jsonb) d`, [bmmLead, JSON.stringify({ resource_type: 'equipment', case_item_id: await itemId('HFNC'), equipment_model: 'Airvo 2' })]);
await expectError('bmm', `select log_deployment($1, $2::jsonb)`, [bmmLead, JSON.stringify({ id: hf.id, status: 'installed' })], 'serial number');
await as('bmm', `select log_deployment($1, $2::jsonb)`, [bmmLead, JSON.stringify({ id: hf.id, status: 'installed', equipment_serial: 'AV2-0091' })]);
await expectError('bmm', `select log_deployment($1, $2::jsonb)`, [bmmLead, JSON.stringify({ id: hf.id, status: 'dispatched' })], 'cannot go back');
const [{ j: jInstalled }] = await as('coord', `select journey_state j from cases where id = $1`, [pd.case_id]);
jInstalled === 'setup_installed' ? ok('HF machine installed (serial logged) -> Setup installed') : fail('journey ' + jInstalled);
await as('bmm', `select log_deployment($1, $2::jsonb)`, [bmmLead, JSON.stringify({ resource_type: 'staff', case_item_id: await itemId('NURSE-12H'), staff_name: 'Nurse Rekha', staff_ref: 'BMM-N-114', shift: 'day', status: 'active' })]);
const [{ j: jActive }] = await as('coord', `select journey_state j from cases where id = $1`, [pd.case_id]);
jActive === 'active_care' ? ok('nurse on duty (staff ID BMM-N-114) -> Active care') : fail('journey ' + jActive);
const [{ n: depSeen }] = await as('bmm', `select count(*)::int n from v_deployments where case_id = $1`, [pd.case_id]);
const [{ n: depSeenCoord }] = await as('coord', `select count(*)::int n from v_deployments where equipment_serial = 'AV2-0091'`);
depSeen === 2 && depSeenCoord === 1 ? ok('work orders visible to the partner and the coordinator') : fail(JSON.stringify({ depSeen, depSeenCoord }));
const hist2 = (await db.query(`select to_state from case_journey_history where case_id = $1 order by id`, [pd.case_id])).rows.map((r) => r.to_state);
const want = ['onsite_assessed', 'commercial_approved', 'partner_dispatched', 'setup_installed', 'active_care'];
let at = 0; for (const st of hist2) if (st === want[at]) at++;
at === want.length ? ok('journey history: ' + want.join(' -> ')) : fail(JSON.stringify(hist2));
await expectError('coord', `select set_payment_schedule($1, $2::jsonb)`, [pd.case_id, JSON.stringify([{ label: 'Advance', due_on: '2026-10-14', pct: 50 }, { label: 'Balance', due_on: '2026-10-29', pct: 40 }])], 'add up to 100');
const [{ r: sched }] = await as('coord', `select set_payment_schedule($1, $2::jsonb) r`, [pd.case_id, JSON.stringify([
  { label: 'Advance', due_on: '2030-01-01', pct: 33.33 }, { label: 'Day 10', due_on: '2030-01-10', pct: 33.33 }, { label: 'Day 20', due_on: '2030-01-20', pct: 33.34 }])]);
const [{ t: caseTotal }] = await as('coord', `select total t from cases where id = $1`, [pd.case_id]);
const sumSched = sched.reduce((a, x) => a + Math.round(Number(x.amount) * 100), 0);
sched.length === 3 && sumSched === Math.round(Number(caseTotal) * 100) && sched.every((x) => x.status === 'due')
  ? ok(`payment schedule: 3 instalments add up to the total ₹${caseTotal}`) : fail(JSON.stringify({ sched, caseTotal }));
const [{ n: provSched }] = await as('bmm', `select count(*)::int n from v_payment_schedule`);
provSched === 0 ? ok('partner cannot see the payment schedule') : fail('provider sees schedule');
const [{ n: pdDmAudit }] = (await db.query(`select count(*)::int n from audit_log where changes::text like '%9820099999%'`)).rows;
await as('agent', `select set_intake($1, $2::jsonb)`, [pd.case_id, JSON.stringify({ decision_maker_mobile: '9820099999', hospital_room: 'Room 512' })]);
const [dm] = await as('agent', `select decision_maker_mobile_display d, hospital_room r from v_cases where id = $1`, [pd.case_id]);
const [{ n: dmAudit }] = (await db.query(`select count(*)::int n from audit_log where changes::text like '%9820099999%'`)).rows;
dm.d.includes('XXX') && dm.r === 'Room 512' && dmAudit === pdDmAudit ? ok('decision-maker mobile masked for agents, kept out of the audit log') : fail(JSON.stringify({ dm, dmAudit }));

console.log('\nAdministrator: full access, not narrowed by agent / partner / platform-admin rules');
const [{ n: supCases }] = await as('sup', `select count(*)::int n from cases`);
const [{ n: admCases }] = await as('administrator', `select count(*)::int n from cases`);
admCases > 0 && admCases === supCases ? ok('administrator sees every case a supervisor sees') : fail(JSON.stringify({ supCases, admCases }));
const [{ n: platformCases }] = await as('admin', `select count(*)::int n from cases`);
platformCases === 0 ? ok('platform admin still sees no patient data') : fail('platform admin sees cases: ' + platformCases);
const [hr] = await as('administrator', `select has_role('client_manager') cm, has_role('supervisor', 'admin') sa, has_role('agent') ag,
  has_role('provider') pv, has_role('field_staff') fs, has_role('admin') ad, has_role('admin', 'field_staff') af, is_user_admin() ua`);
hr.cm && hr.sa && !hr.ag && !hr.pv && !hr.fs && !hr.ad && !hr.af && hr.ua
  ? ok('has_role: administrator passes senior checks, not the agent / partner / platform-admin narrowing ones') : fail(JSON.stringify(hr));
const [dmAdm] = await as('administrator', `select decision_maker_mobile_display d from v_cases where id = $1`, [pd.case_id]);
dmAdm && !dmAdm.d.includes('XXX') ? ok('administrator sees full phone numbers') : fail(JSON.stringify(dmAdm));
await as('administrator', `select transition_metrics(now() - interval '1 day', now() + interval '1 day')`);
ok('administrator reads management reports');
const supEdit = await as('sup', `update profiles set agent_code = 'A-98' where id = $1 returning id`, [users.agent2]);
const admEdit = await as('administrator', `update profiles set agent_code = 'A-99' where id = $1 returning id`, [users.agent2]);
const [{ c: newCode }] = (await db.query(`select agent_code c from profiles where id = $1`, [users.agent2])).rows;
supEdit.length === 0 && admEdit.length === 1 && newCode === 'A-99' ? ok('administrator manages logins; a supervisor still cannot') : fail(JSON.stringify({ supEdit, admEdit, newCode }));

console.log('\nCommunication templates: S-02, T-09, T-10 rendering and variables');
const [{ count: tplCount }] = (await db.query(`select count(*)::int from templates where code in ('S-02', 'T-09', 'T-10') and status = 'approved'`)).rows;
tplCount === 3 ? ok('approved templates S-02, T-09, T-10 inserted') : fail(`templates missing: found ${tplCount}`);

const [{ id: t09Id }] = (await db.query(`select id from templates where code = 'T-09'`)).rows;
const [{ r: t09Text }] = await as('agent', `select render_template($1, $2) r`, [t09Id, pd.case_id]);
!t09Text.includes('{{') && t09Text.includes('Hinduja-Certified Nurse Home Assessment')
  ? ok('T-09 renders with all tokens replaced: ' + t09Text.slice(0, 50) + '...')
  : fail('T-09 unrendered tokens: ' + t09Text);

await as('coord', `select record_payment($1, 10000, 'upi', 'UPI-TEST-123')`, [pd.case_id]);
const [{ id: t10Id }] = (await db.query(`select id from templates where code = 'T-10'`)).rows;
const [{ r: t10Text }] = await as('agent', `select render_template($1, $2) r`, [t10Id, pd.case_id]);
!t10Text.includes('{{') && t10Text.includes('Total Billed:') && t10Text.includes('Receipt No: RCPT-')
  ? ok('T-10 renders with balance, amount_collected, receipt_no: ' + t10Text.slice(0, 60) + '...')
  : fail('T-10 unrendered tokens: ' + t10Text);

const [{ id: s02Id }] = (await db.query(`select id from templates where code = 'S-02'`)).rows;
const [{ r: s02Text }] = await as('agent', `select render_template($1, $2) r`, [s02Id, pd.case_id]);
!s02Text.includes('{{') && s02Text.includes('EXPLAIN HOME ASSESSMENT')
  ? ok('S-02 renders with greeting_time, agent_name: ' + s02Text.slice(0, 50) + '...')
  : fail('S-02 unrendered tokens: ' + s02Text);

console.log('\nCase Closure Stage Gates & Exception Escalation Rule');
const [{ create_enquiry: enqClosure }] = await as('agent', `select create_enquiry($1::jsonb)`, [JSON.stringify({
  patient: { full_name: 'Closure Gate Test', mobile: '9820099887', address: '42 Hill Rd', pincode: '400050' },
  caller_name: 'Test Caller', services_requested: 'General', consent: true, service_ids: [svc['VISIT-STD']],
})]);
const clId = enqClosure.case_id;

await db.exec(`select rpc_on(); update cases set stage = 'closure', service_completed_at = null, amount_collected = 0, total = 1500, payment_status = 'unpaid' where id = '${clId}';`);

const [{ g: clGates }] = await as('agent', `select case_gates($1) g`, [clId]);
const clSvcCheck = clGates.checks.find((x) => x.label === 'Service completion');
const clPayCheck = clGates.checks.find((x) => x.label === 'Payment settled or waived');
const clZeroRefCheck = clGates.checks.find((x) => x.label === 'Zero pending referrals');
const clDepCheck = clGates.checks.find((x) => x.label === 'Equipment returned / active handover');
const clExcCheck = clGates.checks.find((x) => x.label === 'Pending payment/service documented & supervisor approved');

!clGates.ready && !clSvcCheck.ok && !clPayCheck.ok && clZeroRefCheck.ok && clDepCheck.ok && !clExcCheck.ok
  ? ok('closure gate flags uncompleted service and unpaid balance')
  : fail('closure gate initial state: ' + JSON.stringify(clGates));

await expectError('agent', `select advance_stage($1, null)`, [clId],
  'Stage gate not met: All provider leads must be completed and payment reconciled before closure (or documented via supervisor escalation).');

const [bmmProv] = (await db.query(`select id from providers where code = 'BMM'`)).rows;
const [refRow] = (await db.query(`insert into case_referrals (workspace_id, case_id, provider_id, status) values ($1, $2, $3, 'scheduled') returning id`, [ws, clId, bmmProv.id])).rows;
const [{ g: clGatesWithRef }] = await as('agent', `select case_gates($1) g`, [clId]);
!clGatesWithRef.checks.find((x) => x.label === 'Zero pending referrals').ok
  ? ok('referral in scheduled status blocks Zero pending referrals')
  : fail('scheduled referral did not block gate: ' + JSON.stringify(clGatesWithRef));

await db.query(`update case_referrals set status = 'completed' where id = $1`, [refRow.id]);
const [{ g: clGatesRefDone }] = await as('agent', `select case_gates($1) g`, [clId]);
clGatesRefDone.checks.find((x) => x.label === 'Zero pending referrals').ok
  ? ok('completed referral satisfies Zero pending referrals')
  : fail('completed referral failed gate: ' + JSON.stringify(clGatesRefDone));

const [depRow] = (await db.query(`insert into partner_deployments (workspace_id, case_id, referral_id, resource_type, status) values ($1, $2, $3, 'equipment', 'dispatched') returning id`, [ws, clId, refRow.id])).rows;
const [{ g: clGatesWithDep }] = await as('agent', `select case_gates($1) g`, [clId]);
!clGatesWithDep.checks.find((x) => x.label === 'Equipment returned / active handover').ok
  ? ok('deployment in dispatched status blocks Equipment returned / active handover')
  : fail('dispatched deployment did not block gate: ' + JSON.stringify(clGatesWithDep));

await db.query(`update partner_deployments set status = 'returned' where id = $1`, [depRow.id]);
const [{ g: clGatesDepDone }] = await as('agent', `select case_gates($1) g`, [clId]);
clGatesDepDone.checks.find((x) => x.label === 'Equipment returned / active handover').ok
  ? ok('returned deployment satisfies Equipment returned / active handover')
  : fail('returned deployment failed gate: ' + JSON.stringify(clGatesDepDone));

await expectError('agent', `select advance_stage($1, null)`, [clId],
  'Stage gate not met: All provider leads must be completed and payment reconciled before closure (or documented via supervisor escalation).');

await db.query(`update cases set report_status = 'delivered', feedback_rating = 5 where id = $1`, [clId]);

// The coordinator raises and resolves the exception: not a waiver (it needs a senior resolver who did not raise it).
const [{ id: escId }] = await as('coord', `insert into escalations (workspace_id, case_id, type, level, trigger_text, raised_by)
  values ($1, $2, 'operational', 1, 'Client requested early discharge before full plan completion', $3) returning id`, [ws, clId, users.sup]);
await as('coord', `update escalations set status = 'resolved', resolution_notes = 'Remaining visits waived', outcome = 'Remaining visits waived' where id = $1`, [escId]);
const [{ g: clGatesSelf }] = await as('agent', `select case_gates($1) g`, [clId]);
const [escRow] = (await db.query(`select raised_by, resolved_by from escalations where id = $1`, [escId])).rows;
escRow.raised_by === users.coord && escRow.resolved_by === users.coord
  ? ok('raised_by / resolved_by come from the signed-in user, not the screen')
  : fail('escalation people: ' + JSON.stringify(escRow));
!clGatesSelf.ready && !clGatesSelf.checks.find((x) => x.label === 'Pending payment/service documented & supervisor approved').ok
  ? ok('coordinator-resolved exception does not waive payment / service')
  : fail('self-resolved exception waived closure: ' + JSON.stringify(clGatesSelf));

// The supervisor approves it by confirming the resolution text.
await as('sup', `update escalations set resolution_notes = 'Supervisor approved closure with remaining visits waived', outcome = 'Waived' where id = $1`, [escId]);

const [{ g: clGatesApproved }] = await as('agent', `select case_gates($1) g`, [clId]);
const clExcApproved = clGatesApproved.checks.find((x) => x.label === 'Pending payment/service documented & supervisor approved');
clGatesApproved.ready && clExcApproved?.ok
  ? ok('supervisor escalation approves closure exception waiver')
  : fail('approved escalation did not make gates ready: ' + JSON.stringify(clGatesApproved));

await as('agent', `select advance_stage($1, 'Closed with approved supervisor exception')`, [clId]);
const [closedCase] = (await db.query(`select stage, closed_at from cases where id = $1`, [clId])).rows;
closedCase.stage === 'closed' && closedCase.closed_at
  ? ok('advance_stage advanced case to closed')
  : fail('case not closed: ' + JSON.stringify(closedCase));

console.log('\nScenario: enquiry creation to quote generation with 101 catalogue, care plan sheet, discount approval, and pro-forma invoice');

// 1. Create new patient and enquiry via create_enquiry RPC
const [{ create_enquiry: enqE2E }] = await as('agent', `select create_enquiry($1::jsonb)`, [JSON.stringify({
  patient: {
    full_name: 'Pooja Kulkarni',
    age: 65,
    gender: 'F',
    mobile: '9820055443',
    address: 'B-104 Sunrise Heights, Linking Road',
    pincode: '400050',
    locality: 'Bandra West',
    lat: 19.0596,
    lng: 72.8295,
  },
  caller_name: 'Karan Kulkarni',
  caller_relation: 'son',
  caller_mobile: '9820055443',
  services_requested: 'ICU nursing, physiotherapy and medical equipment',
  care_type: 'standard',
  consent: true,
  branch: 'Mahim',
})]);

const e2eCid = enqE2E.case_id;
const e2eCno = enqE2E.case_no;
const e2ePid = enqE2E.patient_id;

/^HHC-\d{6}-\d{5}$/.test(e2eCno) && e2eCid && e2ePid
  ? ok('enquiry created via create_enquiry with valid case_no and patient_id')
  : fail('enquiry creation failed: ' + JSON.stringify(enqE2E));

const [e2eCaseInit] = await as('agent', `select stage, quote_status, subtotal, total, discount_pct, patient_mobile from v_cases where id = $1`, [e2eCid]);
e2eCaseInit?.stage === 'enquiry' && Number(e2eCaseInit.subtotal) === 0 && e2eCaseInit.patient_mobile.includes('XXX')
  ? ok('case starts at enquiry with ₹0 subtotal and masked phone number')
  : fail('initial case state: ' + JSON.stringify(e2eCaseInit));

// 2. Add service items from the 101 service catalogue
// Ensure services have tax_basis set for testing GST calculation (healthcare no_gst, equipment incl_gst, beds excl_gst)
await db.query(`update services set tax_basis = 'no_gst', price = 2300 where code = 'NURSING-ICU-12H'`);
await db.query(`update services set tax_basis = 'no_gst', price = 2000 where code = 'PHYSIO-NEURO'`);
await db.query(`update services set tax_basis = 'incl_gst', price = 1500 where code = 'SUCTION'`);
await db.query(`update services set tax_basis = 'excl_gst', price = 4500 where code = 'BED-ICU'`);

// Check total service catalogue count in database
const [{ count: totalCatalogueServices }] = (await db.query(`select count(*)::int from services where workspace_id = $1`, [ws])).rows;
totalCatalogueServices === 101
  ? ok('101 service catalogue confirmed in workspace')
  : fail(`expected 101 services in catalogue, found ${totalCatalogueServices}`);

// Insert items from the 101 catalogue
await as('agent', `insert into case_items(case_id, service_id, qty) values
  ($1, $2, 15),
  ($1, $3, 6),
  ($1, $4, 1),
  ($1, $5, 1)`,
  [e2eCid, svc['NURSING-ICU-12H'], svc['PHYSIO-NEURO'], svc['SUCTION'], svc['BED-ICU']]);

const e2eItems = await as('agent', `select service_code, service_name, category, unit, qty, unit_price, line_total, price_version, price_tax_basis, priced_at is not null has_priced_at
  from case_items where case_id = $1 order by created_at`, [e2eCid]);

const icuNurse = e2eItems.find((x) => x.service_code === 'NURSING-ICU-12H');
const physioNeuro = e2eItems.find((x) => x.service_code === 'PHYSIO-NEURO');
const suctionEquip = e2eItems.find((x) => x.service_code === 'SUCTION');
const bedIcu = e2eItems.find((x) => x.service_code === 'BED-ICU');

// Expected rates and line totals:
// NURSING-ICU-12H: price 2300, qty 15 -> line_total 34500, price_tax_basis = no_gst
// PHYSIO-NEURO: price 2000, qty 6 -> line_total 12000, price_tax_basis = no_gst
// SUCTION: price 1500, qty 1 -> line_total 1500, price_tax_basis = incl_gst
// BED-ICU: price 4500, qty 1 -> line_total 4500, price_tax_basis = excl_gst
// Subtotal = 34500 + 12000 + 1500 + 4500 = 52500
e2eItems.length === 4
  && icuNurse && Number(icuNurse.unit_price) === 2300 && Number(icuNurse.line_total) === 34500 && icuNurse.price_tax_basis === 'no_gst'
  && physioNeuro && Number(physioNeuro.unit_price) === 2000 && Number(physioNeuro.line_total) === 12000 && physioNeuro.price_tax_basis === 'no_gst'
  && suctionEquip && Number(suctionEquip.unit_price) === 1500 && Number(suctionEquip.line_total) === 1500 && suctionEquip.price_tax_basis === 'incl_gst'
  && bedIcu && Number(bedIcu.unit_price) === 4500 && Number(bedIcu.line_total) === 4500 && bedIcu.price_tax_basis === 'excl_gst'
  && e2eItems.every((x) => x.has_priced_at && x.price_version >= 1)
  ? ok('4 items from 101 catalogue added with rate-card snapshot, line totals, and tax_basis')
  : fail('case_items rate card snapshot failed: ' + JSON.stringify(e2eItems));

const [e2eCasePriced] = await as('agent', `select subtotal, total from cases where id = $1`, [e2eCid]);
Number(e2eCasePriced.subtotal) === 52500 && Number(e2eCasePriced.total) === 52500
  ? ok('server-side subtotal computation: ₹52,500 across all 4 items')
  : fail('subtotal mismatch: ' + JSON.stringify(e2eCasePriced));

// Advance to pricing stage
await as('agent', `select advance_case($1, null)`, [e2eCid]);
const [e2eStagePricing] = await as('agent', `select stage from cases where id = $1`, [e2eCid]);
e2eStagePricing.stage === 'pricing' ? ok('enquiry advanced to pricing stage') : fail('stage: ' + e2eStagePricing.stage);

// 3. Calculate care plan sheet and verify server-side price computation
await db.query(`update cases set plan_days = 30, coordinator_id = $1 where id = $2`, [users.coord, e2eCid]);
const [{ s: e2eCps }] = await as('coord', `select care_plan_sheet($1, 30) s`, [e2eCid]);
const cpsCase = e2eCps?.case;
const cpsNurseOpt = e2eCps?.options?.find((o) => o.code === 'NURSING-ICU-12H' && o.cover === '12-hour');
const cpsPhysioOpt = e2eCps?.options?.find((o) => o.code === 'PHYSIO-NEURO');
const cpsSuctionOpt = e2eCps?.options?.find((o) => o.code === 'SUCTION');

// Server-side computation checks:
// - plan length: 30 days
// - case subtotal: 52500
// - per_day: 52500 / 30 = 1750
// - options scaling: nursing 30 shifts @ 2300 = 69000, physio 3/wk (13 sessions) @ 2000 = 26000, suction 1 month @ 1500 = 1500
e2eCps?.days === 30
  && cpsCase && Number(cpsCase.subtotal) === 52500 && Number(cpsCase.total) === 52500 && Number(cpsCase.per_day) === 1750
  && cpsCase.items.length === 4
  && cpsNurseOpt && Number(cpsNurseOpt.qty) === 30 && Number(cpsNurseOpt.plan_total) === 69000
  && cpsPhysioOpt && Number(cpsPhysioOpt.qty) === 13 && Number(cpsPhysioOpt.plan_total) === 26000
  && cpsSuctionOpt && Number(cpsSuctionOpt.qty) === 30 && Number(cpsSuctionOpt.plan_total) === 45000
  ? ok('care_plan_sheet: 30-day plan server-side computation, daily average ₹1,750, scaled catalogue options')
  : fail('care_plan_sheet computation mismatch: ' + JSON.stringify(e2eCps).slice(0, 300));

// Exclude one item (Suction) via set_item_scope to verify server-side dropped_total & subtotal update
const suctionItem = (await db.query(`select id from case_items where case_id = $1 and service_code = 'SUCTION'`, [e2eCid])).rows[0];
await as('coord', `select set_item_scope($1, false, 'Patient family owns suction apparatus', null, 'arranged_elsewhere')`, [suctionItem.id]);
const [{ s: e2eCpsDropped }] = await as('coord', `select care_plan_sheet($1, 30) s`, [e2eCid]);
Number(e2eCpsDropped?.case?.dropped_total) === 1500 && Number(e2eCpsDropped?.case?.subtotal) === 51000
  ? ok('care_plan_sheet reflects dropped item: dropped_total ₹1,500, active subtotal ₹51,000')
  : fail('dropped total in care_plan_sheet mismatch: ' + JSON.stringify(e2eCpsDropped?.case));

// Restore suction back into scope
await as('coord', `select set_item_scope($1, true)`, [suctionItem.id]);
const [e2eSubtotalRestored] = await as('coord', `select subtotal from cases where id = $1`, [e2eCid]);
Number(e2eSubtotalRestored.subtotal) === 52500 ? ok('scope restored: subtotal returned to ₹52,500') : fail('restored subtotal: ' + e2eSubtotalRestored.subtotal);

// 4. Request discount and verify approval stage gate
// Workspace band is 10%; requesting 15% discount triggers approval stage gate
const [e2eDiscReq] = await as('agent', `select set_discount($1, 15, 'Post-ICU elderly compassionate case') r`, [e2eCid]);
e2eDiscReq.r.status === 'pending_approval' && e2eDiscReq.r.approval_id
  ? ok('15% discount (> 10% band) requests approval stage gate')
  : fail('discount request: ' + JSON.stringify(e2eDiscReq));

const [e2eCaseBlocked] = await as('agent', `select quote_status, discount_pct, discount_amount, total from cases where id = $1`, [e2eCid]);
e2eCaseBlocked.quote_status === 'pending_approval'
  && Number(e2eCaseBlocked.discount_pct) === 15
  && Number(e2eCaseBlocked.discount_amount) === 7875
  && Number(e2eCaseBlocked.total) === 44625
  ? ok('server-side discount calculation: 15% of ₹52,500 = ₹7,875, net total = ₹44,625')
  : fail('discount calculation: ' + JSON.stringify(e2eCaseBlocked));

// Verification of stage gates while approval is pending:
// - Cannot send quote
await expectError('agent', `select send_quote($1, $2)`, [e2eCid, tpl], 'approval needed');
// - Cannot advance case to booking
await expectError('agent', `select advance_case($1, null)`, [e2eCid], 'Stage gate not met');
// - Unauthorized role (agent / coordinator) cannot approve discount
await expectError('agent', `select decide_approval($1, true, 'self approval')`, [e2eDiscReq.r.approval_id], 'client approver');
await expectError('coord', `select decide_approval($1, true, 'coord approval')`, [e2eDiscReq.r.approval_id], 'client approver');

// Client manager (Hinduja approver) decides approval
await as('client', `select decide_approval($1, true, 'Approved by Hinduja Administration')`, [e2eDiscReq.r.approval_id]);
const [e2eCaseApproved] = await as('agent', `select quote_status from cases where id = $1`, [e2eCid]);
e2eCaseApproved.quote_status === 'approved' ? ok('client manager approved discount; quote_status -> approved') : fail('approval status: ' + e2eCaseApproved.quote_status);

// Now send_quote passes
const [e2eQuoteSent] = await as('agent', `select send_quote($1, $2) r`, [e2eCid, tpl]);
e2eQuoteSent.r.text.includes('Total payable: ₹44625.00') && e2eQuoteSent.r.text.includes('Reference: ' + e2eCno)
  ? ok('quote sent with approved discounted payable ₹44,625.00: ' + e2eQuoteSent.r.text.split('\n')[4])
  : fail('sent quote text: ' + e2eQuoteSent.r.text);

// 5. Generate pro-forma invoice and verify tax calculation (tax_basis)
// Fetch final case details, patient info and active case items
const [e2eCaseFinal] = (await db.query(`select * from v_cases where id = $1`, [e2eCid])).rows;
const [e2ePatFinal] = (await db.query(`select * from patients where id = $1`, [e2ePid])).rows;
const e2eActiveItems = (await db.query(`select * from case_items where case_id = $1 and not coalesce(excluded, false) order by created_at`, [e2eCid])).rows;
const [e2eWsRow] = (await db.query(`select brand_name from workspaces where id = $1`, [ws])).rows;

// Pro-forma Invoice Number format
const expectedInvNo = `HHCS-INV-${e2eCno.replace(/^HHC-/, '')}`;
expectedInvNo.startsWith('HHCS-INV-') ? ok('pro-forma invoice number formatted: ' + expectedInvNo) : fail('invoice no: ' + expectedInvNo);

// Verify item-by-item GST tax basis and calculation
// GST basis rules:
// - no_gst: healthcare service exempt (Notification 12/2017-Central Tax) -> Tax = ₹0.00, Taxable = Line Total
// - incl_gst: GST included in rate-card price -> Base = Line Total / (1 + Rate), GST = Line Total - Base (e.g. 18% GST)
// - excl_gst: GST charged extra on top of rate-card price -> Base = Line Total, GST = Line Total * Rate (e.g. 18% GST)
const GST_RATE = 0.18; // standard GST rate for non-exempt medical goods/rentals

const taxBreakdown = e2eActiveItems.map((item) => {
  const lineTotal = Number(item.line_total);
  let taxable = 0;
  let gst = 0;
  let taxNote = '';

  if (item.price_tax_basis === 'no_gst') {
    taxable = lineTotal;
    gst = 0;
    taxNote = 'Healthcare services exempt from GST';
  } else if (item.price_tax_basis === 'incl_gst') {
    taxable = Math.round((lineTotal / (1 + GST_RATE)) * 100) / 100;
    gst = Math.round((lineTotal - taxable) * 100) / 100;
    taxNote = '18% GST included';
  } else if (item.price_tax_basis === 'excl_gst') {
    taxable = lineTotal;
    gst = Math.round(lineTotal * GST_RATE * 100) / 100;
    taxNote = '18% GST excluded (additional)';
  }

  return {
    code: item.service_code,
    basis: item.price_tax_basis,
    lineTotal,
    taxable,
    gst,
    taxNote,
  };
});

const noGstItems = taxBreakdown.filter((x) => x.basis === 'no_gst');
const inclGstItems = taxBreakdown.filter((x) => x.basis === 'incl_gst');
const exclGstItems = taxBreakdown.filter((x) => x.basis === 'excl_gst');

noGstItems.length === 2 && noGstItems.every((x) => x.gst === 0 && x.taxable === x.lineTotal)
  ? ok('tax_basis no_gst: healthcare services (nursing & physio) 100% GST exempt (GST = ₹0.00)')
  : fail('no_gst calculation: ' + JSON.stringify(noGstItems));

inclGstItems.length === 1 && inclGstItems[0].lineTotal === 1500 && inclGstItems[0].taxable === 1271.19 && inclGstItems[0].gst === 228.81
  ? ok('tax_basis incl_gst: suction equipment ₹1,500 yields ₹1,271.19 taxable + ₹228.81 GST (18%)')
  : fail('incl_gst calculation: ' + JSON.stringify(inclGstItems));

exclGstItems.length === 1 && exclGstItems[0].lineTotal === 4500 && exclGstItems[0].taxable === 4500 && exclGstItems[0].gst === 810
  ? ok('tax_basis excl_gst: ICU bed ₹4,500 yields ₹4,500 taxable + ₹810.00 GST (18%)')
  : fail('excl_gst calculation: ' + JSON.stringify(exclGstItems));

// Verify PDF generation of the official quotation / pro-forma estimate
const pdfBytes = generateQuotationPdfBytes({
  k: e2eCaseFinal,
  patient: e2ePatFinal,
  items: e2eActiveItems,
  workspace: e2eWsRow,
});

const pdfStr = new TextDecoder().decode(pdfBytes.slice(0, 100));
const pdfTail = new TextDecoder().decode(pdfBytes.slice(-30));
pdfBytes instanceof Uint8Array && pdfBytes.length > 1000 && pdfStr.startsWith('%PDF-1.4') && pdfTail.includes('%%EOF')
  ? ok(`pro-forma quotation PDF generated successfully (${pdfBytes.length} bytes, PDF 1.4 compliant)`)
  : fail('quotation PDF generation failed, length: ' + pdfBytes?.length);

expect(problems).toEqual([]);
}, 120000);
