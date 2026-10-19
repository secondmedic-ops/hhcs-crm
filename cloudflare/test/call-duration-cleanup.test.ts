import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('outlier cleanup, live/MIS averages, snapshots, RLS and reruns on real migrations', async () => {
  const db = new PGlite();
  const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
  const name = '20261019160000_sanitize_test_call_durations.sql';
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql') && f < name).sort()) {
      await db.exec(readFileSync(join(dir, file), 'utf8'));
    }
    const ws = (await db.query<{ id: string }>("select id from workspaces where code='HHC'")).rows[0].id;
    const agent = '11111111-1111-1111-1111-111111111111';
    const supervisor = '22222222-2222-2222-2222-222222222222';
    await db.query(`insert into profiles(id,workspace_id,full_name,role,agent_code) values
      ($1,$3,'Duration test agent','agent','DURATION'),($2,$3,'Duration supervisor','supervisor',null)`, [agent, supervisor, ws]);
    const fixtures = [
      ['normal', 120, 120, 'completed'], ['boundary', 14400, 14400, 'completed'],
      ['zero', 0, 60, 'completed'], ['unknown', null, null, 'completed'],
      ['negative', -5, 60, 'completed'], ['nonconnected', 60, 60, 'failed'],
      ['local-test', 50000, 50000, 'completed'], ['demo-test', 50000, 50000, 'completed'],
      ['bad-window', 50000, 90, 'completed'], ['genuine-long', 20000, 20000, 'completed'],
      ['unverified-long', 20000, null, 'completed'],
      ['raw-window', 50000, 50000, 'completed'], ['malformed-provider', 20000, null, 'completed'],
    ] as const;
    const ids: Record<string, string> = {};
    for (const [label, seconds, elapsed, status] of fixtures) {
      const session = label === 'local-test' ? 'local-duration-fixture' : label === 'demo-test' ? 'demo-duration-fixture' : label;
      const row = await db.query<{ id: string }>(`insert into calls(workspace_id,agent_id,session_id,direction,status,
        started_at,answered_at,ended_at,talk_seconds,raw)
        values($1,$2,$3,'inbound',$4,'2026-10-10 06:00Z','2026-10-10 06:00Z',
          case when $5::int is not null then '2026-10-10 06:00Z'::timestamptz + $5::int * interval '1 second' end,
          $6,'{"evidence":"keep"}') returning id`, [ws, agent, session, status, elapsed, seconds]);
      ids[label] = row.rows[0].id;
    }
    // Provider milliseconds prove a short call even when the stored end was synthesized incorrectly.
    await db.query(`update calls set raw = '{"end":{"_st":1791898676000,"_et":1791898766000}}' where id=$1`, [ids['raw-window']]);
    await db.query(`update calls set raw = '{"end":{"_st":"broken","_et":"999999999999999999999"}}' where id=$1`, [ids['malformed-provider']]);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query(`insert into mis_snapshots(workspace_id,period,period_start,period_end,data,narrative,email_status)
      values($1,'daily','2026-10-10','2026-10-10',
        mis_report('2026-10-10','2026-10-10',$1::uuid) || '{"unrelated":"preserved"}'::jsonb,'Stale duration narrative','accepted')`, [ws]);
    const before = (await db.query('select id,ended_at,raw from calls order by id')).rows;
    const sql = readFileSync(join(dir, name), 'utf8');
    await db.exec(sql);
    const rows = (await db.query<{ id: string; talk_seconds: number | null }>('select id,talk_seconds from calls')).rows;
    for (const [label, seconds] of fixtures) {
      expect(rows.find((r) => r.id === ids[label])?.talk_seconds).toBe(
        ['local-test', 'demo-test', 'bad-window', 'raw-window'].includes(label) ? null : seconds);
    }
    expect((await db.query('select id,ended_at,raw from calls order by id')).rows).toEqual(before);
    const audit = (await db.query<{ changes: any }>("select changes from audit_log where table_name='calls'")).rows;
    expect(audit).toHaveLength(4);
    expect(audit.every((r) => r.changes.talk_seconds.old === 50000 && r.changes.talk_seconds.new === null)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('keep');
    const snapshot = (await db.query<{ data: any; narrative: string | null; email_status: string }>('select data,narrative,email_status from mis_snapshots')).rows[0];
    expect(snapshot.data.calls.avg_talk).toBe(7260);
    expect(snapshot.data.agents[0]).toMatchObject({ calls: fixtures.length, avg_talk: 7260 });
    expect(snapshot).toMatchObject({ narrative: null, email_status: 'accepted' });
    expect(snapshot.data.unrelated).toBe('preserved');
    expect((await db.query<{ role: string }>("select current_setting('request.jwt.claim.role') as role")).rows[0].role).toBe('service_role');
    await db.exec("select set_config('request.jwt.claim.role','',false)");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [supervisor]);
    const dashboard = (await db.query<{ r: any }>("select dashboard_kpis('2026-10-10 00:00Z','2026-10-11 00:00Z') as r")).rows[0].r;
    const mis = (await db.query<{ r: any }>("select mis_report('2026-10-10','2026-10-10') as r")).rows[0].r;
    expect(dashboard.calls).toMatchObject({ total: fixtures.length, avg_talk: 7260 });
    expect(mis.calls).toMatchObject({ total: fixtures.length, avg_talk: 7260 });
    expect(mis.agents[0].avg_talk).toBe(7260);
    expect(mis.callbacks.agent_unavailable).toBe(0);
    expect(mis.collections.by_account).toEqual({});
    const otherWs = (await db.query<{ id: string }>("insert into workspaces(code,name,brand_name) values('DUR-OTHER','Other test workspace','Test') returning id")).rows[0].id;
    await db.query("insert into calls(workspace_id,direction,talk_seconds,status) values($1,'inbound',240,'completed')", [otherWs]);
    await db.exec('set role caredesk_app');
    expect((await db.query('select * from v_call_metrics')).rows).toHaveLength(fixtures.length);
    await db.exec('reset role');
    const stable = (await db.query('select id,data,narrative,generated_at,email_status from mis_snapshots order by id')).rows;
    await db.exec(sql);
    expect((await db.query('select id,data,narrative,generated_at,email_status from mis_snapshots order by id')).rows).toEqual(stable);
    expect((await db.query("select * from audit_log where table_name='calls'")).rows).toHaveLength(4);
    expect((await db.query<{ role: string }>("select current_setting('request.jwt.claim.role') as role")).rows[0].role).toBe('');
    const diagnostic = readFileSync(join(dir, '..', '..', 'scripts', 'inspect_long_calls.sql'), 'utf8');
    await db.exec(diagnostic);
  } finally {
    await db.close();
  }
}, 120000);
