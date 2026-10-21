// Product knowledge + call scripts (20261016110000_product_knowledge_scripts): category defaults and scripts seeded,
// staff read all, a provider login only its provider's categories (20261021100200), only supervisor / admin edit and
// import, blank import cells keep saved text.
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('product knowledge: seed, read access, edit and import rules', async () => {
  const problems = [];
  const check = (cond, m) => { if (!cond) problems.push(m); };
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const prov = (await db.query(`select id from providers where workspace_id=$1 order by code limit 1`, [ws])).rows[0].id;
  const users = { agent: 'b1111111-1111-4111-8111-111111111111', sup: 'b3333333-3333-4333-8333-333333333333',
    admin: 'b6666666-6666-4666-8666-666666666666', provider: 'b7777777-7777-4777-8777-777777777777', coord: 'b2222222-2222-4222-8222-222222222222' };
  const roles = { agent: 'agent', sup: 'supervisor', admin: 'admin', provider: 'provider', coord: 'coordinator' };
  for (const [k, id] of Object.entries(users)) {
    await db.query(`insert into profiles(id, workspace_id, full_name, role, provider_id) values ($1,$2,$3,$4,$5)`, [id, ws, k + ' user', roles[k], k === 'provider' ? prov : null]);
  }
  async function as(user, sql, params = []) {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [users[user]]);
    await db.exec('set role caredesk_app');
    try { return await db.transaction(async (tx) => (await tx.query(sql, params)).rows); } finally { await db.exec('reset role'); }
  }
  async function refused(user, sql, params, match) {
    try { await as(user, sql, params); problems.push(`expected "${match}" for ${user}: ${sql}`); }
    catch (e) { check(e.message.includes(match), `wrong error for ${user}: ${e.message}`); }
  }

  // seeded
  const cats = (await as('agent', `select category from service_knowledge where category is not null order by category`)).map((r) => r.category);
  for (const c of ['lab', 'xray', 'ecg', 'nursing', 'beds', 'equipment']) check(cats.includes(c), `category default missing: ${c}`);
  const scripts = (await as('agent', `select code from templates where kind='script' and status='approved' order by code`)).map((r) => r.code);
  for (const c of ['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07', 'S-09']) check(scripts.includes(c), `script missing: ${c}`);

  // a provider login sees the product details of the categories its provider delivers, nothing else; staff see all
  const provCats = (await db.query(`select categories from providers where id=$1`, [prov])).rows[0].categories;
  const provRows = await as('provider', `select k.category, s.category as service_category from service_knowledge k left join services s on s.id = k.service_id`);
  check(provRows.length > 0, 'provider login cannot read the product details of its own categories');
  check(provRows.every((r) => provCats.includes(r.category ?? r.service_category)), 'provider login reads product details of another provider: ' + JSON.stringify(provRows));
  check(provRows.filter((r) => r.category).length === cats.filter((c) => provCats.includes(c)).length, 'provider login misses a category default of its own');
  check((await as('coord', `select count(*)::int n from service_knowledge`))[0].n === cats.length, 'coordinator cannot read product knowledge');

  // direct writes refused; RPC only for supervisor / admin
  await refused('sup', `insert into service_knowledge(workspace_id, category, summary) values ($1,'other','x')`, [ws], 'permission denied');
  const cbc = (await db.query(`select id from services where workspace_id=$1 and code='LAB-CBC'`, [ws])).rows[0].id;
  await refused('agent', `select save_service_knowledge($1::jsonb)`, [JSON.stringify({ service_id: cbc, summary: 'x' })], 'Not allowed');
  await refused('sup', `select save_service_knowledge($1::jsonb)`, [JSON.stringify({ service_id: cbc, category: 'lab', summary: 'x' })], 'one service or one category');

  await as('sup', `select save_service_knowledge($1::jsonb)`, [JSON.stringify({ service_id: cbc, summary: 'Counts blood cells.', ask_caller: 'Prescription?' })]);
  let row = (await as('agent', `select summary, ask_caller, faq from service_knowledge where service_id=$1`, [cbc]))[0];
  check(row?.summary === 'Counts blood cells.' && row?.ask_caller === 'Prescription?', 'service notes not saved');
  // fields not sent stay; empty sent clears
  await as('admin', `select save_service_knowledge($1::jsonb)`, [JSON.stringify({ service_id: cbc, faq: 'Q? A.', ask_caller: '' })]);
  row = (await as('agent', `select summary, ask_caller, faq from service_knowledge where service_id=$1`, [cbc]))[0];
  check(row.summary === 'Counts blood cells.' && row.ask_caller === null && row.faq === 'Q? A.', `partial save wrong: ${JSON.stringify(row)}`);

  // import: by code, blank keeps, unknown code skipped, empty row skipped
  const r = (await as('sup', `select import_service_knowledge($1::jsonb) r`, [JSON.stringify([
    { row: 2, service_code: 'lab-cbc', who_needs: 'Post-discharge follow-up', summary: '' },
    { row: 3, service_code: 'ECG-12', summary: 'Heart tracing at home.' },
    { row: 4, service_code: 'NOPE-1', summary: 'x' },
    { row: 5, service_code: 'XR-CHEST' },
  ])]))[0].r;
  check(r.saved === 2, `import saved ${r.saved}`);
  check(r.skipped.length === 2 && r.skipped.some((s) => s.code === 'NOPE-1') && r.skipped.some((s) => s.row === 5), `import skipped ${JSON.stringify(r.skipped)}`);
  row = (await as('agent', `select summary, who_needs from service_knowledge where service_id=$1`, [cbc]))[0];
  check(row.summary === 'Counts blood cells.' && row.who_needs === 'Post-discharge follow-up', 'import overwrote with blank or did not save');
  await refused('agent', `select import_service_knowledge('[]'::jsonb)`, [], 'Not allowed');
  check((await db.query(`select count(*)::int n from audit_log where table_name='service_knowledge'`)).rows[0].n >= 3, 'knowledge changes not audited');

  expect(problems).toEqual([]);
}, 120000);
