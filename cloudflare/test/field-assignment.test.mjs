import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('field dispatch board: idempotent assignment, reassignment, backup technicians, and visit deduplication', async () => {
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const coord = '22222222-2222-2222-2222-222222222222';
  const staff1 = '44444444-4444-4444-4444-444444444441';
  const staff2 = '44444444-4444-4444-4444-444444444442';

  await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1, $2, 'Coordinator', 'coordinator')`, [coord, ws]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role, skills) values ($1, $2, 'Pritesh Sonawane', 'field_staff', array['phlebotomy']::text[])`, [staff1, ws]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role, skills) values ($1, $2, 'Deepak Pawar', 'field_staff', array['phlebotomy']::text[])`, [staff2, ws]);

  const [{ id: patientId }] = (await db.query(`insert into patients(workspace_id, full_name, mobile) values ($1, 'Sunita Sharma', '9820011111') returning id`, [ws])).rows;
  const [{ id: caseId }] = (await db.query(`
    insert into cases(workspace_id, patient_id, case_no, booking_confirmed_at, stage, order_status)
    values ($1, $2, 'HHC-261023-00001', now(), 'booking', 'unassigned')
    returning id
  `, [ws, patientId])).rows;

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

  // 1. Assign staff1 first time
  const [{ assign_staff: id1 }] = await as(coord, `select assign_staff($1, $2, 'phlebotomy', now() + interval '90 minutes')`, [caseId, staff1]);
  expect(id1).toBeTruthy();

  // Verify order_status is 'assigned' so it leaves unassigned queue
  const [{ order_status: statusAfterFirst }] = (await db.query(`select order_status from cases where id = $1`, [caseId])).rows;
  expect(statusAfterFirst).toBe('assigned');

  // 2. Assign staff1 a second time quickly (idempotent assign)
  const [{ assign_staff: id2 }] = await as(coord, `select assign_staff($1, $2, 'phlebotomy', now() + interval '120 minutes')`, [caseId, staff1]);
  expect(id2).toBe(id1);

  // Confirm database still has only ONE assignment row for this order & staff
  const staff1Rows = (await db.query(`select * from assignments where case_id = $1 and staff_id = $2`, [caseId, staff1])).rows;
  expect(staff1Rows.length).toBe(1);
  expect(staff1Rows[0].status).toBe('assigned');
  expect(staff1Rows[0].role).toBe('primary');

  // 3. Reassign to staff2
  const [{ assign_staff: id3 }] = await as(coord, `select assign_staff($1, $2, 'phlebotomy', now() + interval '90 minutes')`, [caseId, staff2]);
  expect(id3).not.toBe(id1);

  const prevRow = (await db.query(`select * from assignments where id = $1`, [id1])).rows[0];
  expect(prevRow.status).toBe('reassigned');

  const newRow = (await db.query(`select * from assignments where id = $1`, [id3])).rows[0];
  expect(newRow.status).toBe('assigned');
  expect(newRow.staff_id).toBe(staff2);
  expect(newRow.role).toBe('primary');

  // Exactly 1 active primary assignment exists across the whole order
  const activePrimary = (await db.query(`
    select * from assignments where case_id = $1 and status not in ('cancelled', 'reassigned') and role = 'primary'
  `, [caseId])).rows;
  expect(activePrimary.length).toBe(1);
  expect(activePrimary[0].id).toBe(id3);

  // 4. Assign staff1 as backup technician for the active visit
  const [{ assign_staff: id4 }] = await as(coord, `select assign_staff($1, $2, 'phlebotomy', now() + interval '100 minutes', $3)`, [caseId, staff1, id3]);
  expect(id4).toBeTruthy();

  const backupRow = (await db.query(`select * from assignments where id = $1`, [id4])).rows[0];
  expect(backupRow.role).toBe('backup');
  expect(backupRow.status).toBe('assigned');
  expect(backupRow.backup_for).toBe(id3);

  // Primary visit remains active primary
  const primaryCheck = (await db.query(`select * from assignments where id = $1`, [id3])).rows[0];
  expect(primaryCheck.status).toBe('assigned');
  expect(primaryCheck.role).toBe('primary');

  // 5. Query v_assignments view and check lateral subquery fields
  const viewRows = await as(coord, `select * from v_assignments where case_id = $1 and status not in ('cancelled', 'reassigned')`, [caseId]);
  
  // Both rows exist (1 primary for staff2, 1 backup for staff1)
  expect(viewRows.length).toBe(2);

  const primaryView = viewRows.find((r) => r.id === id3);
  expect(primaryView).toBeTruthy();
  expect(primaryView.role).toBe('primary');
  expect(primaryView.backup_staff_name).toBe('Pritesh Sonawane');

  const backupView = viewRows.find((r) => r.id === id4);
  expect(backupView).toBeTruthy();
  expect(backupView.role).toBe('backup');

  // 6. Confirm unique partial index blocks inserting a second active primary
  let errorCaught = false;
  try {
    await db.query(`
      insert into assignments(workspace_id, case_id, staff_id, task, status, role)
      values ($1, $2, $3, 'phlebotomy', 'assigned', 'primary')
    `, [ws, caseId, staff1]);
  } catch (err) {
    errorCaught = true;
    expect(err.code).toBe('23505'); // unique_violation
  }
  expect(errorCaught).toBe(true);
}, 30000);
