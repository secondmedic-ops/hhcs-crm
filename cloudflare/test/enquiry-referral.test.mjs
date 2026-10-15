// Test suite for enquiry creation hardening, sequence desync recovery, and referral source details
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('enquiry creation, sequence recovery, repeat enquiries, and referral subtype', async () => {
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const agentId = '11111111-1111-1111-1111-111111111111';
  await db.query(`insert into profiles(id, workspace_id, full_name, role, agent_code) values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
    [agentId, ws, 'Priya Sharma', 'agent', 'A-01']);

  async function asAgent(sql, params = []) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [agentId]);
    await db.exec('set role caredesk_app');
    try {
      return await db.transaction(async (tx) => (await tx.query(sql, params)).rows);
    } finally {
      await db.exec('reset role');
    }
  }

  const services = (await db.query(`select id, code from services where active limit 3`)).rows;
  expect(services.length).toBeGreaterThan(0);

  // 1. Valid enquiry creation for Priya Sharma
  const [{ create_enquiry: enq1 }] = await asAgent(`select create_enquiry($1::jsonb)`, [JSON.stringify({
    patient: { full_name: 'Patient Alpha', age: 45, gender: 'M', mobile: '9820011111', address: '10 Bandra West', pincode: '400050' },
    caller_name: 'Caller Alpha', caller_relation: 'self', caller_mobile: '9820011111',
    source_channel: 'phone', priority: 'routine',
    consent: true, service_ids: [services[0].id],
  })]);
  expect(enq1.case_id).toBeDefined();
  expect(enq1.case_no).toMatch(/^HHC-\d{6}-\d{5}$/);

  // 2. Repeat enquiry for existing patient (same mobile & patient)
  const [{ create_enquiry: enq2 }] = await asAgent(`select create_enquiry($1::jsonb)`, [JSON.stringify({
    patient: { full_name: 'Patient Alpha', mobile: '9820011111', address: '10 Bandra West', pincode: '400050' },
    caller_name: 'Caller Alpha',
    source_channel: 'phone', priority: 'routine',
    consent: true, service_ids: [services[0].id],
  })]);
  expect(enq2.case_id).toBeDefined();
  expect(enq2.patient_id).toBe(enq1.patient_id); // Reuses the existing patient record
  expect(enq2.case_id).not.toBe(enq1.case_id); // Generates a distinct case

  // 3. Sequence desync recovery: simulate pre-existing cases or gaps
  // Intentionally insert a case with a sequence number ahead in cases
  const todayStr = (await db.query(`select to_char(now() at time zone 'Asia/Kolkata', 'YYMMDD') d`)).rows[0].d;
  const collisionCaseNo = `HHC-${todayStr}-00003`;
  await db.query(`insert into cases(workspace_id, patient_id, case_no, source_channel, stage) values ($1, $2, $3, 'phone', 'enquiry')`,
    [ws, enq1.patient_id, collisionCaseNo]);

  // Now create an enquiry - trigger should detect collision and loop to next available number (00004)
  const [{ create_enquiry: enq3 }] = await asAgent(`select create_enquiry($1::jsonb)`, [JSON.stringify({
    patient: { full_name: 'Patient Beta', age: 60, gender: 'F', mobile: '9820022222', address: '20 Khar West', pincode: '400052' },
    caller_name: 'Beta Son', caller_relation: 'son', caller_mobile: '9820022222',
    source_channel: 'phone', priority: 'routine',
    consent: true, service_ids: [services[0].id],
  })]);
  expect(enq3.case_id).toBeDefined();
  expect(enq3.case_no).toBe(`HHC-${todayStr}-00004`);

  // 4. Empty mobile numbers do NOT collide or overwrite on '+'
  const [{ create_enquiry: enqBlank1 }] = await asAgent(`select create_enquiry($1::jsonb)`, [JSON.stringify({
    patient: { full_name: 'Patient NoMobile 1', mobile: '', email: 'nomobile1@test.com', address: 'Addr 1', pincode: '400050' },
    consent: true, service_ids: [services[0].id],
  })]);
  const [{ create_enquiry: enqBlank2 }] = await asAgent(`select create_enquiry($1::jsonb)`, [JSON.stringify({
    patient: { full_name: 'Patient NoMobile 2', mobile: '', email: 'nomobile2@test.com', address: 'Addr 2', pincode: '400050' },
    consent: true, service_ids: [services[0].id],
  })]);
  expect(enqBlank1.patient_id).not.toBe(enqBlank2.patient_id);
  const p1 = (await db.query(`select mobile from patients where id = $1`, [enqBlank1.patient_id])).rows[0];
  const p2 = (await db.query(`select mobile from patients where id = $1`, [enqBlank2.patient_id])).rows[0];
  expect(p1.mobile).toBeNull();
  expect(p2.mobile).toBeNull();

  // 5. Referral subtype: saved on enquiry creation
  const [{ create_enquiry: enqRef }] = await asAgent(`select create_enquiry($1::jsonb)`, [JSON.stringify({
    patient: { full_name: 'Patient Referral', mobile: '9820033333', address: '30 Mahim', pincode: '400016' },
    source_channel: 'referral',
    referral_subtype: 'Doctor',
    consent: true, service_ids: [services[0].id],
  })]);
  const [caseRef] = await asAgent(`select source_channel, referral_subtype from v_cases where id = $1`, [enqRef.case_id]);
  expect(caseRef.source_channel).toBe('referral');
  expect(caseRef.referral_subtype).toBe('Doctor');

  // 6. Referral subtype: editable via set_case_requirements
  await asAgent(`select set_case_requirements($1, $2::jsonb)`, [enqRef.case_id, JSON.stringify({
    referral_subtype: 'Nursing Team',
  })]);
  const [updatedRef] = await asAgent(`select referral_subtype from v_cases where id = $1`, [enqRef.case_id]);
  expect(updatedRef.referral_subtype).toBe('Nursing Team');

  // 7. Non-referral source clears referral_subtype in set_case_requirements
  await asAgent(`select set_case_requirements($1, $2::jsonb)`, [enqRef.case_id, JSON.stringify({
    source_channel: 'phone',
  })]);
  const [clearedRef] = await asAgent(`select source_channel, referral_subtype from v_cases where id = $1`, [enqRef.case_id]);
  expect(clearedRef.source_channel).toBe('phone');
  expect(clearedRef.referral_subtype).toBeNull();
}, 120000);
