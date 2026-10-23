// Buying rates, rate-sheet import, booking snapshots and gross margins on the real migrations (PGlite, in memory).
// Requests run as caredesk_app with the user id set, like the Worker. Amounts here are test values, not the HHCS rate card.
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('buying rates, import, snapshots, margins and confidentiality', async () => {
const problems = [];
let checks = 0;
const ok = () => { checks++; };
const fail = (m) => problems.push(m);
const check = (cond, name, extra) => (cond ? ok(name) : fail(name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')));
const db = new PGlite();
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));

const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
const prov = Object.fromEntries((await db.query(`select code, id from providers`)).rows.map((r) => [r.code, r.id]));
const users = {
  agent: 'c1111111-1111-4111-8111-111111111111', coord: 'c2222222-2222-4222-8222-222222222222', sup: 'c3333333-3333-4333-8333-333333333333',
  field: 'c4444444-4444-4444-8444-444444444444', client: 'c5555555-5555-4555-8555-555555555555', admin: 'c6666666-6666-4666-8666-666666666666',
  medical: 'c7777777-7777-4777-8777-777777777777', bmm: 'c8888888-8888-4888-8888-888888888888', administrator: 'c9999999-9999-4999-8999-999999999999',
  clinical: 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const roles = { agent: 'agent', coord: 'coordinator', sup: 'supervisor', field: 'field_staff', client: 'client_manager', admin: 'admin',
  medical: 'medical_desk', bmm: 'provider', administrator: 'administrator', clinical: 'client_clinical' };
for (const [k, id] of Object.entries(users)) {
  await db.query(`insert into profiles(id, workspace_id, full_name, role, provider_id) values ($1,$2,$3,$4,$5)`,
    [id, ws, k.toUpperCase() + ' user', roles[k], k === 'bmm' ? prov.BMM : null]);
}
async function as(user, sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [users[user]]);
  await db.exec('set role caredesk_app');
  try { return await db.transaction(async (tx) => (await tx.query(sql, params)).rows); }
  finally { await db.exec('reset role'); }
}
async function expectError(user, sql, params, match) {
  try { await as(user, sql, params); fail('expected error: ' + match); }
  catch (e) { (e.message.includes(match) ? ok : fail)('blocked: ' + match + ' / got: ' + e.message.slice(0, 120)); }
}
const owner = async (sql, params = []) => (await db.query(sql, params)).rows;
const [{ d: today }] = await owner(`select ws_today($1)::text d`, [ws]);
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const svc = Object.fromEntries((await owner(`select code, id from services`)).map((r) => [r.code, r.id]));
// The checks below are for real buying rates; the SecondMedic default share (HHCS 30%) is tested on its own at the end.
await owner(`update workspaces set settings = settings - 'sm_share_pct' where id = $1`, [ws]);
const OPT = { buy_tax_basis: 'no_gst', sell_tax_basis: 'no_gst' };
const J = (v) => JSON.stringify(v);
const preview = async (rows, opt = OPT, who = 'sup') => (await as(who, `select rate_import_check($1::jsonb, $2::jsonb) r`, [J(rows), J(opt)]))[0].r;
const rowOf = (res, n) => res.rows.find((r) => Number(r.row) === n);
const has = (list, s) => (list || []).some((m) => m.includes(s));

console.log('\nImport preview: row checks, nothing changed');
const bad = [
  { row: 2, service_code: 'NOPE-1', provider_code: 'BMM', unit: 'shift', b2b: '100', b2c: '', effective_from: today },
  { row: 3, service_code: 'NURSE-12H', provider_code: 'BMM', unit: 'Per day', b2b: '100', b2c: '', effective_from: today },
  { row: 4, service_code: 'NURSE-12H', provider_code: 'BMM', unit: 'shift', b2b: '-5', b2c: '', effective_from: today },
  { row: 5, service_code: 'NURSE-12H', provider_code: 'BMM', unit: 'shift', b2b: '#N/A', b2c: '', effective_from: today },
  { row: 6, service_code: 'NURSE-12H', provider_code: 'BMM', unit: 'shift', b2b: 'abc', b2c: '', effective_from: today },
  { row: 7, service_code: 'NURSE-12H', provider_code: 'BMM', unit: 'shift', b2b: '', b2c: '', effective_from: today },
  { row: 8, service_code: 'NURSE-12H', provider_code: 'BMM', unit: 'shift', b2b: '100', b2c: '', effective_from: '31/02/2026' },
  { row: 9, service_code: 'ATTEND-12H', provider_code: 'BMM', unit: 'shift', b2b: '900', b2c: '1200', effective_from: today },
  { row: 10, service_code: 'ATTEND-12H', provider_code: 'SM', unit: 'shift', b2b: '950', b2c: '1300', effective_from: today },
  { row: 11, service_code: 'ATTEND-12H', provider_code: 'BMM', unit: 'shift', b2b: '900', b2c: '1200', effective_from: today },
  { row: 12, service_code: 'MONITOR', provider_code: 'BMM', unit: 'day', b2b: '1500', b2c: '1000', effective_from: today },
  { row: 13, service_code: 'SUCTION', provider_code: 'XYZ', unit: 'day', b2b: '10', b2c: '0', effective_from: today },
  { row: 14, service_code: 'HFNC', unit: 'day', b2b: '10', b2c: '', effective_from: today },
  { row: 15, unit: 'Per day', b2c: '2500', effective_from: today, new_service: { code: 'TELEMON-DAY', name: 'Telemonitoring', category: 'homecare', unit: 'Per day' } },
  { row: 16, service_code: 'AIRBED', provider_code: 'BMM', unit: 'day', b2b: '12.345', b2c: '', effective_from: today },
];
const pv = await preview(bad);
check(!pv.ok && pv.summary.rows === 15, 'preview flags the sheet', pv.summary);
check(has(rowOf(pv, 2).errors, 'Unknown service code NOPE-1'), 'unknown service code needs a decision', rowOf(pv, 2).errors);
check(has(rowOf(pv, 3).errors, 'does not match the rate-card unit') && has(rowOf(pv, 3).errors, 'never converted'), 'unit mismatch refused, no conversion', rowOf(pv, 3).errors);
check(has(rowOf(pv, 4).errors, 'negative'), 'negative price refused');
check(has(rowOf(pv, 5).errors, 'Spreadsheet error #N/A'), 'spreadsheet error refused');
check(has(rowOf(pv, 6).errors, 'not an amount'), 'text price refused');
check(has(rowOf(pv, 7).errors, 'Neither a B2B nor a B2C'), 'blank row refused');
check(has(rowOf(pv, 8).errors, 'not a date'), 'impossible date refused', rowOf(pv, 8).errors);
check(has(rowOf(pv, 9).errors, 'Duplicate row') && has(rowOf(pv, 11).errors, 'Duplicate row'), 'duplicate provider rows refused', rowOf(pv, 9).errors);
check(has(rowOf(pv, 9).errors, 'Conflicting B2C') && has(rowOf(pv, 10).errors, 'Conflicting B2C'), 'conflicting selling rates across suppliers refused', rowOf(pv, 10).errors);
check(has(rowOf(pv, 12).warnings, 'below this B2B') && rowOf(pv, 12).errors.length === 0, 'selling below buying is a warning, not a rejection', rowOf(pv, 12));
check(has(rowOf(pv, 13).errors, 'Unknown provider code XYZ') && has(rowOf(pv, 13).warnings, 'B2C rate is zero'), 'unknown provider refused; explicit zero kept and flagged', rowOf(pv, 13));
check(has(rowOf(pv, 14).errors, 'needs the provider'), 'buying rate without provider refused');
check(rowOf(pv, 15).errors.length === 0 && rowOf(pv, 15).sell.status === 'new' && rowOf(pv, 15).unit === 'day', 'explicit new service accepted, "Per day" = "day"', rowOf(pv, 15));
check(has(rowOf(pv, 16).errors, 'at most 2 decimals'), 'fraction of a paisa refused');
const noBasis = await preview([{ row: 2, service_code: 'NURSE-12H', provider_code: 'BMM', unit: 'shift', b2b: '1', effective_from: today }], {});
check(has(noBasis.file_errors, 'B2B rates include GST') && !noBasis.ok, 'GST basis must be chosen, never assumed', noBasis.file_errors);
await expectError('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'bad.xlsx', 'Rates')`, [J(bad), J(OPT)], 'nothing was imported');
const [{ n: rates0 }] = await owner(`select count(*)::int n from provider_rates`);
const [{ n: appr0 }] = await owner(`select count(*)::int n from approvals where kind = 'rate_import'`);
check(rates0 === 0 && appr0 === 0, 'a file with errors changes nothing', { rates0, appr0 });
for (const who of ['agent', 'coord', 'client', 'field', 'medical', 'bmm']) await expectError(who, `select rate_import_check('[{"row":1}]'::jsonb, '{}'::jsonb)`, [], 'Not allowed');

console.log('\nImport: buying rates applied, selling changes to the Hinduja approver, retry safe');
const good = [
  { row: 2, service_code: 'nurse-12h', service_name: 'Nurse, 12-hour shift', provider_code: 'bmm', category: 'Nursing', unit: 'Per shift', b2b: '1,500', b2c: '₹2,000', effective_from: today },
  { row: 3, service_code: 'ECG-12', provider_code: 'SM', unit: 'unit', b2b: '0', b2c: '900', effective_from: today },
  { row: 4, service_code: 'LAB-CBC', unit: 'unit', b2c: '500', effective_from: plus(5) },
  { row: 5, service_code: 'XR-LIMB', unit: 'unit', b2c: '2600', effective_from: today },
];
const gp = await preview(good);
check(gp.ok && rowOf(gp, 2).buy.status === 'new' && rowOf(gp, 2).sell.status === 'changed' && Number(rowOf(gp, 2).sell.old) === 0, 'clean file previews with old and new prices', gp);
const [{ r: sub1 }] = await as('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'rates.xlsx', 'Rates') r`, [J(good), J(OPT)]);
check(sub1.buying_applied === 2 && sub1.selling_changes === 4 && sub1.sell_status === 'awaiting_approval', 'submitted: 2 buying rates live, 4 selling changes waiting', sub1);
const [{ r: sub2 }] = await as('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'rates (copy).xlsx', 'Rates') r`, [J(good), J(OPT)]);
const [{ n: appr1 }] = await owner(`select count(*)::int n from approvals where kind = 'rate_import'`);
const [{ n: rates1 }] = await owner(`select count(*)::int n from provider_rates`);
check(sub2.duplicate && sub2.import_id === sub1.import_id && appr1 === 1 && rates1 === 2, 'the same import again is recognised, nothing applied twice', { sub2, appr1, rates1 });
const [again] = (await preview(good)).already_submitted ? [true] : [false];
check(again, 'preview says the file was already submitted');
const [{ price: stillOld }] = await owner(`select price from services where code = 'NURSE-12H'`);
check(Number(stillOld) === 0, 'selling price unchanged until approval');
const [ap] = await as('client', `select id, payload from approvals where kind = 'rate_import' and status = 'pending'`);
// Inspect confidential field names, not substrings of random UUIDs.
const containsBuyingField = (value) => value && typeof value === 'object'
  && Object.entries(value).some(([key, child]) => /b2b|buy|cost|margin/i.test(key) || containsBuyingField(child));
check(ap && !containsBuyingField(ap.payload), 'approval request carries selling prices only', ap?.payload);
await expectError('sup', `select decide_approval($1, true, null)`, [ap.id], 'client approver');
await expectError('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'x', 'y')`,
  [J([{ row: 2, service_code: 'XR-LIMB', unit: 'unit', b2c: '2700', effective_from: today }]), J(OPT)], 'nothing was imported');
await as('client', `select decide_approval($1, true, 'Rates agreed')`, [ap.id]);
const card = Object.fromEntries((await owner(`select code, price, version, tax_basis, active from services`)).map((r) => [r.code, r]));
check(Number(card['NURSE-12H'].price) === 2000 && card['NURSE-12H'].version === 2 && card['NURSE-12H'].tax_basis === 'no_gst', 'approved selling price live with version and GST basis', card['NURSE-12H']);
check(Number(card['LAB-CBC'].price) === 450, 'future-dated selling price waits for its date', card['LAB-CBC']);
const [sched] = await owner(`select status, effective_from::text d from service_price_history where service_id = $1 and source = 'import'`, [svc['LAB-CBC']]);
check(sched?.status === 'scheduled' && sched.d === plus(5), 'scheduled in the price history', sched);
await owner(`update service_price_history set effective_from = $1 where service_id = $2 and status = 'scheduled'`, [today, svc['LAB-CBC']]);
const [{ n: activated }] = await owner(`select activate_due_prices() n`);
const [{ price: cbcNow }] = await owner(`select price from services where code = 'LAB-CBC'`);
check(activated === 1 && Number(cbcNow) === 500, 'scheduled price activates on its date', { activated, cbcNow });
const [{ s: impState }] = await owner(`select sell_status s from rate_imports where id = $1`, [sub1.import_id]);
check(impState === 'approved', 'import shows selling approved');

console.log('\nStale approval: a price moved after the import was submitted');
const [{ r: sub3 }] = await as('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'xr.csv', null) r`,
  [J([{ row: 2, service_code: 'XR-CHEST', unit: 'unit', b2c: '2300', effective_from: today }]), J(OPT)]);
await as('sup', `select request_rate_change($1, 2250, 'Partner revision')`, [svc['XR-CHEST']]);
await as('client', `select decide_approval(id, true, null) from approvals where kind = 'rate_change' and status = 'pending'`);
await expectError('client', `select decide_approval($1, true, null)`, [sub3.approval_id], 'changed after this import');
const [{ price: xr }] = await owner(`select price from services where code = 'XR-CHEST'`);
check(Number(xr) === 2250, 'stale import approval applied nothing', xr);
await as('client', `select decide_approval($1, false, 'Superseded')`, [sub3.approval_id]);
const [{ r: sub4 }] = await as('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'xr.csv', null) r`,
  [J([{ row: 2, service_code: 'XR-CHEST', unit: 'unit', b2c: '2300', effective_from: today }]), J(OPT)]);
check(!sub4.duplicate && sub4.approval_id && sub4.approval_id !== sub3.approval_id, 'a rejected import can be submitted again', sub4);
await as('client', `select decide_approval($1, false, 'Not now')`, [sub4.approval_id]);

console.log('\nRetry of an import that added a new service');
const o2 = { code: 'O2-CONC-MONTH', name: 'Oxygen concentrator, monthly rental', category: 'equipment', unit: 'Per month' };
const withNew = [
  { row: 2, service_code: 'O2-CONC-MONTH', unit: 'Per month', b2c: '5000', effective_from: today, new_service: o2 },
  { row: 3, service_code: 'O2-CONC-MONTH', provider_code: 'BMM', unit: 'month', b2b: '3500', effective_from: today, new_service: o2 },
];
const [{ r: subN }] = await as('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'o2.xlsx', 'Rates') r`, [J(withNew), J(OPT)]);
check(subN.new_services === 1 && subN.buying_applied === 1 && subN.selling_changes === 1, 'new service, its buying rate and selling change submitted', subN);
const [{ r: subN2 }] = await as('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'o2 (1).xlsx', 'Rates') r`, [J(withNew), J(OPT)]);
const [{ n: o2n }] = await owner(`select count(*)::int n from services where code = 'O2-CONC-MONTH'`);
const [{ n: o2r }] = await owner(`select count(*)::int n from provider_rates r join services s on s.id = r.service_id where s.code = 'O2-CONC-MONTH'`);
const [o2s] = await owner(`select active, unit, price from services where code = 'O2-CONC-MONTH'`);
check(subN2.duplicate && subN2.import_id === subN.import_id && o2n === 1 && o2r === 1, 'retry after the new service exists: same import, no duplicate service or rate', { subN2, o2n, o2r });
check(o2s.active === false && o2s.unit === 'month' && Number(o2s.price) === 0, 'new service waits off the quotable card, unit kept as "month" (no conversion to day)', o2s);
await as('client', `select decide_approval($1, false, 'Test only')`, [subN.approval_id]);

console.log('\nB2B as a share of B2C, provider by category');
const PCT = { ...OPT, buy_pct_of_sell: '70', provider_by_routing: true };
const share = await preview([
  { row: 2, service_code: 'NURSE-12H', unit: 'shift', b2c: '2,500', effective_from: today },
  { row: 3, service_code: 'XR-CHEST', unit: 'unit', b2c: '1234.57', effective_from: today },
  { row: 4, service_code: 'LAB-CBC', unit: 'unit', b2c: '500', effective_from: today },
  { row: 5, service_code: 'ECG-12', unit: 'unit', b2c: '900', b2b: '450', effective_from: today },
  { row: 6, service_code: 'AMB-TEST', unit: 'trip', b2c: '3000', effective_from: today, new_service: { code: 'AMB-TEST', name: 'Ambulance (test)', category: 'other', unit: 'trip' } },
], PCT);
const sr = (n) => rowOf(share, n);
check(share.ok && Number(sr(2).buy.new) === 1750 && sr(2).buy.derived && Number(sr(2).buy.pct) === 70 && sr(2).provider_code === 'BMM', 'B2B = 70% of B2C, nursing paid to BMM', sr(2));
check(Number(sr(3).buy.new) === 864.2 && sr(3).provider_code === 'SM', 'rounded to the paisa (1,234.57 x 70% = 864.20); X-ray to SecondMedic', sr(3));
check(sr(4).provider_code === 'SM' && Number(sr(4).buy.new) === 350, 'blood test to SecondMedic', sr(4));
check(Number(sr(5).buy.new) === 450 && !sr(5).buy.derived, 'an explicit B2B in the file is never replaced', sr(5));
check(sr(6).provider_code === 'BMM' && Number(sr(6).buy.new) === 2100, 'category "other" (ambulance) goes to BMM', sr(6));
const badPct = await preview([{ row: 2, service_code: 'NURSE-12H', unit: 'shift', b2c: '2500', effective_from: today }], { ...OPT, buy_pct_of_sell: 'abc' });
check(!badPct.ok && has(badPct.file_errors, 'B2B as % of B2C'), 'a percentage that is not a number is refused', badPct.file_errors);
const over = await preview([{ row: 2, service_code: 'NURSE-12H', unit: 'shift', b2c: '2500', effective_from: today }], { ...OPT, buy_pct_of_sell: '120' });
check(!over.ok && has(over.file_errors, 'at most 100'), 'more than 100% is refused');
const noRoute = await preview([{ row: 2, service_code: 'NURSE-12H', unit: 'shift', b2c: '2500', effective_from: today }], { ...OPT, buy_pct_of_sell: '70' });
check(has(rowOf(noRoute, 2).errors, 'needs the provider'), 'a derived B2B still needs a provider');
const amb = [{ row: 2, service_code: 'AMB-TEST', unit: 'trip', b2c: '3000', effective_from: today, new_service: { code: 'AMB-TEST', name: 'Ambulance (test)', category: 'other', unit: 'trip' } }];
const [{ r: subA }] = await as('sup', `select submit_rate_import($1::jsonb, $2::jsonb, 'amb.xlsx', 'Rates') r`, [J(amb), J(PCT)]);
const [ambRate] = await owner(`select r.rate::float8 rate, p.code, r.tax_basis from provider_rates r join providers p on p.id = r.provider_id join services s on s.id = r.service_id where s.code = 'AMB-TEST'`);
const [{ o: ambOpt }] = await owner(`select options o from rate_imports where id = $1`, [subA.import_id]);
check(subA.buying_applied === 1 && ambRate?.rate === 2100 && ambRate.code === 'BMM' && Number(ambOpt.buy_pct_of_sell) === 70 && ambOpt.provider_by_routing === true,
  'submitted: derived BMM buying rate saved, the rule kept with the import', { subA, ambRate, ambOpt });
await as('client', `select decide_approval($1, false, 'Test only')`, [subA.approval_id]);
const newCats = await preview([
  { row: 2, service_code: 'CARE-TEST', unit: 'shift', b2c: '1200', effective_from: today, new_service: { code: 'CARE-TEST', name: 'Caretaker (test)', category: 'Caretaker / Attendant', unit: 'shift' } },
  { row: 3, service_code: 'AMB2-TEST', unit: 'trip', b2c: '3000', effective_from: today, new_service: { code: 'AMB2-TEST', name: 'Ambulance 2 (test)', category: 'ambulance', unit: 'trip' } },
], PCT);
check(newCats.ok && rowOf(newCats, 2).category === 'caretaker_attendant' && rowOf(newCats, 2).provider_code === 'BMM'
  && rowOf(newCats, 3).category === 'ambulance' && rowOf(newCats, 3).provider_code === 'BMM', 'categories "Caretaker / Attendant" and "ambulance" accepted and paid to BMM', newCats.rows);

console.log('\nBuying-rate versions never overlap');
await as('sup', `select set_provider_rate($1, $2, 1800, $3::date, 'no_gst', 'from next week')`, [prov.BMM, svc['NURSE-12H'], plus(10)]);
await as('sup', `select set_provider_rate($1, $2, 1750, $3::date, 'no_gst', null)`, [prov.BMM, svc['NURSE-12H'], plus(5)]);
const vers = await owner(`select rate, effective_from::text f, effective_to::text t from provider_rates where provider_id = $1 and service_id = $2 and status = 'valid' order by effective_from`, [prov.BMM, svc['NURSE-12H']]);
check(vers.length === 3 && vers[0].t === plus(5) && vers[1].f === plus(5) && vers[1].t === plus(10) && vers[2].t === null, 'each version ends where the next starts', vers);
await expectError('coord', `select set_provider_rate($1, $2, 1, $3::date, 'no_gst', null)`, [prov.BMM, svc['NURSE-12H'], today], 'Not allowed');
await expectError('client', `select set_provider_rate($1, $2, 1, $3::date, 'no_gst', null)`, [prov.BMM, svc['NURSE-12H'], today], 'Not allowed');
await as('admin', `select set_provider_rate($1, $2, 300, $3::date, 'no_gst', null)`, [prov.SM, svc['VISIT-STD'], today]);
ok('platform admin manages buying rates');

console.log('\nAcceptance: ₹12,000 cost, ₹16,000 selling, then a 10% discount');
const enquiry = async (name, mobile) => (await as('agent', `select create_enquiry($1::jsonb) r`, [J({
  patient: { full_name: name, mobile, address: 'Test road', pincode: '400058' }, caller_name: name, consent: true, services_requested: 'Nursing' })]))[0].r.case_id;
const A = await enquiry('Margin test A', '9820011001');
await as('agent', `insert into case_items(case_id, service_id, qty) values ($1, $2, 8)`, [A, svc['NURSE-12H']]);
const margins = async (c, who = 'sup') => (await as(who, `select case_margins($1) r`, [c]))[0].r;
let m = await margins(A);
let l = m.lines[0];
check(l.provider_code === 'BMM' && Number(l.buy_rate) === 1500 && Number(l.buying_total) === 12000 && Number(l.net_selling) === 16000
  && Number(l.margin) === 4000 && Number(l.margin_pct) === 25 && l.unit === 'shift' && l.price_version === 2, 'margin ₹4,000 and 25%', l);
check(m.totals.status === 'complete' && Number(m.totals.margin_pct) === 25 && m.reconciles, 'booking totals complete and reconciled', m.totals);
await as('agent', `select advance_case($1, null)`, [A]);
const [{ r: disc }] = await as('agent', `select set_discount($1, 10, 'Senior citizen') r`, [A]);
m = await margins(A);
check(disc.status === 'approved' && Number(m.totals.net_selling) === 14400 && Number(m.totals.margin) === 2400 && Number(m.totals.margin_pct) === 16.67 && m.reconciles,
  'after 10% discount: net ₹14,400, margin ₹2,400, 16.67%', m.totals);

console.log('\nConfidentiality: costs and margins only for SecondMedic supervisors and coordinators');
for (const who of ['agent', 'field', 'client', 'clinical', 'medical', 'bmm', 'admin']) {
  await expectError(who, `select case_margins($1)`, [A], 'Not allowed');
  await expectError(who, `select margin_report($1::date, $2::date)`, [today, today], 'Not allowed');
  const [{ n }] = await as(who, `select count(*)::int n from case_item_costs`);
  const [{ h }] = await as(who, `select count(*)::int h from case_item_cost_history`);
  check(n === 0 && h === 0, `${who} reads no booking costs`, { n, h });
}
for (const who of ['agent', 'field', 'client', 'clinical', 'medical', 'bmm']) {
  const [{ n }] = await as(who, `select count(*)::int n from provider_rates`);
  const [{ i }] = await as(who, `select count(*)::int i from rate_imports`);
  check(n === 0 && i === 0, `${who} reads no buying rates`, { n, i });
}
const [{ n: adminRates }] = await as('admin', `select count(*)::int n from provider_rates`);
check(adminRates > 0, 'platform admin reads buying rates (rate configuration)');
await expectError('agent', `insert into provider_rates(workspace_id, provider_id, service_id, unit, rate, tax_basis, effective_from) values ($1,$2,$3,'shift',1,'no_gst',current_date)`, [ws, prov.BMM, svc['NURSE-12H']], 'permission denied');
await expectError('sup', `update case_item_costs set buy_rate = 1`, [], 'permission denied');
await expectError('agent', `select margin_lines($1)`, [A], 'permission denied');
await expectError('agent', `select capture_item_cost(id, null, 'auto', null) from case_items limit 1`, [], 'permission denied');
const [{ n: auditLeak }] = await owner(`select count(*)::int n from audit_log where table_name in ('provider_rates','case_item_costs','case_item_cost_history','rate_imports')`);
check(auditLeak === 0, 'buying rates stay out of the audit log Hinduja can read');
const [{ n: tl }] = await owner(`select count(*)::int n from interactions where case_id = $1 and (summary like '%1500%' or coalesce(body,'') like '%1500%')`, [A]);
check(tl === 0, 'no buying rate on the case timeline');
const [{ r: quoteText }] = await as('agent', `select render_template((select id from templates where code = 'T-03'), $1) r`, [A]);
check(!quoteText.includes('1500') && !quoteText.includes('12000') && !quoteText.includes('12,000'), 'patient quote shows no cost', quoteText);
const [{ r: misPack }] = await as('client', `select mis_report($1::date, $2::date) r`, [today, today]);
check(!J(misPack).includes('buy') && !J(misPack).includes('margin'), 'Hinduja MIS pack carries no costs');
const [coordView] = await as('coord', `select count(*)::int n from case_item_costs where case_id = $1`, [A]);
check(coordView.n === 0, 'a coordinator only sees costs on cases they can see (partner case not theirs)', coordView);
const [admView] = await as('administrator', `select (case_margins($1))->'totals'->>'margin' m`, [A]);
check(Number(admView.m) === 2400, 'administrator sees margins');

console.log('\nBooking: snapshots kept, rate changes never rewrite it; amendments explicit and audited');
const tpl = (await owner(`select id from templates where code = 'T-03'`))[0].id;
await as('agent', `select send_quote($1, $2)`, [A, tpl]);
await expectError('agent', `select refresh_case_prices($1)`, [A], 'draft quote');
await as('agent', `select advance_case($1, null)`, [A]);
await as('coord', `select confirm_booking($1, now() + interval '2 hours', $2)`, [A, users.coord]);
await as('sup', `select set_provider_rate($1, $2, 1700, $3::date, 'no_gst', null)`, [prov.BMM, svc['NURSE-12H'], today]);
await as('sup', `select request_rate_change($1, 2500, 'Revision')`, [svc['NURSE-12H']]);
await as('client', `select decide_approval(id, true, null) from approvals where kind = 'rate_change' and status = 'pending'`);
const [aItem] = await owner(`select unit_price, price_version, line_total from case_items where case_id = $1`, [A]);
m = await margins(A);
check(Number(aItem.unit_price) === 2000 && aItem.price_version === 2 && Number(m.lines[0].buy_rate) === 1500 && Number(m.totals.margin) === 2400 && m.frozen,
  'booked case keeps its selling and buying snapshot after both rates change', { aItem, t: m.totals });
await expectError('coord', `select set_item_provider($1, $2, 'Partner change')`, [m.lines[0].item_id, prov.BMM], 'only a supervisor');
await expectError('sup', `select set_item_provider($1, $2, null)`, [m.lines[0].item_id, prov.BMM], 'reason');
const [{ total: totalBefore, signoff_at: so0 }] = await owner(`select total, signoff_at from cases where id = $1`, [A]);
await as('sup', `select set_item_provider($1, $2, 'BMM revised the shift rate')`, [m.lines[0].item_id, prov.BMM]);
m = await margins(A);
const [{ total: totalAfter }] = await owner(`select total from cases where id = $1`, [A]);
check(Number(m.lines[0].buy_rate) === 1700 && m.lines[0].cost_source === 'amendment' && m.history[0]?.reason === 'BMM revised the shift rate'
  && Number(m.history[0].old_rate) === 1500 && Number(totalAfter) === Number(totalBefore) && so0 === null,
  'supervisor amendment recorded with reason and old value; customer total untouched', { l: m.lines[0], h: m.history[0] });

console.log('\nDraft quote: quantity, missing vs zero cost, dropped items, refresh');
const B = await enquiry('Margin test B', '9820011002');
await as('agent', `insert into case_items(case_id, service_id, qty) values ($1, $2, 1), ($1, $3, 1), ($1, $4, 1)`, [B, svc['NURSE-12H'], svc['ECG-12'], svc['ATTEND-12H']]);
m = await margins(B);
const byCode = (mm) => Object.fromEntries(mm.lines.map((x) => [x.service_code, x]));
let bl = byCode(m);
check(Number(bl['NURSE-12H'].sell_rate) === 2500 && Number(bl['NURSE-12H'].buy_rate) === 1700, 'new line takes today\'s rates', bl['NURSE-12H']);
check(bl['ECG-12'].cost_status === 'ok' && Number(bl['ECG-12'].buy_rate) === 0 && Number(bl['ECG-12'].margin) === 900, 'explicit zero cost is a cost of zero', bl['ECG-12']);
check(bl['ATTEND-12H'].cost_status === 'no_provider' && bl['ATTEND-12H'].buy_rate === null && bl['ATTEND-12H'].margin === null, 'missing cost stays missing, never zero', bl['ATTEND-12H']);
check(m.totals.status === 'incomplete' && m.totals.margin === null && Number(m.totals.known_buying) === 1700, 'booking margin withheld; known-cost subtotal separate', m.totals);
await as('sup', `select request_rate_change($1, 2600, 'Revision')`, [svc['NURSE-12H']]);
await as('client', `select decide_approval(id, true, null) from approvals where kind = 'rate_change' and status = 'pending'`);
await as('sup', `select set_provider_rate($1, $2, 1600, $3::date, 'no_gst', null)`, [prov.BMM, svc['NURSE-12H'], today]);
await as('agent', `select set_item_scope($1, true, null, 2)`, [bl['NURSE-12H'].item_id]);
bl = byCode(await margins(B));
check(Number(bl['NURSE-12H'].sell_rate) === 2500 && Number(bl['NURSE-12H'].line_total) === 5000 && Number(bl['NURSE-12H'].buying_total) === 3400,
  'quantity change keeps the snapshot rates', bl['NURSE-12H']);
await as('agent', `select set_item_scope($1, false, 'Family will arrange', null, 'arranged_elsewhere')`, [bl['ATTEND-12H'].item_id]);
m = await margins(B);
check(m.totals.status === 'complete' && m.totals.lines === 2 && Number(m.totals.buying) === 3400 && Number(m.totals.net_selling) === 5900 && m.stale,
  'dropped item leaves the totals; quote marked as behind the rate card', m.totals);
await as('coord', `select set_item_provider($1, $2, null)`, [bl['ECG-12'].item_id, prov.SM]);
const [{ r: refreshed }] = await as('agent', `select refresh_case_prices($1) r`, [B]);
bl = byCode(await margins(B));
check(Number(refreshed.total) === 6100 && Number(bl['NURSE-12H'].sell_rate) === 2600 && Number(bl['NURSE-12H'].buy_rate) === 1600 && bl['ECG-12'].provider_code === 'SM',
  'explicit refresh takes today\'s rates and keeps the chosen provider', { refreshed, n: bl['NURSE-12H'] });

console.log('\nDiscount allocation reconciles to the paisa');
const C = await enquiry('Margin test C', '9820011003');
await as('agent', `insert into case_items(case_id, service_id, qty) values ($1, $2, 1), ($1, $3, 1), ($1, $4, 1)`, [C, svc['VISIT-STD'], svc['LAB-CBC'], svc['LAB-LFT']]);
await as('agent', `select set_discount($1, 3.33, 'Odd rounding')`, [C]);
m = await margins(C);
const shares = m.lines.map((x) => Math.round(Number(x.discount_share) * 100));
const nets = m.lines.reduce((a, x) => a + Math.round(Number(x.net_selling) * 100), 0);
const [cRow] = await owner(`select subtotal, discount_amount, total from cases where id = $1`, [C]);
check(shares.reduce((a, b) => a + b, 0) === Math.round(Number(cRow.discount_amount) * 100) && nets === Math.round(Number(cRow.total) * 100) && m.reconciles,
  'line discounts add up to the booking discount, net lines to the total', { shares, cRow });

console.log('\nOlder bookings: cost not captured, no backfill');
await owner(`set session_replication_role = replica`);
await owner(`update case_items set priced_at = null where case_id = $1 and service_code = 'VISIT-STD'`, [C]);
await owner(`delete from case_item_costs where case_item_id in (select id from case_items where case_id = $1 and service_code = 'VISIT-STD')`, [C]);
await owner(`set session_replication_role = origin`);
m = await margins(C);
const legacy = m.lines.find((x) => x.service_code === 'VISIT-STD');
check(legacy.cost_status === 'not_captured' && legacy.buy_rate === null, 'line made before this release shows cost not captured', legacy);
await expectError('sup', `select set_item_provider($1, $2, null)`, [legacy.item_id, prov.SM], 'before costs were captured');

console.log('\nMIS margins report');
const [{ r: rep }] = await as('sup', `select margin_report($1::date, $2::date) r`, [today, today]);
check(rep.totals.bookings === 1 && rep.totals.complete.bookings === 1 && Number(rep.totals.complete.net_selling) === 14400
  && Number(rep.totals.complete.buying) === 13600 && Number(rep.totals.complete.margin) === 800 && Number(rep.totals.complete.margin_pct) === 5.56,
  'report reconciles with the booking (amended cost)', rep.totals);
check(rep.projected.bookings === 1 && rep.completed.bookings === 0 && rep.by_provider[0]?.code === 'BMM' && rep.by_service[0]?.code === 'NURSE-12H' && rep.basis.includes('booking confirmation'),
  'projected vs completed, by provider and service, basis stated', { p: rep.projected, bp: rep.by_provider });
const [{ r: repSm }] = await as('sup', `select margin_report($1::date, $2::date, $3, null, null) r`, [today, today, prov.SM]);
check(repSm.totals.bookings === 0, 'provider filter');
const [{ r: repCase }] = await as('coord', `select margin_report($1::date, $2::date, null, null, $3) r`, [today, today, 'HHC-']);
check(repCase.totals.bookings === 1, 'coordinator report covers the bookings they can see', repCase.totals);
const [{ r: two }] = await as('sup', `select margin_report($1::date, $2::date) r`, [plus(-3), today]);
check(Number(two.totals.complete.margin_pct) === Math.round(Number(two.totals.complete.margin) * 10000 / Number(two.totals.complete.net_selling)) / 100,
  'aggregate margin % from aggregate amounts', two.totals);

console.log('\nSecondMedic default share: no B2B rate yet -> margin = 30% of B2C');
const [{ p: hhcShare }] = await owner(`select ws_sm_share_pct(id) p from workspaces where code = 'HHC'`);
check(hhcShare === null, 'share switched off for the checks above');
await owner(`update workspaces set settings = settings || '{"sm_share_pct": 30}'::jsonb where id = $1`, [ws]);
await owner(`update services set price = 1000 where id = $1`, [svc['ATTEND-12H']]);   // the example from the business: B2C 1,000
const D = await enquiry('Margin test D', '9820011004');
await as('agent', `insert into case_items(case_id, service_id, qty) values ($1, $2, 2), ($1, $3, 1)`, [D, svc['ATTEND-12H'], svc['NURSE-12H']]);
m = await margins(D);
let dl = byCode(m);
const att = dl['ATTEND-12H'];
const attBuy = Math.round(Number(att.sell_rate) * 70) / 100;
check(Number(att.sell_rate) === 1000 && Number(att.buy_rate) === 700 && Number(att.margin) === 600, 'B2C 1,000 x 2: buying 700 each, SecondMedic margin 300 each', att);
check(att.cost_status === 'ok' && att.cost_basis === 'default_share' && Number(att.default_share_pct) === 30 && Number(att.buy_rate) === attBuy
  && Number(att.margin) === Math.round(Number(att.line_total) * 30) / 100 && Number(att.margin_pct) === 30, 'no B2B rate: buying = 70% of B2C, margin = 30%', att);
check(dl['NURSE-12H'].cost_basis === 'rate' && Number(dl['NURSE-12H'].buy_rate) === 1600 && dl['NURSE-12H'].default_share_pct === null, 'a real B2B rate always wins', dl['NURSE-12H']);
check(m.totals.status === 'complete' && m.reconciles, 'booking margin complete with the default share', m.totals);
const legacyNow = (await margins(C)).lines.find((x) => x.service_code === 'VISIT-STD');
check(legacyNow.cost_basis === 'default_share' && Number(legacyNow.margin) === Math.round(Number(legacyNow.net_selling) * 100 - Number(legacyNow.line_total) * 70) / 100,
  'older line without a captured cost uses the share too', legacyNow);
await owner(`update workspaces set settings = settings || '{"sm_share_pct": "abc"}'::jsonb where id = $1`, [ws]);
check(byCode(await margins(D))['ATTEND-12H'].cost_status === 'no_provider', 'invalid share = no default, cost missing again');
await owner(`update workspaces set settings = settings || '{"sm_share_pct": 30}'::jsonb where id = $1`, [ws]);
await expectError('agent', `select ws_sm_share_pct($1)`, [ws], 'permission denied');

console.log(`${checks} checks passed, ${problems.length} failed`);
expect(problems).toEqual([]);
}, 180000);
