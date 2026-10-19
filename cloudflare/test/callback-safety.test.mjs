import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('callback eligibility, retry boundaries, reservations, reconciliation and workspace isolation', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '../../supabase/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir,f),'utf8'));
    const one = async (sql, params = []) => (await db.query(sql,params)).rows[0];
    const ws = (await one("select id from workspaces where code='HHC'")).id;
    const agent = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    await db.query("insert into profiles(id,workspace_id,full_name,role,myoperator_user_id,available,available_since) values ($1,$2,'Test agent','agent','mo-a',true,now()),($3,$2,'Test agent 2','agent','mo-b',true,now())", [agent,ws,other]);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    const settings = async (window, attempts, enabled = true) => db.query("update workspaces set settings = settings || jsonb_build_object('autodial',jsonb_build_object('enabled',$2::boolean,'buffer_minutes',$3::int,'max_attempts',$4::int)) where id=$1",[ws,enabled,window,attempts]);
    const queue = async () => (await one("insert into callbacks(workspace_id,number,due_at) values ($1,'+919800000001',now()+interval '10 minutes') returning *",[ws]));
    const claim = async () => (await one('select autodial_claim() c')).c;
    const clear = async () => {
      // completed calls are wrapped up (Issue 2: an agent with a connected call awaiting its outcome is not auto-dialled)
      await db.exec("update callbacks set status='done'; update calls set status='completed',ended_at=now(); update calls set disposition='test_internal' where disposition is null; update profiles set available=false");
      await db.query("update profiles set active=true,available=true,myoperator_user_id='mo-a',role='agent' where id=$1",[agent]);
    };
    for (const window of [30,45,60]) for (const attempts of [1,2,3,4,5]) {
      await clear(); await settings(window,attempts);
      const cb = await queue();
      expect(new Date(cb.due_at)-new Date(cb.created_at)).toBe(window*60000);
      expect(cb.next_attempt_at).toEqual(cb.created_at);
      const [k] = await claim(); expect(k.callback_id).toBe(cb.id);
      expect(await claim()).toEqual([]); // cannot reserve a ringing agent or callback again
      await db.query("update calls set status='failed',ended_at=now() where id=$1",[k.call_id]);
      const result = await one("select callback_retry($1,'Agent busy') r",[cb.id]);
      const retry = await one('select * from callbacks where id=$1',[cb.id]);
      if (attempts === 1) expect(result.r).toBe('unreachable');
      else {
        expect(result.r).toBe('pending');
        expect(new Date(retry.next_attempt_at)-new Date(retry.last_attempt_at)).toBe(Math.max(2,window/attempts)*60000);
        expect(retry.notes).toContain('Agent busy');
      }
    }
    for (const change of ["available=false", "active=false", "myoperator_user_id=null", "myoperator_user_id='  '", "role='field_staff'"]) {
      await clear(); await settings(30,3); await queue();
      await db.exec(`update profiles set ${change} where id='${agent}'`);
      expect(await claim()).toEqual([]);
    }
    await clear(); await settings(45,3,false); const disabled = await queue();
    expect(disabled.next_attempt_at).toBeNull(); expect(await claim()).toEqual([]);

    await clear(); await settings(30,3); const expired = await queue();
    await db.query('update callbacks set due_at=now() where id=$1',[expired.id]);
    expect(await claim()).toEqual([]);
    const closed = await one('select status,notes,attempts from callbacks where id=$1',[expired.id]);
    expect(closed).toMatchObject({status:'agent_unavailable',attempts:0}); expect(closed.notes).toContain('no customer attempt made');

    await clear(); await settings(30,3); const expiredWithAttempt = await queue();
    await db.query('update callbacks set attempts=1, due_at=now() where id=$1',[expiredWithAttempt.id]);
    expect(await claim()).toEqual([]);
    const closedAttempted = await one('select status,notes,attempts from callbacks where id=$1',[expiredWithAttempt.id]);
    expect(closedAttempted).toMatchObject({status:'unreachable',attempts:1});

    await clear(); const uncertain = await queue(); const [ringing] = await claim();
    await db.query("update callbacks set last_attempt_at=now()-interval '6 minutes' where id=$1",[uncertain.id]);
    await db.query("update calls set raw='{" + '"dial_outcome":"unconfirmed"' + "}'::jsonb,started_at=now()-interval '31 minutes' where id=$1",[ringing.call_id]);
    await queue(); expect(await claim()).toEqual([]);
    expect((await one('select status from callbacks where id=$1',[uncertain.id])).status).toBe('in_progress');
    // A failed terminal log releases the reservation; the prior elapsed time alone never does.
    await db.query("update calls set status='failed',ended_at=now() where id=$1",[ringing.call_id]);
    expect((await claim()).length).toBe(1);

    await clear(); const connected = await queue(); const [call] = await claim();
    await db.query("update calls set status='answered',answered_at=now(),started_at=now()-interval '31 minutes' where id=$1",[call.call_id]);
    await one('select callback_connected($1)',[call.call_id]);
    expect((await one('select status,completed_at from callbacks where id=$1',[connected.id]))).toMatchObject({status:'reached',completed_at:null});
    await queue(); expect(await claim()).toEqual([]);
    await db.query('update callbacks set due_at=now()-interval \'1 minute\' where id=$1',[connected.id]);
    await claim(); expect((await one('select status from calls where id=$1',[call.call_id])).status).toBe('answered');
    await db.query("update calls set status='completed',talk_seconds=null where id=$1",[call.call_id]);
    expect((await one('select callback_call_ended($1) r',[call.call_id])).r).toBe('reached');

    // Fair selection uses the least recently auto-dialled eligible agent.
    await clear(); await settings(60,5);
    await db.query("update profiles set available=true,last_autodial_at=null where id=$1",[other]);
    await db.query('update profiles set last_autodial_at=now() where id=$1',[agent]);
    const fair = await queue(); expect((await claim())[0].agent_id).toBe(other);
    const latest = (await one('select id from calls where callback_id=$1',[fair.id])).id;
    await db.query("update calls set status='failed' where id=$1",[latest]);
    await one("select callback_retry($1,'customer did not answer')",[fair.id]);
    await db.query("update profiles set available=false where id=$1",[other]);
    await db.query('update callbacks set next_attempt_at=now() where id=$1',[fair.id]);
    const next = (await claim())[0]; expect(next.callback_id).toBe(fair.id);
    await db.query("update calls set status='completed',talk_seconds=60 where id=$1",[latest]);
    expect((await one('select callback_connected($1) n',[latest])).n).toBe(0);
    expect((await one('select callback_call_ended($1) r',[latest])).r).toBe('in_progress');

    const foreign = (await one("insert into workspaces(code,name,brand_name) values ('TEST2','Other workspace','Test') returning id")).id;
    const foreignCb = (await one("insert into callbacks(workspace_id,number,due_at) values ($1,'+919800000001',now()) returning id",[foreign])).id;
    await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[agent]);
    await db.exec('set role caredesk_app');
    expect((await db.query('select id from v_callbacks where id=$1',[foreignCb])).rows).toEqual([]);
    await expect(db.query("select callback_update($1,'unreachable','test')",[foreignCb])).rejects.toThrow('Callback not found');
    await expect(db.query("select callback_close($1,'resolved')",[foreignCb])).rejects.toThrow('Callback not found');
    await expect(db.query('select autodial_claim()')).rejects.toThrow('System only');
  } finally { await db.close(); }
}, 120000);

test('initial callback delay: eligibility from the original call end time, retry window untouched', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '../../supabase/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir,f),'utf8'));
    const one = async (sql, params = []) => (await db.query(sql,params)).rows[0];
    const ws = (await one("select id from workspaces where code='HHC'")).id;
    const agent = '11111111-1111-4111-8111-111111111111';
    await db.query("insert into profiles(id,workspace_id,full_name,role,myoperator_user_id,available,available_since) values ($1,$2,'Test agent','agent','mo-a',true,now())", [agent,ws]);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    const claim = async () => (await one('select autodial_claim() c')).c;
    const clean = async () => { await db.exec("delete from callbacks; delete from calls; update profiles set available=true,active=true"); };
    const setCfg = async (delay, buffer, attempts, enabled) => db.query("update workspaces set settings = settings || jsonb_build_object('autodial',jsonb_build_object('enabled',$4::boolean,'initial_delay_minutes',$1::int,'buffer_minutes',$2::int,'max_attempts',$3::int)) where id=$5",[delay,buffer,attempts,enabled,ws]);
    const missedCall = async (endedMinutesAgo) => (await one(
      "insert into calls(workspace_id,direction,customer_number,status,started_at,ended_at) values ($1,'inbound','+919800000002','missed',now() - ($2::int * interval '1 minute') - interval '1 minute', now() - ($2::int * interval '1 minute')) returning *",
      [ws, endedMinutesAgo]));
    const queueFromCall = async (call) => (await one(
      "insert into callbacks(workspace_id,call_id,number,due_at) values ($1,$2,'+919800000002',now()+interval '30 minutes') returning *",[ws,call.id]));
    // 1. Eligibility matrix: delay 0/30/45/60 against how long ago the original missed call ended.
    //    30-min delay + call ended 15 min ago must NOT dial (the 10:00 call must not dial at 10:15);
    //    the same delay with the call ended 30 min ago must dial at the first eligible minute.
    for (const [delay, endedAgo, expectDial] of [[0, 0, true], [30, 15, false], [30, 30, true], [45, 30, false], [45, 60, true], [60, 59, false], [30, 120, true]]) {
      await clean(); await setCfg(delay, 30, 3, true);
      const call = await missedCall(endedAgo);
      const cb = await queueFromCall(call);
      const expectedEligible = new Date(Math.max(new Date(call.ended_at).getTime() + delay*60000, new Date(cb.created_at).getTime()));
      expect(Math.abs(new Date(cb.eligible_at) - expectedEligible)).toBeLessThan(2000);
      // the retry window starts at first eligibility, so the delay does not consume it
      expect(Math.abs(new Date(cb.due_at) - (new Date(cb.eligible_at).getTime() + 30*60000))).toBeLessThan(2000);
      const out = await claim();
      expect(out.length === 1).toBe(expectDial);
      if (!expectDial) {
        expect((await one('select status from callbacks where id=$1',[cb.id])).status).toBe('pending');
        // after eligibility, an available advisor is dialled on the next scheduler run
        await db.query("update callbacks set eligible_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute' where id=$1",[cb.id]);
        expect((await claim()).length).toBe(1);
      }
    }
    // 2. Fallback: no original call end time available -> eligible at callback creation.
    await clean(); await setCfg(30, 30, 3, true);
    const fallback = await one("insert into callbacks(workspace_id,number,due_at) values ($1,'+919800000002',now()+interval '30 minutes') returning *",[ws]);
    expect(Math.abs(new Date(fallback.eligible_at) - new Date(fallback.created_at))).toBeLessThan(2000);
    expect((await claim()).length).toBe(1);
    // 3. Busy / no eligible agent while eligible: nothing dialled; dialled once one frees up.
    await clean(); await setCfg(30, 30, 3, true);
    const busyCall = await missedCall(60);
    const busyCb = await queueFromCall(busyCall);
    await db.query("update profiles set available=false where id=$1",[agent]);
    expect((await claim()).length).toBe(0);
    await db.query("update profiles set available=true where id=$1",[agent]);
    expect((await claim()).length).toBe(1);
    // duplicate delivery of the same missed call is one callback row per original call (app guard covered elsewhere)
    expect((await one('select count(*) n from callbacks where call_id=$1',[busyCall.id])).n).toBe(1);
    // 4. Failed attempt after a delayed start: retry spacing from the attempt, deadline still eligible_at + window.
    await clean(); await setCfg(60, 30, 3, true);
    const retryCall = await missedCall(70);
    const retryCb = await queueFromCall(retryCall);
    const [k] = await claim();
    await db.query("update calls set status='failed',ended_at=now() where id=$1",[k.call_id]);
    expect((await one("select callback_retry($1,'customer did not answer') r",[retryCb.id])).r).toBe('pending');
    const after = await one('select * from callbacks where id=$1',[retryCb.id]);
    expect(new Date(after.due_at) > new Date(after.next_attempt_at)).toBe(true);
    // customer connection closes it as reached; a recorded outcome would then close it as done (covered above)
    await db.query("update calls set status='answered',answered_at=now() where id=$1",[k.call_id]);
    await one('select callback_connected($1)',[k.call_id]);
    expect((await one('select status from callbacks where id=$1',[retryCb.id])).status).toBe('reached');
    // 5. Immediate default unchanged when the delay setting is absent.
    await clean(); await db.exec("update workspaces set settings = settings - 'autodial' || jsonb_build_object('autodial',jsonb_build_object('enabled',true,'buffer_minutes',30,'max_attempts',3))");
    const imm = await one("insert into callbacks(workspace_id,number,due_at) values ($1,'+919800000002',now()+interval '30 minutes') returning *",[ws]);
    expect(Math.abs(new Date(imm.eligible_at) - new Date(imm.created_at))).toBeLessThan(2000);
    expect((await claim()).length).toBe(1);
  } finally { await db.close(); }
}, 120000);
// Issue 1 (15 Oct missed call with no callback): every path that leaves an inbound call missed / abandoned
// queues exactly one callback, or records a visible reason; the backfill is manual-only for old calls.
test('missed inbound calls: exactly one callback on every path, visible reason, safe backfill', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '../../supabase/migrations');
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) await db.exec(readFileSync(join(dir,f),'utf8'));
    const one = async (sql, params = []) => (await db.query(sql,params)).rows[0];
    const ws = (await one("select id from workspaces where code='HHC'")).id;
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query("update workspaces set settings = settings || jsonb_build_object('autodial',jsonb_build_object('enabled',true,'buffer_minutes',30,'max_attempts',3)) where id=$1",[ws]);
    const call = async (number, status = 'missed', minutesAgo = 1) => (await one(
      "insert into calls(workspace_id,direction,customer_number,status,started_at,ended_at) values ($1,'inbound',$2,$3,now() - ($4::int * interval '1 minute') - interval '30 seconds', now() - ($4::int * interval '1 minute')) returning *",
      [ws, number, status, minutesAgo]));
    const queue = async (id) => (await one('select queue_missed_callback($1) cb',[id])).cb;
    const own = async (id) => (await one('select count(*)::int n from callbacks where call_id=$1',[id])).n;

    // (1) end-event path, repeated delivery: one callback
    const a = await call('+919800000101');
    const cbA = await queue(a.id);
    expect(cbA).toBeTruthy(); expect(await queue(a.id)).toBe(cbA); expect(await own(a.id)).toBe(1);
    expect((await one('select reason,status from callbacks where id=$1',[cbA]))).toMatchObject({reason:'missed',status:'pending'});
    const ab = await call('+919800000109', 'abandoned');
    expect((await one('select reason from callbacks where id=$1',[await queue(ab.id)])).reason).toBe('abandoned');

    // (2) the actual 15 Oct cause: a stale pending callback (queued before the auto-dialer, never scheduled)
    //     must not swallow a new missed call from the same number
    await db.query("insert into callbacks(workspace_id,number,due_at,created_at) values ($1,'+919800000102',now()+interval '1 day',now()-interval '6 days')",[ws]);
    await db.query("update callbacks set next_attempt_at=null where number='+919800000102'");
    const b = await call('+919800000102');
    const cbB = await queue(b.id);
    expect(await own(b.id)).toBe(1);
    expect((await one('select next_attempt_at from callbacks where id=$1',[cbB])).next_attempt_at).not.toBeNull();

    // (3) a live callback for the same number: merged, recorded on both sides, never queued twice
    const c = await call('+919800000102');
    expect(await queue(c.id)).toBe(cbB); expect(await own(c.id)).toBe(0);
    expect((await one('select merged_call_ids from callbacks where id=$1',[cbB])).merged_call_ids).toContain(c.id);
    expect((await one('select callback_note from calls where id=$1',[c.id])).callback_note).toMatch(/already in the callback queue/);
    expect(await queue(c.id)).toBe(cbB);
    expect((await one('select array_length(merged_call_ids,1) n from callbacks where id=$1',[cbB])).n).toBe(1);

    // (4) withheld / IVR number: no callback, a visible reason instead of a silent skip
    for (const num of [null, '', '  ']) {
      const d = await call(num);
      expect(await queue(d.id)).toBeNull(); expect(await own(d.id)).toBe(0);
      expect((await one('select callback_note from calls where id=$1',[d.id])).callback_note).toBe('No caller number: cannot call back');
    }

    // (5) paths that never reach the Worker's end handler (later event, cleanup job, repair migration):
    //     the minute sweep queues them once; outbound, answered and older-than-24 h calls are left alone
    const e = (await one("insert into calls(workspace_id,direction,customer_number,status,started_at) values ($1,'inbound','+919800000103','ringing',now()-interval '2 minutes') returning *",[ws]));
    await db.query("update calls set status='missed', ended_at=now() where id=$1",[e.id]);
    const out = (await one("insert into calls(workspace_id,direction,customer_number,status,started_at,ended_at) values ($1,'outbound','+919800000104','failed',now(),now()) returning *",[ws]));
    const done = await call('+919800000105', 'completed');
    const old = await call('+919800000106', 'missed', 60 * 30);
    expect((await one('select sweep_missed_callbacks() n')).n).toBe(1);
    expect(await own(e.id)).toBe(1); expect(await own(out.id)).toBe(0); expect(await own(done.id)).toBe(0); expect(await own(old.id)).toBe(0);
    expect((await one('select sweep_missed_callbacks() n')).n).toBe(0);
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
    await expect(db.query('select sweep_missed_callbacks()')).rejects.toThrow(/System only/);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");

    // (6) backfill (rerun the migration): old missed call -> pending, backfilled, never auto-dialled, no SLA timer;
    //     a recent one keeps its auto-dial schedule; calls already handled are untouched; reruns add nothing
    const recent = await call('+919800000107', 'missed', 30);
    await db.query("update calls set started_at = greatest(started_at, '2026-10-13'::timestamptz) where id in ($1,$2)",[old.id, recent.id]);
    const before = (await one('select count(*)::int n from callbacks')).n;
    const migration = readFileSync(join(dir, files.find(f => f.includes('missed_call_callback_guarantee'))), 'utf8');
    await db.exec(migration);
    const bOld = await one('select * from callbacks where call_id=$1',[old.id]);
    expect(bOld).toMatchObject({status:'pending',backfilled:true,next_attempt_at:null,auto_dialled:false});
    expect(bOld.notes).toMatch(/Backfilled/);
    expect((await one("select count(*)::int n from sla_timers where callback_id=$1",[bOld.id])).n).toBe(0);
    const bRecent = await one('select * from callbacks where call_id=$1',[recent.id]);
    expect(bRecent.backfilled).toBe(true); expect(bRecent.next_attempt_at).not.toBeNull();
    expect((await one('select count(*)::int n from callbacks')).n).toBe(before + 2);
    await db.exec(migration);
    expect((await one('select count(*)::int n from callbacks')).n).toBe(before + 2);
    const claimed = (await one('select autodial_claim() c')).c.map(x => x.callback_id);
    expect(claimed).not.toContain(bOld.id);
  } finally { await db.close(); }
}, 120000);
