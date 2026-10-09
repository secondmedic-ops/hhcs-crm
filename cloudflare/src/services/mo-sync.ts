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
const isLog = (o: J) => o && typeof o === 'object' && LOG_KEYS.some((k) => o[k] != null);

/** The list of items in a search response, whatever the wrapping (hits / _source / data / logs). */
function itemsFrom(j: J): J[] {
  const pools = [j?.data?.hits?.hits, j?.data?.hits, j?.hits?.hits, j?.hits, j?.data?.data, j?.data?.logs, j?.data?.list, j?.data, j?.logs, j?.result, Array.isArray(j) ? j : null];
  const list = (pools.find((x) => Array.isArray(x)) || []) as J[];
  return list.map((x) => (x && typeof x === 'object' && x._source ? x._source : x));
}

/** The call-log entries in a search response. */
export function logsFrom(j: J): J[] {
  return itemsFrom(j).filter(isLog);
}

/** What MyOperator answered, without any values: keys and counts only, so the settings screen can show why 0 calls came in. */
export function shapeOf(j: J, httpStatus: number): string {
  const keys = (o: unknown) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o as J).slice(0, 15).join(',') : Array.isArray(o) ? `list(${(o as unknown[]).length})` : typeof o);
  const items = itemsFrom(j);
  const parts = [`HTTP ${httpStatus}`, `status=${String(j?.status ?? '-').slice(0, 20)}`, `code=${String(j?.code ?? '-').slice(0, 8)}`];
  if (j?.message) parts.push(`message=${String(j.message).slice(0, 120)}`);
  parts.push(`top={${keys(j)}}`, `data={${keys(j?.data)}}`, `items=${items.length}`, `calls=${items.filter(isLog).length}`);
  if (items[0]) parts.push(`first={${keys(items[0])}}`);
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
  return { logs: best!.logs, total: Number.isFinite(total) ? total : null, shape: shapes.join(' | ').slice(0, 900) };
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
export async function syncCallLogs(env0: Env, sql: Sql, exec: ExecutionContext, opts: { force?: boolean } = {}): Promise<J> {
  const env = await moEnv(env0, sql);
  const prev = await syncState(sql);
  if (!env.MYOPERATOR_API_TOKEN) return { skipped: 'No MyOperator API token' };
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
    await sql`update calls set status = 'failed', notes = coalesce(notes, 'No MyOperator call found within 3 hours')
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
