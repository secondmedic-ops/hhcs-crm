import { createHash } from 'node:crypto';

export async function feedbackApiTests({ call, sql, check, U, ws }) {
  const post = (who,path,body) => call(who,'POST',`/api/v1/feedback/${path}`,body);
  const summary = who => call(who,'POST','/api/v1/rpc/customer_feedback_summary',{});
  const read = (who,table,filters=[]) => call(who,'POST','/api/v1/batch',{ops:[{kind:'select',spec:{table,op:'select',cols:'*',filters}}]});
  const before = (await summary('sup')).body.data;
  const enq = await call('agent','POST','/api/v1/rpc/create_enquiry',{p:{patient:{ full_name:'Feedback Test Customer',mobile:'9000099001',email:'feedback@example.test' },services_requested:'Test call feedback',consent:true}});
  const { case_id:cid,patient_id:pid } = enq.body.data;
  const newCall = async (status='completed', seconds=60, agent=U.agent) => {
    const [r] = await sql`insert into calls(workspace_id,patient_id,case_id,agent_id,direction,status,started_at,ended_at,talk_seconds)
      values (${ws},${pid},${cid},${agent},'outbound',${status},now()-interval '2 minutes',now(),${seconds}) returning id`;
    return r.id;
  };
  const c1 = await newCall();
  const [request] = await sql`select * from feedback_requests where call_id=${c1}`;
  check(!!request && request.patient_id===pid && request.case_id===cid,'feedback: completed connected call creates a linked request');
  await sql`update calls set status='completed' where id=${c1}`;
  check(Number((await sql`select count(*) n from feedback_requests where call_id=${c1}`)[0].n)===1,'feedback: repeated completion creates no duplicate request');
  const missed = await newCall('missed',0);
  check(!(await sql`select id from feedback_requests where call_id=${missed}`).length,'feedback: missed call is ineligible');
  const pending = (await summary('sup')).body.data;
  check(pending.responses===before.responses && pending.average===before.average,'feedback: unanswered requests do not affect averages');
  check((await post(null,'link',{request_id:request.id})).status===401,'feedback: staff link requires login');
  for (const who of ['field','admin','bmm']) {
    check((await post(who,'link',{request_id:request.id})).status===403,'feedback: link denied to '+who);
    check((await read(who,'v_customer_feedback')).status===403,'feedback: list denied to '+who);
    check((await summary(who)).status===403,'feedback: summary denied to '+who);
  }
  check((await post('agent2','link',{request_id:request.id})).status===404,'feedback: another agent cannot generate this call link');
  for (const t of ['feedback_requests','feedback_responses']) check((await read('sup',t)).status===403,'feedback: raw storage is not exposed through data API: '+t);
  const link = await post('agent','link',{request_id:request.id});
  const token = new URL(link.body.url).hash.slice(1);
  const [stored] = await sql`select token_hash from feedback_requests where id=${request.id}`;
  check(stored.token_hash===createHash('sha256').update(token).digest('hex') && stored.token_hash!==token,'feedback: only token hash is stored');
  check((await post(null,'open',{})).status===404 && (await post(null,'open',{token:'0'.repeat(64)})).status===404,'feedback: missing and invalid capabilities rejected');
  const opened = await post(null,'open',{token});
  check(opened.status===200 && opened.body.ok===true && Object.keys(opened.body).sort().join(',')==='experience,ok','feedback: public form reveals no patient, call or medical data');
  for (const rating of [0,6,2.5,'5',null]) check((await post(null,'submit',{token,rating})).status===400,`feedback: invalid rating ${rating} rejected`);
  check((await post(null,'submit',{token,rating:5,comment:'x'.repeat(2001)})).status===400,'feedback: long comments rejected');
  const attempts = await Promise.all([post(null,'submit',{token,rating:5,comment:'<script>test only</script>'}),post(null,'submit',{token,rating:5})]);
  check(attempts.map(r=>r.status).sort().join(',')==='200,409','feedback: concurrent submissions accept exactly once');
  check((await post(null,'open',{token})).status===409 && (await post('sup','link',{request_id:request.id})).status===400,'feedback: used links and regeneration are blocked');
  const c2 = await newCall();
  const [r2] = await sql`select id from feedback_requests where call_id=${c2}`;
  const link2 = await post('sup','link',{request_id:r2.id});
  const token2 = new URL(link2.body.url).hash.slice(1);
  await sql`update feedback_requests set expires_at=now()-interval '1 second' where id=${r2.id}`;
  check((await post(null,'open',{token:token2})).status===410 && (await post(null,'submit',{token:token2,rating:3})).status===410,'feedback: expired links cannot be read or submitted');
  const renewed = await post('sup','link',{request_id:r2.id});
  const token3 = new URL(renewed.body.url).hash.slice(1);
  check((await post(null,'open',{token:token2})).status===404,'feedback: generating a replacement invalidates the old link');
  check((await post(null,'submit',{token:token3,rating:3})).status===200,'feedback: rating without a comment accepted');
  const [history] = (await read('client','v_customer_feedback',[{col:'patient_id',op:'eq',val:pid},{col:'status',op:'eq',val:'submitted'}])).body.results;
  check(history.data.length===2 && new Set(history.data.map(r=>r.call_id)).size===2,'feedback: Hinduja sees distinct submissions on patient history');
  const after = (await summary('sup')).body.data;
  check(after.responses===before.responses+2 && Math.abs(Number(after.average)-((Number(before.average||0)*before.responses+8)/(before.responses+2)))<0.02,'feedback: submitted-only response count and average are accurate');
  check((await read('agent2','v_customer_feedback',[{col:'patient_id',op:'eq',val:pid}])).body.results[0].data.length===0,'feedback: agent RLS hides other agents calls');
  const [caseAfter] = await sql`select stage,feedback_rating from cases where id=${cid}`;
  check(caseAfter.stage==='enquiry' && caseAfter.feedback_rating==null,'feedback: call rating changes neither service delivery nor case closure rating');
  const [otherWs] = await sql`insert into workspaces(code,name,brand_name) values ('FBTEST','Feedback tenant test','Feedback test') returning id`;
  await sql`insert into profiles(id,workspace_id,full_name,role) values ('b0000000-0000-4000-8000-000000000013',${otherWs.id},'Tenant test','supervisor')`;
  const isolated = await sql.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub','b0000000-0000-4000-8000-000000000013',true),set_config('role','caredesk_app',true)`;
    return tx`select id from feedback_responses`;
  });
  check(!isolated.length,'feedback: cross-workspace responses are hidden by RLS');
  // Isolate this new request for the cron claim without sending any mail.
  await sql`update workspaces set settings=settings||'{"feedback_auto_email":false}'::jsonb where id=${ws}`;
  const c3 = await newCall();
  const service = fn => sql.begin(async tx => {await tx`select set_config('request.jwt.claim.role','service_role',true)`; return fn(tx);});
  check(!(await service(tx=>tx`select feedback_email_claim() r`))[0].r,'feedback: auto-email switch respected');
  await sql`update workspaces set settings=settings||'{"feedback_auto_email":true,"feedback_expiry_hours":24}'::jsonb where id=${ws}`;
  const [r3] = await sql`select id from feedback_requests where call_id=${c3}`;
  const generated3 = await post('sup','link',{request_id:r3.id});
  check(Math.abs(new Date(generated3.body.expires_at).getTime()-Date.now()-86400000)<30000,'feedback: configurable expiry applied');
  const c4 = await newCall();
  const [r4] = await sql`select id from feedback_requests where call_id=${c4}`;
  // Other rehearsal requests may be queued; mark just this test request as the oldest.
  await sql`update feedback_requests set requested_at='2000-01-01' where id=${r4.id}`;
  const claim = (await service(tx=>tx`select feedback_email_claim() r`))[0].r;
  check(claim?.id===r4.id && claim.email==='feedback@example.test' && claim.token.length===64,'feedback: cron atomically claims email with a secure link');
  check((await post('sup','link',{request_id:r4.id})).status===400,'feedback: manual generation cannot race an email in flight');
  await sql`update feedback_requests set delivery_attempted_at=now()-interval '16 minutes' where id=${r4.id}`;
  await service(tx=>tx`select feedback_email_claim()`);
  check((await sql`select delivery_status from feedback_requests where id=${r4.id}`)[0].delivery_status==='unknown','feedback: interrupted mail remains unconfirmed, never automatically resent');
}
