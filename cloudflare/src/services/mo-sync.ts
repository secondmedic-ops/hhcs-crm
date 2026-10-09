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

/** The call-log entries in a search response, whatever the wrapping (hits / _source / data / logs). */
export function logsFrom(j: J): J[] {
  const pools = [j?.data?.hits, j?.hits?.hits, j?.hits, j?.data?.data, j?.data?.logs, j?.data, j?.logs, j?.result, Array.isArray(j) ? j : null];
  const list = (pools.find((x) => Array.isArray(x)) || []) as J[];
  return list.map((x) => (x && typeof x === 'object' && x._source ? x._source : x)).filter((o) => o && typeof o === 'object' && (o._ai || o._cr || o._cl));
}

async function search(env: Env, from: number, to: number, page: number): Promise<{ logs: J[]; total: number | null }> {
  const base = (env.MYOPERATOR_API_URL || 'https://developers.myoperator.co').replace(/\/$/, '');
  const u = new URL(base + '/search');
  u.searchParams.set('token', env.MYOPERATOR_API_TOKEN || '');
  const body = new URLSearchParams({ token: env.MYOPERATOR_API_TOKEN || '', from: String(from), to: String(to), page_size: String(PAGE), log_from: String(page * PAGE) });
  const res = await fetch(u.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  const text = await res.text();
  let j: J;
  try { j = JSON.parse(text); } catch { throw new Error(`Call logs: unexpected answer (${res.status}) ${text.slice(0, 160)}`); }
  if (!res.ok || /error|fail/i.test(String(j.status || '')) || Number(j.code) >= 400) {
    throw new Error(`Call logs refused (${res.status}): ${j.message || j.details || text.slice(0, 160)}`);
  }
  const total = Number(j?.data?.total ?? j?.hits?.total?.value ?? j?.hits?.total ?? j?.total);
  return { logs: logsFrom(j), total: Number.isFinite(total) ? total : null };
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
  const from = Math.max((prev.last_to || now - FIRST_WINDOW_S) - OVERLAP_S, now - 24 * 3600);
  const state: J = { ...prev, last_run_at: new Date().toISOString() };
  try {
    const all: J[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { logs, total } = await search(env, from, now, page);
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
    return { ok: true, window_from: new Date(from * 1000).toISOString(), seen: calls.length, new: r.stored, applied: r.applied, failed: r.failed };
  } catch (e) {
    state.last_error = String((e as Error).message || e).slice(0, 400);
    await saveState(sql, state).catch(() => {});
    return { ok: false, error: state.last_error };
  }
}
