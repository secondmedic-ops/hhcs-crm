// Settings > Users (new login) and Settings > Telephony (integration status, last webhook events, MyOperator, AI summaries).
import type { Ctx } from '../api/context';
import { ROLES, supabaseBase } from '../api/auth';
import { ApiError } from '../domain/errors';
import { asUser, asSystem, normMobile, pgArray } from '../db';
import type { Env } from '../env';
import { MO_FIELDS, clearMoCache, describeMo, missingCallingSettings, moEnv, randomKey, wabaConfiguration } from './myoperator-config';
import { testWaba } from './myoperator';
import { syncCallLogs, syncState } from './mo-sync';
import { aiEnv, aiPause, clearAiCache, clearAiPause, describeAi } from './ai-config';
import { gemini, transcribeToken, LIVE_TRANSCRIBE_MODEL } from './ai';
import { safeSmtpError, sendMail, smtpConfig, SMTP_HOST, SMTP_PORT } from './smtp';

type J = Record<string, any>;

export async function createUser(c: Ctx, b: J) {
  if (!c.env.SUPABASE_SERVICE_ROLE_KEY) throw new ApiError(503, 'New logins need the Supabase service key: run START-HERE.bat and add it, or add the user in Supabase > Authentication.');
  if (!b?.email || !b?.password || !b?.full_name) throw new ApiError(400, 'Email, password and name are required', { email: 'must not be blank' });
  if (!(ROLES as readonly string[]).includes(b.role)) throw new ApiError(400, 'Unknown role');
  if (String(b.password).length < 10) throw new ApiError(400, 'Password must be at least 10 characters');
  let targetProviderId: string | null = null;
  if (c.user.role === 'provider') {
    if (b.role !== 'field_staff') throw new ApiError(403, 'Provider coordinators can only create field staff logins');
    const [callerProf] = await c.sql`select provider_id from profiles where id = ${c.user.id}::uuid and workspace_id = ${c.user.workspaceId}::uuid and active`;
    if (!callerProf?.provider_id) throw new ApiError(403, 'Your login is not linked to an active provider');
    targetProviderId = callerProf.provider_id;
  } else {
    if (b.role === 'provider' && !b.provider_id) throw new ApiError(400, 'Pick the provider (SecondMedic / Book My Medicare) for this login');
    if (b.provider_id) {
      if (!['provider','field_staff'].includes(b.role) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(b.provider_id))) throw new ApiError(400,'Choose a valid provider for this login');
      const provider = await asUser(c.sql,c.user.id,async tx => tx`select id from providers where id=${b.provider_id}::uuid and workspace_id=${c.user.workspaceId}::uuid and active`);
      if (!provider.result.length) throw new ApiError(400,'Choose an active provider in this workspace');
      targetProviderId = b.provider_id;
    }
  }
  const base = supabaseBase(c.env);
  const r = await fetch(base + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: b.email, password: b.password, email_confirm: true, user_metadata: { full_name: b.full_name } }),
  });
  const u = (await r.json().catch(() => ({}))) as J;
  if (!r.ok) throw new ApiError(r.status === 422 ? 409 : 502, u.msg || u.message || 'Could not create the login');
  const { result, changed } = await asSystem(c.sql, async (tx) => {
    const rawSkills = Array.isArray(b.skills) ? b.skills : typeof b.skills === 'string' ? b.skills.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const [p] = await tx`insert into profiles (id, workspace_id, full_name, email, phone, role, agent_code, myoperator_user_id, myoperator_extension, skills, provider_id)
      values (${u.id}, ${c.user.workspaceId}, ${b.full_name}, ${b.email}, ${normMobile(b.phone)}, ${b.role}, ${c.user.role === 'provider' ? null : (b.agent_code || null)},
        ${c.user.role === 'provider' ? null : (b.myoperator_user_id || null)}, ${c.user.role === 'provider' ? null : (b.myoperator_extension || null)}, ${pgArray((rawSkills as string[]).map(String))}::text[],
        ${['provider','field_staff'].includes(b.role) ? (targetProviderId || null) : null}::uuid) returning *`;
    return p;
  });
  c.changed.push(...changed);
  c.changed.push('profiles');
  return result;
}

export async function webhookEvents(c: Ctx) {
  return c.sql`select event_id, source, event_type, payload, processed, error, received_at from webhook_events order by received_at desc limit 50`;
}

/** Phone numbers (and any other long digit runs) out of error text before it reaches a screen. */
export const maskDigits = (t: unknown) => String(t ?? '').replace(/\+?\d[\d\s-]{6,}\d/g, '•••').slice(0, 300);

/** Settings > Telephony > Webhook health (supervisors, read-only): is MyOperator still posting to CareDesk?
 *  Times, event types, counts and masked error text only: no payloads, phone numbers or keys. */
export async function webhookHealth(c: Ctx) {
  const ws = c.user.workspaceId;
  const [last] = await c.sql`select event_type, received_at from webhook_events where source = 'myoperator' order by received_at desc limit 1`;
  const [lastSync] = await c.sql`select event_type, received_at from webhook_events where source = 'myoperator_sync' order by received_at desc limit 1`;
  const [counts] = await c.sql`select
      count(*) filter (where source = 'myoperator' and received_at > now() - interval '24 hours')::int as webhook_24h,
      count(*) filter (where source = 'myoperator' and received_at > now() - interval '7 days')::int as webhook_7d,
      count(*) filter (where source = 'myoperator_sync' and received_at > now() - interval '24 hours')::int as sync_24h,
      count(*) filter (where source = 'myoperator_sync' and received_at > now() - interval '7 days')::int as sync_7d,
      count(*) filter (where not processed and received_at > now() - interval '7 days')::int as unapplied_7d
    from webhook_events where received_at > now() - interval '7 days'`;
  const failed = await c.sql`select event_type, source, received_at, error from webhook_events
    where not processed and (error is not null or received_at < now() - interval '5 minutes')
    order by received_at desc limit 20`;
  const [health] = await c.sql`select settings from integration_settings where provider = 'webhook_health'`;
  const [sync] = await c.sql`select settings from integration_settings where provider = 'myoperator_sync'`;
  const [cfg] = await c.sql`select webhook_alert_hours(${ws}::uuid) as hours`;
  const [alert] = await c.sql`select created_at from notifications where workspace_id = ${ws}::uuid and kind = 'webhook_silence' order by created_at desc limit 1`;
  const h = health?.settings || {}, st = sync?.settings || {};
  return {
    last_event: last ? { at: last.received_at, type: last.event_type } : null,
    last_sync_event: lastSync ? { at: lastSync.received_at, type: lastSync.event_type } : null,
    counts,
    failed: failed.map((e) => ({ at: e.received_at, type: e.event_type, source: e.source, error: e.error ? maskDigits(e.error) : 'Not applied (no error recorded)' })),
    rejections: { last_401_at: h.last_401_at ?? null, last_503_at: h.last_503_at ?? null, last: h.last_rejection ?? null },
    sync: { last_ok_at: st.last_ok_at ?? null, last_error: st.last_error ? maskDigits(st.last_error) : null },
    alert: { hours: cfg?.hours ?? 4, window: '09:00 to 21:00 IST', last_alert_at: alert?.created_at ?? null },
  };
}

export async function integrations(c: Ctx) {
  const [e, ai] = await Promise.all([moEnv(c.env, c.sql), aiEnv(c.env, c.sql)]);
  return {
    supabase: !!(e.HYPERDRIVE || e.DATABASE_URL), auth: !!e.SUPABASE_URL, telephony: missingCallingSettings(e).length === 0,
    webhook: !!e.MYOPERATOR_WEBHOOK_KEY, recordings: !!e.MYOPERATOR_API_TOKEN,
    whatsapp: wabaConfiguration(e).status === 'configured' ? 'configured' : 'missing credentials',
    ai: !!ai.GEMINI_API_KEY, email: smtpConfig(c.env).ok, mis_email: smtpConfig(c.env).ok && !!c.env.MIS_RECIPIENTS?.trim(), user_admin: !!e.SUPABASE_SERVICE_ROLE_KEY,
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
  const [agents] = await c.sql`select count(*) filter (where role in ('agent','coordinator','supervisor','medical_desk') and active)::int as ops,
      count(*) filter (where role in ('agent','coordinator','supervisor','medical_desk') and active and myoperator_user_id is not null)::int as linked
    from profiles where workspace_id = ${c.user.workspaceId}::uuid`;
  return {
    fields: await describeMo(c.env, c.sql),
    waba: wabaConfiguration(env),
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
  const missing = missingCallingSettings(env);
  out.click_to_call = missing.length
    ? { ok: false, message: 'Missing: ' + missing.join(', ') }
    : { ok: true, message: 'Settings present. Link each agent below and place a test call to verify Calling API access and agent-first routing.' };
  const [last] = await c.sql`select event_type, received_at from webhook_events where source = 'myoperator' order by received_at desc limit 1`;
  out.webhook = !env.MYOPERATOR_WEBHOOK_KEY
    ? { ok: false, message: 'No webhook key yet: press Generate key' }
    : last
      ? { ok: true, message: `Last event received ${new Date(last.received_at).toISOString()} (${last.event_type})` }
      : { ok: false, message: 'Key set, but no event received yet. Add the webhook in MyOperator and make a test call.' };
  out.whatsapp = await testWaba(c);
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

// ---------- AI call summaries (Settings > Telephony & integrations > AI call summaries) ----------

/** Key (last 4 characters only), model, auto switch, and how the last 14 days of recorded calls stand. */
export async function aiSettings(c: Ctx) {
  const [stats] = await c.sql`select
      count(*) filter (where ai_processed_at is not null)::int as done,
      count(*) filter (where ai_processed_at is null and ai_status = 'failed')::int as failed,
      count(*) filter (where ai_processed_at is null and ai_status = 'skipped')::int as skipped,
      count(*) filter (where ai_processed_at is null and (ai_status is null or ai_status = 'processing'))::int as waiting
    from calls where workspace_id = ${c.user.workspaceId}::uuid and (recording_filename is not null or nullif(live_transcript, '') is not null) and started_at > now() - interval '14 days'`;
  const [last] = await c.sql`select ai_error, ai_started_at from calls
    where workspace_id = ${c.user.workspaceId}::uuid and ai_status = 'failed' order by ai_started_at desc nulls last limit 1`;
  return { ...(await describeAi(c.env, c.sql)), live_model: LIVE_TRANSCRIBE_MODEL, stats: stats ?? { done: 0, failed: 0, skipped: 0, waiting: 0 }, last_error: last ?? null, paused: await aiPause(c.sql) };
}

/** Save what was typed: api_key ('' removes the app key, the Worker secret applies again), model ('' = default), auto.
 *  Any save lifts a pause. retry_failed: true also puts the last 14 days' failed calls back in the queue with fresh attempts
 *  (after billing was turned on, for example). */
export async function saveAiSettings(c: Ctx, b: J) {
  const input: J = {};
  for (const k of ['api_key', 'model'] as const) {
    if (b?.[k] === undefined) continue;
    if (b[k] !== null && typeof b[k] !== 'string') throw new ApiError(400, `${k} must be text`);
    const t = String(b[k] ?? '').trim();
    if (t.length > 200) throw new ApiError(400, `${k} is too long`);
    if (k === 'model' && t && !/^[a-z0-9][a-z0-9.-]*$/i.test(t)) throw new ApiError(400, 'Model name: letters, digits, dots and dashes only (for example gemini-2.5-flash)');
    if (k === 'model' && /transcribe|live/i.test(t)) throw new ApiError(400, 'Choose a text model for summaries. Gemini 3.5 Transcribe Live is used separately for live speech.');
    input[k] = t;
  }
  if (b?.auto !== undefined) {
    if (typeof b.auto !== 'boolean') throw new ApiError(400, 'auto must be true or false');
    input.auto = b.auto ? 'on' : 'off';
  }
  const retry = b?.retry_failed === true;
  const { changed } = await asSystem(c.sql, async (tx) => {
    if (retry) await tx`update calls set ai_status = null, ai_attempts = 0, ai_error = null
      where workspace_id = ${c.user.workspaceId}::uuid and (recording_filename is not null or nullif(live_transcript, '') is not null) and ai_processed_at is null
        and ai_status in ('failed', 'skipped') and started_at > now() - interval '14 days'`;
    const [row] = await tx`select settings from integration_settings where provider = 'ai' for update`;
    const next: J = { ...((row?.settings as J) || {}) };
    for (const [k, v] of Object.entries(input)) { if (v) next[k] = v; else delete next[k]; }
    await tx`insert into integration_settings (provider, settings, updated_at, updated_by)
      values ('ai', ${tx.json(next)}, now(), ${c.user.id}::uuid)
      on conflict (provider) do update set settings = excluded.settings, updated_at = now(), updated_by = excluded.updated_by`;
    await tx`insert into access_log (workspace_id, user_id, action, entity, meta)
      values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, 'settings_changed', 'ai', ${tx.json({ fields: Object.keys(input), retry_failed: retry })})`;
    return null;
  });
  c.changed.push(...changed);
  clearAiCache();
  await clearAiPause(c.sql);
  return aiSettings(c);
}

/** One small request to Gemini with the saved key and model (no patient data). */
export async function testAi(c: Ctx) {
  const env = await aiEnv(c.env, c.sql);
  if (!env.GEMINI_API_KEY) return { ok: false, message: 'No Gemini API key yet' };
  try {
    const r = await gemini(env, [{ text: 'Reply with the JSON {"ok": true}.' }], { temperature: 0 });
    if (r?.ok !== true) return { ok: false, message: 'Gemini answered, but not as expected' };
    await transcribeToken(env);
    return { ok: true, message: `Summary model ${(await describeAi(c.env, c.sql)).model} answered; ${LIVE_TRANSCRIBE_MODEL} token created. Test live audio on a call to verify streaming access.` };
  } catch (e) {
    return { ok: false, message: String((e as Error).message || e).slice(0, 300) };
  }
}

// ---------- Outbound e-mail (Gmail SMTP) ----------

/** Readiness: what is set (names only, never values), the last MIS send. */
export async function emailStatus(c: Ctx) {
  const cfg = smtpConfig(c.env);
  const [mis] = await c.sql`select period, period_start, email_status, email_error, emailed_at, email_attempted_at from mis_snapshots
    where workspace_id = ${c.user.workspaceId}::uuid and email_status is not null order by email_attempted_at desc nulls last limit 1`;
  return {
    ready: cfg.ok, missing: cfg.ok ? [] : cfg.missing, host: SMTP_HOST, port: SMTP_PORT, security: 'implicit TLS, certificate verified',
    sender: c.env.SMTP_FROM || null, mis_recipients: (c.env.MIS_RECIPIENTS || '').split(',').filter((x) => x.trim()).length,
    last_mis: mis ?? null,
  };
}

/** Send one test message to the configured sender address only. body.debug = 2 returns a redacted SMTP transcript. */
export async function testEmail(c: Ctx, b: J) {
  const cfg = smtpConfig(c.env);
  if (!cfg.ok) return { ok: false, message: `E-mail is not configured (missing ${cfg.missing.join(', ')})` };
  const debug = b?.debug === 2 || b?.debug === '2' ? 2 : 0;
  let out: J;
  try {
    const r = await sendMail(c.env, {
      to: [cfg.cfg.from], subject: 'CareDesk e-mail test',
      text: 'Test message from CareDesk (Gmail SMTP). No patient data.',
      html: '<p>Test message from CareDesk (Gmail SMTP). No patient data.</p>',
    }, { debug });
    out = { ok: true, message: `Gmail accepted the test message for ${cfg.cfg.from} (accepted for delivery, not yet proof it reached the inbox: check the mailbox).`, attempts: r.attempts, transcript: r.transcript };
  } catch (e) {
    out = { ok: false, message: safeSmtpError(e) };
  }
  await asSystem(c.sql, (tx) => tx`insert into access_log (workspace_id, user_id, action, entity, meta)
    values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, 'email_test', 'smtp', ${tx.json({ ok: out.ok, message: out.message })})`);
  return out;
}
