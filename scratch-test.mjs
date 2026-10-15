import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'supabase', 'migrations');
const db = new PGlite();

for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(dir, f), 'utf8'));
}

const ws = (await db.query(`select id from workspaces where code = 'HHC'`)).rows[0].id;
const agentId = '11111111-1111-1111-1111-111111111111';
await db.query(`insert into profiles(id, workspace_id, full_name, role) values ($1,$2,$3,$4) on conflict (id) do nothing`,
  [agentId, ws, 'Priya Sharma', 'agent']);

async function asAgent(sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [agentId]);
  await db.exec('set role caredesk_app');
  try {
    return await db.transaction(async (tx) => (await tx.query(sql, params)).rows);
  } finally { await db.exec('reset role'); }
}

const services = (await db.query(`select id, code from services`)).rows;

console.log('--- Test empty mobile 1 ---');
const r1 = await asAgent(`select create_enquiry($1::jsonb) r`, [JSON.stringify({
  patient: { full_name: 'Patient Empty 1', mobile: '', email: 'p1@test.com', address: 'Addr 1', pincode: '400050' },
  consent: true, service_ids: [services[0].id]
})]);
console.log('r1:', r1[0].r);

console.log('--- Test empty mobile 2 ---');
const r2 = await asAgent(`select create_enquiry($1::jsonb) r`, [JSON.stringify({
  patient: { full_name: 'Patient Empty 2', mobile: '', email: 'p2@test.com', address: 'Addr 2', pincode: '400050' },
  consent: true, service_ids: [services[0].id]
})]);
console.log('r2:', r2[0].r);

const pats = (await db.query(`select id, full_name, mobile, email from patients`)).rows;
console.log('Patients in DB:', pats);

