import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = new PGlite();
const dir = join(import.meta.dirname, '../../supabase/migrations');
for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(dir, f), 'utf8'));
}

const ws = (await db.query("select id from workspaces where code='HHC'")).rows[0].id;
const user = '73000000-0000-4000-8000-000000000002';
await db.query("insert into profiles(id, workspace_id, full_name, role) values ($1, $2, 'Agent', 'agent')", [user, ws]);
await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [user]);
await db.exec('set role caredesk_app');

const svcs = Object.fromEntries((await db.query('select code, id from services')).rows.map(r => [r.code, r.id]));
const enq = (await db.query("select create_enquiry($1::jsonb) v", [JSON.stringify({
  patient: { full_name: 'Anil Desai', mobile: '9820011999', address: 'Bandra West', pincode: '400050' },
  consent: true,
  care_type: 'post_discharge',
  service_ids: [svcs['LAB-CBC'], svcs['ECG-12']]
})])).rows[0].v;

console.log('Enquiry:', enq);
const c = (await db.query('select total, subtotal, stage, quote_status from cases where id = $1', [enq.case_id])).rows[0];
console.log('Case:', c);
const items = (await db.query('select id, service_code, unit_price, qty, line_total, excluded from case_items where case_id = $1', [enq.case_id])).rows;
console.log('Items:', items);
