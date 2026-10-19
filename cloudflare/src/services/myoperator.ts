// MyOperator integration
//  - Webhook receiver POST /webhooks/myoperator (key in header x-webhook-key, ?key=, or Basic auth password):
//    Webhooks v2 (call.*, message.*), the after-call webhook and the in-call webhook (ringing / answered)
//  - Click-to-call through the OBD API (the agent's phone rings first, then the patient; the number never reaches the browser)
//  - Recording link lookup, WhatsApp send
// Every raw event is stored in webhook_events first (duplicates from MyOperator retries are skipped), so field mappings
// can be checked from Settings > Telephony after the first test call.
import { asSystem, connect, normMobile, pgArray, type Sql, type Tx } from '../db';
import type { Ctx } from '../api/context';
import type { Env } from '../env';
import { notifyLive } from './live';
import { missingCallingSettings, moEnv, wabaConfiguration } from './myoperator-config';
import { ApiError } from '../domain/errors';

const OBD_URL = 'https://obd-api.myoperator.co/obd-api-v1';
type J = Record<string, any>;

/** Every MyOperator time goes through here: epoch seconds or milliseconds (also "1760539745.5"), ISO with a zone, or a
 *  wall-clock time without a zone ("2026-10-15 19:49:05", what MyOperator shows), which is India time, never UTC. */
export const toIso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  let d: Date;
  const text = String(v).trim();
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(text)) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) {
    d = new Date(text.replace(' ', 'T') + '+05:30');
  } else d = new Date(text);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * One source of truth for a connected call's timing. MyOperator's own times win over the Worker's clock: the answer time
 * is the provider's, else end minus the provider's talk time, and only then the time the in-call webhook reached us.
 * Always started <= answered <= ended, and always a talk time (0 with duration_flag 'unknown' when nothing says how
 * long; averages skip it). duration_flag: null (as reported), 'derived' (talk from the timestamps), 'clamped'
 * (inverted or impossible values corrected), 'unknown'.
 */
export function settleTiming(a: { startedAt?: unknown; answeredAt?: unknown; serverAnsweredAt?: unknown; endedAt?: unknown; talkSeconds?: unknown }) {
  const ms = (v: unknown) => { const x = toIso(v); return x ? Date.parse(x) : null; };
  const iso = (n: number | null) => (n == null ? null : new Date(n).toISOString());
  let s = ms(a.startedAt), e = ms(a.endedAt), flag: string | null = null;
  if (s != null && e != null && e < s) { s = e; flag = 'clamped'; }
  const span = s != null && e != null ? Math.round((e - s) / 1000) : null;
  const t0 = a.talkSeconds == null || a.talkSeconds === '' ? NaN : Number(a.talkSeconds);
  let talk: number | null = Number.isFinite(t0) && t0 >= 0 && t0 <= 2147483647 ? Math.round(t0) : null;
  if (talk != null && span != null && talk > span + 1) { talk = span; flag = 'clamped'; }
  let an = ms(a.answeredAt);
  if (an == null && talk != null && e != null) an = e - talk * 1000;
  if (an == null) an = ms(a.serverAnsweredAt);
  if (an != null && s != null && an < s) { an = s; flag = flag || 'clamped'; }
  if (an != null && e != null && an > e) { an = e; flag = flag || 'clamped'; }
  if (talk == null) {
    if (an != null && e != null) { talk = Math.round((e - an) / 1000); flag = flag || 'derived'; }
    else { talk = 0; flag = 'unknown'; }
  }
  return { started_at: iso(s), answered_at: iso(an), ended_at: iso(e), talk_seconds: talk, duration_flag: flag };
}

/** The answer time already on the call, split by source: the Worker's clock (in-call webhook) is only a last resort. */
const knownAnswer = (call: J) => (call.raw?.answered_source === 'server' ? { serverAnsweredAt: call.answered_at } : { answeredAt: call.answered_at });
const int = (v: unknown) => (v == null || v === '' || isNaN(Number(v)) ? null : Math.round(Number(v)));
const mins = (s: number | null) => `${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`;

async function resolveWorkspace(tx: Tx, env: Env, did: unknown): Promise<string> {
  const n = normMobile(did);
  if (n) {
    const all = await tx`select id::text, settings from workspaces`;
    const hit = all.find((w) => ((w.settings?.did_numbers as string[]) || []).map(normMobile).includes(n));
    if (hit) return hit.id;
  }
  const [w] = await tx`select id::text from workspaces where code = ${env.DEFAULT_WORKSPACE_CODE || 'HHC'}`;
  if (!w) throw new Error('No workspace ' + (env.DEFAULT_WORKSPACE_CODE || 'HHC'));
  return w.id;
}

async function matchAgent(tx: Tx, ws: string, legs: J[], payload: J, phones: unknown[] = []) {
  const cands: unknown[] = [];
  for (const l of legs) {
    const a = l.agent || {};
    cands.push(a.uuid, a.id, a.email, a.extension, l.extension, l.user_id);
  }
  cands.push(payload.agent?.uuid, payload.agent?.email, payload.user_id);
  const vals = cands.filter(Boolean).map(String);
  const nums = phones.map(normMobile).filter(Boolean) as string[];
  if (!vals.length && !nums.length) return null;
  const lower = vals.map((v) => v.toLowerCase());
  const [p] = await tx`select id::text, full_name from profiles where workspace_id = ${ws}::uuid and active
    and (myoperator_user_id = any(${pgArray(vals)}::text[]) or myoperator_extension = any(${pgArray(vals)}::text[])
      or lower(email) = any(${pgArray(lower)}::text[]) or phone = any(${pgArray(nums)}::text[]))
    order by (myoperator_user_id = any(${pgArray(vals)}::text[])) desc nulls last limit 1`;
  return p ?? null;
}

const customerLegs = (legs: J[], number: string | null) => legs.filter((l) =>
  /customer|client/i.test(String(l.type || l.leg_type || '')) ||
  (!!number && normMobile(l.phone_number || l.number) === number));

const legsAnswered = (legs: J[]) => legs.some((l) => /^(answer|answered|connected|completed|success)$/i.test(l.dial_status || l.status || '') || !!l.answered_at || Number(l.talk_duration || 0) > 0);

/** Basic auth (user:password@ in the URL, or MyOperator's "Credentials"): the password is the key. */
function basicPassword(req: Request): string | null {
  const h = req.headers.get('authorization') || '';
  if (!/^basic /i.test(h)) return null;
  try { const t = atob(h.slice(6).trim()); return t.slice(t.indexOf(':') + 1); } catch { return null; }
}

/**
 * The three formats MyOperator sends, as one list of events:
 *  - Webhooks v2: JSON with event_type (call.*, message.*), one event or an array
 *  - After-call webhook (older): form or JSON field "myoperator" holding the call log (_ai, _cr, _su, _ld ...)
 *  - In-call webhook: JSON with uid, clid, call_state (0 ringing, 1 answered), users
 */
async function readEvents(req: Request): Promise<J[] | null> {
  const type = req.headers.get('content-type') || '';
  const text = await req.text();
  let body: unknown = null;
  if (/x-www-form-urlencoded/i.test(type) || (!/json/i.test(type) && /^[\w%.-]+=/.test(text))) {
    const f = new URLSearchParams(text);
    body = Object.fromEntries(f.entries());
  } else {
    try { body = JSON.parse(text); } catch { return null; }
  }
  const list = Array.isArray(body) ? body : [body];
  const out: J[] = [];
  for (let item of list) {
    if (!item || typeof item !== 'object') continue;
    let o = item as J;
    if (o.myoperator != null) {
      const inner = typeof o.myoperator === 'string' ? (() => { try { return JSON.parse(o.myoperator); } catch { return null; } })() : o.myoperator;
      if (inner && typeof inner === 'object') o = inner as J;
    }
    if (o.event_type) out.push(o);
    else if (o._ai || o._ci || o._cr || o._cl) out.push(afterCallEvent(o)); else if (o.uid != null && (o.call_state != null || o.clid != null)) {
      out.push({ event_id: `incall:${o.uid}:${o.call_state ?? ''}:${o.event ?? ''}`, event_type: Number(o.call_state) === 1 ? 'incall.answered' : 'incall.ringing', incall: o });
    } else out.push({ event_type: 'unknown', raw: o });
  }
  return out;
}

/** A refused webhook post (401 wrong / missing key, 503 no key set), for Settings > Telephony > Webhook health. Only
 *  the status and time are kept: never the key that was sent or the body. Never fails the response. */
async function noteRejection(sql: Sql, status: 401 | 503) {
  try {
    const now = new Date().toISOString();
    await sql`insert into integration_settings (provider, settings, updated_at)
      values ('webhook_health', ${sql.json({ [`last_${status}_at`]: now, last_rejection: { status, at: now } })}, now())
      on conflict (provider) do update set settings = integration_settings.settings || excluded.settings, updated_at = now()`;
  } catch { /* health note only */ }
}

export async function handleMyOperatorWebhook(req: Request, env0: Env, exec: ExecutionContext): Promise<Response> {
  const sql = connect(env0);
  const changedAll = new Set<string>();
  let responseBody: J = { ok: true };
  try {
    const env = await moEnv(env0, sql);
    const expected = env.MYOPERATOR_WEBHOOK_KEY;
    const got = req.headers.get('x-webhook-key') || new URL(req.url).searchParams.get('key') || basicPassword(req);
    if (req.headers.get('x-whatsapp-bridge') === '1' || new URL(req.url).searchParams.get('bridge') === 'whatsapp_qr') {
      return new Response('QR scanning is disabled for enterprise compliance. Use MyOperator WABA.', { status: 403 });
    }
    const authorized = !!expected && got === expected;
    if (!expected && !authorized) { await noteRejection(sql, 503); return new Response('webhook key not configured', { status: 503 }); }
    if (!authorized) { await noteRejection(sql, 401); return new Response('unauthorized', { status: 401 }); }
    const events = await readEvents(req);
    if (!events) return new Response('bad body', { status: 400 });
    if (events.length === 1 && events[0]?.raw?.bridge === 'whatsapp_qr') {
      return new Response('QR scanning is disabled for enterprise compliance. Use MyOperator WABA.', { status: 403 });
    } else {
      const r = await processEvents(sql, env, env0, exec, events);
      r.changed.forEach((x) => changedAll.add(x));
    }
  } finally {
    exec.waitUntil(sql.end({ timeout: 2 }).catch(() => {}));
  }
  if (changedAll.size) notifyLive(env0, exec, [...changedAll]);
  return Response.json(responseBody); // always 2xx after storing, so MyOperator does not retry forever
}

/**
 * Store each event once (webhook_events, unique event id) and apply it to calls / cases / callbacks.
 * Used by the webhook and by the call-log sync (both use the same event id per MyOperator call log, so a call that
 * arrives both ways is applied once).
 */
export async function processEvents(sql: Sql, env: Env, env0: Env, exec: ExecutionContext, events: J[]) {
  const changed = new Set<string>();
  let stored = 0, applied = 0, failed = 0;
  for (const ev of events) {
    const eventId = String(ev.event_id || `${ev.event_type}:${ev.session_id}:${ev.event_sequence ?? Date.now()}`);
    const payload = ev.v1 || ev.incall || ev.raw || ev;
    const fresh = await sql`insert into webhook_events (event_id, source, event_type, payload)
      values (${eventId}, ${ev.source || 'myoperator'}, ${ev.event_type ?? null}, ${sql.json(payload)}) on conflict do nothing returning event_id`;
    if (!fresh.length) continue; // already handled (MyOperator retry, or the same call from the other route)
    stored++;
    try {
      const { result: after, changed: ch } = await asSystem(sql, async (tx) => {
        const t = String(ev.event_type || '');
        if (t.startsWith('call.')) return onCallEvent(tx, env, ev);
        if (t === 'aftercall') return onAfterCall(tx, env, ev.v1);
        if (t.startsWith('incall.')) { await onInCall(tx, env, ev.incall); return null; }
        if (t.startsWith('message.')) { await onMessageEvent(tx, env, ev); return null; }
        if (t === 'unknown') throw new Error('Format not recognised (stored for checking)');
        return null;
      });
      ch.forEach((x) => changed.add(x));
      await sql`update webhook_events set processed = true where event_id = ${eventId}`;
      applied++;
      // AI summary of the recording; it checks the key and the auto-summary switch itself (Settings or Worker secret)
      if (after?.aiCallId) {
        const { summariseIfEnabled } = await import('./ai');
        exec.waitUntil(summariseIfEnabled(env0, after.aiCallId, exec));
      }
    } catch (e) {
      failed++;
      await sql`update webhook_events set error = ${String((e as Error).message || e)} where event_id = ${eventId}`;
    }
  }
  return { stored, applied, failed, changed };
}

/** A call-log entry (after-call webhook or call-log search) -> the event processEvents applies. */
export function afterCallEvent(o: J, source = 'myoperator'): J {
  const uid = (o._pm || []).find((x: J) => x?.ky === 'ui')?.vl;
  return { event_id: `v1:${o._ai || uid || o._st}`, event_type: 'aftercall', v1: o, source };
}

/** The CRM call for a provider session: by session id, else by our click-to-call reference, else a new one. */
async function findOrCreateCall(tx: Tx, a: { ws: string; session: string; refId?: unknown; customer: string | null; direction: string;
  did: string | null; startedAt: string | null; providerCallId?: string | null; first: J; adoptRecent?: boolean }): Promise<J> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${a.ws + ':' + a.session}, 0))`;
  let [call] = await tx`select * from calls where provider = 'myoperator' and workspace_id = ${a.ws}::uuid
    and (session_id = ${a.session} or (${a.providerCallId ?? null}::text is not null and provider_call_id = ${a.providerCallId ?? null})) limit 1 for update`;
  if (!call && a.refId) {
    [call] = await tx`update calls set session_id = ${a.session} where workspace_id = ${a.ws}::uuid and click_to_call_ref = ${String(a.refId)} returning *`;
  }
  if (!call && a.adoptRecent && a.customer) {
    // the in-call webhook may have opened this call under another id: take over a live call from the same number
    [call] = await tx`update calls set session_id = ${a.session} where id = (select id from calls where provider = 'myoperator'
      and workspace_id = ${a.ws}::uuid and direction = ${a.direction} and click_to_call_ref is null
      and customer_number = ${a.customer} and status in ('ringing','answered')
      and started_at > now() - interval '3 hours' order by started_at desc limit 1) returning *`;
  }
  if (!call) {
    const [patient] = a.customer ? await tx`select id from patients where workspace_id = ${a.ws}::uuid and mobile = ${a.customer} limit 1` : [];
    const [open] = patient ? await tx`select id from cases where patient_id = ${patient.id} and stage not in ('closed','cancelled') order by created_at desc limit 1` : [];
    [call] = await tx`insert into calls (workspace_id, provider, session_id, provider_call_id, direction, customer_number, did_number, status,
        started_at, patient_id, case_id, raw)
      values (${a.ws}::uuid, 'myoperator', ${a.session}, ${a.providerCallId ?? null}, ${a.direction}, ${a.customer}, ${a.did}, 'ringing',
        ${a.startedAt || new Date().toISOString()}, ${patient?.id ?? null}, ${open?.id ?? null}, ${tx.json({ first: a.first })})
      returning *`;
  }
  return call;
}

/** The workspace's only line, when it has exactly one (the older webhooks do not say which number was called). */
async function soleLine(tx: Tx, ws: string): Promise<string | null> {
  const [w] = await tx`select settings from workspaces where id = ${ws}::uuid`;
  const n = ((w?.settings?.did_numbers as string[]) || []).map(normMobile).filter(Boolean);
  return n.length === 1 ? n[0] : null;
}

const hms = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const text = String(v).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text) && !/^\d+:[0-5]?\d(?::[0-5]?\d)?$/.test(text)) return null;
  const seconds = Math.round(text.split(':').map(Number).reduce((s, x) => s * 60 + x, 0));
  return Number.isSafeInteger(seconds) && seconds <= 2147483647 ? seconds : null;
};

const elapsedSeconds = (start: unknown, end: unknown): number | null => {
  const s = toIso(start), e = toIso(end);
  if (!s || !e) return null;
  const seconds = Math.round((Date.parse(e) - Date.parse(s)) / 1000);
  return seconds >= 0 && seconds <= 2147483647 ? seconds : null;
};

/** Fallback ring duration: EXTRACT(EPOCH FROM (end - start)) capped safely between 0 and 120s. */
export const ringFallback = (start: unknown, end: unknown, cap = 120): number | null => {
  const s = toIso(start), e = toIso(end);
  if (!s || !e) return null;
  const seconds = Math.round((Date.parse(e) - Date.parse(s)) / 1000);
  if (isNaN(seconds)) return null;
  return Math.max(0, Math.min(cap, seconds));
};

/** Legacy _ss is UTC seconds since midnight in some payloads, never a safe talk-time fallback. */
export function afterCallTalkSeconds(o: J): number | null {
  const elapsed = elapsedSeconds(o._st, o._et);
  const valid = (seconds: number | null, limit = elapsed) => seconds != null && seconds <= 2147483647 && (limit == null || seconds <= limit + 1);
  for (const field of [o._dr, o._drs]) {
    const seconds = hms(field);
    if (valid(seconds)) return seconds;
  }
  const legs: J[] = Array.isArray(o._ld) ? o._ld : [];
  const durations = legs.map((leg) => {
    const limit = elapsedSeconds(leg._st, leg._et) ?? elapsed;
    for (const field of [leg._dr, leg._drs]) {
      const seconds = hms(field);
      if (valid(seconds, limit)) return seconds;
    }
    return null;
  });
  if (durations.length && durations.every((s) => s != null)) {
    const total = durations.reduce<number>((sum, s) => sum + (s ?? 0), 0);
    if (valid(total)) return total;
  }
  return elapsed;
}

/** After-call webhook: one message when the call is over, with status, times, agent legs and the recording. */
async function onAfterCall(tx: Tx, env: Env, o: J): Promise<{ aiCallId?: string } | null> {
  if (Number(o._ty || 1) === 2) return null; // SMS log
  const ws = await resolveWorkspace(tx, env, o._did || o._vn || null);
  const customer = normMobile(o._cl || o._cr);
  const direction = Number(o._ev) === 2 ? 'outbound' : 'inbound';
  const uid = (o._pm || []).find((x: J) => x?.ky === 'ui')?.vl;
  const session = String(uid || o._ai);
  const did = normMobile(o._did || o._vn) || (await soleLine(tx, ws));
  let call = await findOrCreateCall(tx, { ws, session, refId: o._cri || o._ri, customer, direction, did, startedAt: toIso(o._st),
    providerCallId: o._ai ? String(o._ai) : null, first: o, adoptRecent: true });

  const legs: J[] = Array.isArray(o._ld) ? o._ld : [];
  const agents: J[] = legs.flatMap((l) => (Array.isArray(l._rr) ? l._rr : l._rr ? [l._rr] : []));
  const answeredLeg = legs.find((l) => /^(answer|answered|connected)$/i.test(String(l._ds || l._ac || '')));
  const pick = answeredLeg ? (Array.isArray(answeredLeg._rr) ? answeredLeg._rr : [answeredLeg._rr]).filter(Boolean) : agents;
  const agent = await matchAgent(tx, ws, pick.map((a: J) => ({ user_id: a._id, agent: { email: a._em, id: a._id } })), {}, pick.map((a: J) => a._nr || a._ct));

  const connected = Number(o._su) === 1;
  const patch: J = {
    status: connected ? 'completed' : direction === 'outbound' ? 'failed' : 'missed',
    ended_at: toIso(o._et) || new Date().toISOString(),
    talk_seconds: connected ? afterCallTalkSeconds(o) : 0,
    raw: tx.json({ ...(call.raw || {}), end: o }),
  };
  if (connected) {
    const t = settleTiming({ startedAt: toIso(o._st) || call.started_at, endedAt: patch.ended_at, talkSeconds: patch.talk_seconds, ...knownAnswer(call) });
    Object.assign(patch, { ended_at: t.ended_at, talk_seconds: t.talk_seconds, answered_at: t.answered_at, duration_flag: t.duration_flag });
    if (t.started_at && t.started_at !== new Date(call.started_at).toISOString()) patch.started_at = t.started_at;
  }
  if (call.ring_seconds == null || call.ring_seconds === 0) {
    const startedAt = call.started_at || toIso(o._st);
    if (!connected && patch.status === 'missed') {
      const ring = ringFallback(startedAt, patch.ended_at, 120);
      if (ring != null) patch.ring_seconds = ring;
    } else if (connected) {
      const answeredAt = patch.answered_at || call.answered_at;
      const ring = ringFallback(startedAt, answeredAt, 120);
      if (ring != null) patch.ring_seconds = ring;
    }
  }
  if (!connected && direction === 'outbound') patch.raw = tx.json({ ...(call.raw || {}), end: o,
    callback_failure_reason: answeredLeg ? 'Customer did not connect after the agent answered'
      : 'Agent unavailable or call not connected; customer reachability not verified' });
  if (o._fn) patch.recording_filename = String(o._fn);
  if (o._dn) patch.department = String(o._dn);
  if (agent && !call.agent_id) { patch.agent_id = agent.id; patch.agent_name = agent.full_name; }
  else if (!call.agent_name && pick[0]?._na) patch.agent_name = String(pick[0]._na);
  [call] = await tx`update calls set ${tx(patch)} where id = ${call.id} returning *`;
  return afterCallEnded(tx, call);
}

/** In-call webhook: ringing (screen pop for the agent being rung) and answered. */
async function onInCall(tx: Tx, env: Env, o: J) {
  const ws = await resolveWorkspace(tx, env, o.did || o.did_number || null);
  const customer = normMobile(o.clid);
  const session = String(o.uid);
  const did = normMobile(o.did || o.did_number) || (await soleLine(tx, ws));
  let call = await findOrCreateCall(tx, { ws, session, refId: o.client_ref_id || o.reference_id, customer, direction: 'inbound', did,
    startedAt: new Date().toISOString(), first: o });
  const users = (Array.isArray(o.users) ? o.users : o.users ? [o.users] : []).flatMap((u: unknown) =>
    u && typeof u === 'object' ? Object.values(u as J) : [u]);
  const agent = await matchAgent(tx, ws, [], {}, users);
  const patch: J = {};
  if (agent && call.agent_id !== agent.id && call.status !== 'completed') { patch.agent_id = agent.id; patch.agent_name = agent.full_name; }
  if (Number(o.call_state) === 1 && call.status === 'ringing') {
    patch.status = 'answered';
    if (call.direction === 'inbound') {
      patch.answered_at = new Date().toISOString();
      patch.raw = tx.json({ ...(call.raw || {}), answered_source: 'server' }); // no provider time in this webhook
    }
  }
  if (Object.keys(patch).length) [call] = await tx`update calls set ${tx(patch)} where id = ${call.id} returning *`;
  if (patch.status === 'answered' && call.direction === 'inbound') await onConnected(tx, call);
}

/** The patient is on the line: the callback dialled by this call is reached now, so "Callbacks pending" drops live.
 *  The agent closes it with an outcome later (callback_close). */
async function onConnected(tx: Tx, call: J) {
  if (call.direction === 'outbound') await tx`select callback_connected(${call.id}::uuid)`;
}

async function onCallEvent(tx: Tx, env: Env, ev: J): Promise<{ aiCallId?: string } | null> {
  const p: J = ev.payload || {};
  const legs: J[] = p.legs || ev.legs || [];
  const did = p.did_number || p.virtual_number || ev.system_identifier;
  const ws = await resolveWorkspace(tx, env, did);
  const customer = normMobile(ev.customer_identifier || p.customer_number || p.caller_number || p.client_number);
  const direction = /out/i.test(ev.direction || p.direction || '') ? 'outbound' : 'inbound';
  const session = String(ev.session_id || p.session_id || p.id || ev.event_id);
  const refId = p.client_ref_id || p.ref_id || ev.client_ref_id;

  let call = await findOrCreateCall(tx, { ws, session, refId, customer, direction, did: normMobile(did),
    startedAt: toIso(p.started_at || ev.timestamp), providerCallId: p.id ? String(p.id) : null, first: ev });

  const patch: J = {};
  const agent = await matchAgent(tx, ws, legs, p);
  if (agent && !call.agent_id) { patch.agent_id = agent.id; patch.agent_name = agent.full_name; }

  switch (ev.event_type) {
    case 'call.answered': {
      if (!['ringing','answered'].includes(call.status)) break; // delayed answer must not reopen a finished call
      const answeredLegs = call.direction === 'outbound' ? customerLegs(legs, call.customer_number) : legs;
      const leg = answeredLegs.find((l) => l.answered_at) || answeredLegs[0] || {};
      patch.status = 'answered';
      if (call.direction === 'inbound' || legsAnswered(customerLegs(legs, call.customer_number))) {
        const providerAnswer = toIso(leg.answered_at || ev.timestamp);
        patch.answered_at = providerAnswer || new Date().toISOString();
        patch.raw = { ...(call.raw || {}), answered_source: providerAnswer ? 'provider' : 'server' };
      }
      const explicit = int(leg.ring_duration ?? p.ring_duration);
      if (explicit != null && explicit > 0) {
        patch.ring_seconds = explicit;
      } else {
        const startedAt = call.started_at || toIso(p.started_at || ev.timestamp);
        const answeredAt = patch.answered_at || call.answered_at || (call.direction === 'inbound' ? toIso(leg.answered_at || ev.timestamp) : null);
        if (startedAt && answeredAt) {
          patch.ring_seconds = ringFallback(startedAt, answeredAt, 120);
        } else if (explicit != null) {
          patch.ring_seconds = explicit;
        }
      }
      break;
    }
    case 'call.end': {
      if (!['ringing','answered'].includes(call.status)) break; // a delayed duplicate must not undo a terminal event
      const customer = customerLegs(legs, call.customer_number);
      const answered = call.direction === 'outbound'
        ? (call.raw?.customer_connected === true || legsAnswered(customer))
        : call.status === 'answered' || legsAnswered(legs) || /^(answer|answered|completed|connected)$/i.test(p.status || '');
      const abandoned = /abandon|hangup_in_ivr|ivr/i.test(`${p.status} ${p.category}`);
      patch.status = answered ? 'completed' : call.direction === 'outbound' ? 'failed' : abandoned ? 'abandoned' : 'missed';
      patch.ended_at = toIso(p.ended_at || ev.timestamp) || new Date().toISOString();
      const talkLegs = call.direction === 'outbound' ? customer : legs;
      const talk = talkLegs.filter((l) => l.talk_duration != null).map((l) => Number(l.talk_duration));
      patch.talk_seconds = answered ? (talk.length ? (call.direction === 'outbound' ? Math.max(...talk) : talk.reduce((sum,n) => sum+n,0)) : int(p.talk_duration)) : 0;
      if (answered) {
        const legAnswer = (call.direction === 'outbound' ? customer : legs).find((l) => l.answered_at)?.answered_at;
        const prior = knownAnswer(call);
        const t = settleTiming({ startedAt: toIso(p.started_at) || call.started_at, endedAt: patch.ended_at, talkSeconds: patch.talk_seconds,
          answeredAt: toIso(p.answered_at || legAnswer) || prior.answeredAt, serverAnsweredAt: prior.serverAnsweredAt });
        Object.assign(patch, { ended_at: t.ended_at, talk_seconds: t.talk_seconds, answered_at: t.answered_at, duration_flag: t.duration_flag });
        if (t.started_at && t.started_at !== new Date(call.started_at).toISOString()) patch.started_at = t.started_at;
      }
      if (patch.ring_seconds == null && (call.ring_seconds == null || call.ring_seconds === 0)) {
        const ring = legs.map((l) => Number(l.ring_duration || 0)).filter(Boolean);
        const explicitRing = ring.length ? Math.min(...ring) : int(p.ring_duration);
        if (explicitRing != null && explicitRing > 0) {
          patch.ring_seconds = explicitRing;
        } else if (answered) {
          const startedAt = call.started_at || toIso(p.started_at || ev.timestamp);
          const answeredAt = patch.answered_at || call.answered_at;
          const fallback = ringFallback(startedAt, answeredAt, 120);
          if (fallback != null) patch.ring_seconds = fallback;
          else if (call.ring_seconds == null && explicitRing != null) patch.ring_seconds = explicitRing;
        } else if (patch.status === 'missed' || patch.status === 'abandoned' || (!answered && call.direction === 'outbound')) {
          const startedAt = call.started_at || toIso(p.started_at || ev.timestamp);
          const endedAt = patch.ended_at || call.ended_at || toIso(p.ended_at || ev.timestamp);
          const fallback = ringFallback(startedAt, endedAt, 120);
          if (fallback != null) patch.ring_seconds = fallback;
          else if (call.ring_seconds == null && explicitRing != null) patch.ring_seconds = explicitRing;
        }
      }
      if (p.recording_filename) patch.recording_filename = String(p.recording_filename);
      patch.provider_call_id = p.id ? String(p.id) : call.provider_call_id;
      patch.raw = { ...(call.raw || {}), ...(patch.raw || {}), end: ev };
      if (!answered && call.direction === 'outbound') patch.raw.callback_failure_reason =
        call.status === 'answered' || legsAnswered(legs)
          ? 'Customer did not connect after the agent answered'
          : 'Agent unavailable or call not connected; customer reachability not verified';
      break;
    }
    case 'call.summary': {
      const leg = legs.find((l) => l.agent) || {};
      if (leg.agent?.name) patch.agent_name = leg.agent.name;
      const dept = leg.department?.name || p.department?.name;
      if (dept) patch.department = dept;
      const comments = (p.comments || []).map((c: J | string) => (typeof c === 'string' ? c : c.comment || c.text)).filter(Boolean);
      if (comments.length) patch.notes = comments.join('\n');
      break;
    }
    case 'call.disposition': {
      const d = (p.dispositions || []).map((x: J | string) => (typeof x === 'string' ? x : x.name || x.title)).filter(Boolean);
      if (d.length) patch.disposition = d.join(', ');
      break;
    }
  }
  if (Object.keys(patch).length) {
    if (patch.raw) patch.raw = tx.json(patch.raw);
    [call] = await tx`update calls set ${tx(patch)} where id = ${call.id} returning *`;
  }
  if (ev.event_type === 'call.answered' && call.status === 'answered' &&
      (call.direction === 'inbound' || legsAnswered(customerLegs(legs, call.customer_number)))) {
    [call] = await tx`update calls set raw = coalesce(raw, '{}'::jsonb) || '{"customer_connected":true}'::jsonb where id = ${call.id} returning *`;
    await onConnected(tx, call);
  }
  if (ev.event_type === 'call.end') return afterCallEnded(tx, call);
  return null;
}

async function afterCallEnded(tx: Tx, call: J): Promise<{ aiCallId?: string }> {
  // missed / abandoned inbound -> callback queue with the SLA timer (trigger starts it), exactly once per call.
  // queue_missed_callback also records why when it cannot (no caller number) or merges into a live callback.
  if (['missed', 'abandoned'].includes(call.status) && call.direction === 'inbound') {
    const [origin] = await tx`select id from callbacks where workspace_id = ${call.workspace_id} and call_id = ${call.id} limit 1`;
    if (origin) return {}; // a repeated end event: already queued and on the timeline
    await tx`select queue_missed_callback(${call.id}::uuid)`;
  }
  // the callback's own call ended: reached stays reached (or becomes so if the answered event never came); a call that
  // did not complete or a drop-off under 20 s goes back to the queue for the next attempt, or unreachable
  if (call.direction === 'outbound' && call.callback_id) await tx`select callback_call_ended(${call.id}::uuid)`;
  if (call.patient_id || call.case_id) {
    const summary = `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call ${call.status}` +
      (call.ring_seconds != null && call.status === 'completed' ? ` · answered in ${call.ring_seconds} s` : '');
    await tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, call_id, summary, evidence, occurred_at)
      values (${call.workspace_id}, ${call.case_id}, ${call.patient_id}, 'phone', ${call.direction}, ${call.agent_id}, ${call.agent_name || 'Telephony'},
        ${call.id}, ${summary}, ${call.recording_filename ? `Recording ${mins(call.talk_seconds)}` : null}, ${call.started_at})`;
  }
  return call.recording_filename ? { aiCallId: call.id } : {};
}

async function onMessageEvent(tx: Tx, env: Env, ev: J) {
  const p: J = ev.payload || {};
  const ws = await resolveWorkspace(tx, env, ev.system_identifier);
  const number = normMobile(ev.customer_identifier || p.customer_number || p.conversation?.customer_number || p.from || p.to);
  const msgId = String(p.id || p.message_id || p.waba_message_id || '').trim() || null;
  const evType = String(ev.event_type || '');

  // Delivery / read receipts update the outbound message metadata
  if (/^message\.(delivered|read|failed|status)$/i.test(evType)) {
    const status = evType === 'message.status' ? String(p.status || 'delivered').toLowerCase() : evType.split('.')[1].toLowerCase();
    if (msgId) {
      await tx`update interactions set meta = coalesce(meta, '{}'::jsonb) || ${tx.json({ delivery_status: status, status_at: new Date().toISOString() })}
        where workspace_id = ${ws}::uuid and channel = 'whatsapp' and meta->>'message_id' = ${msgId}`;
    } else if (number) {
      await tx`update interactions set meta = coalesce(meta, '{}'::jsonb) || ${tx.json({ delivery_status: status, status_at: new Date().toISOString() })}
        where id = (
          select i.id from interactions i join patients pt on pt.id = i.patient_id
          where i.workspace_id = ${ws}::uuid and i.channel = 'whatsapp' and i.direction = 'outbound' and pt.mobile = ${number}
          order by i.occurred_at desc limit 1
        )`;
    }
    return;
  }

  if (!number) return;
  const inbound = evType === 'message.received';
  if (!inbound && evType !== 'message.sent') return;

  const mediaType = String(p.data?.type || p.type || 'text').toLowerCase();
  const rawText = String(
    p.data?.context?.body ||
    p.data?.context?.caption ||
    p.data?.context?.button_reply?.title ||
    p.data?.context?.list_reply?.title ||
    p.interactive?.button_reply?.title ||
    p.interactive?.list_reply?.title ||
    p.data?.body ||
    p.text ||
    p.body ||
    p.caption ||
    ''
  ).trim();
  const text = rawText || (mediaType !== 'text' ? `[${mediaType.toUpperCase()} attachment]` : '');
  const mediaUrl = p.data?.context?.link || p.data?.context?.url || p.media_url || null;

  let [patient] = await tx`select id::text, full_name from patients where workspace_id = ${ws}::uuid and mobile = ${number} limit 1`;
  let [kase] = patient ? await tx`select id::text from cases where patient_id = ${patient.id}::uuid and stage not in ('closed','cancelled') order by created_at desc limit 1` : [];
  if (inbound && !kase) {
    // new WhatsApp enquiry -> case opened, 5-minute acknowledgement timer starts (trigger)
    const name = p.conversation?.customer_name || p.profile?.name || p.customer_name || patient?.full_name || 'WhatsApp contact';
    const [r] = await tx`select create_enquiry(${tx.json({
      workspace_id: ws, source_channel: 'whatsapp', services_requested: (text || 'WhatsApp enquiry').slice(0, 500),
      patient: { full_name: name, mobile: number }, caller_mobile: number,
    })}) as r`;
    kase = { id: r.r.case_id } as never; patient = { id: r.r.patient_id, full_name: name } as never;
  } else if (!patient) {
    const name = p.conversation?.customer_name || p.profile?.name || p.customer_name || 'WhatsApp contact';
    const [r] = await tx`select upsert_patient(${tx.json({ workspace_id: ws, full_name: name, mobile: number })}) as id`;
    patient = { id: r.id, full_name: name } as never;
  }

  // Avoid duplicate outbound timeline rows when MyOperator echoes a message just sent from CareDesk CRM
  if (!inbound && patient?.id) {
    const [existing] = await tx`
      select id::text from interactions
      where workspace_id = ${ws}::uuid and patient_id = ${patient.id}::uuid and channel = 'whatsapp' and direction = 'outbound'
        and occurred_at > now() - interval '2 minutes'
        and (coalesce(body, '') = ${text} or (${msgId}::text is not null and meta->>'message_id' = ${msgId}))
      order by occurred_at desc limit 1`;
    if (existing) {
      await tx`update interactions set meta = coalesce(meta, '{}'::jsonb) || ${tx.json({ message_id: msgId, delivery_status: 'sent' })}
        where id = ${existing.id}::uuid`;
      return;
    }
  }

  await tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_label, summary, body, evidence, meta)
    values (${ws}::uuid, ${kase?.id ?? null}, ${patient?.id ?? null}, 'whatsapp', ${inbound ? 'inbound' : 'outbound'}, ${inbound ? 'Patient' : 'WhatsApp'},
      ${inbound ? 'WhatsApp message received' : 'WhatsApp message sent'}, ${text}, 'Message copy',
      ${tx.json({ message_id: msgId, media_type: mediaType, media_url: mediaUrl, delivery_status: inbound ? 'received' : 'sent' })})`;
}

// ---------- click-to-call ----------
export async function clickToCall(env: Env, a: { myoperatorUserId: string | null; number: string; referenceId: string }) {
  if (missingCallingSettings(env).length) throw new ApiError(503, 'MyOperator calling is not configured in Settings > Telephony');
  if (!a.myoperatorUserId) throw new ApiError(409, 'Your MyOperator agent is not linked in Settings > Telephony');
  // Never retry a dial POST automatically: a lost response can still mean the phone is ringing.
  const uncertain = () => new ApiError(504, 'MyOperator has not confirmed this call. Check your phone and the Calls list before trying again.');
  let res: Response, json: J;
  try {
    res = await fetch(env.MYOPERATOR_OBD_URL || OBD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.MYOPERATOR_OBD_API_KEY!, 'secret-key': env.MYOPERATOR_SECRET_TOKEN! },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        company_id: env.MYOPERATOR_COMPANY_ID,
        secret_token: env.MYOPERATOR_SECRET_TOKEN,
        type: '1', // peer-to-peer user dial; configure this campaign's Dial First setting to Agent
        user_id: a.myoperatorUserId,
        number: a.number,
        public_ivr_id: env.MYOPERATOR_PUBLIC_IVR_ID,
        reference_id: a.referenceId,
        region: env.MYOPERATOR_REGION || undefined,
        caller_id: env.MYOPERATOR_CALLER_ID || undefined,
      }),
    });
    // Raw provider errors may contain customer data or secrets; never pass them to the browser.
    json = await res.json().catch(() => ({})) as J;
  } catch { throw uncertain(); }
  if (res.status >= 500 || res.status === 408) throw uncertain();
  if (!res.ok || /error|fail|reject/i.test(String(json?.status || '')) || Number(json?.code) >= 400) {
    throw new ApiError(502, 'MyOperator rejected the call. Ask your administrator to check Calling API access, the peer-to-peer Public IVR ID, agent availability and calling credits in Settings > Telephony.');
  }
  if (!json || !/^(success|accepted)$/i.test(String(json.status || ''))) throw uncertain();
  return json;
}

// ---------- recordings ----------
export async function recordingUrl(env: Env, filename: string): Promise<string> {
  if (!env.MYOPERATOR_API_TOKEN) throw new Error('MyOperator API token not configured');
  const u = new URL(env.MYOPERATOR_RECORDING_URL || 'https://developers.myoperator.co/recordings/link');
  u.searchParams.set('token', env.MYOPERATOR_API_TOKEN);
  u.searchParams.set('file', filename);
  const res = await fetch(u.toString());
  const t = await res.text();
  let j: J | null = null;
  try { j = JSON.parse(t); } catch { j = null; }
  const link = j?.url || j?.data?.url || j?.link || (t.startsWith('http') ? t.trim() : null);
  if (!link) throw new Error('Recording link not available: ' + t.slice(0, 160));
  return link;
}

// ---------- WhatsApp Business API only (QR linking disabled) ----------
export async function whatsappSession(c: Ctx) {
  const config = wabaConfiguration(await moEnv(c.env, c.sql));
  return {
    status: config.status, connected: false, mode: 'waba', qr_enabled: false,
    waba_ready: !config.missing.length, waba_configured: !config.missing.length,
    qr_svg: null, pairing_code: null, queued_count: 0,
    message: config.message,
  };
}

export async function whatsappSessionAction(_c: Ctx, _body: J) {
  throw new ApiError(403, 'QR scanning is disabled for enterprise compliance. Configure MyOperator WABA in Settings > Telephony.');
}

/** Read-only MyOperator phone-number lookup. No message is sent and provider payloads stay server-side.
 * Contract: https://documenter.getpostman.com/view/38426694/2sAXqy3evq (List Phone Numbers).
 */
export async function testWaba(c: Ctx) {
  const env = await moEnv(c.env, c.sql);
  const config = wabaConfiguration(env);
  const checked_at = new Date().toISOString();
  const result = (ok: boolean, message: string) => ({ ...config, ok, status: ok ? 'connected' : config.status, message, checked_at });
  if (config.missing.length) return result(false, config.message);
  const url = new URL('phonenumbers', env.MYOPERATOR_WABA_URL || 'https://publicapi.myoperator.co/chat/messages');
  url.search = '';
  url.searchParams.set('limit', '100');
  const signal = AbortSignal.timeout(10_000);
  try {
    // Bound the admin check to five pages; never follow a provider-supplied URL with credentials.
    for (let page = 0; page < 5; page++) {
      url.searchParams.set('offset', String(page * 100));
      const res = await fetch(url, {
        method: 'GET', redirect: 'manual', signal,
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + env.MYOPERATOR_WABA_API_KEY, 'X-MYOP-COMPANY-ID': env.MYOPERATOR_COMPANY_ID! },
      });
      if (res.status === 401 || res.status === 403) return result(false, 'MyOperator refused WABA access. Check the WhatsApp API key, Company ID and account permissions.');
      if (!res.ok) return result(false, 'MyOperator WABA check failed (HTTP ' + res.status + '). Try again later or contact MyOperator support.');
      const body = await res.json() as J;
      if (body.status !== 'success' || Number(body.code) !== 200 || !Array.isArray(body.data?.results)) {
        return result(false, 'MyOperator did not confirm WABA access. Check credentials and permissions, or contact MyOperator support.');
      }
      const phone = body.data.results.find((row: J) => String(row.phone_number_id) === env.MYOPERATOR_WABA_PHONE_ID);
      if (phone) {
        const connected = phone.status === 'active' && phone.phone_number_status === 'connected' && phone.onboarding_status === 'success';
        return result(connected, connected
          ? 'MyOperator verified the credentials and reports this WhatsApp phone ID active, connected and onboarded. No message was sent; delivery and webhooks are not tested.'
          : 'Credentials accepted, but MyOperator has not confirmed this phone ID active, connected and fully onboarded. Complete activation in MyOperator.');
      }
      if (!body.data.next) return result(false, 'Credentials accepted, but the saved WhatsApp phone number ID was not found on this account. Check the phone ID and Company ID.');
    }
    return result(false, 'Credentials accepted, but the phone ID was not found in the first 500 numbers. Ask MyOperator support to verify this phone ID.');
  } catch {
    return result(false, 'Could not complete the MyOperator WABA check. The provider timed out or returned an unexpected response. Try again.');
  }
}

export async function sendWhatsApp(env: Env, a: { to: string; text: string; templateName?: string | null; language?: string; params?: string[] }, sql?: Sql) {
  if (sql) env = await moEnv(env, sql);
  const config = wabaConfiguration(env);
  if (config.missing.length) return { skipped: config.message };
  const digits = a.to.replace(/\D/g, '');
  const data = a.templateName
    ? { type: 'template', context: { template_name: a.templateName, language: a.language || 'en', body: Object.fromEntries((a.params || []).map((v, i) => [String(i + 1), v])) } }
    : { type: 'text', context: { body: a.text } };
  const res = await fetch(env.MYOPERATOR_WABA_URL || 'https://publicapi.myoperator.co/chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MYOPERATOR_WABA_API_KEY}`, 'X-MYOP-COMPANY-ID': env.MYOPERATOR_COMPANY_ID || '' },
    body: JSON.stringify({ phone_number_id: env.MYOPERATOR_WABA_PHONE_ID, customer_country_code: digits.slice(0, 2), customer_number: digits.slice(2), data }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error('WhatsApp send failed: ' + t.slice(0, 200));
  return JSON.parse(t || '{}');
}
