// MIS > Margins: net selling value, buying cost and gross margin of the bookings confirmed in the period.
// SecondMedic supervisors and coordinators; margin_report() checks the role and each case's visibility, and all money
// is computed there. Aggregate margin % = aggregate margin / aggregate net selling (never an average of percentages).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { inr, num, pct, dateTime } from '../lib/fmt.js';
import { Panel, Kpi, Badge, Button, Input, Select, TableSkeleton, Empty, ErrorNote, useAction } from './ui.jsx';

const STATUS = { complete: ['ok', 'Complete'], incomplete: ['warn', 'Margin incomplete'], not_captured: ['', 'Cost not captured'] };
const money = (v) => inr(Math.round(Number(v || 0)));
const mp = (v) => (v == null ? 'n/a' : pct(v, 2));

export default function MarginReport({ from, to, periodId }) {
  const [run, busy] = useAction();
  const [provider, setProvider] = useState('');
  const [service, setService] = useState('');
  const [caseNo, setCaseNo] = useState('');
  const [find, setFind] = useState('');
  const provs = useLoad(() => q(db.from('providers').select('id,code,name').order('code')), []);
  const svcs = useLoad(() => q(db.from('services').select('id,code,name').order('code')), []);
  const rep = useLoad(() => rpc('margin_report', { p_from: from, p_to: to, p_provider: provider || null, p_service: service || null, p_case: find || null }),
    [from, to, provider, service, find], ['cases', 'case_items', 'case_item_costs']);
  const r = rep.data;
  const t = r?.totals;

  const exportXlsx = () => run(async () => {
    const wb = XLSX.utils.book_new();
    const sheet = (rows) => XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: 'No rows' }]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Period', `${from} to ${to}`], ['Basis', r.basis],
      ['Filters', [provider && `provider ${provs.data?.find((p) => p.id === provider)?.code}`, service && `service ${svcs.data?.find((s) => s.id === service)?.code}`, find && `booking ${find}`].filter(Boolean).join(', ') || 'none'],
      [], ['Bookings', t.bookings], ['Net selling (all bookings)', Number(t.net_selling)],
      ['Bookings with complete costs', t.complete.bookings], ['  net selling', Number(t.complete.net_selling)], ['  buying cost', Number(t.complete.buying)],
      ['  gross margin', Number(t.complete.margin)], ['  margin %', t.complete.margin_pct == null ? 'n/a' : Number(t.complete.margin_pct)],
      ['Bookings with incomplete costs', t.incomplete.bookings], ['  net selling', Number(t.incomplete.net_selling)],
      ['  costed lines only: net / buying / margin', `${t.incomplete.known_net} / ${t.incomplete.known_buying} / ${t.incomplete.known_margin}`],
      ['Bookings with cost not captured', t.not_captured.bookings], ['  net selling', Number(t.not_captured.net_selling)],
    ]), 'Summary');
    const grp = (x) => ({ Code: x.code, Name: x.name, Lines: x.lines, 'Net selling': Number(x.net_selling), 'Net selling (costed)': Number(x.costed_net),
      'Buying cost': Number(x.buying), 'Gross margin': Number(x.margin), 'Margin %': x.margin_pct == null ? 'n/a' : Number(x.margin_pct), 'Lines without cost': x.lines_without_cost });
    XLSX.utils.book_append_sheet(wb, sheet(r.by_provider.map(grp)), 'By provider');
    XLSX.utils.book_append_sheet(wb, sheet(r.by_service.map((x) => ({ ...grp(x), Unit: x.unit, Qty: x.qty }))), 'By service');
    XLSX.utils.book_append_sheet(wb, sheet(r.bookings.map((b) => ({ Booking: b.case_no, 'Booked (IST)': dateTime(b.booked_at), Stage: b.stage, Completed: b.completed ? 'yes' : 'no',
      Lines: b.lines, 'Net selling': Number(b.net_selling), 'Buying cost': b.buying == null ? '' : Number(b.buying), 'Gross margin': b.margin == null ? '' : Number(b.margin),
      'Margin %': b.margin_pct == null ? '' : Number(b.margin_pct), Status: STATUS[b.status][1], 'Known buying (incomplete)': b.known_buying == null ? '' : Number(b.known_buying) }))), 'Bookings');
    XLSX.writeFile(wb, `HHC-margins-${from}-${to}.xlsx`);
    await rpc('log_access', { p_action: 'export', p_entity: 'margins', p_entity_id: periodId, p_meta: { from, to, provider: provider || null, service: service || null, booking: find || null, format: 'xlsx' } });
  }, 'Margins downloaded · export logged');

  const Group = ({ title, rows }) => (
    <Panel tight title={title}>
      {rows.length ? <div className="table-wrap"><table className="t compact">
        <thead><tr><th>{title === 'By provider' ? 'Provider' : 'Service'}</th><th className="num">Lines</th><th className="num">Net selling</th><th className="num">Buying cost</th>
          <th className="num">Gross margin</th><th className="num">Margin %</th><th className="num">Lines without cost</th></tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.code + x.name}><td><span className="mono small">{x.code}</span> {x.name}{x.unit ? <span className="tiny muted"> · per {x.unit}</span> : null}</td>
            <td className="num">{num(x.lines)}</td><td className="num">{money(x.net_selling)}</td><td className="num">{money(x.buying)}</td>
            <td className="num">{money(x.margin)}</td><td className="num">{mp(x.margin_pct)}</td>
            <td className="num">{x.lines_without_cost ? <span className="warn-text">{x.lines_without_cost}</span> : 0}</td></tr>
        ))}</tbody>
      </table></div> : <Empty title="Nothing in this period" />}
      <div className="tiny faint panel-body">Buying cost, margin and margin % cover lines with a comparable cost only ({'"'}costed{'"'}); net selling covers every line.</div>
    </Panel>
  );

  return (
    <div className="col gap-12">
      <div className="row wrap no-print" style={{ gap: 8 }}>
        <Select value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="All providers" options={(provs.data || []).map((p) => [p.id, `${p.code} · ${p.name}`])} style={{ width: 'auto' }} aria-label="Provider" />
        <Select value={service} onChange={(e) => setService(e.target.value)} placeholder="All services" options={(svcs.data || []).map((s) => [s.id, `${s.code} · ${s.name}`])} style={{ width: 'auto', maxWidth: 260 }} aria-label="Service" />
        <Input placeholder="Booking (case ID)" value={caseNo} onChange={(e) => setCaseNo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setFind(caseNo.trim())} onBlur={() => setFind(caseNo.trim())} style={{ width: 170 }} aria-label="Booking" />
        <Button icon="download" onClick={exportXlsx} disabled={!r || busy}>Excel</Button>
      </div>
      <ErrorNote error={rep.error} />
      {r && <div className="small muted">{r.basis}</div>}
      <div className="kpis">
        <Kpi label="Bookings" value={t && num(t.bookings)} detail={t && `${money(t.net_selling)} net selling`} />
        <Kpi label="Net selling (complete costs)" value={t && money(t.complete.net_selling)} detail={t && `${num(t.complete.bookings)} bookings`} />
        <Kpi label="Buying cost" value={t && money(t.complete.buying)} detail="bookings with complete costs" />
        <Kpi label="Gross margin" value={t && money(t.complete.margin)} detail={t && `${mp(t.complete.margin_pct)} of net selling`} tone={t && Number(t.complete.margin) < 0 ? 'warn' : ''} />
        <Kpi label="Incomplete costs" value={t && num(t.incomplete.bookings)} detail={t && `${money(t.incomplete.net_selling)} net selling · ${num(t.not_captured.bookings)} not captured`} tone={t && t.incomplete.bookings ? 'warn' : ''} />
      </div>
      {t && t.incomplete.bookings > 0 && (
        <div className="small muted">Bookings with incomplete costs, costed lines only (not their margin): net {money(t.incomplete.known_net)}, buying {money(t.incomplete.known_buying)}, gross margin {money(t.incomplete.known_margin)}.</div>
      )}
      <div className="grid g2">
        {['projected', 'completed'].map((k) => (
          <Panel key={k} title={k === 'projected' ? 'Projected (service not completed)' : 'Completed services'}>
            {r ? <table className="t compact"><tbody>
              <tr><td>Bookings</td><td className="num">{num(r[k].bookings)} ({num(r[k].complete_bookings)} with complete costs)</td></tr>
              <tr><td>Net selling, all</td><td className="num">{money(r[k].net_selling)}</td></tr>
              <tr><td>Net selling, complete costs</td><td className="num">{money(r[k].complete_net)}</td></tr>
              <tr><td>Buying cost</td><td className="num">{money(r[k].buying)}</td></tr>
              <tr><td>Gross margin</td><td className="num strong">{money(r[k].margin)} · {mp(r[k].margin_pct)}</td></tr>
            </tbody></table> : <TableSkeleton rows={5} cols={2} />}
          </Panel>
        ))}
      </div>
      {r ? <div className="grid g2"><Group title="By provider" rows={r.by_provider} /><Group title="By service" rows={r.by_service} /></div> : <TableSkeleton rows={4} cols={6} />}
      <Panel tight title="Bookings" sub="Margin per booking only where every line has a comparable cost">
        {!r ? <TableSkeleton rows={6} cols={8} /> : r.bookings.length ? <div className="table-wrap"><table className="t compact">
          <thead><tr><th>Booking</th><th>Booked</th><th>Stage</th><th className="num">Lines</th><th className="num">Net selling</th><th className="num">Buying cost</th><th className="num">Gross margin</th><th className="num">Margin %</th><th>Costs</th></tr></thead>
          <tbody>{r.bookings.map((b) => (
            <tr key={b.case_id}><td className="mono small"><Link to={`/cases/${b.case_id}`}>{b.case_no}</Link></td><td className="small nowrap">{dateTime(b.booked_at)}</td>
              <td className="small">{b.stage}{b.completed ? ' · completed' : ''}</td><td className="num">{b.lines}</td><td className="num">{money(b.net_selling)}</td>
              <td className="num">{b.buying != null ? money(b.buying) : '–'}</td><td className="num">{b.margin != null ? money(b.margin) : '–'}</td>
              <td className="num">{b.status === 'complete' ? mp(b.margin_pct) : '–'}</td>
              <td><Badge kind={STATUS[b.status][0]}>{STATUS[b.status][1]}</Badge>{b.known_buying != null && <div className="tiny muted">costed lines: {money(b.known_buying)}</div>}</td></tr>
          ))}</tbody>
        </table></div> : <Empty title="No bookings confirmed in this period" />}
      </Panel>
    </div>
  );
}
