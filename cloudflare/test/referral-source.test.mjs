// Referring source on a Referral enquiry (20261015200000 + 20261015210000_referral_source_options):
// ICU, Doctor, Nursing Team or Other; kept only when the channel is Referral; corrected on the case page.
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REFERRAL_SOURCES } from '../../src/lib/fmt.js';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('referring source: the four options, saved with a referral only, editable', async () => {
  const problems = [];
  const check = (cond, m) => { if (!cond) problems.push(m); };
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const agent = 'c1111111-1111-4111-8111-111111111111';
  await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1,$2,'agent user','agent')`, [agent, ws]);
  async function as(sql, params = []) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [agent]);
    await db.exec('set role caredesk_app');
    try { return await db.transaction(async (tx) => (await tx.query(sql, params)).rows); } finally { await db.exec('reset role'); }
  }
  let n = 0;
  const enquiry = async (extra) => (await as(`select create_enquiry($1::jsonb) r`, [JSON.stringify({
    patient: { full_name: 'Referral Patient', mobile: '98222' + String(++n).padStart(5, '0'), address: '1 Test Rd', pincode: '400050' },
    services_requested: 'ECG at home', consent: true, ...extra,
  })]))[0].r;
  const src = async (id) => (await as(`select source_channel, referral_subtype from v_cases where id = $1`, [id]))[0];

  check(JSON.stringify(REFERRAL_SOURCES) === JSON.stringify(['ICU', 'Doctor', 'Nursing Team', 'Other']), 'screen options ' + REFERRAL_SOURCES);
  for (const s of REFERRAL_SOURCES) {
    const e = await enquiry({ source_channel: 'referral', referral_subtype: s });
    const r = await src(e.case_id);
    check(r.source_channel === 'referral' && r.referral_subtype === s, `saved ${s}: ` + JSON.stringify(r));
  }
  // the earlier wording is no longer accepted
  for (const old of ['ICU / Pamphlet Advertisement', 'Nursing Team / Internal Nurse', 'icu_pamphlet']) {
    try { await enquiry({ source_channel: 'referral', referral_subtype: old }); problems.push('accepted ' + old); }
    catch (e) { check(/referral_subtype_check|check constraint/.test(e.message), 'wrong error ' + e.message); }
  }
  // only a referral keeps a referring source
  const ph = await enquiry({ source_channel: 'phone', referral_subtype: 'Doctor' });
  check((await src(ph.case_id)).referral_subtype === null, 'phone enquiry kept a referring source');
  // corrected on the case page; switching away from Referral clears it
  const e = await enquiry({ source_channel: 'referral', referral_subtype: 'ICU' });
  await as(`select set_case_requirements($1, $2::jsonb)`, [e.case_id, JSON.stringify({ referral_subtype: 'Nursing Team' })]);
  check((await src(e.case_id)).referral_subtype === 'Nursing Team', 'edit to Nursing Team');
  await as(`select set_case_requirements($1, $2::jsonb)`, [e.case_id, JSON.stringify({ branch: 'Mahim' })]);
  check((await src(e.case_id)).referral_subtype === 'Nursing Team', 'unrelated edit changed the referring source');
  await as(`select set_case_requirements($1, $2::jsonb)`, [e.case_id, JSON.stringify({ source_channel: 'phone' })]);
  const r = await src(e.case_id);
  check(r.source_channel === 'phone' && r.referral_subtype === null, 'leaving Referral clears it ' + JSON.stringify(r));
  // old values saved under the earlier wording are mapped by the migration (re-run it on a seeded row)
  await db.query(`alter table cases drop constraint cases_referral_subtype_check`);
  await db.query(`update cases set source_channel = 'referral', referral_subtype = 'ICU / Pamphlet Advertisement' where id = $1`, [e.case_id]);
  await db.exec(readFileSync(join(dir, '20261015210000_referral_source_options.sql'), 'utf8'));
  check((await src(e.case_id)).referral_subtype === 'ICU', 'old wording mapped to ICU');

  expect(problems).toEqual([]);
}, 120000);
