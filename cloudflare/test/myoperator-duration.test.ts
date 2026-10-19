import { expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterCallTalkSeconds, ringFallback } from '../src/services/myoperator';

vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));

const start = 1791898676; // UTC 13:37:56; the old _ss fallback displayed 817:56.

test('legacy clock seconds never replace a missing call duration', () => {
  expect(start % 86400).toBe(49076);
  expect(afterCallTalkSeconds({ _st: start, _et: start + 90, _ss: 49076 })).toBe(90);
  expect(afterCallTalkSeconds({ _ss: 49076 })).toBeNull();
  expect(afterCallTalkSeconds({ _st: start, _et: start - 1, _ss: 49076 })).toBeNull();
});

test('trusted duration fields remain bounded by provider timestamps', () => {
  expect(afterCallTalkSeconds({ _st: start, _et: start + 130, _dr: '00:02:05', _ss: 49076 })).toBe(125);
  expect(afterCallTalkSeconds({ _st: start, _et: start + 130, _dr: '13:37:56', _drs: 125 })).toBe(125);
  expect(afterCallTalkSeconds({ _st: start * 1000, _et: (start + 130) * 1000, _drs: 125 })).toBe(125);
  expect(afterCallTalkSeconds({ _dr: '00:02:05' })).toBe(125);
  expect(afterCallTalkSeconds({ _drs: 0 })).toBe(0);
});

test('leg durations are validated individually and as a total', () => {
  expect(afterCallTalkSeconds({ _st: start, _et: start + 90, _ld: [{ _dr: '00:00:30' }, { _drs: 45 }] })).toBe(75);
  expect(afterCallTalkSeconds({ _st: start, _et: start + 90, _ld: [{ _drs: 90 }, { _drs: 90 }] })).toBe(90);
  expect(afterCallTalkSeconds({ _ld: [{ _st: start, _et: start + 30, _drs: 90 }] })).toBeNull();
});

test.each(['Infinity', Infinity, -1, '00:60:00', 'broken', 2147483648])('invalid duration %s stays unknown without trustworthy timing', (duration) => {
  expect(afterCallTalkSeconds({ _dr: duration, _ss: 49076 })).toBeNull();
});

test('invalid provider timestamps do not throw or manufacture duration', () => {
  expect(afterCallTalkSeconds({ _st: Infinity, _et: 999999999999999999, _ss: 49076 })).toBeNull();
});

test('ring fallback computes epoch difference and clamps safely between 0 and 120s', () => {
  // Normal difference within 120s
  expect(ringFallback(start, start + 18)).toBe(18);
  expect(ringFallback(start * 1000, (start + 25) * 1000)).toBe(25);
  expect(ringFallback('2026-10-19T10:00:00.000Z', '2026-10-19T10:00:14.000Z')).toBe(14);

  // Exact same second (0s)
  expect(ringFallback(start, start)).toBe(0);

  // Exceeds upper bound (120s max cap)
  expect(ringFallback(start, start + 150)).toBe(120);
  expect(ringFallback(start, start + 3600)).toBe(120);

  // Inverted timestamps / clock skew clamped safely to 0
  expect(ringFallback(start + 10, start)).toBe(0);

  // Missing or invalid inputs
  expect(ringFallback(null, start)).toBeNull();
  expect(ringFallback(start, null)).toBeNull();
  expect(ringFallback(undefined, undefined)).toBeNull();
  expect(ringFallback('invalid', 'dates')).toBeNull();
});

test('historical repair is conservative, preserves summaries and is idempotent', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
    const filename = '20261014120000_repair_legacy_call_duration.sql';
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql') && f < filename).sort()) {
      await db.exec(readFileSync(join(dir, file), 'utf8'));
    }
    const workspace = (await db.query<{ id: string }>("select id from workspaces where code = 'HHC'")).rows[0].id;
    const over = 'Over 2 hours of talk time: check the call length, then use Summarise now if it is right';
    const legacy = { _su: 1, _st: start, _et: start + 90, _ss: 49076 };
    const fixtures = [
      { name: 'repair', end: legacy, status: 'skipped', error: over },
      { name: 'milliseconds', end: { ...legacy, _st: start * 1000, _et: (start + 90) * 1000, _drs: 75 }, status: 'skipped', error: over },
      { name: 'summary', end: legacy, status: 'done', summary: 'Existing summary', processed: new Date().toISOString() },
      { name: 'valid-duration', end: { ...legacy, _dr: '00:01:15' }, status: 'skipped', error: over },
      { name: 'different-clock', end: { ...legacy, _ss: 49075 }, status: 'skipped', error: over },
      { name: 'missing-timing', end: { _su: 1, _ss: 49076 }, status: 'skipped', error: over },
      { name: 'genuine-long-call', end: { ...legacy, _et: start + 49076 }, status: 'skipped', error: over },
      { name: 'other-skip', end: legacy, status: 'skipped', error: 'A different reason' },
    ];
    const ids: Record<string, string> = {};
    for (const f of fixtures) {
      const result = await db.query<{ id: string }>(`insert into calls
        (workspace_id, direction, status, recording_filename, talk_seconds, raw, ai_status, ai_error, ai_summary, ai_processed_at)
        values ($1, 'outbound', 'completed', 'fictional.mp3', 49076, $2::jsonb, $3, $4, $5, $6) returning id`,
      [workspace, JSON.stringify({ end: f.end }), f.status, f.error ?? null, f.summary ?? null, f.processed ?? null]);
      ids[f.name] = result.rows[0].id;
      await db.query(`insert into interactions (workspace_id, channel, call_id, summary, evidence)
        values ($1, 'phone', $2, 'Outbound call completed', 'Recording 817:56'),
               ($1, 'phone', $2, 'Manual note', 'Recording checked by staff')`, [workspace, ids[f.name]]);
    }
    const snapshot = async () => (await db.query(`select c.id, c.talk_seconds, c.ai_status, c.ai_error, c.ai_summary, c.ai_processed_at,
      array_agg(i.evidence order by i.summary) as evidence from calls c join interactions i on i.call_id = c.id
      group by c.id order by c.id`)).rows;
    const before = await snapshot();
    const migration = readFileSync(join(dir, filename), 'utf8');
    await db.exec(migration);
    const after = await snapshot();
    const repaired = after.find((r) => r.id === ids.repair)!;
    expect(repaired).toMatchObject({ talk_seconds: 90, ai_status: null, ai_error: null });
    expect(repaired.evidence).toEqual(['Recording checked by staff', 'Recording 1:30']);
    expect(after.find((r) => r.id === ids.milliseconds)).toMatchObject({ talk_seconds: 75, ai_status: null, ai_error: null });
    expect(after.find((r) => r.id === ids['other-skip'])).toMatchObject({ talk_seconds: 90, ai_status: 'skipped', ai_error: 'A different reason' });
    for (const f of fixtures.filter((f) => !['repair', 'milliseconds', 'other-skip'].includes(f.name))) {
      expect(after.find((r) => r.id === ids[f.name])).toEqual(before.find((r) => r.id === ids[f.name]));
    }
    await db.exec(migration);
    expect(await snapshot()).toEqual(after);
  } finally {
    await db.close();
  }
}, 60000);
