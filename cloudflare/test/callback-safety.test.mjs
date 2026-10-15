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
      await db.exec("update callbacks set status='done'; update calls set status='completed',ended_at=now(); update profiles set available=false");
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
    expect(closed).toMatchObject({status:'unreachable',attempts:0}); expect(closed.notes).toContain('no customer attempt made');

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
