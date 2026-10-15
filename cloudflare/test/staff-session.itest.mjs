// Run through the real Worker, with real RLS and migrations. No staff password or staff JWT is used.
export async function staffSessionTests({ call, sql, check, U, ws }) {
  const start = (who, staff_id) => call(who, 'POST', '/api/v1/staff-sessions/start', { staff_id });
  const directory = await call('sup', 'GET', '/api/v1/staff-sessions/staff');
  check(directory.status === 200 && directory.body.some((p) => p.id === U.coord) && !directory.body.some((p) => ['admin','supervisor','client_manager','client_clinical'].includes(p.role)), 'staff access: directory lists operational staff only');
  for (const who of ['agent', 'admin', 'bmm']) check((await start(who, U.coord)).status === 403, `staff access: ${who} cannot assume staff`);
  check((await start('sup', U.admin)).status === 403 && (await start('sup', U.client)).status === 403, 'staff access: no administrator or management privilege escalation');
  check((await start('sup', 'bad')).status === 400, 'staff access: malformed staff ID refused');
  await sql`update profiles set active = false where id = ${U.agent2}`;
  check((await start('sup', U.agent2)).status === 403, 'staff access: disabled target refused');
  await sql`update profiles set active = true where id = ${U.agent2}`;
  const [{ id: foreignWs }] = await sql`insert into workspaces(code,name,brand_name) values ('STAFF-TEST','Other workspace','Other') returning id`;
  const [{ id: foreignStaff }] = await sql`insert into profiles(id,workspace_id,full_name,role) values (gen_random_uuid(),${foreignWs},'Other staff','coordinator') returning id`;
  check((await start('sup', foreignStaff)).status === 403, 'staff access: cross-workspace target refused');

  const opened = await start('sup', U.agent);
  const sid = opened.body?.id;
  check(opened.status === 200 && !!sid, 'staff access: supervisor opens staff workspace');
  if (!sid) return;
  const h = { 'X-Staff-Session': sid };
  const acting = (method, path, body) => call('sup', method, path, body, h);
  const me = await acting('GET', '/api/v1/me');
  check(me.body?.userId === U.agent && me.body?.role === 'agent' && me.body.staffSession?.supervisorName === 'SUP user', 'staff access: supervisor JWT resolves to staff permissions with real supervisor retained');
  check((await call('agent2', 'GET', '/api/v1/me', undefined, h)).status === 409, 'staff access: session ID cannot be used with a different JWT');
  check((await acting('POST', '/api/v1/staff-sessions/start', { staff_id: U.coord })).status === 403, 'staff access: nested switching refused');
  check((await acting('POST', '/api/v1/admin/users', {})).status === 403, 'staff access: supervisor privileges unavailable inside staff workspace');

  const enquiry = await acting('POST', '/api/v1/rpc/create_enquiry', { p: { patient: { full_name: 'Staff access test', mobile: '9899227711', address: 'Test', pincode: '400058' }, consent: true } });
  const cid = enquiry.body?.data?.case_id;
  check(enquiry.status === 200 && !!cid, 'staff access: staff can carry out normal business actions');
  const [audit] = await sql`select actor_id, staff_id, actor_name from v_audit where staff_session_id = ${sid} and table_name = 'cases' order by at desc limit 1`;
  check(audit?.actor_id === U.sup && audit.staff_id === U.agent && audit.actor_name === 'AGENT user - Supervisor (SUP user)', 'staff access: business audit stores supervisor ID, staff ID and combined display label');
  if (cid) {
    const note = await acting('POST', '/api/v1/data/interactions', { table: 'interactions', op: 'insert', rows: [{ workspace_id: ws, case_id: cid, channel: 'note', direction: 'internal', actor_id: U.agent, summary: 'Staff session test' }], returning: true });
    const [saved] = await sql`select actor_label, meta from interactions where case_id = ${cid} and summary = 'Staff session test'`;
    check(note.status === 200 && saved?.actor_label === 'AGENT user - Supervisor (SUP user)' && saved.meta.supervisor_id === U.sup, 'staff access: timeline notes also identify the supervisor');
    const cases = await acting('POST', '/api/v1/batch', { ops: [{ kind: 'select', spec: { table: 'v_cases', op: 'select', cols: 'patient_mobile', filters: [{ col: 'id', op: 'eq', val: cid }] } }] });
    check(JSON.stringify(cases.body).includes('XXX'), 'staff access: agent phone masking still applies');
  }
  const [access] = await sql`select user_id, staff_id, user_name from v_access where staff_session_id = ${sid} and action = 'staff_session_request' limit 1`;
  check(access?.user_id === U.sup && access.staff_id === U.agent && access.user_name.includes(' - Supervisor ('), 'staff access: reads and denied requests attributed in access log');
  await sql`update profiles set active = false where id = ${U.agent}`;
  check((await acting('GET', '/api/v1/me')).status === 409, 'staff access: disabling staff invalidates session immediately');
  await sql`update profiles set active = true where id = ${U.agent}`;
  await sql`update profiles set role = 'agent' where id = ${U.sup}`;
  check((await acting('GET', '/api/v1/me')).status === 409, 'staff access: removing supervisor role invalidates session immediately');
  await sql`update profiles set role = 'supervisor' where id = ${U.sup}`;
  await sql`update staff_sessions set expires_at = now() - interval '1 second' where id = ${sid}`;
  check((await acting('GET', '/api/v1/me')).status === 409, 'staff access: expired session refused');
  check((await acting('POST', '/api/v1/staff-sessions/end', {})).status === 200, 'staff access: return works even after expiry');
  check((await call('sup', 'GET', '/api/v1/me')).body?.role === 'supervisor', 'staff access: original supervisor login remains intact');

  const partner = await start('sup', U.bmm);
  const ph = { 'X-Staff-Session': partner.body?.id };
  check((await call('sup', 'GET', '/api/v1/calls/00000000-0000-0000-0000-000000000000/recording', undefined, ph)).status === 403, 'staff access: partner workspace never grants recordings');
  await call('sup', 'POST', '/api/v1/staff-sessions/end', {}, ph);
  check((await call('sup', 'GET', '/api/v1/me', undefined, ph)).status === 409, 'staff access: ended session cannot be reused');
}
