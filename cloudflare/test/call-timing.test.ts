// Issue 3: one source of truth for call timing (Worker) and the database repair / guard / averages.
import { expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { settleTiming, toIso } from '../src/services/myoperator';

vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));

const T = Date.parse('2026-10-15T14:19:00Z'); // 19:49 IST
const sec = (ms: number) => Math.floor(ms / 1000);

test('toIso: IST wall-clock vs UTC, seconds vs milliseconds, decimals, Date objects', () => {
  expect(toIso('2026-10-15 19:49:00')).toBe('2026-10-15T14:19:00.000Z');          // MyOperator shows India time
  expect(toIso('2026-10-15T19:49:00')).toBe('2026-10-15T14:19:00.000Z');
  expect(toIso('2026-10-15T14:19:00Z')).toBe('2026-10-15T14:19:00.000Z');          // explicit zone wins
  expect(toIso('2026-10-15T19:49:00+05:30')).toBe('2026-10-15T14:19:00.000Z');
  expect(toIso(sec(T))).toBe('2026-10-15T14:19:00.000Z');                          // epoch seconds
  expect(toIso(String(T))).toBe('2026-10-15T14:19:00.000Z');                       // epoch milliseconds
  expect(toIso(`${sec(T)}.250`)).toBe('2026-10-15T14:19:00.250Z');
  expect(toIso(new Date(T))).toBe('2026-10-15T14:19:00.000Z');
  expect(toIso('')).toBeNull(); expect(toIso('not a time')).toBeNull();
});

test('settleTiming: provider times win, started <= answered <= ended, talk always set', () => {
  // after-call: provider start / end / talk -> answered = end - talk
  expect(settleTiming({ startedAt: sec(T), endedAt: sec(T) + 95, talkSeconds: 80 })).toEqual({
    started_at: '2026-10-15T14:19:00.000Z', answered_at: '2026-10-15T14:19:15.000Z', ended_at: '2026-10-15T14:20:35.000Z', talk_seconds: 80, duration_flag: null });

  // the in-call webhook reached the Worker 9 s after MyOperator ended the call (the -9 s rows): the server
  // clock never beats the provider's end - talk, so answered stays before ended
  const late = settleTiming({ startedAt: sec(T), endedAt: sec(T) + 40, talkSeconds: 20, serverAnsweredAt: new Date(T + 49_000).toISOString() });
  expect(late.answered_at).toBe('2026-10-15T14:19:20.000Z');
  expect(Date.parse(late.ended_at!) - Date.parse(late.answered_at!)).toBe(20_000);

  // only the server answer time is known and it is after the end: clamped, talk derived (0), flagged
  const clamped = settleTiming({ startedAt: sec(T), endedAt: sec(T) + 40, serverAnsweredAt: new Date(T + 42_000).toISOString() });
  expect(clamped).toMatchObject({ answered_at: '2026-10-15T14:19:40.000Z', talk_seconds: 0, duration_flag: 'clamped' });

  // IST provider times mixed with UTC epoch: no five-and-a-half-hour gap
  const mixed = settleTiming({ startedAt: '2026-10-15 19:49:00', endedAt: String(T + 60_000), answeredAt: '2026-10-15T14:19:10Z' });
  expect(mixed).toMatchObject({ talk_seconds: 50, duration_flag: 'derived' });

  // missing talk_duration: derived from the provider's answer and end; nothing at all: 0 and 'unknown', never null
  expect(settleTiming({ startedAt: sec(T), answeredAt: sec(T) + 5, endedAt: sec(T) + 65 })).toMatchObject({ talk_seconds: 60, duration_flag: 'derived' });
  expect(settleTiming({ startedAt: sec(T), endedAt: sec(T) + 65 })).toMatchObject({ talk_seconds: 0, duration_flag: 'unknown', answered_at: null });

  // impossible talk (longer than the call) is cut to the call; inverted start / end is clamped
  expect(settleTiming({ startedAt: sec(T), endedAt: sec(T) + 30, talkSeconds: 500 })).toMatchObject({ talk_seconds: 30, duration_flag: 'clamped', answered_at: '2026-10-15T14:19:00.000Z' });
  const inverted = settleTiming({ startedAt: sec(T) + 10, endedAt: sec(T), talkSeconds: 0 });
  expect(inverted.started_at).toBe(inverted.ended_at); expect(inverted.duration_flag).toBe('clamped');
  // milliseconds and seconds for the same instant give the same result
  expect(settleTiming({ startedAt: T, endedAt: T + 95_000, talkSeconds: 80 })).toEqual(settleTiming({ startedAt: sec(T), endedAt: sec(T) + 95, talkSeconds: 80 }));
});

test('repair migration, inverted-timestamp guard and averages that skip unknown durations', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const target = files.find((f) => f.includes('call_timing_integrity'))!;
    for (const f of files.filter((f) => f < target)) await db.exec(readFileSync(join(dir, f), 'utf8'));
    const one = async (q: string, p: unknown[] = []) => (await db.query<any>(q, p)).rows[0];
    const ws = (await one("select id from workspaces where code='HHC'")).id;
    const at = (s: number) => new Date(T + s * 1000).toISOString();
    const add = async (o: { answered: number | null; ended: number; talk: number | null; raw?: unknown }) => (await one(
      `insert into calls(workspace_id,direction,status,started_at,answered_at,ended_at,talk_seconds,raw)
       values ($1,'inbound','completed',$2,$3,$4,$5,$6) returning id`,
      [ws, at(0), o.answered == null ? null : at(o.answered), at(o.ended), o.talk, o.raw ? JSON.stringify(o.raw) : null])).id;
    // the live shape: 2 inverted (-2 s, -9 s), 5 connected without talk time, 1 healthy
    const invRaw = await add({ answered: 32, ended: 30, talk: 18, raw: { end: { _st: sec(T), _et: sec(T) + 30, _dr: '00:00:18' } } });
    const invBare = await add({ answered: 49, ended: 40, talk: 31 });
    const nullV2 = await add({ answered: 5, ended: 65, talk: null, raw: { end: { event_type: 'call.end', payload: { ended_at: sec(T) + 65, legs: [{ talk_duration: 57 }] } } } });
    const nullIst = await add({ answered: 5, ended: 65, talk: null, raw: { end: { _st: '2026-10-15 19:49:00', _et: '2026-10-15 19:50:05', _dr: 50 } } });
    const nullTs = await add({ answered: 10, ended: 70, talk: null });
    const nullNone = await add({ answered: null, ended: 70, talk: null });
    const nullNone2 = await add({ answered: null, ended: 80, talk: null });
    const healthy = await add({ answered: 10, ended: 130, talk: 120 });

    await db.exec(readFileSync(join(dir, target), 'utf8'));
    const row = (id: string) => one('select answered_at, ended_at, talk_seconds, duration_flag from calls where id=$1', [id]);
    expect(await row(invRaw)).toMatchObject({ talk_seconds: 18, duration_flag: 'repaired' });
    expect(new Date((await row(invRaw)).answered_at).toISOString()).toBe(at(12));
    expect(await row(invBare)).toMatchObject({ talk_seconds: null, duration_flag: 'unknown' });
    expect(new Date((await row(invBare)).answered_at).toISOString()).toBe(at(40));
    expect(await row(nullV2)).toMatchObject({ talk_seconds: 57, duration_flag: 'repaired' });
    expect(await row(nullIst)).toMatchObject({ talk_seconds: 50, duration_flag: 'repaired' });
    expect(await row(nullTs)).toMatchObject({ talk_seconds: 60, duration_flag: 'derived' });
    expect(await row(nullNone)).toMatchObject({ talk_seconds: null, duration_flag: 'unknown' });
    expect(await row(healthy)).toMatchObject({ talk_seconds: 120, duration_flag: null });
    expect((await one("select count(*)::int n from calls where status='completed' and ended_at < answered_at")).n).toBe(0);
    expect((await one("select count(*)::int n from audit_log where changes->>'migration' = '20261019180200_call_timing_integrity'")).n).toBe(7);
    void nullNone2;

    // rerun: nothing left to change
    await db.exec(readFileSync(join(dir, target), 'utf8'));
    expect((await one("select count(*)::int n from audit_log where changes->>'migration' = '20261019180200_call_timing_integrity'")).n).toBe(7);

    // later migrations still apply cleanly on top
    for (const f of files.filter((f) => f > target)) await db.exec(readFileSync(join(dir, f), 'utf8'));

    // guard: any later write with an inverted answer time is corrected
    const later = await add({ answered: 50, ended: 40, talk: 10 });
    const g = await row(later);
    expect(new Date(g.answered_at).toISOString()).toBe(at(40)); expect(g.duration_flag).toBe('clamped');
    await db.query('update calls set answered_at=$2 where id=$1', [healthy, at(-30)]);
    expect(new Date((await row(healthy)).answered_at).toISOString()).toBe(at(0));
    await db.query('update calls set talk_seconds=-5 where id=$1', [later]);
    expect(await row(later)).toMatchObject({ talk_seconds: null, duration_flag: 'unknown' });

    // averages skip unknown durations instead of counting 0: only 18, 57, 50, 60, 120 count
    const unknownZero = await add({ answered: 5, ended: 5, talk: 0 });
    await db.query("update calls set duration_flag='unknown' where id=$1", [unknownZero]);
    const avg = await one("select round(avg(talk_seconds))::int a, count(talk_seconds)::int n from v_call_metrics where workspace_id=$1", [ws]);
    expect(avg).toEqual({ a: Math.round((18 + 57 + 50 + 60 + 120) / 5), n: 5 });
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    const day = new Date(T + 5.5 * 3600e3).toISOString().slice(0, 10);
    const mis = (await one('select mis_report($1::date,$1::date,$2) r', [day, ws])).r;
    expect(mis.calls.avg_talk).toBe(avg.a);
  } finally { await db.close(); }
}, 120000);
