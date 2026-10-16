import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('home X-ray options retain prices, units, routing and existing case snapshots', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '../../supabase/migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, file), 'utf8'));
    const rows = (await db.query("select code, name, price::text, unit, category, tax_basis from services where code in ('XR-HOME','XR-ADDITIONAL','XR-PRINT') order by code")).rows;
    expect(rows.map((r) => [r.code, r.price, r.unit, r.category, r.tax_basis])).toEqual([
      ['XR-ADDITIONAL', '700.00', '1 Additional X-ray Shoot', 'xray', null],
      ['XR-HOME', '2000.00', 'First Shot', 'xray', null],
      ['XR-PRINT', '200.00', 'additional X-ray Print', 'xray', null],
    ]);
    expect(rows.find((r) => r.code === 'XR-HOME').name).toBe('X-ray at Home');
    const [{ id: ws }] = (await db.query("select id from workspaces where code='HHC'")).rows;
    const uid = 'd1111111-1111-4111-8111-111111111111';
    await db.query("insert into profiles(id, workspace_id, full_name, role) values ($1,$2,'Diagnostic test agent','agent')", [uid, ws]);
    await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [uid]);
    await db.exec('set role caredesk_app');
    const ids = (await db.query("select id from services where code in ('XR-HOME','XR-ADDITIONAL','XR-PRINT') and active")).rows.map((r) => r.id);
    const [{ r }] = (await db.query('select create_enquiry($1::jsonb) r', [JSON.stringify({
      patient: { full_name: 'Diagnostic test patient', age: 50, gender: 'F', mobile: '+919876500099', address: 'Test address', pincode: '400058' },
      caller_name: 'Test caller', caller_relation: 'self', consent: true, service_ids: ids,
    })])).rows;
    const lines = (await db.query('select s.code, ci.unit, ci.unit_price::text from case_items ci join services s on s.id=ci.service_id where ci.case_id=$1 order by s.code', [r.case_id])).rows;
    expect(lines.map((v) => [v.code, v.unit_price, v.unit])).toEqual(rows.map((v) => [v.code, v.price, v.unit]));
    expect((await db.query('select total::text from cases where id=$1', [r.case_id])).rows[0].total).toBe('2900.00');
    expect((await db.query("select p.code from case_referrals cr join providers p on p.id=cr.provider_id where cr.case_id=$1", [r.case_id])).rows.map((v) => v.code)).toEqual(['SM']);
    await db.exec('reset role');
    await db.exec("update services set price=2100, version=version+1 where code='XR-HOME'");
    await db.exec(readFileSync(join(dir, '20261016130000_diagnostic_xray_home.sql'), 'utf8'));
    expect((await db.query("select price::text from services where code='XR-HOME'")).rows[0].price).toBe('2100.00');
    expect((await db.query("select count(*)::int n from service_price_history h join services s on s.id=h.service_id where s.code in ('XR-HOME','XR-ADDITIONAL','XR-PRINT')")).rows[0].n).toBe(3);
    expect((await db.query('select total::text from cases where id=$1', [r.case_id])).rows[0].total).toBe('2900.00');
  } finally { await db.close(); }
}, 120000);
