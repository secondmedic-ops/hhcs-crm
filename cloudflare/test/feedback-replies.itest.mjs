import { createHash } from 'node:crypto';

export async function feedbackReplyApiTests({call,sql,check,U,ws,hook}) {
  const enq=await call('agent','POST','/api/v1/rpc/create_enquiry',{p:{patient:{full_name:'Reply Feedback Test',mobile:'9000099003',email:'replies@example.test'},services_requested:'Feedback reply test',consent:true}});
  const {case_id:cid,patient_id:pid}=enq.body.data;
  const newCall=async()=>{
    const [c]=await sql`insert into calls(workspace_id,patient_id,case_id,agent_id,direction,status,started_at,ended_at,talk_seconds)
      values(${ws},${pid},${cid},${U.agent},'outbound','completed',now()-interval '2 minutes',now(),60) returning id`;
    return (await sql`select id from feedback_requests where call_id=${c.id}`)[0].id;
  };
  const callRequest=await newCall();
  // Model the existing operational completion gate without unrelated fulfilment setup in this feedback test.
  await sql`update case_referrals set status='completed' where case_id=${cid}`;
  await sql.begin(async tx=>{await tx`select rpc_on()`; await tx`update cases set service_completed_at=now() where id=${cid}`;});
  const [service]=await sql`select id from feedback_requests where case_id=${cid} and experience='service'`;
  check(!!service,'feedback replies: actual service completion creates an independent service request');
  if (!service) throw new Error('Service feedback fixture did not reach its completion gate');
  await sql.begin(async tx=>{await tx`select rpc_on()`; await tx`update cases set service_completed_at=now() where id=${cid}`;});
  check(Number((await sql`select count(*) n from feedback_requests where case_id=${cid} and experience='service'`)[0].n)===1,'feedback replies: service completion creates no duplicate');
  const wa=async(id,text,from='+919000099003',context)=>{
    const res=await hook({event_id:id,event_type:'message.received',customer_identifier:from,payload:{id,text,context}});
    check(res.ok,'feedback replies: webhook accepted '+id);
    const [event]=await sql`select processed,error from webhook_events where event_id=${id}`;
    check(event?.processed===true,'feedback replies: webhook applied '+id,event?.error || 'event missing');
  };
  await wa('feedback-ambiguous','Rating: 2');
  check(!(await sql`select f.id from feedback_responses f join feedback_requests r on r.id=f.request_id where r.patient_id=${pid}`).length,'feedback replies: ambiguous plain rating is not assigned to a call or service');
  await wa('feedback-call',`Rating: 4 Helpful call\nFB-${callRequest}`);
  const [callResponse]=await sql`select rating,source_channel from feedback_responses where request_id=${callRequest}`;
  check(callResponse?.rating===4 && callResponse?.source_channel==='whatsapp','feedback replies: WhatsApp reply updates the matched call rating');
  await wa('feedback-call-duplicate',`Rating: 1\nFB-${callRequest}`);
  check((await sql`select rating from feedback_responses where request_id=${callRequest}`)[0]?.rating===4,'feedback replies: duplicate reply cannot overwrite feedback');
  const link=await call('sup','POST','/api/v1/feedback/link',{request_id:service.id});
  const token=new URL(link.body.url).hash.slice(1);
  const opened=await call(null,'POST','/api/v1/feedback/open',{token});
  check(opened.body.experience==='service','feedback replies: public service question is distinct from call question');
  const receive=async(sender,hash,rating,msg)=>sql.begin(async tx=>{
    await tx`select set_config('request.jwt.claim.role','service_role',true)`;
    return (await tx`select receive_feedback_reply(${ws}::uuid,'email',${sender},${service.id}::uuid,${hash},${rating},'Service was helpful',${msg}) r`)[0].r;
  });
  check((await receive('replies@example.test',null,5,'fb-mail-no-proof')).status==='unverified','feedback replies: From address alone cannot forge an email rating');
  const hash=createHash('sha256').update(token).digest('hex');
  check((await receive('other@example.test',hash,1,'fb-mail-wrong-sender')).handled===false,'feedback replies: private link from a different sender cannot rate this customer');
  check((await receive('replies@example.test',hash,5,'fb-mail-valid')).status==='submitted','feedback replies: verified email reply automatically submits service feedback');
  const [serviceResponse]=await sql`select rating,source_channel from feedback_responses where request_id=${service.id}`;
  check(serviceResponse.rating===5 && serviceResponse.source_channel==='email','feedback replies: email response is labelled and linked to service');
  const k=await call('sup','POST','/api/v1/rpc/customer_feedback_summary',{});
  check(k.body.data.service.responses>=1 && Number(k.body.data.service.average)===5 && Number(k.body.data.average)!==5,'feedback replies: call and service aggregates remain separate');
  check((await call('sup','POST','/api/v1/rpc/receive_feedback_reply',{})).status===403,'feedback replies: ingestion helper is inaccessible to staff APIs');
  const quotedRequest=await newCall();
  const pendingOther=await newCall();
  await sql`insert into interactions(workspace_id,case_id,patient_id,channel,direction,summary,body,meta)
    values(${ws},${cid},${pid},'whatsapp','outbound','Feedback request',${'Request FB-'+quotedRequest},${sql.json({message_id:'quoted-feedback-out'})})`;
  await wa('feedback-quoted','Rating: 3 No comment needed','+919000099003',{id:'quoted-feedback-out'});
  check((await sql`select rating from feedback_responses where request_id=${quotedRequest}`)[0]?.rating===3 && !(await sql`select id from feedback_responses where request_id=${pendingOther}`).length,'feedback replies: quoted WhatsApp message selects the correct interaction among several');
  await sql`update feedback_requests set expires_at=now()-interval '1 second' where id=${pendingOther}`;
  await wa('feedback-expired',`Rating: 2\nFB-${pendingOther}`);
  check(!(await sql`select id from feedback_responses where request_id=${pendingOther}`).length,'feedback replies: expired requests reject message ratings');
  const [leak]=await sql`select count(*) n from interactions where patient_id=${pid} and body like ${'%'+token+'%'}`;
  check(Number(leak.n)===0,'feedback replies: private tokens and original email quotes are excluded from stored replies');
}
