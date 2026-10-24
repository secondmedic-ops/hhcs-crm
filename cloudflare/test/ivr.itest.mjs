export async function ivrApiTests({ call, sql, check, base, webhookKey, ws }) {
  const path = '/api/v1/admin/ivr';
  const keys = ['main_menu','after_hours','information','billing','homecare','emergency','hold','callback_offer','callback_confirm','voicemail'];
  const cfg = { enabled: false, flow_id: 'test-flow', nodes: Object.fromEntries(keys.map(k => [k, 'node-' + k])) };
  const hook = async (b, key = webhookKey) => {
    const r = await fetch(base + '/webhooks/myoperator/ivr', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-key': key }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  check((await call('agent','GET',path)).status === 403 && (await call('bmm','POST',path,cfg)).status === 403, 'IVR settings reject operational/partner writes');
  check((await call(null,'GET',path)).status === 401, 'IVR settings require login');
  const initial = await call('sup','GET',path);
  check(initial.status === 200 && initial.body.enabled === false, 'IVR defaults disabled');
  check((await call('sup','POST',path,{...cfg,enabled:true,nodes:{}})).status === 400, 'IVR cannot enable incomplete nodes');
  check((await call('sup','POST',path,cfg)).status === 200, 'supervisor saves IVR mapping');
  const b = { session_id: 'ivr-rehearsal', request_id: 'entry-1', customer_number: '+919877662211', step: 'entry' };
  check((await hook(b,'wrong')).status === 401, 'IVR requires provider key');
  check((await hook(b)).status === 503, 'disabled IVR cannot process a call');
  await call('sup','POST',path,{...cfg,enabled:true});
  check((await hook({...b,customer_number:'anonymous'})).status === 400, 'IVR rejects withheld number for provider fallback');
  const entry = await hook(b);
  check(entry.status === 200 && ['main_menu','after_hours'].includes(entry.body.action), 'IVR entry selects IST menu');
  check((await hook({...b,request_id:'out-of-order',step:'callback_offer',digit:'1'})).status === 409, 'IVR cannot skip callback consent menu');
  const [c] = await sql`select id from calls where workspace_id = ${ws} and session_id = ${b.session_id}`;
  // Test a queued call independently of the wall clock and of unrelated test agents' availability.
  await sql`update profiles set available=false where workspace_id = ${ws}`;
  await sql`update calls set raw = raw || ${sql.json({ivr:{afterHours:false,queuedAt:Date.now()-180_100,lastAction:'hold'}})} where id = ${c.id}`;
  const offered = await hook({...b,request_id:'queue-1',step:'queue'});
  check(offered.status === 200 && offered.body.action === 'callback_offer', 'IVR offers callback after 180 seconds');
  const ask = {...b,request_id:'callback-1',step:'callback_offer',digit:'1'};
  const cb = await hook(ask);
  const again = await hook(ask);
  const [{n}] = await sql`select count(*)::int n from callbacks where call_id = ${c.id}`;
  check(cb.status === 200 && cb.body.callback_id && cb.body.action === 'callback_confirm' && n === 1 && again.body.callback_id === cb.body.callback_id, 'IVR callback is persisted exactly once on retry');
  check(cb.body.sms_status === 'provider_pending' && cb.body.target_node_id === cfg.nodes.callback_confirm, 'IVR confirms registration without claiming SMS delivery');
  check((await hook({...ask,customer_number:'+919877662212'})).status === 409, 'IVR session cannot change caller');
  const [saved] = await sql`select reason, next_attempt_at, due_at from callbacks where id = ${cb.body.callback_id}`;
  check(saved.reason === 'requested' && new Date(saved.due_at).getTime() > Date.now(), 'IVR callback has a future deadline and requested reason');
  await call('sup','POST',path,{...cfg,enabled:false});
  await sql`delete from callbacks where call_id=${c.id}`;
  await sql`delete from calls where id=${c.id}`;
}
