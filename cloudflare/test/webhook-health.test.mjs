// Issue 4: webhook silence alert (working hours, configurable N, once per silence) and the masked error text.
import { test, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskDigits } from '../src/services/admin';

vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));

const ist = (s) => new Date(s + '+05:30').toISOString();

test('webhook silence alert: 09:00-21:00 IST, after N hours, once per silence, sync does not count', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '../../supabase/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir,f),'utf8'));
    const one = async (sql, params = []) => (await db.query(sql,params)).rows[0];
    const ws = (await one("select id from workspaces where code='HHC'")).id;
    const sup = '33333333-3333-4333-8333-333333333333', agent = '44444444-4444-4444-8444-444444444444';
    await db.query("insert into profiles(id,workspace_id,full_name,role) values ($1,$3,'Sup','supervisor'),($2,$3,'Agent','agent')", [sup, agent, ws]);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    const check = async (at) => (await one('select webhook_silence_check($1::timestamptz) n', [ist(at)])).n;
    const alerts = async () => (await one("select count(*)::int n from notifications where kind='webhook_silence'")).n;
    const event = (id, at, source = 'myoperator') => db.query("insert into webhook_events(event_id,source,event_type,received_at,processed) values ($1,$2,'call.end',$3,true)", [id, source, ist(at)]);

    expect((await one('select webhook_alert_hours($1) h', [ws])).h).toBe(4);       // default N
    await event('w1', '2026-10-15T19:49:00');                                         // the last live call
    await event('s1', '2026-10-19T10:00:00', 'myoperator_sync');                      // sync activity is not the webhook
    expect(await check('2026-10-19T08:30:00')).toBe(0);                               // before working hours
    expect(await check('2026-10-19T12:59:00')).toBe(0);                               // silence counted from 09:00 IST
    expect(await check('2026-10-19T13:00:00')).toBe(1);
    const n = await one("select role::text, title, body, link from notifications where kind='webhook_silence'");
    expect(n).toMatchObject({ role: 'supervisor', title: 'No MyOperator call events for 4 h', link: '/settings?tab=telephony' });
    expect(n.body).toContain('15 Oct 19:49');
    expect(await check('2026-10-19T15:00:00')).toBe(0);                               // once per silence
    expect(await check('2026-10-19T21:30:00')).toBe(0);                               // after working hours
    await event('w2', '2026-10-20T09:30:00');                                         // events resume
    expect(await check('2026-10-20T13:00:00')).toBe(0);
    expect(await check('2026-10-20T13:30:00')).toBe(1);                               // a new silence, a new alert
    expect(await alerts()).toBe(2);

    // N is configurable by a supervisor only (1 to 24)
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [agent]);
    await db.exec('set role caredesk_app');
    await expect(db.query('select set_webhook_alert_hours(2)')).rejects.toThrow('Only a supervisor');
    await expect(db.query('select webhook_silence_check()')).rejects.toThrow();
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [sup]);
    await db.exec('set role caredesk_app');
    await expect(db.query('select set_webhook_alert_hours(0)')).rejects.toThrow('1 to 24');
    expect((await one('select set_webhook_alert_hours(2) h')).h).toBe(2);
    await db.exec('reset role');
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    expect(await check('2026-10-21T10:59:00')).toBe(0);
    expect(await check('2026-10-21T11:00:00')).toBe(1);
    expect((await one("select title from notifications where kind='webhook_silence' order by created_at desc limit 1")).title).toBe('No MyOperator call events for 2 h');
  } finally { await db.close(); }
}, 120000);

test('error text shown in Webhook health never carries a phone number', () => {
  expect(maskDigits('duplicate key (number)=(+919820012012) violates')).toBe('duplicate key (number)=(•••) violates');
  expect(maskDigits('caller 98200 12012 not found')).toBe('caller ••• not found');
  expect(maskDigits('Format not recognised (stored for checking)')).toBe('Format not recognised (stored for checking)');
  expect(maskDigits('x'.repeat(400)).length).toBe(300);
});
