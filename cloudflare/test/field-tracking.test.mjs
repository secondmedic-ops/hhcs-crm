import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('Live field staff geolocation tracking, geofencing, and ATA', { timeout: 30000 }, async () => {
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const bmm = (await db.query(`select id from providers where workspace_id=$1 and code='BMM'`, [ws])).rows[0];
  const sm = (await db.query(`select id from providers where workspace_id=$1 and code='SM'`, [ws])).rows[0];

  const fieldStaff1 = 'b1111111-1111-4111-8111-111111111111';
  const fieldStaff2 = 'b2222222-2222-4222-8222-222222222222';
  const bmmCoord = 'b3333333-3333-4333-8333-333333333333';
  const supUser = 'b4444444-4444-4444-8444-444444444444';

  // FieldStaff1 belongs to BMM
  await db.query(`insert into profiles(id, workspace_id, full_name, role, provider_id, active) values ($1,$2,$3,$4,$5,true)`,
    [fieldStaff1, ws, 'BMM Technician 1', 'field_staff', bmm.id]);
  // FieldStaff2 belongs to SM
  await db.query(`insert into profiles(id, workspace_id, full_name, role, provider_id, active) values ($1,$2,$3,$4,$5,true)`,
    [fieldStaff2, ws, 'SM Technician 2', 'field_staff', sm.id]);
  // BMM Coordinator
  await db.query(`insert into profiles(id, workspace_id, full_name, role, provider_id, active) values ($1,$2,$3,$4,$5,true)`,
    [bmmCoord, ws, 'BMM Coordinator', 'provider', bmm.id]);
  // SecondMedic Supervisor
  await db.query(`insert into profiles(id, workspace_id, full_name, role, active) values ($1,$2,$3,$4,true)`,
    [supUser, ws, 'Supervisor User', 'supervisor']);

  // Create patient and case
  const pat = (await db.query(`insert into patients(workspace_id, full_name, mobile, lat, lng)
    values ($1, 'Test Patient', '+919876543210', 19.0760, 72.8777) returning id`, [ws])).rows[0].id;
  const c = (await db.query(`insert into cases(workspace_id, patient_id, source_channel, stage, booked_slot)
    values ($1, $2, 'phone', 'booking', now() + interval '30 minutes') returning id`, [ws, pat])).rows[0].id;

  // Create assignment for fieldStaff1
  const asg = (await db.query(`insert into assignments(workspace_id, case_id, staff_id, task, status, eta)
    values ($1, $2, $3, 'nursing', 'assigned', now() + interval '25 minutes') returning id`,
    [ws, c, fieldStaff1])).rows[0].id;

  async function as(userId, sql, params = []) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [userId]);
    await db.exec('set role caredesk_app');
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec('reset role');
    }
  }

  // 0. Live location switch: a BMM field login is off until its manager turns it on; SecondMedic staff need no switch
  const insertOwn = (who) => as(who, `insert into staff_locations (workspace_id, staff_id, lat, lng) values ($1, $2, 19.07, 72.87)`, [ws, who]);
  await expect(insertOwn(fieldStaff1)).rejects.toThrow(/row-level security/);
  expect((await as(fieldStaff1, `select location_allowed($1) ok`, [fieldStaff1]))[0].ok).toBe(false);
  expect((await as(fieldStaff2, `select location_allowed($1) ok`, [fieldStaff2]))[0].ok).toBe(true);
  await expect(as(fieldStaff1, `select set_location_sharing($1, true)`, [fieldStaff1])).rejects.toThrow(/provider manager/);
  await expect(as(bmmCoord, `select set_location_sharing($1, true)`, [fieldStaff2])).rejects.toThrow(/provider manager/);
  await expect(as(bmmCoord, `select set_location_sharing($1, true)`, [bmmCoord])).rejects.toThrow(/not found/);
  await as(bmmCoord, `select set_location_sharing($1, true)`, [fieldStaff1]);
  expect((await as(fieldStaff1, `select location_sharing from profiles where id = $1`, [fieldStaff1]))[0].location_sharing).toBe(true);
  await as(supUser, `select set_location_sharing($1, false)`, [fieldStaff1]);
  await expect(insertOwn(fieldStaff1)).rejects.toThrow(/row-level security/);
  await as(bmmCoord, `select set_location_sharing($1, true)`, [fieldStaff1]);

  // 1. Field staff 1 can insert their own GPS location
  await as(fieldStaff1, `insert into staff_locations (workspace_id, staff_id, assignment_id, case_id, lat, lng, accuracy, speed, battery_pct)
    values ($1, $2, $3, $4, 19.0761, 72.8778, 10.5, 4.2, 85)`, [ws, fieldStaff1, asg, c]);

  // Field staff 2 inserts location
  await as(fieldStaff2, `insert into staff_locations (workspace_id, staff_id, lat, lng, accuracy)
    values ($1, $2, 18.5204, 73.8567, 15.0)`, [ws, fieldStaff2]);

  // 2. RLS read scoping:
  // Supervisor can read all staff locations
  const supLocs = await as(supUser, `select staff_id from staff_locations where workspace_id = $1`, [ws]);
  expect(supLocs.map((l) => l.staff_id)).toContain(fieldStaff1);
  expect(supLocs.map((l) => l.staff_id)).toContain(fieldStaff2);

  // BMM coordinator can read BMM staff location, but NOT SM staff location
  const bmmLocs = await as(bmmCoord, `select staff_id from staff_locations where workspace_id = $1`, [ws]);
  expect(bmmLocs.map((l) => l.staff_id)).toContain(fieldStaff1);
  expect(bmmLocs.map((l) => l.staff_id)).not.toContain(fieldStaff2);

  // 3. RPC field_update - en_route
  await as(fieldStaff1, `select field_update($1, 'en_route', $2::jsonb)`, [asg, JSON.stringify({ eta: new Date().toISOString() })]);
  const asgAfterEnRoute = (await as(fieldStaff1, `select status from assignments where id = $1`, [asg]))[0];
  expect(asgAfterEnRoute.status).toBe('en_route');

  // 4. RPC field_update - checkin records ATA, distance, and variance
  // Check in at 19.0761, 72.8778 (very close to patient 19.0760, 72.8777 - ~15m)
  const checkinRes = await as(fieldStaff1, `select field_update($1, 'checkin', $2::jsonb)`,
    [asg, JSON.stringify({ lat: 19.0761, lng: 72.8778 })]);

  const asgAfterCheckin = (await as(fieldStaff1,
    `select status, actual_arrival_at, checkin_distance_m, eta_vs_ata_variance_min from assignments where id = $1`, [asg]))[0];

  expect(asgAfterCheckin.status).toBe('checked_in');
  expect(asgAfterCheckin.actual_arrival_at).not.toBeNull();
  expect(Number(asgAfterCheckin.checkin_distance_m)).toBeLessThan(200);

  // Check that check-in also wrote a breadcrumb into staff_locations
  const breadcrumbs = await as(fieldStaff1, `select count(*) as cnt from staff_locations where assignment_id = $1`, [asg]);
  expect(Number(breadcrumbs[0].cnt)).toBeGreaterThanOrEqual(2);

  // 5. v_staff_locations view calculates distance_to_patient_m and shows latest location
  const viewLocs = await as(bmmCoord, `select staff_name, distance_to_patient_m, actual_arrival_at from v_staff_locations where staff_id = $1`, [fieldStaff1]);
  expect(viewLocs.length).toBe(1);
  expect(viewLocs[0].staff_name).toBe('BMM Technician 1');
  expect(Number(viewLocs[0].distance_to_patient_m)).toBeLessThan(200);
});
