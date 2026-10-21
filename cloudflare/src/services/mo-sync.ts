// MyOperator call-log sync: every minute (cron) CareDesk reads the calls MyOperator logged since the last run (Call Logs
// "search" API, API token) and applies each one exactly like the after-call webhook: call record, patient / case match,
// agent, recording, missed call -> callback queue. Works while MyOperator's webhooks are locked; once webhooks are on,
// both routes run side by side and each call is still applied once (same event id per call log).
// State (last run, window, counts, last error) is kept in integration_settings under provider 'myoperator_sync'.
import type { Sql } from '../db';
import type { Env } from '../env';
import { moEnv } from './myoperator-config';
import { afterCallEvent, processEvents } from './myoperator';
import { notifyLive } from './live';

type J = Record<string, any>;
const OVERLAP_S = 180;          // re-read the last 3 minutes: logs can appear a little after the call ends
const FIRST_WINDOW_S = 6 * 3600; // first run looks back 6 hours
const PAGE = 100, MAX_PAGES = 5;

const LOG_KEYS = ['_ai', '_cr', '_cl'];

/** The list of items in a search response, whatever the wrapping (hits / _source / data / logs). The search-engine
 *  document id (hit._id) is kept as _doc_id: newer call logs carry no _ai. */
function itemsFrom(j: J): J[] {
  const pools = [j?.data?.hits?.hits, j?.data?.hits, j?.hits?.hits, j?.hits, j?.data?.data, j?.data?.logs, j?.data?.list, j?.data, j?.logs, j?.result, Array.isArray(j) ? j : null];
  const list = (pools.find((x) => Array.isArray(x)) || []) as J[];
  return list.map((x) => (x && typeof x === 'object' && x._source && typeof x._source === 'object' ? { _doc_id: x._id, ...x._source } : x))
    .filter((o) => o && typeof o === 'object');
}

const first = (o: J, keys: string[]) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== '') return v; } return null; };
const pickStr = (o: J, keys: string[]) => { const v = first(o, keys); return v == null || typeof v === 'object' ? null : String(v); };

/** A time from the newer log: epoch seconds / ms, ISO, or "2026-10-09 17:41:05" (MyOperator shows India time). */
export function logTime(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); return Math.round(n > 1e12 ? n / 1000 : n); }
  let t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) t = t.replace(' ', 'T') + '+05:30';
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : Math.round(d.getTime() / 1000);
}

/** Seconds from 95, "95", "00:01:35" or "1:35". */
function secs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const p = String(v).trim().split(':').map(Number);
  if (!p.length || p.some((x) => isNaN(x))) return null;
  return p.reduce((a, x) => a * 60 + x, 0);
}

/** The newer call-log layout (caller_number, start_time, duration, ...) turned into the older short one (_ai, _cl, _st,
 *  ...) that the after-call handling reads. Fields are looked up under every name MyOperator has used; anything not
 *  found is left out and the call is still recorded with what is known. */
export function normalizeLog(o: J): J | null {
  if (LOG_KEYS.some((k) => o[k] != null)) return o; // already the short layout
  const customer = pickStr(o, ['caller_number', 'customer_number', 'client_number', 'caller_number_raw', 'phone', 'number', 'caller']);
  const st = logTime(first(o, ['start_time', 'started_at', 'call_start_time', 'created_at', 'synced_time', '_ms']));
  if (!customer && !st) return null;
  const et = logTime(first(o, ['end_time', 'ended_at', 'call_end_time']));
  const id = pickStr(o, ['call_id', 'uid', 'unique_id', 'uuid', 'id', 'log_id', '_id', '_doc_id']) || `${customer || 'x'}-${st || 0}`;
  const kind = String(first(o, ['call_type', 'direction', 'type', 'event', 'log_type', 'call_direction']) ?? '').toLowerCase();
  const outbound = /out|obd|click|dial/.test(kind) || kind === '2';
  const statusRaw = String(first(o, ['status', 'call_status', 'call_state', 'state_name', 'disposition', 'result', 'answered']) ?? '').toLowerCase();
  const talk = secs(first(o, ['talk_time', 'talk_duration', 'billsec', 'bill_seconds', 'conversation_duration', 'seconds', 'duration']));
  let connected: boolean;
  if (/miss|no.?answer|unanswer|busy|fail|abandon|reject|cancel|not.?connect|voicemail/.test(statusRaw)) connected = false;
  else if (/answer|connect|complete|success|true|^1$/.test(statusRaw)) connected = true;
  else connected = (talk || 0) > 0 && !!first(o, ['recording', 'recording_url', 'filename', 'file_name', 'recording_file', '_fn']);
  const agentName = pickStr(o, ['agent_name', 'user_name', 'answered_by', 'receiver_name', 'agent', 'user']);
  const agentId = pickStr(o, ['agent_id', 'user_id', 'user_uuid', 'receiver_id']);
  const agentPhone = pickStr(o, ['agent_number', 'user_number', 'receiver_number', 'agent_phone']);
  const agentEmail = pickStr(o, ['agent_email', 'user_email']);
  const hasAgent = agentName || agentId || agentPhone || agentEmail;
  return {
    _ai: id, _cl: customer, _st: st, _et: et ?? (st && talk != null ? st + talk : null),
    _ev: outbound ? 2 : 1, _su: connected ? 1 : 2, _dr: connected ? talk : 0, _ss: connected ? talk : 0, _ty: 1,
    _cri: pickStr(o, ['client_ref_id', 'reference_id', 'click_to_call_ref']),
    _did: pickStr(o, ['did', 'did_number', 'virtual_number', 'display_number', 'company_number', 'called_number']),
    _fn: pickStr(o, ['recording', 'recording_url', 'filename', 'file_name', 'recording_file', '_fn']),
    _dn: pickStr(o, ['department', 'department_name', 'dept_name', 'group_name']),
    _ld: hasAgent ? [{ _ds: connected ? 'ANSWER' : 'NOANSWER', _rr: [{ _na: agentName, _id: agentId, _nr: agentPhone, _em: agentEmail }] }] : [],
    _layout: 'v2', _raw_keys: Object.keys(o).slice(0, 60),
  };
}

/** The call-log entries in a search response, in the short layout. */
export function logsFrom(j: J): J[] {
  return itemsFrom(j).map(normalizeLog).filter((x): x is J => !!x);
}

/** What MyOperator answered, without personal values: every key of the first entry with its type, and the value only
 *  for short status-like fields, so the settings screen shows how to read the log. */
export function shapeOf(j: J, httpStatus: number): string {
  const keys = (o: unknown) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o as J).slice(0, 15).join(',') : Array.isArray(o) ? `list(${(o as unknown[]).length})` : typeof o);
  const items = itemsFrom(j);
  const parts = [`HTTP ${httpStatus}`, `status=${String(j?.status ?? '-').slice(0, 20)}`, `code=${String(j?.code ?? '-').slice(0, 8)}`];
  if (j?.message) parts.push(`message=${String(j.message).slice(0, 120)}`);
  parts.push(`top={${keys(j)}}`, `data={${keys(j?.data)}}`, `items=${items.length}`, `calls=${logsFrom(j).length}`);
  const f = items[0];
  if (f) {
    const show = /status|type|direction|event|state|source|disposition|answered|layout|_su|_ev|_ty/i;
    parts.push('first={' + Object.keys(f).slice(0, 60).map((k) => {
      const v = f[k];
      const t = v == null ? 'null' : Array.isArray(v) ? `list${v.length}` : typeof v === 'object' ? `{${Object.keys(v).slice(0, 8).join('/')}}` : typeof v;
      return show.test(k) && v != null && typeof v !== 'object' ? `${k}:${t}=${String(v).slice(0, 24)}` : `${k}:${t}`;
    }).join(',') + '}');
  }
  return parts.join(' ');
}

async function ask(url: string, init: RequestInit): Promise<{ j: J; status: number; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let j: J;
  try { j = JSON.parse(text); } catch { throw new Error(`Call logs: unexpected answer (${res.status}) ${text.slice(0, 160)}`); }
  if (!res.ok || /error|fail/i.test(String(j.status || '')) || Number(j.code) >= 400) {
    throw new Error(`Call logs refused (${res.status}): ${j.message || j.details || text.slice(0, 160)}`);
  }
  return { j, status: res.status, text };
}

/** One page of call logs. MyOperator's docs do not say POST or GET: POST (form) first, and GET with the same values in the
 *  query when POST brings nothing back. The shape of each answer is kept for the settings screen. */
async function search(env: Env, from: number, to: number, page: number): Promise<{ logs: J[]; total: number | null; shape: string }> {
  const base = (env.MYOPERATOR_API_URL || 'https://developers.myoperator.co').replace(/\/$/, '');
  const params = { token: env.MYOPERATOR_API_TOKEN || '', from: String(from), to: String(to), page_size: String(PAGE), log_from: String(page * PAGE) };
  const u = new URL(base + '/search');
  u.searchParams.set('token', params.token);
  const shapes: string[] = [];
  let best: { j: J; logs: J[] } | null = null;
  try {
    const a = await ask(u.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params) });
    best = { j: a.j, logs: logsFrom(a.j) };
    shapes.push('POST ' + shapeOf(a.j, a.status));
  } catch (e) { shapes.push('POST ' + String((e as Error).message).slice(0, 200)); }
  if (!best?.logs.length) {
    const g = new URL(base + '/search');
    for (const [k, v] of Object.entries(params)) g.searchParams.set(k, v);
    try {
      const b = await ask(g.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
      shapes.push('GET ' + shapeOf(b.j, b.status));
      const logs = logsFrom(b.j);
      if (!best || logs.length > best.logs.length) best = { j: b.j, logs };
    } catch (e) {
      shapes.push('GET ' + String((e as Error).message).slice(0, 200));
      if (!best) throw new Error(shapes.join(' | '));
    }
  }
  const j = best!.j;
  const total = Number(j?.data?.total?.value ?? j?.data?.total ?? j?.hits?.total?.value ?? j?.hits?.total ?? j?.total);
  return { logs: best!.logs, total: Number.isFinite(total) ? total : null, shape: shapes.join(' | ').slice(0, 2000) };
}

export async function syncState(sql: Sql): Promise<J> {
  try {
    const [r] = await sql`select settings from integration_settings where provider = 'myoperator_sync'`;
    return (r?.settings as J) || {};
  } catch { return {}; }
}

async function saveState(sql: Sql, s: J) {
  await sql`insert into integration_settings (provider, settings, updated_at) values ('myoperator_sync', ${sql.json(s)}, now())
    on conflict (provider) do update set settings = excluded.settings, updated_at = now()`;
}

/** One sync run. Returns what happened; never throws (errors are kept in the state for the settings screen). */
export async function syncCallLogs(env0: Env, sql: Sql, exec: ExecutionContext, opts: { force?: boolean; mo?: Env } = {}): Promise<J> {
  const env = opts.mo ?? await moEnv(env0, sql);
  if (!env.MYOPERATOR_API_TOKEN) return { skipped: 'No MyOperator API token' };
  const prev = await syncState(sql);
  if (prev.paused && !opts.force) return { skipped: 'Paused' };
  const now = Math.floor(Date.now() / 1000);
  // "Sync now" re-reads the last 24 hours (each call is still applied once), so calls an earlier run missed come in too
  const from = opts.force ? now - 24 * 3600 : Math.max((prev.last_to || now - FIRST_WINDOW_S) - OVERLAP_S, now - 24 * 3600);
  const state: J = { ...prev, last_run_at: new Date().toISOString() };
  try {
    const all: J[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { logs, total, shape } = await search(env, from, now, page);
      if (page === 0) state.last_shape = shape;
      all.push(...logs);
      if (logs.length < PAGE || (total != null && all.length >= total)) break;
    }
    const calls = all.filter((o) => Number(o._ty || 1) !== 2);     // 2 = SMS log
    const r = await processEvents(sql, env, env0, exec, calls.map((o) => afterCallEvent(o, 'myoperator_sync')));
    // calls started from CareDesk that MyOperator never logged (the agent did not place it): close them after 3 hours
    await sql`update calls set status = 'failed', ended_at = now(), notes = coalesce(notes, 'Provider outcome unconfirmed after 3-hour call-log recovery; connection not verified')
      where direction = 'outbound' and status = 'ringing' and click_to_call_ref is not null and started_at < now() - interval '3 hours'`;
    if (r.changed.size) notifyLive(env0, exec, [...r.changed]);
    Object.assign(state, { last_to: now, last_ok_at: state.last_run_at, last_error: null, last_seen: calls.length, last_new: r.stored,
      total_new: (prev.total_new || 0) + r.stored, last_failed: r.failed });
    await saveState(sql, state);
    return { ok: true, window_from: new Date(from * 1000).toISOString(), shape: state.last_shape, seen: calls.length, new: r.stored, applied: r.applied, failed: r.failed };
  } catch (e) {
    state.last_error = String((e as Error).message || e).slice(0, 400);
    await saveState(sql, state).catch(() => {});
    return { ok: false, error: state.last_error };
  }
}
