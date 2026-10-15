// Expected discharge date and requested service start date on the enquiry (20261015190000_requested_service_start):
// captured at enquiry, shown and corrected on the case, independent of callbacks, the preferred / booked slot and each
// other, never advancing the case. Real migrations on PGlite, requests as caredesk_app with the user id set.
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dayStr, dayLong, isDay } from '../../src/lib/fmt.js';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('screen date helpers keep the calendar day', () => {
  expect(dayStr('2026-10-18')).toBe('2026-10-18');
  expect(dayStr(new Date('2026-10-18'))).toBe('2026-10-18');     // browser demo: PGlite gives a Date at UTC midnight
  expect(dayStr(null)).toBe('');
  expect(dayLong('2026-10-18')).toBe(dayLong(new Date('2026-10-18')));
  expect(dayLong('2026-10-18')).toMatch(/^18 Oct 2026$/);
  expect(dayLong('2026-12-31')).toMatch(/^31 Dec 2026$/);           // year end: no roll into 2027 or back to the 30th
  expect(dayLong('')).toBe('–');
  expect(isDay('2026-10-20')).toBe(true);
  expect(isDay('2028-02-29')).toBe(true);
  expect(isDay('2026-02-29')).toBe(false);
  expect(isDay('2026-02-30')).toBe(false);
  expect(isDay('20/10/2026')).toBe(false);
});

test('expected discharge and requested service start: persistence and independence', async () => {
  const problems = [];
  const check = (cond, m) => { if (!cond) problems.push(m); };
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const users = {
    agent: 'a1111111-1111-4111-8111-111111111111', coord: 'a2222222-2222-4222-8222-222222222222',
    sup: 'a3333333-3333-4333-8333-333333333333', field: 'a4444444-4444-4444-8444-444444444444',
    client: 'a5555555-5555-4555-8555-555555555555', admin: 'a6666666-6666-4666-8666-666666666666',
  };
  const roles = { agent: 'agent', coord: 'coordinator', sup: 'supervisor', field: 'field_staff', client: 'client_manager', admin: 'admin' };
  for (const [k, id] of Object.entries(users)) {
    await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1,$2,$3,$4)`, [id, ws, k + ' user', roles[k]]);
  }
  async function as(user, sql, params = []) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [users[user]]);
    await db.exec('set role caredesk_app');
    try { return await db.transaction(async (tx) => (await tx.query(sql, params)).rows); } finally { await db.exec('reset role'); }
  }
  async function refused(user, sql, params, match) {
    try { await as(user, sql, params); problems.push(`expected "${match}" for ${user}: ${sql}`); }
    catch (e) { check(e.message.includes(match), `wrong error for ${user}: ${e.message}`); }
  }
  // dates read back as text: exactly what was stored, no Date conversion in the test
  const dates = async (id, user = 'agent') => (await as(user, `select expected_discharge_on::text d, requested_service_start_on::text s,
    stage::text, booked_slot, booking_confirmed_at, preferred_slot, journey_state::text j from v_cases where id = $1`, [id]))[0];
  const setReq = (user, id, p) => as(user, `select set_case_requirements($1, $2::jsonb) r`, [id, JSON.stringify(p)]);
  const enquiry = async (extra) => (await as('agent', `select create_enquiry($1::jsonb) r`, [JSON.stringify({
    patient: { full_name: 'Synthetic Patient', mobile: '98111' + String(Math.floor(Math.random() * 1e5)).padStart(5, '0'), address: '1 Test Rd', pincode: '400050' },
    services_requested: 'ECG at home', branch: 'Mahim', consent: true, ...extra,
  })]))[0].r;

  // A. captured on the enquiry: discharge on the 18th, service from the 20th
  const slot = '2026-10-21T04:30:00.000Z';
  const a = await enquiry({ expected_discharge_on: '2026-10-18', requested_service_start_on: '2026-10-20', preferred_slot: slot });
  let r = await dates(a.case_id);
  check(r.d === '2026-10-18' && r.s === '2026-10-20', 'A: saved dates ' + JSON.stringify(r));
  check(new Date(r.preferred_slot).toISOString() === slot, 'A: preferred slot kept separately');
  for (const u of ['coord', 'sup', 'client']) {
    const x = await dates(a.case_id, u);
    check(x.d === '2026-10-18' && x.s === '2026-10-20', `A: ${u} sees the same dates`);
  }

  // H. date-only meaning: the session time zone never moves the day
  for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    await db.exec(`set timezone = '${tz}'`);
    const x = await dates(a.case_id);
    check(x.d === '2026-10-18' && x.s === '2026-10-20', `H: day shifted in ${tz}: ${JSON.stringify(x)}`);
  }
  await db.exec(`set timezone = 'UTC'`);

  // B / C. a callback for the same patient is independent in both directions
  const cbDue = '2026-10-16T05:00:00.000Z';
  const [{ id: cb }] = (await db.query(`insert into callbacks(workspace_id, number, patient_id, reason, due_at)
    select $1, p.mobile, p.id, 'followup', $2 from patients p where p.id = $3 returning id`, [ws, cbDue, a.patient_id])).rows;
  await setReq('agent', a.case_id, { requested_service_start_on: '2026-10-22' });
  const [cb1] = (await db.query(`select due_at, status from callbacks where id = $1`, [cb])).rows;
  check(new Date(cb1.due_at).toISOString() === new Date(cbDue).toISOString() && cb1.status === 'pending', 'B: callback changed by a date edit ' + JSON.stringify(cb1));
  await db.query(`update callbacks set due_at = due_at + interval '1 day' where id = $1`, [cb]);
  await as('agent', `select callback_update($1, 'in_progress', null)`, [cb]);
  r = await dates(a.case_id);
  check(r.d === '2026-10-18' && r.s === '2026-10-22', 'C: callback changes moved a date ' + JSON.stringify(r));
  const [{ n: cbCount }] = (await db.query(`select count(*)::int n from callbacks where patient_id = $1`, [a.patient_id])).rows;
  check(cbCount === 1, 'B: date edits created callbacks: ' + cbCount);

  // D. changing the expected discharge never silently changes the requested start, by any path
  await setReq('agent', a.case_id, { expected_discharge_on: '2026-10-19' });
  r = await dates(a.case_id);
  check(r.d === '2026-10-19' && r.s === '2026-10-22', 'D: requirements edit ' + JSON.stringify(r));
  await as('agent', `select set_intake($1, $2::jsonb)`, [a.case_id, JSON.stringify({ care_type: 'post_discharge', intake_disposition: 'requirement_captured',
    spoke_with: 'patient', expected_discharge_on: '2026-10-23' })]);
  r = await dates(a.case_id);
  check(r.d === '2026-10-23' && r.s === '2026-10-22', 'D: post-discharge intake reads / writes the same discharge field ' + JSON.stringify(r));
  await as('coord', `select schedule_validation($1, $2, now() + interval '2 hours', 'home_visit')`, [a.case_id, users.field]);
  await as('field', `select record_validation($1, $2::jsonb)`, [a.case_id, JSON.stringify({ readiness: 'ready', met_family: true, revised_discharge_on: '2026-10-24' })]);
  r = await dates(a.case_id);
  check(r.d === '2026-10-24' && r.s === '2026-10-22', 'D: validation revised discharge ' + JSON.stringify(r));
  // a requested start before the expected discharge is kept as entered (no ordering rule decided)
  await setReq('agent', a.case_id, { requested_service_start_on: '2026-10-17' });
  check((await dates(a.case_id)).s === '2026-10-17', 'no ordering rule: earlier start refused');
  // the post-discharge rule (discharge date needed once the requirement is captured) still holds
  await refused('agent', `select set_case_requirements($1, $2::jsonb)`, [a.case_id, JSON.stringify({ expected_discharge_on: null })], 'Enter the expected discharge date');

  // E. authorised staff correct the dates; the change is audited and on the timeline
  await setReq('coord', a.case_id, { expected_discharge_on: '2026-10-18', requested_service_start_on: '2026-10-20' });
  r = await dates(a.case_id, 'sup');
  check(r.d === '2026-10-18' && r.s === '2026-10-20', 'E: coordinator correction ' + JSON.stringify(r));
  await setReq('sup', a.case_id, { requested_service_start_on: '2026-10-21' });
  check((await dates(a.case_id)).s === '2026-10-21', 'E: supervisor correction');
  for (const u of ['field', 'client', 'admin']) {
    await refused(u, `select set_case_requirements($1, $2::jsonb)`, [a.case_id, JSON.stringify({ requested_service_start_on: '2026-10-25' })], 'Not allowed');
  }
  const [{ n: audits }] = (await db.query(`select count(*)::int n from audit_log where table_name = 'cases' and record_id = $1 and changes ? 'requested_service_start_on'`, [a.case_id])).rows;
  check(audits >= 3, 'E: audit rows for requested start ' + audits);
  const notes = (await db.query(`select summary from interactions where case_id = $1 and summary ~ '^(Dates|Details) updated:' order by occurred_at`, [a.case_id])).rows.map((x) => x.summary);
  check(notes.some((x) => x.includes('requested service start 21 Oct 2026')), 'E: timeline note ' + JSON.stringify(notes));

  // validation: real calendar dates only, on both paths
  await refused('agent', `select create_enquiry($1::jsonb)`, [JSON.stringify({ patient: { full_name: 'X', mobile: '9811122233', address: 'a' }, consent: true, requested_service_start_on: '2026-02-30' })], 'not a real calendar date');
  await refused('agent', `select create_enquiry($1::jsonb)`, [JSON.stringify({ patient: { full_name: 'X', mobile: '9811122234', address: 'a' }, consent: true, expected_discharge_on: '18/10/2026' })], 'must be a date');
  await refused('agent', `select set_case_requirements($1, $2::jsonb)`, [a.case_id, JSON.stringify({ requested_service_start_on: '2026-13-01' })], 'not a real calendar date');
  check((await dates(a.case_id)).s === '2026-10-21', 'refused edit changed the date');

  // F. older records without the dates stay readable and editable; one date can be set alone
  const f = await enquiry({});
  r = await dates(f.case_id);
  check(r.d === null && r.s === null, 'F: no defaults ' + JSON.stringify(r));
  await setReq('agent', f.case_id, { branch: 'Khar', services_requested: 'ECG at home', additional_info: 'Lift available', expected_discharge_on: null, requested_service_start_on: null });
  const [fx] = await as('agent', `select branch, additional_info, expected_discharge_on, requested_service_start_on from v_cases where id = $1`, [f.case_id]);
  check(fx.branch === 'Khar' && fx.additional_info === 'Lift available' && fx.expected_discharge_on === null && fx.requested_service_start_on === null, 'F: legacy edit ' + JSON.stringify(fx));
  await setReq('agent', f.case_id, { requested_service_start_on: '2026-10-20' });
  r = await dates(f.case_id);
  check(r.d === null && r.s === '2026-10-20', 'F: start without discharge ' + JSON.stringify(r));
  const half = await enquiry({ expected_discharge_on: '2026-10-18' });
  r = await dates(half.case_id);
  check(r.d === '2026-10-18' && r.s === null, 'F: discharge without start ' + JSON.stringify(r));

  // G. entering the dates books, assigns, dispatches and starts nothing
  const refs = async (id) => JSON.stringify((await db.query(`select provider_id, status from case_referrals where case_id = $1 order by provider_id`, [id])).rows);
  const g = await enquiry({});
  const before = { refs: await refs(g.case_id), j: (await dates(g.case_id)).j };
  await setReq('agent', g.case_id, { branch: 'Mahim', services_requested: 'ECG at home', additional_info: null, expected_discharge_on: '2026-10-18', requested_service_start_on: '2026-10-20' });
  r = await dates(g.case_id);
  check(r.stage === 'enquiry' && r.booked_slot === null && r.booking_confirmed_at === null && r.j === before.j, 'G: case advanced ' + JSON.stringify(r));
  check(await refs(g.case_id) === before.refs, 'G: partner leads changed');
  const [{ n: asg }] = (await db.query(`select count(*)::int n from assignments where case_id = $1`, [g.case_id])).rows;
  const [{ n: dep }] = (await db.query(`select count(*)::int n from partner_deployments where case_id = $1`, [g.case_id])).rows;
  check(asg === 0 && dep === 0, `G: assignments ${asg}, deployments ${dep}`);
  const [{ n: hist }] = (await db.query(`select count(*)::int n from case_stage_history where case_id = $1`, [g.case_id])).rows;
  check(hist === 1, 'G: stage history ' + hist);

  // I. stage changes still go only through the workflow actions (the full booking flow is in workflow.test.mjs)
  await refused('agent', `update cases set stage = 'booking' where id = $1`, [g.case_id], 'controlled by workflow');
  const [{ n: aHist }] = (await db.query(`select count(*)::int n from case_stage_history where case_id = $1`, [a.case_id])).rows;
  check(aHist === 1 && (await dates(a.case_id)).stage === 'enquiry', 'I: date edits on the post-discharge case moved its stage');

  // closed / cancelled cases are not edited
  await as('agent', `select cancel_case($1, 'Synthetic test')`, [half.case_id]);
  await refused('agent', `select set_case_requirements($1, $2::jsonb)`, [half.case_id, JSON.stringify({ requested_service_start_on: '2026-10-20' })], 'reopen it first');

  expect(problems).toEqual([]);
}, 120000);
