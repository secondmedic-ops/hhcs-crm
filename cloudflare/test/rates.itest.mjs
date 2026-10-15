// Buying rates, rate import and margins through the real Worker (rehearsal): role rules per action, generic reads
// closed for cost tables, and the import -> approval -> margin path. Amounts are test values.
export async function rateApiTests({ call, sql, check, U, ws }) {
  const rpc = (who, fn, args = {}) => call(who, 'POST', `/api/v1/rpc/${fn}`, args);
  const read = (who, table) => call(who, 'POST', '/api/v1/batch', { ops: [{ kind: 'select', spec: { table, op: 'select', cols: '*', filters: [] } }] });
  const [{ d: today }] = await sql`select ws_today(${ws}::uuid)::text d`;
  const OPT = { buy_tax_basis: 'excl_gst', sell_tax_basis: 'excl_gst' };
  const rows = [{ row: 2, service_code: 'ELDER-CARE', provider_code: 'BMM', unit: 'unit', b2b: '900', b2c: '1200', effective_from: today }];

  for (const who of ['agent', 'coord', 'field', 'client', 'clinical', 'medical', 'bmm']) {
    check((await rpc(who, 'rate_import_check', { p_rows: rows, p_options: OPT })).status === 403, `rates: ${who} cannot check an import`);
    check((await rpc(who, 'submit_rate_import', { p_rows: rows, p_options: OPT })).status === 403, `rates: ${who} cannot submit an import`);
  }
  for (const who of ['agent', 'field', 'client', 'clinical', 'medical', 'bmm', 'admin']) {
    check((await rpc(who, 'margin_report', { p_from: today, p_to: today })).status === 403, `rates: ${who} gets no margin report`);
  }
  for (const who of ['agent', 'field', 'client', 'clinical', 'medical', 'bmm']) {
    check((await read(who, 'provider_rates')).status === 403, `rates: ${who} cannot read buying rates`);
    check((await read(who, 'rate_imports')).status === 403, `rates: ${who} cannot read rate imports`);
  }
  for (const who of ['sup', 'coord', 'agent', 'client', 'administrator']) {
    check((await read(who, 'case_item_costs')).status === 403, `rates: booking costs are not a readable table for ${who}`);
  }
  check((await call('sup', 'POST', '/api/v1/data/provider_rates', { table: 'provider_rates', op: 'insert', rows: [{ rate: 1 }] })).status === 403, 'rates: no direct writes to buying rates');

  const pv = await rpc('sup', 'rate_import_check', { p_rows: rows, p_options: OPT });
  check(pv.status === 200 && pv.body?.data?.ok === true && pv.body.data.rows[0].buy.status === 'new', 'rates: supervisor previews an import', pv.body);
  const sub = await rpc('admin', 'submit_rate_import', { p_rows: rows, p_options: OPT, p_file_name: 'rehearsal.xlsx', p_sheet: 'Rates' });
  check(sub.status === 200 && sub.body?.data?.buying_applied === 1 && sub.body.data.sell_status === 'awaiting_approval', 'rates: platform admin submits; buying applied, selling awaiting approval', sub.body);
  const again = await rpc('admin', 'submit_rate_import', { p_rows: rows, p_options: OPT, p_file_name: 'rehearsal.xlsx', p_sheet: 'Rates' });
  check(again.status === 200 && again.body?.data?.duplicate === true, 'rates: retrying the same import is safe');
  const apprId = sub.body?.data?.approval_id;
  check((await rpc('sup', 'decide_approval', { p_id: apprId, p_approve: true, p_note: null })).status === 400, 'rates: supervisor cannot approve selling prices');
  check((await rpc('client', 'decide_approval', { p_id: apprId, p_approve: true, p_note: 'ok' })).status === 200, 'rates: Hinduja approver approves the selling prices');
  const [svc] = await sql`select id, price::float8 price, tax_basis from services where workspace_id = ${ws}::uuid and code = 'ELDER-CARE'`;
  check(svc?.price === 1200 && svc.tax_basis === 'excl_gst', 'rates: approved selling price live', svc);

  const enq = await rpc('agent', 'create_enquiry', { p: { patient: { full_name: 'Rates rehearsal', mobile: '9899330011', address: 'Test', pincode: '400058' }, consent: true, service_ids: [svc.id] } });
  const cid = enq.body?.data?.case_id;
  check(enq.status === 200 && !!cid, 'rates: case with a costed service');
  if (!cid) return;
  for (const who of ['agent', 'client', 'admin', 'medical', 'bmm', 'field']) {
    check((await rpc(who, 'case_margins', { p_case: cid })).status === 403, `rates: ${who} gets no case margins`);
  }
  const [item] = await sql`select id from case_items where case_id = ${cid}::uuid`;
  check((await rpc('agent', 'set_item_provider', { p_item: item.id, p_provider: null })).status === 403, 'rates: agent cannot choose the cost provider');
  const batchLeak = await call('agent', 'POST', '/api/v1/batch', { ops: [{ kind: 'rpc', fn: 'case_margins', args: { p_case: cid } }] });
  check(batchLeak.status === 403, 'rates: margins cannot ride in an agent batch');
  const m = await rpc('sup', 'case_margins', { p_case: cid });
  const l = m.body?.data?.lines?.[0];
  check(m.status === 200 && l?.provider_code === 'BMM' && Number(l.buy_rate) === 900 && Number(l.margin) === 300 && Number(l.margin_pct) === 25, 'rates: supervisor sees the margin snapshot', l);
  const items = await call('agent', 'POST', '/api/v1/batch', { ops: [{ kind: 'select', spec: { table: 'case_items', op: 'select', cols: '*', filters: [{ col: 'case_id', op: 'eq', val: cid }] } }] });
  check(items.status === 200 && items.body?.results?.[0]?.data?.length === 1 && !/buy|provider_rate|margin/.test(JSON.stringify(items.body)), 'rates: the case lines an agent reads carry no cost', items.body);
  check((await rpc('sup', 'margin_report', { p_from: today, p_to: today })).status === 200, 'rates: supervisor runs the margin report');
}
