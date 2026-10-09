// Settings > Users (new login) and Settings > Telephony (integration status, last webhook events).
import type { Ctx } from '../api/context';
import { ROLES, supabaseBase } from '../api/auth';
import { ApiError } from '../domain/errors';
import { asSystem, normMobile, pgArray } from '../db';
import type { Env } from '../env';
import { MO_FIELDS, clearMoCache, describeMo, moEnv, randomKey } from './myoperator-config';
import { syncCallLogs, syncState } from './mo-sync';

type J = Record<string, any>;

export async function createUser(c: Ctx, b: J) {
  if (!c.env.SUPABASE_SERVICE_ROLE_KEY) throw new ApiError(503, 'New logins need the Supabase service key: run START-HERE.bat and add it, or add the user in Supabase > Authentication.');
  if (!b?.email || !b?.password || !b?.full_name) throw new ApiError(400, 'Email, password and name are required', { email: 'must not be blank' });
  if (!(ROLES as readonly string[]).includes(b.role)) throw new ApiError(400, 'Unknown role');
  if (String(b.password).length < 10) throw new ApiError(400, 'Password must be at least 10 characters');
  if (b.role === 'provider' && !b.provider_id) throw new ApiError(400, 'Pick the provider (SecondMedic / Book My Medicare) for this login');
  const base = supabaseBase(c.env);
  const r = await fetch(base + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: b.email, password: b.password, email_confirm: true, user_metadata: { full_name: b.full_name } }),
  });
  const u = (await r.json().catch(() => ({}))) as J;
  if (!r.ok) throw new ApiError(r.status === 422 ? 409 : 502, u.msg || u.message || 'Could not create the login');
  const { result, changed } = await asSystem(c.sql, async (tx) => {
    const [p] = await tx`insert into profiles (id, workspace_id, full_name, email, phone, role, agent_code, myoperator_user_id, myoperator_extension, skills, provider_id)
      values (${u.id}, ${c.user.workspaceId}, ${b.full_name}, ${b.email}, ${normMobile(b.phone)}, ${b.role}, ${b.agent_code || null},
        ${b.myoperator_user_id || null}, ${b.myoperator_extension || null}, ${pgArray((b.skills || []).map(String))}::text[],
        ${b.role === 'provider' ? (b.provider_id as string) : null}::uuid) returning *`;
    return p;
  });
  c.changed.push(...changed);
  return result;
}

export async function webhookEvents(c: Ctx) {
  return c.sql`select event_id, source, event_type, payload, processed, error, received_at from webhook_events order by received_at desc limit 50`;
}

export async function integrations(c: Ctx) {
  const e = await moEnv(c.env, c.sql);
  return {
    supabase: !!(e.HYPERDRIVE || e.DATABASE_URL), auth: !!e.SUPABASE_URL, telephony: !!(e.MYOPERATOR_OBD_API_KEY && e.MYOPERATOR_COMPANY_ID),
    webhook: !!e.MYOPERATOR_WEBHOOK_KEY, recordings: !!e.MYOPERATOR_API_TOKEN, whatsapp: !!e.MYOPERATOR_WABA_API_KEY,
    ai: !!e.GEMINI_API_KEY, mis_email: !!(e.RESEND_API_KEY && e.MIS_RECIPIENTS), user_admin: !!e.SUPABASE_SERVICE_ROLE_KEY,
    webhook_url: (e.APP_URL || new URL(c.req.url).origin) + '/webhooks/myoperator', build: e.BUILD_SHA || 'dev',
  };
}

// ---------- MyOperator connection (Settings > Telephony > MyOperator) ----------

/** What is configured (credentials only as their last 4 characters), the webhook addresses, the last event received. */
export async function moSettings(c: Ctx) {
  const env = await moEnv(c.env, c.sql);
  const origin = (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  const key = env.MYOPERATOR_WEBHOOK_KEY || null;
  const [last] = await c.sql`select event_type, received_at, processed, error from webhook_events where source = 'myoperator' order by received_at desc limit 1`;
  const [agents] = await c.sql`select count(*) filter (where role in ('agent','coordinator','supervisor') and active)::int as ops,
      count(*) filter (where role in ('agent','coordinator','supervisor') and active and myoperator_user_id is not null)::int as linked
    from profiles where workspace_id = ${c.user.workspaceId}::uuid`;
  return {
    fields: await describeMo(c.env, c.sql),
    webhook: { key, url: origin + '/webhooks/myoperator', url_with_key: key ? `${origin}/webhooks/myoperator?key=${encodeURIComponent(key)}` : null },
    last_event: last ?? null,
    agents: agents ?? { ops: 0, linked: 0 },
    sync: await syncState(c.sql),
  };
}

/** Save values typed in the app. Only the keys sent change; "" removes the app value (the GitHub secret applies again). */
export async function saveMoSettings(c: Ctx, b: J) {
  const input = (b?.values && typeof b.values === 'object' ? b.values : {}) as J;
  const allowed = new Set<string>(MO_FIELDS.map((f) => f.key));
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) throw new ApiError(400, `Unknown MyOperator field: ${k}`);
    if (input[k] != null && typeof input[k] !== 'string') throw new ApiError(400, `${k} must be text`);
    if (String(input[k] ?? '').length > 500) throw new ApiError(400, `${k} is too long`);
  }
  if (b?.generate_webhook_key) input.webhook_key = randomKey();
  const { changed } = await asSystem(c.sql, async (tx) => {
    const [row] = await tx`select settings from integration_settings where provider = 'myoperator' for update`;
    const next: J = { ...((row?.settings as J) || {}) };
    for (const [k, v] of Object.entries(input)) {
      const t = String(v ?? '').trim();
      if (t) next[k] = t; else delete next[k];
    }
    await tx`insert into integration_settings (provider, settings, updated_at, updated_by)
      values ('myoperator', ${tx.json(next)}, now(), ${c.user.id}::uuid)
      on conflict (provider) do update set settings = excluded.settings, updated_at = now(), updated_by = excluded.updated_by`;
    await tx`insert into access_log (workspace_id, user_id, action, entity, meta)
      values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, 'settings_changed', 'myoperator', ${tx.json({ fields: Object.keys(input) })})`;
    return null;
  });
  c.changed.push(...changed);
  clearMoCache();
  return moSettings(c);
}

export interface MoUser { id: string; name: string; email: string | null; phone: string | null; extension: string | null }

/** Users on the MyOperator account (Users API, token parameter). */
export async function fetchMoUsers(env: Env): Promise<MoUser[]> {
  if (!env.MYOPERATOR_API_TOKEN) throw new ApiError(400, 'Enter the MyOperator API token first');
  const base = (env.MYOPERATOR_API_URL || 'https://developers.myoperator.co').replace(/\/$/, '');
  let last = '';
  for (const path of ['/user', '/users']) {
    const u = new URL(base + path);
    u.searchParams.set('token', env.MYOPERATOR_API_TOKEN);
    let res: Response;
    try { res = await fetch(u.toString(), { headers: { Accept: 'application/json' } }); } catch (e) { throw new ApiError(502, 'MyOperator could not be reached: ' + (e as Error).message); }
    const text = await res.text();
    last = `${res.status} ${text.slice(0, 200)}`;
    if (res.status === 404) continue;
    let j: J;
    try { j = JSON.parse(text); } catch { throw new ApiError(502, 'MyOperator answered in an unexpected format: ' + text.slice(0, 160)); }
    if (!res.ok || /error|fail/i.test(String(j.status || '')) || j.code >= 400) {
      throw new ApiError(res.status === 401 || res.status === 403 || j.code === 401 ? 400 : 502, 'MyOperator refused the API token: ' + (j.message || j.details || text.slice(0, 160)));
    }
    const list: J[] = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray(j.data?.users) ? j.data.users : Array.isArray(j.users) ? j.users : Array.isArray(j.data?.data) ? j.data.data : [];
    return list.map((x) => ({
      id: String(x.uuid ?? x.id ?? x.user_id ?? x.user_uuid ?? ''),
      name: String(x.name ?? [x.first_name, x.last_name].filter(Boolean).join(' ') ?? ''),
      email: x.email ? String(x.email) : null,
      phone: normMobile(x.contact_number ?? x.mobile ?? x.phone ?? x.contact ?? x.number ?? null),
      extension: x.extension != null ? String(x.extension) : null,
    })).filter((x) => x.id);
  }
  throw new ApiError(502, 'MyOperator users API not found: ' + last);
}

/** Check each part of the connection; nothing is changed and no call is placed. */
export async function testMo(c: Ctx) {
  const env = await moEnv(c.env, c.sql);
  const out: J = {};
  try {
    const users = await fetchMoUsers(env);
    out.api = { ok: true, message: `API token works: ${users.length} MyOperator user${users.length === 1 ? '' : 's'} found` };
  } catch (e) {
    out.api = { ok: false, message: (e as Error).message };
  }
  const missing = [['company_id', env.MYOPERATOR_COMPANY_ID], ['secret_token', env.MYOPERATOR_SECRET_TOKEN], ['obd_api_key', env.MYOPERATOR_OBD_API_KEY], ['public_ivr_id', env.MYOPERATOR_PUBLIC_IVR_ID]]
    .filter(([, v]) => !v).map(([k]) => MO_FIELDS.find((f) => f.key === k)!.label);
  out.click_to_call = missing.length
    ? { ok: false, message: 'Missing: ' + missing.join(', ') }
    : { ok: true, message: 'Ready. Each agent also needs their MyOperator user (Link users below).' };
  const [last] = await c.sql`select event_type, received_at from webhook_events where source = 'myoperator' order by received_at desc limit 1`;
  out.webhook = !env.MYOPERATOR_WEBHOOK_KEY
    ? { ok: false, message: 'No webhook key yet: press Generate key' }
    : last
      ? { ok: true, message: `Last event received ${new Date(last.received_at).toISOString()} (${last.event_type})` }
      : { ok: false, message: 'Key set, but no event received yet. Add the webhook in MyOperator and make a test call.' };
  return out;
}

/** MyOperator users with the CRM login each is linked to, plus suggested links (same email or phone). */
export async function moUsers(c: Ctx) {
  const env = await moEnv(c.env, c.sql);
  const users = await fetchMoUsers(env);
  const profiles = await c.sql`select id::text, full_name, email, phone, role, myoperator_user_id from profiles
    where workspace_id = ${c.user.workspaceId}::uuid and active order by full_name`;
  return {
    users: users.map((u) => {
      const linked = profiles.find((p) => p.myoperator_user_id === u.id);
      const suggested = linked ? null : profiles.find((p) => !p.myoperator_user_id &&
        ((u.email && p.email && p.email.toLowerCase() === u.email.toLowerCase()) || (u.phone && normMobile(p.phone) === u.phone)));
      return { ...u, linked_profile: linked?.id ?? null, linked_name: linked?.full_name ?? null, suggested_profile: suggested?.id ?? null, suggested_name: suggested?.full_name ?? null };
    }),
    profiles: profiles.map((p) => ({ id: p.id, full_name: p.full_name, role: p.role, myoperator_user_id: p.myoperator_user_id })),
  };
}

/** Link CRM logins to MyOperator users: body.links = [{profile_id, myoperator_user_id | null}], or body.auto = true (same email / phone). */
export async function linkMoUsers(c: Ctx, b: J) {
  let links: { profile_id: string; myoperator_user_id: string | null }[] = Array.isArray(b?.links) ? b.links : [];
  if (b?.auto) {
    const r = await moUsers(c);
    links = r.users.filter((u) => u.suggested_profile).map((u) => ({ profile_id: u.suggested_profile as string, myoperator_user_id: u.id }));
  }
  const uuid = /^[0-9a-f-]{36}$/i;
  for (const l of links) if (!uuid.test(String(l.profile_id))) throw new ApiError(400, 'Bad profile id');
  const { changed } = await asSystem(c.sql, async (tx) => {
    for (const l of links) {
      const id = l.myoperator_user_id ? String(l.myoperator_user_id).slice(0, 100) : null;
      if (id) await tx`update profiles set myoperator_user_id = null where workspace_id = ${c.user.workspaceId}::uuid and myoperator_user_id = ${id} and id <> ${l.profile_id}::uuid`;
      await tx`update profiles set myoperator_user_id = ${id} where id = ${l.profile_id}::uuid and workspace_id = ${c.user.workspaceId}::uuid`;
    }
    return null;
  });
  c.changed.push(...changed);
  return { linked: links.filter((l) => l.myoperator_user_id).length, unlinked: links.filter((l) => !l.myoperator_user_id).length };
}

/** Supervisors and the admin set the telephony fields of a login (MyOperator user id, extension, phone); nothing else. */
export async function setTelephony(c: Ctx, b: J) {
  if (!/^[0-9a-f-]{36}$/i.test(String(b?.profile_id || ''))) throw new ApiError(400, 'Bad profile id');
  const clean = (v: unknown, max: number) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
  const phone = b.phone ? normMobile(b.phone) : null;
  const { result, changed } = await asSystem(c.sql, async (tx) => {
    const [p] = await tx`update profiles set myoperator_user_id = ${clean(b.myoperator_user_id, 100)}, myoperator_extension = ${clean(b.myoperator_extension, 20)},
        phone = ${phone} where id = ${b.profile_id}::uuid and workspace_id = ${c.user.workspaceId}::uuid
      returning id::text, full_name, myoperator_user_id, myoperator_extension, phone`;
    if (!p) throw new ApiError(404, 'User not found');
    await tx`insert into access_log (workspace_id, user_id, action, entity, entity_id, meta)
      values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, 'settings_changed', 'telephony', ${b.profile_id}, ${tx.json({ fields: ['myoperator_user_id', 'myoperator_extension', 'phone'] })})`;
    return p;
  });
  c.changed.push(...changed);
  return result;
}

/** Run the call-log sync now (Settings > Telephony > Sync now). */
export async function syncNow(c: Ctx) {
  return syncCallLogs(c.env, c.sql, c.exec, { force: true });
}
