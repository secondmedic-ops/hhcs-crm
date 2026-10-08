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
expect(problems).toEqual([]);
}, 120000);
