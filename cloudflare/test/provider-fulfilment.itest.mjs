export async function providerFulfilmentApiTests({call,sql,check,U,ws,token,base}) {
 const rpc=(who,fn,args={})=>call(who,'POST','/api/v1/rpc/'+fn,args);
 check((await rpc(null,'provider_portal')).status===401,'provider portal requires login');
 check((await rpc('admin','provider_portal')).status===403,'platform admin cannot read fulfilment patients');
 check((await rpc('field','plan_provider_job',{p_referral:U.field,p:{}})).status===403,'field login cannot plan work orders');
 const [{id:provider}]=await sql.unsafe("select id::text from providers where workspace_id=$1 and code='BMM'",[ws]);
 const created=await call('administrator','POST','/api/v1/admin/users',{email:'portal.field@rehearsal.test',password:'synthetic-test-pass',full_name:'Portal field synthetic',role:'field_staff',provider_id:provider});
 check(created.status===200 && created.body?.provider_id===provider,'administrator creates provider-linked field login');
 if(!created.body?.id) return;
 const fieldToken=await token(created.body.id,'portal.field@rehearsal.test');
 const [{id:service}]=await sql.unsafe("select id::text from services where category='nursing' and active limit 1");
 const enquiry=await rpc('agent','create_enquiry',{p:{patient:{full_name:'Synthetic fulfilment API',mobile:'9899006677',address:'Synthetic only',pincode:'400058'},consent:true,service_ids:[service]}});
 const [{id:ref}]=await sql.unsafe('select id::text from case_referrals where case_id=$1 and provider_id=$2',[enquiry.body.data.case_id,provider]);
 const [{id:item}]=await sql.unsafe('select id::text from case_items where case_id=$1 and service_id=$2',[enquiry.body.data.case_id,service]);
 await rpc('bmm','accept_provider_lead',{p_id:ref});
 check((await rpc('bmm','update_referral',{p_id:ref,p_status:'completed'})).status===400,'portal acceptance requires unit fulfilment even before planning');
 const body={p_referral:ref,p:{request_id:'63000000-0000-4000-8000-000000000001',case_item_id:item,resource_type:'staff',assigned_staff_id:created.body.id,
  scheduled_at:new Date(Date.now()-7200000).toISOString(),scheduled_end:new Date(Date.now()-3600000).toISOString()}};
 const sockets=[],updates=[];
 for(const who of ['client','sup']) {
  const socket=new WebSocket(base.replace(/^http/,'ws')+'/api/v1/live',['caredesk',await token(U[who],who+'@rehearsal.test')]);
  socket.addEventListener('message',(event)=>{try{updates.push({who,...JSON.parse(event.data)});}catch{}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Live portal test connection timed out')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Live portal connection failed'));},{once:true});});
  sockets.push(socket);
 } const [planned,concurrentPlan]=await Promise.all([rpc('bmm','plan_provider_job',body),rpc('bmm','plan_provider_job',body)]);
 check(planned.status===200 && concurrentPlan.status===200 && planned.body.data.id===concurrentPlan.body.data.id,'concurrent duplicate plan requests create one job');
 check(planned.status===200 && planned.body?.data?.id,'provider plans an assigned fulfilment job',JSON.stringify(planned.body));
 if(!planned.body?.data?.id) { sockets.forEach((socket)=>socket.close()); return; }
 for(let attempt=0;attempt<20 && !['client','sup'].every((who)=>updates.some((u)=>u.who===who && u.tables?.includes('partner_deployments')));attempt++) await new Promise((resolve)=>setTimeout(resolve,50));
 check(['client','sup'].every((who)=>updates.some((u)=>u.who===who && u.tables?.includes('partner_deployments'))),'both Hinduja and SecondMedic receive live fulfilment invalidation');
 sockets.forEach((socket)=>socket.close());
 const again=await rpc('bmm','plan_provider_job',body);
 check(again.body?.data?.id===planned.body.data.id && again.body?.data?.duplicate===true,'replayed plan request returns one work order');
 const refs=await call('bmm','POST','/api/v1/batch',{ops:[{kind:'select',spec:{table:'v_referrals',op:'select',cols:'id,fulfilment_managed',filters:[{col:'id',op:'eq',val:ref}],orders:[]}}]});
 check(refs.status===200 && refs.body.results[0].data[0].fulfilment_managed===true,'existing lead and case views expose managed fulfilment flag');
 const current=await rpc(fieldToken,'provider_portal',{p_referral:ref});
 check(current.status===200 && current.body.data.jobs.length===1 && current.body.data.staff.length===0,'field login sees assigned job without staff directory');
 check(!JSON.stringify(current.body).includes('buy_rate') && !JSON.stringify(current.body).includes('clinical_notes'),'field projection excludes costs and clinical notes');
 const client=await rpc('client','provider_portal',{p_referral:ref});
 check(client.body?.data?.jobs?.length===1 && client.body.data.leads[0].can_manage===false,'Hinduja monitors the same provider job read-only');
 check((await rpc('medical','provider_portal',{p_referral:ref})).body?.data?.jobs?.length===1,'medical desk can monitor existing case fulfilment');
 check((await rpc('client','update_provider_job',{p_id:planned.body.data.id,p_event:'63000000-0000-4000-8000-000000000002',p_version:1,p_action:'dispatched',p:{}})).status===403,'Hinduja monitoring cannot mutate fulfilment');
 check((await rpc('bmm','update_referral',{p_id:ref,p_status:'completed'})).status===400,'lead completion cannot bypass unfinished work order');
 let version=1, index=10;
 for(const action of ['dispatched','arrived','active','completed']) {
  const result=await rpc(fieldToken,'update_provider_job',{p_id:planned.body.data.id,p_event:'63000000-0000-4000-8000-'+String(index++).padStart(12,'0'),p_version:version,p_action:action,
   p:action==='completed'?{confirmed_by:'Synthetic recipient',handover_confirmed:true}:{}});
  check(result.status===200 && result.body.data.version===version+1,'assigned field staff '+action,JSON.stringify(result.body));
  version++;
 }
 const completed=await rpc('client','provider_portal',{p_referral:ref});
 check(completed.body?.data?.leads?.[0]?.completed===1 && completed.body.data.leads[0].status==='completed','Hinduja sees completed unit and lead');
 check((await call(fieldToken,'GET','/api/v1/calls/62000000-0000-4000-8000-000000000099/recording')).status===403,'provider field staff cannot access recordings');
}
