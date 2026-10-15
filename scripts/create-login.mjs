// Create (or update) one CareDesk login from the GitHub secret NEW_LOGIN, run by .github/workflows/create-login.yml.
// For the first administrator, or any login nobody in the app can create yet. Normal logins: Settings > Users > Add user.
//   NEW_LOGIN = {"full_name": "...", "email": "...", "password": "...", "role": "administrator"}
// The repository is public and so are its Actions logs: this script prints no name, email, id or password.
// Afterwards delete the secret: gh secret delete NEW_LOGIN
import { execFileSync } from 'node:child_process';

const ROLES = ['agent', 'coordinator', 'supervisor', 'field_staff', 'medical_desk', 'client_manager', 'client_clinical', 'admin', 'administrator'];
const fail = (m) => { console.error('create-login: ' + m); process.exit(1); };

const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const dbUrl = process.env.SUPABASE_DB_URL || '';
if (!base || !key || !dbUrl) fail('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_DB_URL are needed');
let L;
try { L = JSON.parse(process.env.NEW_LOGIN || ''); } catch { fail('NEW_LOGIN secret is missing or not JSON'); }
const email = String(L.email || '').trim().toLowerCase();
const fullName = String(L.full_name || '').trim();
const role = String(L.role || 'administrator');
if (!/^\S+@\S+\.\S+$/.test(email) || !fullName) fail('NEW_LOGIN needs full_name and email');
if (String(L.password || '').length < 10) fail('password must be at least 10 characters');
if (!ROLES.includes(role)) fail('unknown role (partner logins are made in Settings > Users)');

const auth = async (path, method, body) => {
  const r = await fetch(base + '/auth/v1/admin' + path, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
};

// the Supabase Auth login: create it, or set the password on the one that already exists
let id;
const made = await auth('/users', 'POST', { email, password: L.password, email_confirm: true, user_metadata: { full_name: fullName } });
if (made.ok) id = made.j.id;
else if (made.status === 422) {
  for (let page = 1; !id && page <= 20; page++) {
    const list = await auth(`/users?page=${page}&per_page=200`, 'GET');
    if (!list.ok) fail(`could not list logins (HTTP ${list.status})`);
    const users = list.j.users || [];
    id = users.find((u) => String(u.email || '').toLowerCase() === email)?.id;
    if (users.length < 200) break;
  }
  if (!id) fail('the email is registered but the login was not found');
  const upd = await auth(`/users/${id}`, 'PUT', { password: L.password, email_confirm: true });
  if (!upd.ok) fail(`could not update the existing login (HTTP ${upd.status})`);
} else fail(`Supabase refused the login (HTTP ${made.status}): ${made.j.msg || made.j.message || ''}`);

// the CareDesk profile: role, workspace, active (psql variables, never pasted into the SQL text)
const sql = `insert into profiles (id, workspace_id, full_name, email, role, active)
  select :'uid'::uuid, w.id, :'name', :'email', :'role'::app_role, true from workspaces w where w.code = 'HHC'
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, role = excluded.role, active = true`;
// read from stdin: psql fills in :'var' only there, not in -c
execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-v', `uid=${id}`, '-v', `name=${fullName}`, '-v', `email=${email}`, '-v', `role=${role}`, '-f', '-'],
  { input: `${sql};\n`, stdio: ['pipe', 'ignore', 'inherit'] });
console.log(`Login ready with role ${role}${made.ok ? ' (new)' : ' (existing login updated)'}. Delete the NEW_LOGIN secret now.`);
