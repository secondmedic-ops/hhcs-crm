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
import { missingCallingSettings, moEnv } from './myoperator-config';
import { ApiError } from '../domain/errors';

const OBD_URL = 'https://obd-api.myoperator.co/obd-api-v1';
type J = Record<string, any>;

const toIso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  let d: Date;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
};
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

const legsAnswered = (legs: J[]) => legs.some((l) => /answer|connect|complete/i.test(l.dial_status || l.status || '') || Number(l.talk_duration || 0) > 0);

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

export async function handleMyOperatorWebhook(req: Request, env0: Env, exec: ExecutionContext): Promise<Response> {
  const sql = connect(env0);
  const changedAll = new Set<string>();
  let responseBody: J = { ok: true };
  try {
    const env = await moEnv(env0, sql);
    const expected = env.MYOPERATOR_WEBHOOK_KEY;
    const got = req.headers.get('x-webhook-key') || new URL(req.url).searchParams.get('key') || basicPassword(req);
    const isBridgeReq = req.headers.get('x-whatsapp-bridge') === '1' || new URL(req.url).searchParams.get('bridge') === 'whatsapp_qr';
    let authorized = !!expected && got === expected;
    if (!authorized && isBridgeReq && got && got.length >= 24) {
      const qr = await loadWhatsAppQr(sql);
      if (qr.bridge_key && got === qr.bridge_key) authorized = true;
    }
    if (!expected && !authorized) return new Response('webhook key not configured', { status: 503 });
    if (!authorized) return new Response('unauthorized', { status: 401 });
    const events = await readEvents(req);
    if (!events) return new Response('bad body', { status: 400 });
    if (events.length === 1 && events[0]?.raw?.bridge === 'whatsapp_qr') {
      responseBody = await handleWhatsAppBridge(sql, env, events[0].raw, changedAll);
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
  let [call] = await tx`select * from calls where provider = 'myoperator' and session_id = ${a.session} limit 1`;
  if (!call && a.refId) {
    [call] = await tx`update calls set session_id = ${a.session} where click_to_call_ref = ${String(a.refId)} returning *`;
  }
  if (!call && a.adoptRecent && a.customer) {
    // the in-call webhook may have opened this call under another id: take over a live call from the same number
    [call] = await tx`update calls set session_id = ${a.session} where id = (select id from calls where provider = 'myoperator'
      and workspace_id = ${a.ws}::uuid and customer_number = ${a.customer} and status in ('ringing','answered')
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
  const answeredLeg = legs.find((l) => /answer|connect/i.test(String(l._ds || l._ac || '')));
  const pick = answeredLeg ? (Array.isArray(answeredLeg._rr) ? answeredLeg._rr : [answeredLeg._rr]).filter(Boolean) : agents;
  const agent = await matchAgent(tx, ws, pick.map((a: J) => ({ user_id: a._id, agent: { email: a._em, id: a._id } })), {}, pick.map((a: J) => a._nr || a._ct));

  const connected = Number(o._su) === 1;
  const patch: J = {
    status: connected ? 'completed' : direction === 'outbound' ? 'failed' : 'missed',
    ended_at: toIso(o._et) || new Date().toISOString(),
    talk_seconds: connected ? afterCallTalkSeconds(o) : 0,
    raw: tx.json({ ...(call.raw || {}), end: o }),
  };
  if (connected && !call.answered_at) patch.answered_at = call.started_at;
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
  if (Number(o.call_state) === 1 && call.status === 'ringing') { patch.status = 'answered'; patch.answered_at = new Date().toISOString(); }
  if (Object.keys(patch).length) [call] = await tx`update calls set ${tx(patch)} where id = ${call.id} returning *`;
  if (patch.status === 'answered') await onConnected(tx, call);
}

/** The patient is on the line: an outbound callback is done now, so "Callbacks pending" drops live, not at call end. */
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
      const leg = legs.find((l) => l.answered_at) || legs[0] || {};
      patch.status = 'answered';
      patch.answered_at = toIso(leg.answered_at || ev.timestamp) || new Date().toISOString();
      patch.ring_seconds = int(leg.ring_duration);
      break;
    }
    case 'call.end': {
      const answered = call.status === 'answered' || legsAnswered(legs) || /answer|complete|connect/i.test(p.status || '');
      const abandoned = /abandon|hangup_in_ivr|ivr/i.test(`${p.status} ${p.category}`);
      patch.status = answered ? 'completed' : direction === 'outbound' ? 'failed' : abandoned ? 'abandoned' : 'missed';
      patch.ended_at = toIso(p.ended_at || ev.timestamp) || new Date().toISOString();
      const talk = legs.reduce((s, l) => s + Number(l.talk_duration || 0), 0);
      patch.talk_seconds = int(talk || (answered ? p.duration : 0));
      if (patch.ring_seconds == null && call.ring_seconds == null) {
        const ring = legs.map((l) => Number(l.ring_duration || 0)).filter(Boolean);
        if (ring.length) patch.ring_seconds = Math.min(...ring);
      }
      if (p.recording_filename) patch.recording_filename = String(p.recording_filename);
      patch.provider_call_id = p.id ? String(p.id) : call.provider_call_id;
      patch.raw = { ...(call.raw || {}), end: ev };
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
  if (ev.event_type === 'call.answered') await onConnected(tx, call);
  if (ev.event_type === 'call.end') return afterCallEnded(tx, call);
  return null;
}

async function afterCallEnded(tx: Tx, call: J): Promise<{ aiCallId?: string }> {
  // missed / abandoned inbound -> callback queue with the SLA timer (trigger starts it)
  if (['missed', 'abandoned'].includes(call.status) && call.direction === 'inbound' && call.customer_number) {
    const [pol] = await tx`select target_minutes from sla_policies where workspace_id = ${call.workspace_id} and key = 'missed_callback'`;
    const [pending] = await tx`select id from callbacks where workspace_id = ${call.workspace_id} and number = ${call.customer_number}
      and status in ('pending','in_progress') limit 1`;
    if (!pending) {
      const due = new Date(Date.now() + (pol?.target_minutes || 10) * 60000).toISOString();
      await tx`insert into callbacks (workspace_id, call_id, number, patient_id, reason, due_at)
        values (${call.workspace_id}, ${call.id}, ${call.customer_number}, ${call.patient_id}, ${call.status === 'abandoned' ? 'abandoned' : 'missed'}, ${due})`;
    }
  }
  // a successful outbound call to a pending callback number completes it (if the answered event did not already)
  if (call.direction === 'outbound' && call.status === 'completed' && call.customer_number) await onConnected(tx, call);
  // a callback attempt that did not reach the patient: back to the queue for the next attempt, or unreachable
  if (call.direction === 'outbound' && call.status !== 'completed' && call.callback_id) {
    await tx`select callback_retry(${call.callback_id}::uuid, ${'call ' + call.status})`;
  }
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

// ---------- WhatsApp (WABA + QR Web multi-device session) ----------
export async function loadWhatsAppQr(sql: Sql): Promise<J> {
  try {
    const [row] = await sql`select settings from integration_settings where provider = 'whatsapp_qr'`;
    return (row?.settings as J) || {};
  } catch {
    return {};
  }
}

export async function whatsappSession(c: Ctx) {
  const [env, qr, [queued]] = await Promise.all([
    moEnv(c.env, c.sql),
    loadWhatsAppQr(c.sql),
    c.sql`select count(*)::int as n from interactions where workspace_id = ${c.user.workspaceId}::uuid and channel = 'whatsapp' and direction = 'outbound' and meta->>'delivery_status' = 'queued'`,
  ]);
  const wabaReady = !!(env.MYOPERATOR_WABA_API_KEY && env.MYOPERATOR_WABA_PHONE_ID);
  const bridgeOnline = !!(qr.heartbeat_at && Date.now() - new Date(String(qr.heartbeat_at)).getTime() < 90_000);
  const isQrStatus = qr.status === 'qr' || qr.status === 'qr_ready';
  const status = qr.status === 'connected'
    ? 'connected'
    : isQrStatus && qr.qr_svg && bridgeOnline
      ? 'qr_ready'
      : (qr.status === 'starting' || qr.command === 'start')
        ? 'starting'
        : 'disconnected';
  return {
    status,
    connected: status === 'connected' || wabaReady,
    mode: status === 'connected' ? 'qr' : wabaReady ? 'waba' : 'qr',
    bridge_online: bridgeOnline,
    waba_ready: wabaReady,
    waba_configured: wabaReady,
    qr_svg: status === 'qr_ready' ? (qr.qr_svg || null) : null,
    qr_at: qr.qr_at || null,
    qr_updated_at: qr.qr_at || null,
    pairing_code: status === 'qr_ready' || status === 'starting' ? (qr.pairing_code || null) : null,
    phone: qr.phone || null,
    name: qr.name || null,
    connected_at: qr.connected_at || null,
    heartbeat_at: qr.heartbeat_at || null,
    last_seen_at: qr.heartbeat_at || null,
    last_error: qr.last_error || null,
    error: qr.last_error || null,
    queued_count: Number(queued?.n || 0),
  };
}

export async function whatsappSessionAction(c: Ctx, body: J) {
  const act = String(body?.action || 'start').trim();
  if (!['start', 'refresh_qr', 'logout', 'disconnect', 'sync'].includes(act)) {
    throw new ApiError(400, 'Choose a valid WhatsApp session action (start, sync or logout)');
  }
  const now = new Date().toISOString();
  const rawPhone = body?.phone_number || body?.pairing_phone || null;
  const pairingPhone = rawPhone ? (normMobile(rawPhone)?.replace(/\D/g, '') || null) : null;
  const { changed } = await asSystem(c.sql, async (tx) => {
    const [row] = await tx`select settings from integration_settings where provider = 'whatsapp_qr' for update`;
    const prev: J = (row?.settings as J) || {};
    const next: J = { ...prev };
    if (act === 'start' || act === 'refresh_qr') {
      next.command = 'start';
      next.command_at = now;
      next.pairing_phone = pairingPhone;
      next.last_error = null;
      if (act === 'refresh_qr' || (next.status !== 'qr' && next.status !== 'qr_ready')) {
        next.status = 'starting';
        if (act === 'refresh_qr') { next.qr_svg = null; next.pairing_code = null; }
      }
    } else if (act === 'logout' || act === 'disconnect') {
      next.command = 'logout';
      next.command_at = now;
      next.status = 'disconnected';
      next.qr_svg = null;
      next.qr_at = null;
      next.pairing_code = null;
      next.phone = null;
      next.name = null;
      next.connected_at = null;
    } else if (act === 'sync') {
      next.command = 'sync';
      next.command_at = now;
    }
    await tx`insert into integration_settings (provider, settings, updated_at, updated_by)
      values ('whatsapp_qr', ${tx.json(next)}, now(), ${c.user.id}::uuid)
      on conflict (provider) do update set settings = excluded.settings, updated_at = now(), updated_by = excluded.updated_by`;
    return null;
  });
  c.changed.push(...changed);
  return whatsappSession(c);
}

async function handleWhatsAppBridge(sql: Sql, env: Env, body: J, changedAll: Set<string>): Promise<J> {
  const act = String(body.action || 'poll');
  const now = new Date().toISOString();

  if (act === 'poll') {
    const prev = await loadWhatsAppQr(sql);
    const command = prev.command || null;
    const pairingPhone = prev.pairing_phone || null;
    const next: J = {
      ...prev,
      heartbeat_at: now,
      command: null,
      pairing_phone: null,
    };
    if (body.status) {
      const normStatus = body.status === 'qr' ? 'qr_ready' : String(body.status);
      next.status = normStatus;
      next.qr_svg = normStatus === 'qr_ready' ? (body.qr_svg ?? prev.qr_svg ?? null) : null;
      next.qr_at = normStatus === 'qr_ready' ? (body.qr_at ?? prev.qr_at ?? now) : null;
      next.pairing_code = normStatus === 'qr_ready' || normStatus === 'starting' ? (body.pairing_code ?? prev.pairing_code ?? null) : null;
      if (normStatus === 'connected') {
        next.phone = normMobile(body.phone) || body.phone || prev.phone || null;
        next.name = body.name ?? prev.name ?? null;
        next.connected_at = body.connected_at ?? prev.connected_at ?? now;
        next.last_error = null;
      } else if (normStatus === 'disconnected') {
        next.phone = null;
        next.name = null;
        next.connected_at = null;
      }
    }
    if (body.last_error !== undefined) next.last_error = body.last_error;
    if (body.error !== undefined) next.last_error = body.error;

    const stateChanged =
      prev.status !== next.status ||
      prev.qr_svg !== next.qr_svg ||
      prev.pairing_code !== next.pairing_code ||
      prev.phone !== next.phone ||
      prev.last_error !== next.last_error ||
      !!command;

    if (stateChanged) {
      const { changed } = await asSystem(sql, async (tx) => {
        await tx`insert into integration_settings (provider, settings, updated_at)
          values ('whatsapp_qr', ${tx.json(next)}, now())
          on conflict (provider) do update set settings = excluded.settings, updated_at = now()`;
        return null;
      });
      changed.forEach((x) => changedAll.add(x));
    } else {
      await sql`insert into integration_settings (provider, settings, updated_at)
        values ('whatsapp_qr', ${sql.json(next)}, now())
        on conflict (provider) do update set settings = excluded.settings, updated_at = now()`;
    }

    const outbox = next.status === 'connected'
      ? await sql`
          select i.id::text, i.body, coalesce(p.mobile, c.caller_mobile) as mobile, coalesce(p.mobile, c.caller_mobile) as to_mobile, p.full_name as patient_name
          from interactions i
          left join patients p on p.id = i.patient_id
          left join cases c on c.id = i.case_id
          where i.channel = 'whatsapp' and i.direction = 'outbound'
            and i.meta->>'delivery_status' = 'queued'
            and i.occurred_at > now() - interval '24 hours'
          order by i.occurred_at asc limit 20`
      : [];
    return {
      ok: true,
      status: next.status || 'disconnected',
      command,
      pairing_phone: pairingPhone,
      command_meta: pairingPhone ? { phone_number: pairingPhone } : null,
      outbox,
    };
  }

  if (act === 'ack') {
    const items: J[] = Array.isArray(body.items) ? body.items : body.id ? [body] : [];
    if (items.length) {
      const { changed } = await asSystem(sql, async (tx) => {
        for (const it of items) {
          if (!it?.id) continue;
          const status = String(it.status || 'sent');
          await tx`update interactions
            set meta = coalesce(meta, '{}'::jsonb) || ${tx.json({
              delivery_status: status,
              message_id: it.message_id || null,
              delivery_error: it.error || null,
              status_at: now,
            })}
            where id = ${String(it.id)}::uuid and channel = 'whatsapp'`;
        }
        return null;
      });
      changed.forEach((x) => changedAll.add(x));
    }
    return { ok: true };
  }

  if (act === 'sync_messages') {
    const msgs: J[] = Array.isArray(body.messages) ? body.messages : [];
    let synced = 0;
    if (msgs.length) {
      const { changed } = await asSystem(sql, async (tx) => {
        const ws = await resolveWorkspace(tx, env, null);
        for (const m of msgs) {
          const msgId = String(m?.id || '').trim();
          const number = normMobile(m?.mobile || m?.phone);
          if (!msgId || !number) continue;
          const fresh = await tx`insert into webhook_events (event_id, source, event_type, payload, processed)
            values (${'waqr:' + msgId}, 'whatsapp_qr', ${m.direction === 'outbound' ? 'message.sent' : 'message.received'}, ${tx.json(m)}, true)
            on conflict do nothing returning event_id`;
          if (!fresh.length) continue;

          const inbound = m.direction !== 'outbound';
          const mediaType = String(m.media_type || 'text').toLowerCase();
          const text = String(m.text || '').trim() || (mediaType !== 'text' ? `[${mediaType.toUpperCase()} attachment]` : '');
          if (!text) continue;

          let [patient] = await tx`select id::text, full_name from patients where workspace_id = ${ws}::uuid and mobile = ${number} limit 1`;
          let [kase] = patient ? await tx`select id::text from cases where patient_id = ${patient.id}::uuid and stage not in ('closed','cancelled') order by created_at desc limit 1` : [];
          const name = String(m.name || '').trim() || patient?.full_name || 'WhatsApp contact';
          const isHistory = !!(m.historical || m.is_history);
          if (isHistory) continue; // Never create patients or cases from historical chat syncs

          if (inbound && !kase) {
            const [r] = await tx`select create_enquiry(${tx.json({
              workspace_id: ws, source_channel: 'whatsapp', services_requested: text.slice(0, 500),
              patient: { full_name: name, mobile: number }, caller_mobile: number,
            })}) as r`;
            kase = { id: r.r.case_id } as never;
            patient = { id: r.r.patient_id, full_name: name } as never;
          } else if (!patient && number.startsWith('+91')) {
            const [r] = await tx`select upsert_patient(${tx.json({ workspace_id: ws, full_name: name, mobile: number })}) as id`;
            patient = { id: r.id, full_name: name } as never;
          } else if (m.name && patient?.full_name === 'WhatsApp contact' && name !== 'WhatsApp contact') {
            await tx`update patients set full_name = ${name} where id = ${patient.id}::uuid`;
          }

          if (!inbound && patient?.id) {
            const [existing] = await tx`
              select id::text from interactions
              where workspace_id = ${ws}::uuid and patient_id = ${patient.id}::uuid and channel = 'whatsapp' and direction = 'outbound'
                and (
                  (${msgId}::text is not null and meta->>'message_id' = ${msgId})
                  or (occurred_at > now() - interval '5 minutes' and coalesce(body, '') = ${text})
                )
              order by occurred_at desc limit 1`;
            if (existing) {
              await tx`update interactions set meta = coalesce(meta, '{}'::jsonb) || ${tx.json({ message_id: msgId, delivery_status: 'sent', via: 'qr' })}
                where id = ${existing.id}::uuid`;
              continue;
            }
          }

          await tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_label, summary, body, evidence, occurred_at, meta)
            values (${ws}::uuid, ${kase?.id ?? null}, ${patient?.id ?? null}, 'whatsapp', ${inbound ? 'inbound' : 'outbound'},
              ${inbound ? 'Patient' : 'WhatsApp'},
              ${inbound ? 'WhatsApp message received' : 'WhatsApp message sent'},
              ${text}, 'Message copy', ${toIso(m.timestamp) || now},
              ${tx.json({ message_id: msgId, media_type: mediaType, delivery_status: inbound ? 'received' : 'sent', via: 'qr' })})`;
          synced++;
        }
        return null;
      });
      changed.forEach((x) => changedAll.add(x));
    }
    return { ok: true, synced, imported: synced };
  }

  return { ok: false, error: 'unknown bridge action' };
}

export async function sendWhatsApp(env: Env, a: { to: string; text: string; templateName?: string | null; language?: string; params?: string[] }, sql?: Sql) {
  if (!env.MYOPERATOR_WABA_API_KEY || !env.MYOPERATOR_WABA_PHONE_ID) {
    if (sql) {
      const qr = await loadWhatsAppQr(sql);
      if (qr.status === 'connected') return { queued: true, via: 'qr' };
    }
    return { skipped: 'WhatsApp API not configured' };
  }
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
