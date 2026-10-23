import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('field assignment guard: duplicate prevention, reassignment, backups, concurrency, and RBAC', async () => {
  const db = await PGlite.create();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const coord = '22222222-2222-2222-2222-222222222222';
  const supervisor = '33333333-3333-3333-3333-333333333333';
  const staffA = '44444444-4444-4444-4444-444444444441';
  const staffB = '44444444-4444-4444-4444-444444444442';
  const staffC = '44444444-4444-4444-4444-444444444443';
  const accountsUser = '55555555-5555-5555-5555-555555555555';

  await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1, $2, 'Farhan Coordinator', 'coordinator')`, [coord, ws]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1, $2, 'Meera Supervisor', 'supervisor')`, [supervisor, ws]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role, skills) values ($1, $2, 'Pritesh Sonawane', 'phlebotomist', array['phlebotomy']::text[])`, [staffA, ws]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role, skills) values ($1, $2, 'Deepak Pawar', 'phlebotomist', array['phlebotomy']::text[])`, [staffB, ws]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role, skills) values ($1, $2, 'Kavita More', 'phlebotomist', array['phlebotomy']::text[])`, [staffC, ws]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1, $2, 'Sandeep Accounts', 'accounts')`, [accountsUser, ws]);

  const [{ id: patientId1 }] = (await db.query(`insert into patients(workspace_id, full_name, mobile) values ($1, 'Sunita Sharma', '9820011111') returning id`, [ws])).rows;
  const [{ id: caseId1 }] = (await db.query(`
    insert into cases(workspace_id, patient_id, case_no, booking_confirmed_at, stage, order_status)
    values ($1, $2, 'HHC-261023-00001', now(), 'booking', 'unassigned')
    returning id
  `, [ws, patientId1])).rows;

  const [{ id: patientId2 }] = (await db.query(`insert into patients(workspace_id, full_name, mobile) values ($1, 'Ramesh Kapoor', '9820022222') returning id`, [ws])).rows;
  const [{ id: caseId2 }] = (await db.query(`
    insert into cases(workspace_id, patient_id, case_no, booking_confirmed_at, stage, order_status)
    values ($1, $2, 'HHC-261023-00002', now(), 'booking', 'unassigned')
    returning id
  `, [ws, patientId2])).rows;

  async function as(user, sql, params = []) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [user]);
    await db.exec('set role caredesk_app');
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec('reset role');
    }
  }

  // TEST CASE 1: Assign Visit to Staff A -> try assigning Visit again to Staff B -> blocked with message
  const slot1 = new Date(Date.now() + 2 * 3600000).toISOString();
  const [{ assign_staff: idA }] = await as(coord, `select assign_staff($1, $2, 'phlebotomy', $3)`, [caseId1, staffA, slot1]);
  expect(idA).toBeTruthy();

  // Same staff idempotent assign succeeds
  const [{ assign_staff: idA2 }] = await as(coord, `select assign_staff($1, $2, 'phlebotomy', $3)`, [caseId1, staffA, slot1]);
  expect(idA2).toBe(idA);

  // Different staff assigning SAME task without Reassign fails with 23505 conflict message
  let duplicateBlocked = false;
  try {
    await as(coord, `select assign_staff($1, $2, 'phlebotomy', $3)`, [caseId1, staffB, slot1]);
  } catch (err) {
    duplicateBlocked = true;
    expect(err.message).toMatch(/already assigned to Pritesh Sonawane\. Use Reassign\./i);
  }
  expect(duplicateBlocked).toBe(true);

  // TEST CASE 2: Reassign Visit from A to B with mandatory reason
  // Omitting reason fails
  let noReasonFailed = false;
  try {
    await as(coord, `select reassign_staff($1, $2, $3, '')`, [caseId1, idA, staffB]);
  } catch (err) {
    noReasonFailed = true;
    expect(err.message).toMatch(/reason is mandatory/i);
  }
  expect(noReasonFailed).toBe(true);

  // Reassign with reason succeeds
  const [{ reassign_staff: idB }] = await as(coord, `select reassign_staff($1, $2, $3, 'staff_unavailable', $4, 'Staff unwell')`, [caseId1, idA, staffB, slot1]);
  expect(idB).toBeTruthy();
  expect(idB).not.toBe(idA);

  const prevA = (await db.query(`select * from assignments where id = $1`, [idA])).rows[0];
  expect(prevA.status).toBe('reassigned');
  expect(prevA.reassign_reason).toBe('staff_unavailable');
  expect(prevA.reassign_note).toBe('Staff unwell');

  const currB = (await db.query(`select * from assignments where id = $1`, [idB])).rows[0];
  expect(currB.status).toBe('assigned');
  expect(currB.staff_id).toBe(staffB);
  expect(currB.role).toBe('primary');

  // TEST CASE 3: Add backup C -> shows as backup, cannot pick active primary as backup
  let selfBackupBlocked = false;
  try {
    // Attempting to pick Staff B as backup for Staff B's own primary
    await as(coord, `select assign_staff($1, $2, 'phlebotomy', $3, $4, 'backup')`, [caseId1, staffB, slot1, idB]);
  } catch (err) {
    selfBackupBlocked = true;
    expect(err.message).toMatch(/cannot be the same person as the primary/i);
  }
  expect(selfBackupBlocked).toBe(true);

  // Picking Staff C as backup succeeds
  const [{ assign_staff: idC }] = await as(coord, `select assign_staff($1, $2, 'phlebotomy', $3, $4, 'backup')`, [caseId1, staffC, slot1, idB]);
  expect(idC).toBeTruthy();

  const backupRow = (await db.query(`select * from assignments where id = $1`, [idC])).rows[0];
  expect(backupRow.role).toBe('backup');
  expect(backupRow.status).toBe('assigned');
  expect(backupRow.backup_for).toBe(idB);

  // Primary visit remains active primary with backup attached
  const viewRows = await as(coord, `select * from v_assignments where case_id = $1 and status not in ('cancelled', 'reassigned')`, [caseId1]);
  const primaryView = viewRows.find((r) => r.id === idB);
  expect(primaryView).toBeTruthy();
  expect(primaryView.backup_staff_name).toBe('Kavita More');

  // Trying to add a second backup for the same task fails
  let secondBackupBlocked = false;
  try {
    await as(coord, `select assign_staff($1, $2, 'phlebotomy', $3, $4, 'backup')`, [caseId1, staffA, slot1, idB]);
  } catch (err) {
    secondBackupBlocked = true;
    expect(err.message).toMatch(/backup is already assigned for Phlebotomy/i);
  }
  expect(secondBackupBlocked).toBe(true);

  // TEST CASE 4: Concurrent / direct double insert blocked by partial unique constraint
  let directDuplicateBlocked = false;
  try {
    await db.query(`
      insert into assignments(workspace_id, case_id, staff_id, task, status, role)
      values ($1, $2, $3, 'phlebotomy', 'assigned', 'primary')
    `, [ws, caseId1, staffA]);
  } catch (err) {
    directDuplicateBlocked = true;
    expect(err.code).toBe('23505');
  }
  expect(directDuplicateBlocked).toBe(true);

  // TEST CASE 5: Phlebotomist login sees only own tasks; cannot open other cases via URL/API
  // Assign Staff A to caseId2
  await as(coord, `select assign_staff($1, $2, 'phlebotomy', $3)`, [caseId2, staffA, slot1]);

  // Staff A should be able to see caseId2 (where assigned)
  const staffACases = await as(staffA, `select id, case_no from v_cases where id = $1`, [caseId2]);
  expect(staffACases.length).toBe(1);
  expect(staffACases[0].id).toBe(caseId2);

  // Staff A should NOT be able to see caseId1 (where only staffB and staffC are active)
  const staffAForbiddenCases = await as(staffA, `select id, case_no from v_cases where id = $1`, [caseId1]);
  expect(staffAForbiddenCases.length).toBe(0);

  // TEST CASE 6: Accounts login cannot assign staff (denied)
  let accountsBlocked = false;
  try {
    await as(accountsUser, `select assign_staff($1, $2, 'phlebotomy', $3)`, [caseId1, staffA, slot1]);
  } catch (err) {
    accountsBlocked = true;
    expect(err.message).toMatch(/only coordinators assign field staff/i);
  }
  expect(accountsBlocked).toBe(true);
}, 45000);
