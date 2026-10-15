import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bmmUpdate } from '../src/services/bmm';

test('BMM contract validates status events before accessing data', () => {
  const id = '90260313-c1ab-41ae-bbcf-7b325c9f42c1';
  const event = {event_id:id,expected_status:'dispatched',status:'deployed',note:' Ready '};
  expect(bmmUpdate(event,id).status).toBe('in_progress');
  expect(bmmUpdate(event,id).note).toBe('Ready');
  for (const body of [null,[],{...event,event_id:'bad'},{...event,status:'unknown'},{...event,note:42},
    {...event,scheduled_at:'2026-10-16T10:00:00'},{...event,scheduled_at:'bad'},{...event,note:'x'.repeat(2001)}]) {
    expect(() => bmmUpdate(body,id)).toThrow();
  }
});

test('BMM provider isolation, sign-off, workflow, idempotency and closure', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname,'../../supabase/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir,f),'utf8'));
    // The migration remains safe to rerun.
    await db.exec(readFileSync(join(dir,'20261014100000_bmm_partner_api.sql'),'utf8'));
    await db.exec(readFileSync(join(dir,'20261015170200_bmm_release_scope.sql'),'utf8'));
    const ws = (await db.query<any>("select id from workspaces where code='HHC'")).rows[0].id;
    const ids = {sup:'31000000-0000-4000-8000-000000000001',agent:'31000000-0000-4000-8000-000000000002',
      bmm:'31000000-0000-4000-8000-000000000003',other:'31000000-0000-4000-8000-000000000004',foreign:'31000000-0000-4000-8000-000000000005'};
    const providers = Object.fromEntries((await db.query<any>('select code,id from providers')).rows.map(r => [r.code,r.id]));
    for (const [name,id] of Object.entries(ids)) await db.query('insert into profiles(id,workspace_id,full_name,role,provider_id) values($1,$2,$3,$4,$5)',
      [id,ws,name,name === 'sup' ? 'supervisor' : name === 'agent' ? 'agent' : 'provider',name === 'bmm' || name === 'foreign' ? providers.BMM : name === 'other' ? providers.SM : null]);
    const as = async (user: keyof typeof ids, sql: string, params: any[] = []) => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[ids[user]]);
      await db.exec('set role caredesk_app');
      try { return (await db.transaction(tx => tx.query<any>(sql,params))).rows; }
      finally {await db.exec('reset role');}
    };
    const fn = async (user: keyof typeof ids,sql: string,params: any[] = []) => (await as(user,sql,params))[0]?.v;
    expect((await fn('sup','select bmm_settings() v')).enabled).toBe(false);
    await expect(fn('bmm','select bmm_leads() v')).rejects.toThrow('disabled');
    await expect(fn('agent','select set_bmm_integration(true,true) v')).rejects.toThrow('Not allowed');
    await expect(fn('sup','select set_bmm_integration(true,false) v')).rejects.toThrow('confirm');
    await fn('sup','select set_bmm_integration(true,true) v');
    await expect(fn('other','select bmm_leads() v')).rejects.toThrow('BMM provider');
    const svc = Object.fromEntries((await db.query<any>('select code,id from services')).rows.map(r => [r.code,r.id]));
    const create = (mobile: string,serviceIds: string[]) => fn('agent','select create_enquiry($1::jsonb) v',[JSON.stringify({
      patient:{full_name:'Test patient',mobile,address:'Test address',pincode:'400058'},consent:true,clinical_notes:'Private diagnosis',service_ids:serviceIds})]);
    const first = await create('9899001101',[svc['NURSE-12H'],svc['ECG-12']]);
    const second = await create('9899001102',[svc['NURSE-12H']]);
    const lead = (await db.query<any>("select id from case_referrals where case_id=$1 and provider_id=$2",[first.case_id,providers.BMM])).rows[0].id;
    const pureLead = (await db.query<any>("select id from case_referrals where case_id=$1 and provider_id=$2",[second.case_id,providers.BMM])).rows[0].id;
    const snapshot = await fn('bmm','select bmm_leads(1,0) v');
    expect(snapshot.total).toBe(2);expect(snapshot.leads).toHaveLength(1);
    expect(snapshot.leads[0].items.map((i:any) => i.service_code)).toEqual(['NURSE-12H']);
    expect(JSON.stringify(snapshot)).not.toContain('Private diagnosis');
    expect(JSON.stringify(snapshot)).not.toContain('unit_price');
    const next = await fn('bmm','select bmm_leads(1,1) v');expect(next.leads[0].referral_id).not.toBe(snapshot.leads[0].referral_id);
    await expect(fn('bmm','select bmm_leads(101,0) v')).rejects.toThrow('pagination');
    // The unit is the one agreed on the case line; a line given to another provider on the case is not BMM's.
    const [nurse] = (await db.query<any>('select id from case_items where case_id=$1',[second.case_id])).rows;
    const items = async () => (await fn('bmm','select bmm_leads(1,1) v')).leads[0].items;
    await db.exec("select set_config('request.jwt.claim.role','service_role',false); select rpc_on();");
    await db.exec("set session_replication_role = replica; update case_items set unit = 'per 12-hour shift' where id = '" + nurse.id + "'; set session_replication_role = origin;");
    expect((await items())[0].unit).toBe('per 12-hour shift');
    await db.exec("select set_config('request.jwt.claim.role','service_role',false); select rpc_on();");
    await db.query(`insert into case_item_costs(case_item_id,case_id,workspace_id,provider_id,source) values($1,$2,$3,$4,'selected')
      on conflict (case_item_id) do update set provider_id = excluded.provider_id`,[nurse.id,second.case_id,ws,providers.SM]);
    expect(await items()).toEqual([]);
    await db.query('update case_item_costs set provider_id=$1 where case_item_id=$2',[providers.BMM,nurse.id]);
    expect((await items()).map((i:any) => i.case_item_id)).toEqual([nurse.id]);
    const event='32000000-0000-4000-8000-000000000001';
    const apply = (ref: string,eventId: string,expected: string,status: string,note: string|null = null,when: string|null = null) =>
      fn('bmm','select bmm_apply_status($1,$2,$3,$4,$5,$6::timestamptz) v',[ref,eventId,expected,status,note,when]);
    await expect(apply(lead,event,'new','completed')).rejects.toThrow('transition');
    expect((await apply(lead,event,'new','accepted')).duplicate).toBe(false);
    const n1=(await db.query<any>('select count(*)::int n from interactions where case_id=$1',[first.case_id])).rows[0].n;
    expect((await apply(lead,event,'new','accepted')).duplicate).toBe(true);
    expect((await db.query<any>('select count(*)::int n from interactions where case_id=$1',[first.case_id])).rows[0].n).toBe(n1);
    await expect(apply(lead,event,'new','declined','Different event')).rejects.toThrow('different data');
    await expect(apply(lead,'32000000-0000-4000-8000-000000000002','new','scheduled',null,'2026-10-16T10:00:00Z')).rejects.toThrow('status changed');
    await expect(apply(lead,'32000000-0000-4000-8000-000000000003','accepted','scheduled')).rejects.toThrow('visit date');
    await apply(lead,'32000000-0000-4000-8000-000000000003','accepted','scheduled',null,'2026-10-16T10:00:00Z');
    await apply(lead,'32000000-0000-4000-8000-000000000004','scheduled','dispatched');
    await apply(lead,'32000000-0000-4000-8000-000000000005','dispatched','in_progress');
    await apply(lead,'32000000-0000-4000-8000-000000000006','in_progress','completed');
    expect((await db.query<any>('select stage from cases where id=$1',[first.case_id])).rows[0].stage).not.toBe('closed');
    for (const [i,from,to] of [[11,'new','accepted'],[12,'accepted','scheduled'],[13,'scheduled','in_progress'],[14,'in_progress','completed']] as const)
      await apply(pureLead,'32000000-0000-4000-8000-'+String(i).padStart(12,'0'),from,to,null,to === 'scheduled' ? '2026-10-16T10:00:00Z' : null);
    expect((await db.query<any>('select stage from cases where id=$1',[second.case_id])).rows[0].stage).toBe('closed');
    const held = await create('9899001103',[svc['NURSE-12H']]);
    const heldLead=(await db.query<any>('select id from case_referrals where case_id=$1',[held.case_id])).rows[0].id;
    await db.exec("select set_config('request.jwt.claim.role','service_role',false); select rpc_on();");
    await db.query("update cases set care_type='post_discharge',signoff_at=null where id=$1",[held.case_id]);
    const onHold=(await fn('bmm','select bmm_leads() v')).leads.find((r:any)=>r.referral_id===heldLead);
    expect(onHold.status).toBe('on_hold');expect(onHold.patient).toBeUndefined();expect(onHold.items).toBeUndefined();
    await expect(apply(heldLead,'32000000-0000-4000-8000-000000000021','new','accepted')).rejects.toThrow('on hold');
    await db.exec("select set_config('request.jwt.claim.role','service_role',false); select rpc_on();");
    await db.query("update cases set stage='cancelled' where id=$1",[held.case_id]);
    expect((await fn('bmm','select bmm_leads() v')).leads.find((r:any)=>r.referral_id===heldLead).status).toBe('cancelled');
    const foreignWs=(await db.query<any>("insert into workspaces(code,name,brand_name) values('BMMTEST','Other workspace','Other workspace') returning id")).rows[0].id;
    const foreignProvider=(await db.query<any>("insert into providers(workspace_id,code,name) values($1,'BMM','Other BMM') returning id",[foreignWs])).rows[0].id;
    await db.exec("select set_config('request.jwt.claim.role','service_role',false);");
    await db.query('update profiles set workspace_id=$1,provider_id=$2 where id=$3',[foreignWs,foreignProvider,ids.foreign]);
    await db.query('insert into bmm_integration_settings(workspace_id,enabled,contract_confirmed) values($1,true,true)',[foreignWs]);
    expect((await fn('foreign','select bmm_leads() v')).leads).toEqual([]);
    await expect(fn('foreign','select bmm_apply_status($1,$2,$3,$4) v',[lead,event,'new','accepted'])).rejects.toThrow('Lead not found');
    await fn('sup','select set_bmm_integration(false,true) v');
    await expect(fn('bmm','select bmm_leads() v')).rejects.toThrow('disabled');
    // Disabling the system interface does not take away provider portal reads.
    expect((await as('bmm','select id from v_referrals')).length).toBeGreaterThan(0);
    expect((await db.query<any>('select count(*)::int n from bmm_status_events where event_id=$1',[event])).rows[0].n).toBe(1);
  } finally {await db.close();}
},30000);
