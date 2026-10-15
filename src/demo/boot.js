// Boots DEMO mode: an in-browser Postgres (PGlite) running the real migrations + a week of sample data.
import { PGlite } from '@electric-sql/pglite';
import { buildSeedSql } from './seed.js';

// The production migrations, in file-name order (same files the pipeline applies to Supabase).
const MIGRATIONS = Object.entries(import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }))
  .sort(([a], [b]) => a.localeCompare(b)).map(([, sql]) => sql);

const DB_VERSION = 'caredesk-demo-v8';

export async function seedDatabase(pg, onStep = () => {}) {
  onStep('Creating schema');
  for (const m of MIGRATIONS) await pg.exec(m);
  onStep('Loading a week of sample operations');
  const ws = (await pg.query(`select id from workspaces where code = 'HHC'`)).rows[0].id;
  const services = (await pg.query(`select id, code, name, category, price from services`)).rows;
  const templates = (await pg.query(`select id, code from templates`)).rows;
  const zones = (await pg.query(`select id, name from zones`)).rows;
  const sql = buildSeedSql({ ws, services, templates, zones });
  await pg.exec(`set session_replication_role = replica;\n${sql}\nset session_replication_role = origin;`);
  await pg.exec(`create table if not exists _demo_meta (k text primary key, v text); insert into _demo_meta values ('version', '${DB_VERSION}') on conflict (k) do update set v = excluded.v;`);
}

export async function bootDemo(onStep, { fresh = false } = {}) {
  const dataDir = 'idb://caredesk-demo';
  if (fresh) await deleteDb();
  let pg = new PGlite(dataDir);
  await pg.waitReady;
  let ready = false;
  try { ready = (await pg.query(`select v from _demo_meta where k = 'version'`)).rows[0]?.v === DB_VERSION; } catch { ready = false; }
  if (!ready) {
    await pg.close();
    await deleteDb();
    pg = new PGlite(dataDir);
    await pg.waitReady;
    await seedDatabase(pg, onStep);
  }
  return pg;
}

function deleteDb() {
  return new Promise((res) => {
    try {
      const req = indexedDB.deleteDatabase('/pglite/caredesk-demo');
      req.onsuccess = req.onerror = req.onblocked = () => res();
    } catch { res(); }
  });
}
