import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('BMM service scoping, non-BMM service restriction, and pricing guard', { timeout: 30000 }, async () => {
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const bmm = (await db.query(`select id, categories from providers where workspace_id=$1 and code='BMM'`, [ws])).rows[0];
  const sm = (await db.query(`select id, categories from providers where workspace_id=$1 and code='SM'`, [ws])).rows[0];

  // 1. Verify BMM categories
  expect(bmm.categories).toEqual(expect.arrayContaining(['nursing', 'physio', 'beds', 'eldercare', 'homecare', 'equipment', 'icu', 'other']));
  for (const nonBmm of ['lab', 'xray', 'ecg', 'visit']) {
    expect(bmm.categories).not.toContain(nonBmm);
  }

  // Create users
  const bmmUser = 'b7777777-7777-4777-8777-777777777777';
  const supUser = 'b3333333-3333-4333-8333-333333333333';
  await db.query(`insert into profiles(id, workspace_id, full_name, role, provider_id) values ($1,$2,$3,$4,$5)`,
    [bmmUser, ws, 'BMM Coordinator', 'provider', bmm.id]);
  await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1,$2,$3,$4)`,
    [supUser, ws, 'Supervisor User', 'supervisor']);

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

  // 2. Supervisor sees all services, with B2C prices
  const supServices = await as(supUser, `select code, category, price from services where workspace_id=$1`, [ws]);
  const supCats = new Set(supServices.map((s) => s.category));
  expect(supCats.has('lab')).toBe(true);
  expect(supCats.has('xray')).toBe(true);
  expect(supCats.has('ecg')).toBe(true);
  expect(supCats.has('nursing')).toBe(true);
  expect(supServices.some((s) => Number(s.price) > 0)).toBe(true);

  // 3. BMM sees ONLY allocated services; non-BMM services (lab, xray, ecg, visit) are strictly hidden
  const bmmServices = await as(bmmUser, `select code, category, price from services where workspace_id=$1`, [ws]);
  expect(bmmServices.length).toBeGreaterThan(0);
  for (const s of bmmServices) {
    expect(['lab', 'xray', 'ecg', 'visit']).not.toContain(s.category);
    expect(bmm.categories).toContain(s.category);
  }

  // 4. v_services view: BMM gets b2b_rate (70%) and price (B2C) is completely masked/null
  const bmmVServices = await as(bmmUser, `select code, category, price, b2b_rate, tax_basis from v_services where workspace_id=$1`, [ws]);
  expect(bmmVServices.length).toBeGreaterThan(0);
  for (const s of bmmVServices) {
    expect(s.price).toBeNull();
    expect(s.tax_basis).toBeNull();
    if (s.b2b_rate != null) {
      expect(Number(s.b2b_rate)).toBeGreaterThanOrEqual(0);
    }
  }

  // Supervisor gets B2C price on v_services
  const supVServices = await as(supUser, `select code, category, price, b2b_rate from v_services where workspace_id=$1 and code='NURSING-IV-VISIT'`, [ws]);
  expect(Number(supVServices[0].price)).toBe(1500);
  expect(supVServices[0].b2b_rate).toBeNull();

  // BMM gets 70% B2B rate on NURSING-IV-VISIT
  const bmmNurse = bmmVServices.find((s) => s.code === 'NURSING-IV-VISIT');
  expect(bmmNurse).toBeDefined();
  expect(Number(bmmNurse.b2b_rate)).toBe(1050); // 70% of 1500

  // 5. Approvals are hidden from BMM
  const bmmApprovals = await as(bmmUser, `select * from approvals`);
  expect(bmmApprovals.length).toBe(0);

  // 6. Direct provider_rates query from BMM yields 0 rows (internal confidentiality preserved)
  const bmmRates = await as(bmmUser, `select * from provider_rates`);
  expect(bmmRates.length).toBe(0);
});
