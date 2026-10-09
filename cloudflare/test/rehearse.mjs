// Step 3 rehearsal: runs the REAL Worker (wrangler dev) against a database built from supabase/migrations/ and a
// stand-in for Supabase's login keys, then checks it before anything touches production:
//   - every table/column the code uses exists (replaces Hibernate ddl-auto=validate)
//   - the API is closed without a valid login (no token, forged token, expired token)
//   - the API tests (test/api.itest.mjs): roles per endpoint, case workflow, MyOperator webhooks + click-to-call, live updates
//   - exports docs/openapi.json (the contract src/api.ts is checked against) and docs/schema.md
// Run from the repo root: node scripts/rehearse.mjs (CI: after `supabase db start`).
// REHEARSAL_DB_URL overrides the database (default: local Supabase at 127.0.0.1:54322); "pglite" = an in-memory one.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import postgres from 'postgres';
import { runApiTests } from './api.itest.mjs';
import { startLocalDb } from './local-db.mjs';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const root0 = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const localDb = process.env.REHEARSAL_DB_URL === 'pglite' || process.argv.includes('--pglite') ? await startLocalDb({ root: root0, port: 54331 }) : null;
const DB = localDb?.url || process.env.REHEARSAL_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const JWKS_PORT = 54399;
const PORT = Number(process.env.REHEARSAL_PORT || 8799);
const SUPABASE = `http://127.0.0.1:${JWKS_PORT}`;
const base = `http://127.0.0.1:${PORT}`;

// --- A stand-in for Supabase Auth's signing keys (ES256, like the real project).
const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const KID = 'rehearsal-' + Date.now();
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' };
// ... and for its Auth admin API (new staff logins): users go into auth.users of the rehearsal database.
const ADMIN_KEY = 'rehearsal-secret';
const authDb = postgres(DB, { max: 1, onnotice: () => {} });
// ... and for MyOperator's click-to-call (OBD) API: requests are recorded for the API checks.
const obdCalls = [];
const jwks = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/auth/v1/.well-known/jwks.json') return send(200, { keys: [jwk] });
  if (req.url === '/obd' && req.method === 'POST') {
    let raw = ''; for await (const ch of req) raw += ch;
    obdCalls.push({ body: JSON.parse(raw || '{}'), headers: req.headers });
    if (obdCalls[obdCalls.length - 1].body.public_ivr_id === 'bad') return send(400, { status: 'error', code: 400, message: 'Public ID or Company id is invalid' });
    return send(200, { status: 'success', code: 200, message: 'Request accepted', unique_id: 'obd-' + obdCalls.length });
  }
  if (req.url.startsWith('/mo/search') && req.method === 'POST') { // MyOperator call-log search stand-in
    let raw = ''; for await (const ch of req) raw += ch;
    const f = new URLSearchParams(raw);
    if (f.get('token') !== 'api-tok') return send(200, { status: 'error', code: 401, message: 'Invalid token' });
    const t = Math.floor(Date.now() / 1000) - 300;
    return send(200, { status: 'success', code: 200, data: { total: 3, hits: [
      { _source: { _ai: 'sync-1', _cl: '+919876500077', _ev: 1, _su: 2, _st: t, _et: t + 25, _ty: 1, _ld: [] } },
      { _source: { _ai: 'sync-2', _cl: '+919876500078', _ev: 1, _su: 1, _st: t, _et: t + 95, _dr: '00:01:30', _ty: 1, _fn: 'rec-sync-2.mp3', _dn: 'HHCS',
        _ld: [{ _ds: 'ANSWER', _rr: [{ _na: 'Agent Two', _id: 'mo-88' }] }] } },
      { _source: { _ai: 'sync-3', _cl: '+919876500079', _ty: 2 } },
    ] } });
  }
  if (req.url.startsWith('/mo/user')) { // MyOperator Users API stand-in
    const tokenOk = new URL(req.url, 'http://x').searchParams.get('token') === 'api-tok';
    if (!tokenOk) return send(200, { status: 'error', code: 401, message: 'Invalid token' });
    return send(200, { status: 'success', code: 200, data: [
      { uuid: 'mo-77', name: 'Agent One', email: 'agent@rehearsal.test', contact_number: '+919800000077', extension: '11' },
      { uuid: 'mo-88', name: 'Agent Two', email: 'agent2@rehearsal.test', contact_number: '+919800000088', extension: '12' },
    ] });
  }
  if (req.url.startsWith('/auth/v1/admin/users')) {
    if (req.headers.apikey !== ADMIN_KEY) return send(401, { msg: 'Invalid API key' });
    let raw = ''; for await (const ch of req) raw += ch;
    const body = raw ? JSON.parse(raw) : {};
    const id = req.url.split('/')[5];
    try {
      if (req.method === 'POST') {
        if ((await authDb`select 1 from auth.users where lower(email) = ${String(body.email).toLowerCase()}`).length) return send(422, { msg: 'A user with this email address has already been registered', error_code: 'email_exists' });
        if (String(body.password || '').length < 8) return send(422, { msg: 'Password should be at least 8 characters.', error_code: 'weak_password' });
        const [u] = await authDb`insert into auth.users (id, email, aud, role) values (${crypto.randomUUID()}, ${body.email}, 'authenticated', 'authenticated') returning id::text`;
        return send(200, { id: u.id, email: body.email });
      }
      if (req.method === 'PUT' && id) return send(200, { id });
      if (req.method === 'DELETE' && id) { await authDb`delete from auth.users where id = ${id}::uuid`; return send(200, {}); }
    } catch (e) { return send(500, { msg: String(e.message || e) }); }
  }
  res.writeHead(404); res.end();
});
await new Promise((ok) => jwks.listen(JWKS_PORT, '127.0.0.1', ok));

async function token(sub, email, { key = privateKey, iss = SUPABASE + '/auth/v1', aud = 'authenticated', exp = '1h' } = {}) {
  return new SignJWT({ email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(key);
}

// --- The Worker, exactly as deployed, on this machine. A Worker left over from an earlier run would answer instead.
try {
  await fetch(base + '/api/version');
  console.error(`REHEARSAL FAILED: something is already listening on ${base} (an old wrangler dev?). Close it and run again.`);
  process.exit(1);
} catch {}
if (!existsSync(join(root, 'dist'))) {
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>rehearsal</title>');
}
const tmp = mkdtempSync(join(tmpdir(), 'caredesk-'));
const envFile = join(tmp, 'rehearsal.env');
writeFileSync(envFile, [
  `SUPABASE_URL=${SUPABASE}`, `SUPABASE_SERVICE_ROLE_KEY=${ADMIN_KEY}`, 'EXPOSE_CONTRACT=1', 'BUILD_SHA=rehearsal', 'GEMINI_API_KEY=',
  'MYOPERATOR_WEBHOOK_KEY=rehearsal-hook', 'MYOPERATOR_COMPANY_ID=co-1', 'MYOPERATOR_SECRET_TOKEN=st', 'MYOPERATOR_OBD_API_KEY=obd-key',
  'MYOPERATOR_PUBLIC_IVR_ID=ivr-1', `MYOPERATOR_OBD_URL=${SUPABASE}/obd`, `MYOPERATOR_API_URL=${SUPABASE}/mo`,
].join('\n') + '\n', { mode: 0o600 });
let log = '';
const noProxy = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',');
const worker = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--env-file', envFile,
  '--show-interactive-dev-session=false', '--log-level', 'warn'], {
  cwd: join(root, 'cloudflare'), shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32', // own process group, so stopping it also stops workerd
  // The Worker reaches the database through its Hyperdrive binding, exactly as in production.
  env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_PROXY: noProxy, no_proxy: noProxy,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: DB },
});
worker.stdout.on('data', (d) => (log += d));
worker.stderr.on('data', (d) => (log += d));
let stopping = false;
const stop = () => {
  stopping = true;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-worker.pid, 'SIGTERM');
  } catch {}
  jwks.close();
  authDb.end({ timeout: 1 }).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  localDb?.stop().catch(() => {});
};
const fail = (m) => {
  console.error('REHEARSAL FAILED: ' + m + '\n--- Worker log (last 60 lines) ---\n' + log.split('\n').slice(-60).join('\n'));
  stop();
  process.exit(1);
};
worker.on('exit', (c) => { if (!stopping) fail(`wrangler dev exited with code ${c} before the checks finished`); });

for (let i = 0; ; i++) {
  try { if ((await fetch(base + '/api/actuator/health/liveness')).ok) break; } catch {}
  if (i === 90) fail('The Worker did not start in 180 s');
  await new Promise((r) => setTimeout(r, 2000));
}

const sql = postgres(DB, { max: 1, onnotice: () => {}, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
try {
  const schema = await (await fetch(base + '/api/_schema-check')).json();
  if (schema.problems?.length) fail('The code uses columns the migrations do not create:\n  ' + schema.problems.join('\n  '));
  const health = await (await fetch(base + '/api/v1/health')).json();
  if (health.database !== 'UP') fail('Worker cannot reach the database: ' + JSON.stringify(health));

  const results = await runApiTests({ base, token, sql, wrongKey: (await generateKeyPair('ES256')).privateKey, obdCalls, webhookKey: 'rehearsal-hook' });
  if (results.failed.length) fail(`${results.failed.length} of ${results.total} API checks failed:\n  ` + results.failed.join('\n  '));
  console.log(`API checks OK: ${results.total} passed`);

  mkdirSync(join(root, 'docs'), { recursive: true });
  const spec = await (await fetch(base + '/api/_contract')).json();
  writeFileSync(join(root, 'docs', 'openapi.json'), JSON.stringify(spec, null, 2) + '\n');
  const cols = await sql`select table_name, column_name, data_type, is_nullable from information_schema.columns
                         where table_schema = 'public' order by table_name, ordinal_position`;
  let md = '# Database schema (generated from supabase/migrations - do not edit)\n';
  let t = '';
  for (const r of cols) {
    if (r.table_name !== t) { md += `\n## ${r.table_name}\n| column | type | nullable |\n|---|---|---|\n`; t = r.table_name; }
    md += `| ${r.column_name} | ${r.data_type} | ${r.is_nullable} |\n`;
  }
  writeFileSync(join(root, 'docs', 'schema.md'), md);
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  await sql.end({ timeout: 2 }).catch(() => {});
}
stop();
console.log('Rehearsal OK: Worker matches the migrations, API closed without login, API checks passed, contract exported');
process.exit(0);
