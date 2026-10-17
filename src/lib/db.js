// Data access for every screen. Three modes, chosen at start-up:
//   live   VITE_SUPABASE_URL is set (the deployed app): Supabase login, all data through the Worker's /api.
//   local  no Supabase settings, but the local Worker answers (RUN-LOCAL-TEST.bat): pick a role, data through /api.
//   demo   neither: an in-browser Postgres (PGlite) with the real migrations and a week of sample data.
// Screens import { db } and use the familiar query builder: db.from('v_cases').select(...).eq(...), db.rpc(fn, args).
import { createApiClient, createDemoClient, onChange, emitChange } from './pg-adapter.js';
import { supabase } from './supabase.ts';
import { api, openLive, setLocalUser } from '../api.ts';

export let mode = supabase ? 'live' : null;
export let isDemo = false;      // true only in the in-browser demo (kept for the screens that show demo hints)
export let isLocal = false;     // local test against the real Worker, login off
export { supabase };

export let db = null;
export let pg = null;           // demo only

const KEY = 'caredesk-session-user';
let pickedUser = null;
/** The login picked on the start screen (demo and local test). */
export const demoSession = {
  userId: () => pickedUser,
  set(id) {
    pickedUser = id;
    if (mode === 'local') setLocalUser(id);
    try { id ? sessionStorage.setItem(KEY, id) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  },
  restore() {
    try { pickedUser = sessionStorage.getItem(KEY); } catch { pickedUser = null; }
    if (mode === 'local') setLocalUser(pickedUser);
    return pickedUser;
  },
};

async function localWorker() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('/api/v1/health', { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const h = await r.json();
    return h.auth === 'off' && h.database === 'UP';
  } catch { return false; }
}

let initPromise = null;

export async function initDb(onStep) {
  if (db) return db;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (mode === 'live') {
        db = createApiClient();
        return db;
      }
      onStep?.('Looking for the local test server');
      if (await localWorker()) {
        mode = 'local'; isLocal = true;
        db = createApiClient();
        return db;
      }
      mode = 'demo'; isDemo = true;
      const { bootDemo } = await import('../demo/boot.js');
      onStep?.('Starting demo database');
      pg = await bootDemo(onStep);
      db = createDemoClient(pg, demoSession);
      // service-role runner for demo simulations (telephony / AI stand-ins)
      db.service = async (sql, params = []) => {
        const rows = await pg.transaction(async (tx) => {
          await tx.query(`select set_config('request.jwt.claim.role', 'service_role', true), set_config('request.jwt.claim.sub', '', true)`);
          return (await tx.query(sql, params)).rows;
        });
        emitChange('*');
        return rows;
      };
      // the production Worker runs sla_scan() and activates approved prices whose date has come every minute; the demo does the same
      const scan = () => db.service('select sla_scan(), activate_due_prices()').catch(() => {});
      scan(); setInterval(scan, 60000);
      return db;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

export async function resetDemo() {
  const { bootDemo } = await import('../demo/boot.js');
  if (pg) await pg.close();
  pg = await bootDemo(() => {}, { fresh: true });
  db = createDemoClient(pg, demoSession);
  location.reload();
}

// Live updates: calls back when any of the given tables change (this screen's own writes at once,
// everyone else's through the Worker's live hub). Hidden tabs wait and catch up when shown again.
let liveStarted = false;
function startLive() {
  if (liveStarted || mode === 'demo' || !mode) return;
  liveStarted = true;
  let pending = new Set();
  const deliver = () => { const t = [...pending]; pending = new Set(); t.forEach((x) => emitChange(x)); };
  openLive((tables) => {
    tables.forEach((t) => pending.add(t));
    if (document.visibilityState === 'visible') deliver();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && pending.size) deliver(); });
}

export function subscribe(tables, cb) {
  startLive();
  return onChange((t) => { if (t === '*' || tables.includes(t)) cb(t); });
}

// Throws on error so callers can use try/catch + toast.
export async function q(promise) {
  const { data, error, count } = await promise;
  if (error) throw new Error(error.message);
  return count != null && data == null ? count : data;
}
export async function rpc(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}
export { api };
