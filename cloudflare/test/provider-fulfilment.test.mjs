import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('provider field fulfilment is scoped, versioned and completes every unit before closure', async () => {
 const db=new PGlite();
 try {
  const dir=join(import.meta.dirname,'../../supabase/migrations');
  for(const f of readdirSync(dir).filter((f)=>f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir,f),'utf8'));
  await db.exec(readFileSync(join(dir,'20261015160000_provider_fulfilment_portal.sql'),'utf8'));
  const ws=(await db.query("select id from workspaces where code='HHC'")).rows[0].id;
  const pv=Object.fromEntries((await db.query('select code,id from providers')).rows.map((r)=>[r.code,r.id]));
  const uid=(n)=>'62000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const ids={sup:uid(1),agent:uid(2),provider:uid(3),field:uid(4),other:uid(5),coord:uid(6),client:uid(7),clinical:uid(8),admin:uid(9)};
  for(const [name,id] of Object.entries(ids)) await db.query('insert into profiles(id,workspace_id,full_name,role,provider_id) values($1,$2,$3,$4,$5)',
   [id,ws,name,{sup:'supervisor',agent:'agent',provider:'provider',field:'field_staff',other:'field_staff',coord:'coordinator',client:'client_manager',clinical:'client_clinical',admin:'admin'}[name],['provider','field'].includes(name)?pv.BMM:name==='other'?pv.SM:null]);
  const as=async(who,sql,args=[])=>{
   await db.exec('reset role');
   await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[ids[who]]);
   await db.exec('set role caredesk_app');
   try{return (await db.transaction((tx)=>tx.query(sql,args))).rows;}finally{await db.exec('reset role');}
  };
  const fn=async(who,sql,args=[])=>(await as(who,sql,args))[0]?.v;
  const services=(await db.query("select id,code,category from services where category in ('nursing','beds') order by code")).rows;
  const nurse=services.find((s)=>s.category==='nursing'),bed=services.find((s)=>s.category==='beds');
  const enquiry=await fn('agent','select create_enquiry($1::jsonb) v',[JSON.stringify({patient:{full_name:'Synthetic portal recipient',mobile:'9899003344',address:'Synthetic destination',pincode:'400058'},consent:true,service_ids:[nurse.id,bed.id]})]);
  const cid=enquiry.case_id;
  await db.exec("select set_config('request.jwt.claim.role','service_role',false);select rpc_on();");
  await db.query('update cases set coordinator_id=$1 where id=$2',[ids.coord,cid]);
  await db.query('update case_items set qty=2 where case_id=$1 and service_id=$2',[cid,nurse.id]);
  const ref=(await db.query('select id from case_referrals where case_id=$1 and provider_id=$2',[cid,pv.BMM])).rows[0].id;
  const items=(await db.query('select id,service_id from case_items where case_id=$1',[cid])).rows;
  const ni=items.find((i)=>i.service_id===nurse.id).id,bi=items.find((i)=>i.service_id===bed.id).id;
  await expect(fn('field','select provider_portal($1) v',[ref])).rejects.toThrow('Lead not found');
  await expect(fn('admin','select provider_portal() v')).rejects.toThrow('Not allowed');
  await fn('provider',"select update_referral($1,'accepted') v",[ref]);
  const start=new Date(Date.now()-4*3600000).toISOString(),end=new Date(Date.now()-3*3600000).toISOString();
  let requestNo=2000;
  const plan=(item,type='staff',staff=ids.field,at=start,until=end)=>fn('provider','select plan_provider_job($1,$2::jsonb) v',[ref,JSON.stringify({request_id:uid(requestNo++),case_item_id:item,resource_type:type,assigned_staff_id:staff,scheduled_at:at,scheduled_end:until,return_required:type==='equipment'})]);
  await expect(plan(ni,'staff',ids.other)).rejects.toThrow('this provider');
  const first=await plan(ni);
  await expect(plan(ni)).rejects.toThrow('overlapping shift');
  const second=await plan(ni,'staff',null,new Date(Date.now()-2*3600000).toISOString(),new Date(Date.now()-3600000).toISOString());
  await expect(plan(ni,'staff',null)).rejects.toThrow('Every agreed unit');
  const equipment=await plan(bi,'equipment');
  expect((await fn('field','select provider_portal() v')).jobs).toHaveLength(2);
  expect((await fn('other','select provider_portal() v')).jobs).toHaveLength(0);
  expect((await fn('client','select provider_portal($1) v',[ref])).jobs).toHaveLength(3);
  expect((await fn('clinical','select provider_portal($1) v',[ref])).jobs).toHaveLength(3);
  expect((await fn('coord','select provider_portal($1) v',[ref])).jobs).toHaveLength(3);
  await expect(fn('client','select plan_provider_job($1,$2::jsonb) v',[ref,JSON.stringify({})])).rejects.toThrow('Not allowed');
  let serial=100;
  const move=async(who,id,action,p={},eventId=uid(serial++),version=null)=>{
   const current=(await db.query('select version from partner_deployments where id=$1',[id])).rows[0].version;
   return fn(who,'select update_provider_job($1,$2,$3,$4,$5::jsonb) v',[id,eventId,version??current,action,JSON.stringify(p)]);
  };
  await expect(move('other',first.id,'dispatched')).rejects.toThrow('Job not found');
  await expect(move('field',second.id,'dispatched')).rejects.toThrow('Job not found');
  await expect(move('provider',second.id,'dispatched')).rejects.toThrow('Assign field staff');
  await move('provider',second.id,'assign',{assigned_staff_id:ids.field});
  const event=uid(1000);
  const oldVersion=(await db.query('select version from partner_deployments where id=$1',[first.id])).rows[0].version;
  expect((await move('field',first.id,'dispatched',{},event,oldVersion)).duplicate).toBe(false);
  expect((await move('field',first.id,'dispatched',{},event,oldVersion)).duplicate).toBe(true);
  await expect(move('field',first.id,'dispatched',{note:'changed'},event,oldVersion)).rejects.toThrow('different data');
  await expect(move('field',first.id,'arrived',{},uid(1001),oldVersion)).rejects.toThrow('Job changed');
  await expect(fn('provider',"select update_referral($1,'completed') v",[ref])).rejects.toThrow('every included service unit');
  for(const action of ['arrived','active']) await move('field',first.id,action);
  await expect(move('field',first.id,'completed')).rejects.toThrow('confirmation');
  await move('field',first.id,'completed',{confirmed_by:'Synthetic family',handover_confirmed:true});
  expect((await db.query('select stage from cases where id=$1',[cid])).rows[0].stage).not.toBe('closed');
  await move('field',second.id,'report_issue',{note:'Synthetic delay'});
  await expect(move('field',second.id,'dispatched')).rejects.toThrow('Resolve');
  await expect(move('field',second.id,'resolve_issue',{note:'resolved'})).rejects.toThrow('manager');
  await move('provider',second.id,'resolve_issue',{note:'Coordinator confirmed timing'});
  for(const action of ['dispatched','arrived','active']) await move('field',second.id,action);
  await move('field',second.id,'completed',{confirmed_by:'Synthetic family',handover_confirmed:true});
  await move('field',equipment.id,'dispatched');
  await expect(move('field',equipment.id,'delivered')).rejects.toThrow('serial number');
  await move('field',equipment.id,'delivered',{equipment_serial:'SYNTHETIC-SERIAL'});
  for(const action of ['installed','active']) await move('field',equipment.id,action);
  await move('field',equipment.id,'completed',{confirmed_by:'Synthetic family',handover_confirmed:true});
  expect((await db.query('select stage from cases where id=$1',[cid])).rows[0].stage).not.toBe('closed');
  await move('field',equipment.id,'returned',{confirmed_by:'Synthetic store',handover_confirmed:true});
  expect((await db.query('select stage from cases where id=$1',[cid])).rows[0].stage).toBe('closed');
  const snapshot=await fn('field','select provider_portal($1) v',[ref]);
  expect(snapshot.leads[0].completed).toBe(3);
  expect(snapshot.events.length).toBeGreaterThan(10);
  expect(JSON.stringify(snapshot)).not.toContain('buy_rate');
  expect(JSON.stringify(snapshot)).not.toContain('clinical_notes');
  expect((await db.query("select count(*)::int n from audit_log where changes::text like '%Synthetic family%' or changes::text like '%Synthetic delay%'")).rows[0].n).toBe(0);
  // A managed BMM lead completing must not close mixed SecondMedic work.
  const sm=(await db.query("select id from services where category='ecg' and active limit 1")).rows[0].id;
  const mixed=await fn('agent','select create_enquiry($1::jsonb) v',[JSON.stringify({patient:{full_name:'Synthetic mixed case',mobile:'9899003355',address:'Synthetic destination',pincode:'400058'},consent:true,service_ids:[nurse.id,sm]})]);
  const mr=(await db.query('select id from case_referrals where case_id=$1 and provider_id=$2',[mixed.case_id,pv.BMM])).rows[0].id;
  const mi=(await db.query('select id from case_items where case_id=$1 and service_id=$2',[mixed.case_id,nurse.id])).rows[0].id;
  await fn('provider',"select update_referral($1,'accepted') v",[mr]);
  const mj=await fn('provider','select plan_provider_job($1,$2::jsonb) v',[mr,JSON.stringify({request_id:uid(3000),case_item_id:mi,resource_type:'staff',assigned_staff_id:ids.field,scheduled_at:start,scheduled_end:end})]);
  for(const action of ['dispatched','arrived','active','completed']) await move('field',mj.id,action,action==='completed'?{confirmed_by:'Synthetic recipient',handover_confirmed:true}:{});
  expect((await db.query('select stage from cases where id=$1',[mixed.case_id])).rows[0].stage).not.toBe('closed');

  // A product without setup or collection does not fabricate an installation event.
  const product=await fn('agent','select create_enquiry($1::jsonb) v',[JSON.stringify({patient:{full_name:'Synthetic product',mobile:'9899003366',address:'Synthetic destination',pincode:'400058'},consent:true,service_ids:[bed.id]})]);
  const productRef=(await db.query('select id from case_referrals where case_id=$1 and provider_id=$2',[product.case_id,pv.BMM])).rows[0].id;
  const productItem=(await db.query('select id from case_items where case_id=$1',[product.case_id])).rows[0].id;
  await fn('provider','select accept_provider_lead($1) v',[productRef]);
  await expect(fn('provider',"select update_referral($1,'completed') v",[productRef])).rejects.toThrow('every included');
  const productJob=await fn('provider','select plan_provider_job($1,$2::jsonb) v',[productRef,JSON.stringify({request_id:uid(4000),case_item_id:productItem,resource_type:'equipment',assigned_staff_id:ids.field,scheduled_at:start,return_required:false,setup_required:false})]);
  await move('provider',productJob.id,'reschedule',{scheduled_at:start});
  await move('field',productJob.id,'dispatched');
  await move('field',productJob.id,'delivered',{equipment_serial:'SYNTHETIC-BATCH'});
  await move('field',productJob.id,'completed',{confirmed_by:'Synthetic recipient',handover_confirmed:true});
  const physical=(await db.query('select installed_at,status from partner_deployments where id=$1',[productJob.id])).rows[0];
  expect(physical.installed_at).toBe(null);
  expect(physical.status).toBe('completed');
  expect((await db.query('select stage from cases where id=$1',[product.case_id])).rows[0].stage).toBe('closed');

  // Withdrawal of post-discharge sign-off blocks dispatch but still permits cancellation.
  const held=await fn('agent','select create_enquiry($1::jsonb) v',[JSON.stringify({patient:{full_name:'Synthetic held',mobile:'9899003377',address:'Synthetic destination',pincode:'400058'},consent:true,service_ids:[nurse.id]})]);
  const heldRef=(await db.query('select id from case_referrals where case_id=$1 and provider_id=$2',[held.case_id,pv.BMM])).rows[0].id;
  const heldItem=(await db.query('select id from case_items where case_id=$1',[held.case_id])).rows[0].id;
  await fn('provider','select accept_provider_lead($1) v',[heldRef]);
  const heldJob=await fn('provider','select plan_provider_job($1,$2::jsonb) v',[heldRef,JSON.stringify({request_id:uid(5000),case_item_id:heldItem,resource_type:'staff',assigned_staff_id:ids.field,scheduled_at:start,scheduled_end:end})]);
  await db.exec("select set_config('request.jwt.claim.role','service_role',false);select rpc_on();");
  await db.query("update cases set care_type='post_discharge',signoff_at=null where id=$1",[held.case_id]);
  await expect(move('field',heldJob.id,'dispatched')).rejects.toThrow('on hold');
  await move('provider',heldJob.id,'cancelled',{note:'Family withdrew approval'});
  expect((await db.query('select stage from cases where id=$1',[held.case_id])).rows[0].stage).not.toBe('closed');

  // A different tenant with its own BMM provider cannot retrieve or mutate this work.
  await db.exec("select set_config('request.jwt.claim.role','service_role',false);select rpc_on();");
  const fw=(await db.query("insert into workspaces(code,name,brand_name) values('PORTALX','Synthetic foreign','Synthetic foreign') returning id")).rows[0].id;
  const fp=(await db.query("insert into providers(workspace_id,code,name) values($1,'BMM','Synthetic foreign BMM') returning id",[fw])).rows[0].id;
  ids.foreign=uid(99);
  await db.query("insert into profiles(id,workspace_id,full_name,role,provider_id) values($1,$2,'Synthetic foreign field','field_staff',$3)",[ids.foreign,fw,fp]);
  expect((await fn('foreign','select provider_portal() v')).jobs).toHaveLength(0);
  await expect(fn('foreign','select provider_portal($1) v',[mr])).rejects.toThrow('Lead not found');
  await expect(move('foreign',mj.id,'report_issue',{note:'Unauthorized'})).rejects.toThrow('Job not found');
  const calls=await as('field','select count(*)::int n from calls');
  expect(calls[0].n).toBe(0);
 }finally{await db.close();}
},30000);
