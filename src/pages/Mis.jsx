// MIS reports (slide 11): daily, weekly, monthly and custom packs for Hinduja with Excel and PDF export.
import { useState } from 'react';
import * as XLSX from 'xlsx';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { inr, num, pct, dur, date, dateLong, dateTime, istDateStr } from '../lib/fmt.js';
import { PageHead, Panel, Kpi, Segmented, Button, Badge, Input, TableSkeleton, Skeleton, Empty, ErrorNote, AiTag, useAction } from '../components/ui.jsx';
import { Bars, HBars, Funnel, Line, Meter } from '../components/charts.jsx';

// ---- IST calendar helpers on 'YYYY-MM-DD' strings
const D = (s) => new Date(s + 'T00:00:00Z');
const S = (d) => d.toISOString().slice(0, 10);
const add = (s, n) => S(new Date(D(s).getTime() + n * 86400e3));
const monday = (s) => add(s, -((D(s).getUTCDay() + 6) % 7));
const monthStart = (s) => s.slice(0, 7) + '-01';
const monthEnd = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); return add(S(d), -1); };
const shiftMonth = (s, n) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return S(d); };
const label = (s) => date(s + 'T00:00:00+05:30');
const longLabel = (s) => dateLong(s + 'T00:00:00+05:30');

function rangeFor(mode, anchor, custom) {
  if (mode === 'daily') return [anchor, anchor];
  if (mode === 'weekly') { const m = monday(anchor); return [m, add(m, 6)]; }
  if (mode === 'monthly') return [monthStart(anchor), monthEnd(anchor)];
  return custom[0] <= custom[1] ? custom : [custom[1], custom[0]];
}
const defaultAnchor = (mode) => (mode === 'daily' ? istDateStr(-1) : mode === 'weekly' ? add(monday(istDateStr(0)), -7) : shiftMonth(istDateStr(0), -1));

const MODES = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['custom', 'Custom']];
const CAT = { lab: 'Sample collection', xray: 'Portable X-ray', ecg: 'ECG at home', visit: 'Visit charges', other: 'Other' };
const COMPLAINT = { service: 'Service', behaviour: 'Staff behaviour', billing: 'Billing', report_delay: 'Report delay', other: 'Other' };
const ESC = { clinical: 'Clinical', emergency: 'Emergency', delay: 'Field delay', complaint: 'Complaint', privacy: 'Privacy', sla: 'SLA breach' };
const MODE_PAY = { upi: 'UPI', link: 'Payment link', card: 'Card', cash: 'Cash', refund: 'Refund' };
const mins = (m) => (m == null ? '–' : m >= 120 ? `${(m / 60).toFixed(1)} h` : `${Number(m).toFixed(1)} min`);
const target = (m) => (m >= 120 ? `${m / 60} h` : `${m} min`);
const ratio = (a, b) => (b ? (100 * a) / b : null);

export default function Mis() {
  const { workspace, can } = useAuth();
  const canExport = can('supervisor', 'client_manager', 'client_clinical');
  const [mode, setModeRaw] = useState('daily');
  const [anchor, setAnchor] = useState(defaultAnchor('daily'));
  const [custom, setCustom] = useState([istDateStr(-7), istDateStr(-1)]);
  const [run, busy] = useAction();
  const setMode = (m) => { setModeRaw(m); if (m !== 'custom') setAnchor(defaultAnchor(m)); };
  const [from, to] = rangeFor(mode, anchor, custom);
  const step = (n) => setAnchor(mode === 'daily' ? add(anchor, n) : mode === 'weekly' ? add(anchor, 7 * n) : shiftMonth(anchor, n));
  const today = istDateStr(0);

  const rep = useLoad(() => rpc('mis_report', { p_from: from, p_to: to }), [from, to]);
  const trans = useLoad(() => rpc('transition_metrics', { p_from: `${from}T00:00:00+05:30`, p_to: `${add(to, 1)}T00:00:00+05:30` }), [from, to]);
  const snap = useLoad(() => (mode === 'custom' ? Promise.resolve(null)
    : q(db.from('mis_snapshots').select('id,narrative,generated_at,period_end').eq('period', mode).eq('period_start', from).maybeSingle())), [mode, from]);
  const r = rep.data;
  const periodText = from === to ? longLabel(from) : `${longLabel(from)} to ${longLabel(to)}`;
  const periodId = mode === 'custom' ? `custom:${from}..${to}` : `${mode}:${from}`;

  const logExport = (format) => rpc('log_access', { p_action: 'export', p_entity: 'mis', p_entity_id: periodId, p_meta: { from, to, format } });
  const exportXlsx = () => run(async () => { writeWorkbook(r, { from, to, mode, workspace }); await logExport('xlsx'); }, 'Excel pack downloaded · export logged');
  const exportPdf = () => run(async () => { await logExport('pdf'); setTimeout(() => window.print(), 50); });

  const c = r?.calls || {};
  const cb = r?.callbacks || {};
  const f = r?.funnel || {};
  const col = r?.collections || {};
  const cmp = r?.complaints || {};
  const slaRows = (r?.sla || []).filter((s) => s.met + s.breached > 0);
  const slaMet = (r?.sla || []).reduce((a, s) => a + Number(s.met), 0);
  const slaAll = (r?.sla || []).reduce((a, s) => a + Number(s.met) + Number(s.breached), 0);
  const daily = (r?.daily || []).map((d) => ({ ...d, label: label(d.day), d: d.day.slice(8, 10) }));
  const every = daily.length > 16 ? Math.ceil(daily.length / 10) : 1;

  return (
    <>
      <div className="mis-print-head">
        <div className="row between"><strong>{workspace?.name || 'Hinduja Home Care Services'} · MIS {MODES.find((m) => m[0] === mode)[1].toLowerCase()} pack</strong><span className="mono small">{periodText}</span></div>
        <div className="small muted">Operated by SecondMedic on CareDesk · generated {dateTime(new Date())} IST · format proposed for joint sign-off</div>
      </div>

      <PageHead title="MIS reports" sub={<>{workspace?.name} · {periodText} · IST</>}>
        <Segmented options={MODES} value={mode} onChange={setMode} />
        {canExport && <Button icon="download" onClick={exportXlsx} disabled={!r || busy} className="no-print">Excel</Button>}
        {canExport && <Button icon="print" onClick={exportPdf} disabled={!r || busy} className="no-print">PDF</Button>}
      </PageHead>

      <div className="row wrap mb-12 no-print mis-period">
        {mode !== 'custom' ? <>
          <Button size="sm" icon="chevron" className="mis-prev" onClick={() => step(-1)} aria-label="Previous period" />
          {mode === 'daily' && <Input type="date" value={anchor} max={today} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={{ width: 160 }} aria-label="Day" />}
          {mode === 'weekly' && <Input type="date" value={from} max={today} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={{ width: 160 }} aria-label="Week starting" />}
          {mode === 'monthly' && <Input type="month" value={anchor.slice(0, 7)} max={today.slice(0, 7)} onChange={(e) => e.target.value && setAnchor(e.target.value + '-01')} style={{ width: 160 }} aria-label="Month" />}
          <Button size="sm" icon="chevron" onClick={() => step(1)} disabled={to >= today} aria-label="Next period" />
          <span className="small muted">{mode === 'weekly' ? `Mon ${label(from)} to Sun ${label(to)}` : mode === 'monthly' ? `${label(from)} to ${label(to)}` : 'One IST calendar day'}</span>
        </> : <>
          <Input type="date" value={custom[0]} max={today} onChange={(e) => e.target.value && setCustom([e.target.value, custom[1]])} style={{ width: 160 }} aria-label="From" />
          <span className="small muted">to</span>
          <Input type="date" value={custom[1]} max={today} onChange={(e) => e.target.value && setCustom([custom[0], e.target.value])} style={{ width: 160 }} aria-label="To" />
          <span className="small muted">{Math.round((D(to) - D(from)) / 86400e3) + 1} days</span>
        </>}
        {!canExport && <span className="small faint">Exports are available to the supervisor and Hinduja users.</span>}
      </div>

      <ErrorNote error={rep.error} />

      <div className="kpis mis-kpis">
        <Kpi label="Calls" value={r && num(c.total)} detail={r && `${num(c.answered)} answered`} />
        <Kpi label="Answered within 30 s" value={r && pct(c.answer_within_30s_pct, 1)} detail="of all calls" tone={r && c.answer_within_30s_pct != null && c.answer_within_30s_pct < 90 ? 'warn' : 'ok'} />
        <Kpi label="Missed / abandoned" value={r && pct(c.abandon_pct, 1)} detail={r && `${num(c.missed)} missed · ${num(c.abandoned)} abandoned`} tone={r && c.abandon_pct > 5 ? 'warn' : ''} />
        <Kpi label="Enquiries" value={r && num(f.enquiries)} detail={r && `${pct(f.conversion_pct, 1)} booked`} />
        <Kpi label="Booking value" value={r && inr(Math.round(r.revenue.booking_value))} detail={r && `${inr(Math.round(r.revenue.completed_value))} completed`} />
        <Kpi label="Collected" value={r && inr(Math.round(col.collected))} detail={r && `${num(col.count)} payments`} />
        <Kpi label="SLA compliance" value={r && pct(ratio(slaMet, slaAll), 1)} detail={r && `${slaMet} met of ${slaAll} closed timers`} tone={r && slaAll && ratio(slaMet, slaAll) < 90 ? 'warn' : 'ok'} />
      </div>

      <div className="grid g-main-side mt-16">
        <div className="col gap-12" style={{ minWidth: 0 }}>
          <div className="grid g2">
            <Panel title="Contact centre" sub="MyOperator telephony and the callback queue">
              {r ? <table className="t compact"><tbody>
                <Row k="Calls offered" v={num(c.total)} />
                <Row k="Answered" v={num(c.answered)} />
                <Row k="Missed" v={num(c.missed)} />
                <Row k="Abandoned in IVR / queue" v={num(c.abandoned)} />
                <Row k="Answered within 30 s" v={pct(c.answer_within_30s_pct, 1)} />
                <Row k="Missed + abandoned" v={pct(c.abandon_pct, 1)} />
                <Row k="Callbacks raised" v={num(cb.raised)} />
                <Row k="Callbacks done" v={num(cb.done)} />
                <Row k="Done within SLA (10 min)" v={`${num(cb.within_sla)}${cb.raised ? ` · ${pct(ratio(cb.within_sla, cb.raised), 0)}` : ''}`} />
                <Row k="Average callback time" v={mins(cb.avg_minutes)} />
              </tbody></table> : <TableSkeleton rows={8} cols={2} />}
            </Panel>
            <Panel title="Funnel & conversion" sub="Cases opened in the period">
              {r ? <>
                <Funnel steps={[
                  { label: 'Enquiries', value: f.enquiries }, { label: 'Quoted', value: f.quotes }, { label: 'Booked', value: f.bookings },
                  { label: 'Completed', value: f.completions }, { label: 'Closed', value: f.closed },
                ]} />
                <div className="grid g2 mt-16" style={{ gap: 8 }}>
                  <div><div className="upper">Conversion</div><div className="mono mis-big">{pct(f.conversion_pct, 1)}</div><div className="tiny muted">enquiry to booking</div></div>
                  <div><div className="upper">Cancelled</div><div className="mono mis-big">{num(f.cancelled)}</div><div className="tiny muted">reasons below</div></div>
                  <div><div className="upper">Quote TAT</div><div className="mono mis-big">{mins(r.tat.quote_min)}</div><div className="tiny muted">pricing to quote sent · target 10 min</div></div>
                  <div><div className="upper">Booking TAT</div><div className="mono mis-big">{mins(r.tat.booking_min)}</div><div className="tiny muted">quote to confirmation · target 15 min</div></div>
                </div>
              </> : <TableSkeleton rows={6} cols={1} />}
            </Panel>
          </div>

          <TransitionMis t={trans.data} loading={trans.loading} />

          <Panel title="SLA compliance by policy" sub="Met vs breached timers started in the period · marker at the 90% target">
            {r ? (slaRows.length ? <div className="grid g2" style={{ gap: '14px 24px' }}>
              {slaRows.map((s) => (
                <div key={s.label}>
                  <Meter label={<span>{s.label} <span className="faint">≤ {target(s.target_minutes)}</span></span>} value={s.pct} target={90} />
                  <div className="tiny muted mt-4">{num(s.met)} met · {num(s.breached)} breached</div>
                </div>
              ))}
            </div> : <Empty title="No SLA timers closed in this period" />) : <TableSkeleton rows={5} cols={2} />}
          </Panel>

          <Panel title="Daily trend" sub="Calls (with enquiries overlaid), bookings and collections per IST day"
            actions={<span className="row small muted"><span className="dot" style={{ color: '#b7cfc4' }} /> calls <span className="dot" style={{ color: 'var(--accent)' }} /> enquiries</span>}>
            {r ? (daily.length > 1 ? <div className="col gap-16">
              <Bars data={daily} x="d" y="calls" y2="enquiries" colors={['#b7cfc4', '#0e5e57']} height={110} labelEvery={every} />
              <div className="grid g2">
                <div><div className="upper mb-8">Bookings</div><Bars data={daily} x="d" y="bookings" height={60} labelEvery={every} colors={['#2d5577']} /></div>
                <div><div className="upper mb-8">Collections · {inr(daily.reduce((a, d) => a + Number(d.collections), 0))}</div><Line data={daily} y="collections" height={60} /><div className="row between tiny faint mono mt-4"><span>{label(from)}</span><span>{label(to)}</span></div></div>
              </div>
            </div> : <div className="grid g4" style={{ gap: 8 }}>
              {daily.map((d) => [['Calls', num(d.calls)], ['Enquiries', num(d.enquiries)], ['Bookings', num(d.bookings)], ['Collections', inr(d.collections)]].map(([k, v]) => (
                <div key={k}><div className="upper">{k}</div><div className="mono mis-big">{v}</div></div>
              )))}
              <div className="tiny muted" style={{ gridColumn: '1 / -1' }}>Day-by-day charts appear for weekly, monthly and custom periods.</div>
            </div>) : <Skeleton height={180} />}
          </Panel>

          <Panel title="Zones" sub="MMR zones by pincode" tight>
            {r ? (r.zones.length ? <div className="table-wrap"><table className="t">
              <thead><tr><th>Zone</th><th className="num">Enquiries</th><th className="num">Bookings</th><th className="num">Completed</th><th className="num">Conversion</th><th className="num">Revenue</th></tr></thead>
              <tbody>{r.zones.map((z) => (
                <tr key={z.zone}><td>{z.zone}</td><td className="num">{num(z.enquiries)}</td><td className="num">{num(z.bookings)}</td><td className="num">{num(z.completed)}</td>
                  <td className="num">{pct(ratio(z.bookings, z.enquiries), 0)}</td><td className="num">{inr(z.revenue)}</td></tr>
              ))}</tbody>
            </table></div> : <Empty title="No enquiries in this period" />) : <TableSkeleton rows={5} cols={6} />}
          </Panel>

          <Panel title="Services" sub="Line items on cases opened in the period" tight>
            {r ? (r.services.length ? <div className="table-wrap"><table className="t">
              <thead><tr><th>Service</th><th>Category</th><th className="num">Count</th><th className="num">Value</th><th className="num">Share</th></tr></thead>
              <tbody>{(() => { const tot = r.services.reduce((a, s) => a + Number(s.value), 0); return r.services.map((s) => (
                <tr key={s.service_name}><td>{s.service_name}</td><td className="small muted">{CAT[s.category] || s.category}</td><td className="num">{num(s.n)}</td><td className="num">{inr(s.value)}</td><td className="num">{pct(ratio(s.value, tot), 0)}</td></tr>
              )); })()}</tbody>
            </table></div> : <Empty title="No services booked in this period" />) : <TableSkeleton rows={6} cols={5} />}
          </Panel>

          <Panel title="Agents" sub="Contact centre agents · QA from supervisor and AI-assisted reviews" tight>
            {r ? (r.agents.length ? <div className="table-wrap"><table className="t">
              <thead><tr><th>Agent</th><th className="num">Calls</th><th className="num">Avg talk</th><th className="num">QA score</th></tr></thead>
              <tbody>{r.agents.map((a) => (
                <tr key={a.agent}><td className="mono">{a.agent}</td><td className="num">{num(a.calls)}</td><td className="num">{a.avg_talk ? dur(a.avg_talk) : '–'}</td>
                  <td className="num">{a.qa == null ? '–' : <span className={a.qa < 80 ? 'warn-text' : ''}>{pct(a.qa, 1)}</span>}</td></tr>
              ))}</tbody>
            </table></div> : <Empty title="No agents on this workspace" />) : <TableSkeleton rows={3} cols={4} />}
            {r && <div className="small muted" style={{ padding: '8px 12px' }}>{num(r.qa.reviews)} QA reviews · average {pct(r.qa.avg_pct, 1)}</div>}
          </Panel>
        </div>

        <div className="col gap-12">
          <Panel title="Commentary" actions={snap.data?.narrative ? <AiTag>AI draft</AiTag> : null}>
            {snap.loading ? <Skeleton lines={4} /> : snap.data?.narrative ? <>
              <div className="ai-box small" style={{ whiteSpace: 'pre-wrap' }}>{snap.data.narrative}</div>
              <div className="tiny muted mt-8">Stored pack generated {dateTime(snap.data.generated_at)}. AI-drafted from the figures; reviewed by the supervisor before circulation.</div>
            </> : <div className="small muted">
              {mode === 'custom' ? 'Commentary is written for the scheduled daily, weekly and monthly packs only.' : <>No stored pack for this {mode === 'daily' ? 'day' : mode === 'weekly' ? 'week' : 'month'} yet. The AI commentary is generated by the 10:00 IST job with the e-mailed pack; the figures here are live.</>}
            </div>}
          </Panel>

          <Panel title="Revenue & collections">
            {r ? <>
              <dl className="kv">
                <dt>Booking value</dt><dd className="mono">{inr(r.revenue.booking_value)}</dd>
                <dt>Completed value</dt><dd className="mono">{inr(r.revenue.completed_value)}</dd>
                <dt>Collected</dt><dd className="mono">{inr(col.collected)} <span className="muted small">· {num(col.count)} payments</span></dd>
                <dt>Reconciled</dt><dd className="mono">{num(col.reconciled)} of {num(col.count)}</dd>
                <dt>Exceptions</dt><dd>{col.exceptions ? <Badge kind="danger">{col.exceptions}</Badge> : <span className="mono">0</span>}</dd>
                <dt>Outstanding</dt><dd className="mono">{inr(r.outstanding)} <span className="muted small">· all time</span></dd>
              </dl>
              {Object.keys(col.by_mode || {}).length > 0 && <div className="mt-16"><div className="upper mb-8">By mode</div>
                <HBars data={Object.entries(col.by_mode).map(([k, v]) => ({ k: MODE_PAY[k] || k, v }))} label="k" value="v" format={inr} /></div>}
            </> : <Skeleton lines={6} />}
          </Panel>

          <Panel title="Cancellations" sub="With reasons recorded by the agent">
            {r ? (r.cancellations.length ? <HBars data={r.cancellations} label="reason" value="n" color="#9a5b0b" /> : <Empty title="No cancellations" />) : <Skeleton lines={4} />}
          </Panel>

          <Panel title="Complaints">
            {r ? <>
              <div className="grid g3" style={{ gap: 8 }}>
                <div><div className="upper">New</div><div className="mono mis-big">{num(cmp.new)}</div></div>
                <div><div className="upper">Resolved</div><div className="mono mis-big">{num(cmp.resolved)}</div></div>
                <div><div className="upper">Ack ≤ 15 min</div><div className="mono mis-big">{cmp.new ? pct(ratio(cmp.ack_within_sla, cmp.new), 0) : '–'}</div></div>
              </div>
              {Object.keys(cmp.by_category || {}).length > 0 && <div className="mt-16"><HBars data={Object.entries(cmp.by_category).map(([k, v]) => ({ k: COMPLAINT[k] || k, v }))} label="k" value="v" color="#a3362e" /></div>}
            </> : <Skeleton lines={4} />}
          </Panel>

          <Panel title="Escalations by type">
            {r ? (Object.keys(r.escalations).length ? <HBars data={Object.entries(r.escalations).map(([k, v]) => ({ k: ESC[k] || k, v }))} label="k" value="v" color="#a3362e" />
              : <Empty title="No escalations raised" />) : <Skeleton lines={3} />}
          </Panel>

          <Panel title="Delivery schedule">
            <div className="col small" style={{ gap: 6 }}>
              <div className="row between"><span>Daily pack</span><span className="mono">by 10:00 next day</span></div>
              <div className="row between"><span>Weekly pack</span><span className="mono">Monday 12:00</span></div>
              <div className="row between"><span>Monthly pack</span><span className="mono">by 5th working day</span></div>
              <div className="tiny muted mt-8">Formats and metric definitions here are proposals for joint sign-off with Hinduja. Every Excel or PDF export is written to the access log.</div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

const Row = ({ k, v }) => <tr><td className="muted">{k}</td><td className="num">{v}</td></tr>;

const DISP = { requirement_captured: 'Requirement captured', information_only: 'Information only', price_enquiry: 'Price enquiry', follow_up_requested: 'Follow-up requested',
  not_interested: 'Not interested', already_arranged: 'Already arranged elsewhere', wrong_number: 'Wrong number', duplicate: 'Duplicate enquiry' };
const hrs = (h) => (h == null ? '–' : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${Number(h).toFixed(1)} h`);

/** Post-discharge transitions opened in the period: conversion, TAT per step, items kept, partner fulfilment SLA. */
function TransitionMis({ t, loading }) {
  return (
    <Panel title="Post-discharge transitions" sub="Cases marked post-discharge, opened in the period · median times">
      {loading || !t ? <TableSkeleton rows={6} cols={4} /> : !t.intake ? <Empty title="No post-discharge cases in this period" /> : <>
        <Funnel steps={[{ label: 'Intake', value: t.intake }, { label: 'Validated', value: t.validated }, { label: 'Signed off', value: t.signed_off }, { label: 'Deployed', value: t.deployed }]} />
        <div className="grid g4 mt-16" style={{ gap: 8 }}>
          <div><div className="upper">Conversion</div><div className="mono mis-big">{pct(t.conversion_pct, 1)}</div><div className="tiny muted">intake to sign-off</div></div>
          <div><div className="upper">After validation</div><div className="mono mis-big">{pct(t.validation_to_signoff_pct, 1)}</div><div className="tiny muted">validated to sign-off</div></div>
          <div><div className="upper">Items kept</div><div className="mono mis-big">{pct(t.items.retention_pct, 0)}</div><div className="tiny muted">{num(t.items.agreed)} of {num(t.items.recommended)} recommended</div></div>
          <div><div className="upper">Not ready</div><div className="mono mis-big">{num(t.not_ready)}</div><div className="tiny muted">at hospital validation</div></div>
        </div>
        <div className="grid g2 mt-16" style={{ gap: 16 }}>
          <table className="t compact"><tbody>
            <Row k="Intake to hospital validation" v={hrs(t.tat_hours.intake_to_validation)} />
            <Row k="Validation to family sign-off" v={hrs(t.tat_hours.validation_to_signoff)} />
            <Row k="Sign-off to deployment" v={hrs(t.tat_hours.signoff_to_deployment)} />
            <Row k="Intake to deployment" v={hrs(t.tat_hours.intake_to_deployment)} />
          </tbody></table>
          <table className="t compact">
            <thead><tr><th>Partner</th><th className="num">Leads</th><th className="num">Declined</th><th className="num">Deployed</th><th className="num">In SLA</th><th className="num">Before discharge</th></tr></thead>
            <tbody>{t.providers.map((p) => (
              <tr key={p.code}><td>{p.name}</td><td className="num">{num(p.leads)}</td><td className="num">{num(p.declined)}</td><td className="num">{num(p.deployed)}</td>
                <td className="num">{pct(p.deploy_sla_pct, 0)}</td><td className="num">{pct(p.before_discharge_pct, 0)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        {Object.keys(t.dispositions).length > 0 && <div className="mt-16"><div className="upper mb-8">Interaction reasons (all enquiries)</div>
          <HBars data={Object.entries(t.dispositions).map(([k, v]) => ({ k: DISP[k] || k, v }))} label="k" value="v" /></div>}
        {t.drop_reasons.length > 0 && <div className="mt-16"><div className="upper mb-8">Items dropped in negotiation</div>
          <div className="col small" style={{ gap: 4 }}>{t.drop_reasons.slice(0, 12).map((d, i) => <div key={i}><strong>{d.service}</strong> · {d.reason}</div>)}</div></div>}
      </>}
    </Panel>
  );
}

function sheet(rows, widths) {
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No data in this period' }]);
  if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
  return ws;
}

function writeWorkbook(r, { from, to, mode, workspace }) {
  const wb = XLSX.utils.book_new();
  const c = r.calls, cb = r.callbacks, f = r.funnel, col = r.collections, k = r.complaints;
  const S1 = (section, metric, value) => ({ Section: section, Metric: metric, Value: value ?? '' });
  const summary = [
    S1('Report', 'Workspace', workspace?.name || ''), S1('Report', 'Period', `${mode} ${from} to ${to}`), S1('Report', 'Generated (IST)', dateTime(new Date())),
    S1('Contact centre', 'Calls', c.total), S1('Contact centre', 'Answered', c.answered), S1('Contact centre', 'Missed', c.missed), S1('Contact centre', 'Abandoned', c.abandoned),
    S1('Contact centre', 'Answered within 30 s %', c.answer_within_30s_pct), S1('Contact centre', 'Missed + abandoned %', c.abandon_pct),
    S1('Callbacks', 'Raised', cb.raised), S1('Callbacks', 'Done', cb.done), S1('Callbacks', 'Done within SLA', cb.within_sla), S1('Callbacks', 'Average minutes', cb.avg_minutes),
    S1('Funnel', 'Enquiries', f.enquiries), S1('Funnel', 'Quotes', f.quotes), S1('Funnel', 'Bookings', f.bookings), S1('Funnel', 'Completions', f.completions),
    S1('Funnel', 'Closed', f.closed), S1('Funnel', 'Cancelled', f.cancelled), S1('Funnel', 'Conversion %', f.conversion_pct),
    S1('TAT', 'Quote minutes', r.tat.quote_min), S1('TAT', 'Booking minutes', r.tat.booking_min),
    S1('Revenue', 'Booking value', r.revenue.booking_value), S1('Revenue', 'Completed value', r.revenue.completed_value),
    S1('Collections', 'Collected', col.collected), S1('Collections', 'Payments', col.count), S1('Collections', 'Reconciled', col.reconciled), S1('Collections', 'Exceptions', col.exceptions),
    ...Object.entries(col.by_mode || {}).map(([m, v]) => S1('Collections', `By mode: ${MODE_PAY[m] || m}`, v)),
    S1('Collections', 'Outstanding (all time)', r.outstanding),
    S1('Complaints', 'New', k.new), S1('Complaints', 'Resolved', k.resolved), S1('Complaints', 'Acknowledged within 15 min', k.ack_within_sla),
    ...Object.entries(k.by_category || {}).map(([m, v]) => S1('Complaints', `Category: ${COMPLAINT[m] || m}`, v)),
    ...Object.entries(r.escalations || {}).map(([m, v]) => S1('Escalations', ESC[m] || m, v)),
    S1('Quality', 'QA reviews', r.qa.reviews), S1('Quality', 'Average QA %', r.qa.avg_pct),
  ];
  XLSX.utils.book_append_sheet(wb, sheet(summary, [16, 34, 18]), 'Summary');
  XLSX.utils.book_append_sheet(wb, sheet(r.sla.map((s) => ({ Policy: s.label, 'Target minutes': s.target_minutes, Met: s.met, Breached: s.breached, 'Compliance %': s.pct })), [44, 14, 8, 10, 14]), 'SLA');
  XLSX.utils.book_append_sheet(wb, sheet(r.zones.map((z) => ({ Zone: z.zone, Enquiries: z.enquiries, Bookings: z.bookings, Completed: z.completed, Revenue: z.revenue })), [18, 10, 10, 10, 12]), 'Zones');
  XLSX.utils.book_append_sheet(wb, sheet(r.services.map((s) => ({ Service: s.service_name, Category: CAT[s.category] || s.category, Count: s.n, Value: s.value })), [34, 18, 8, 12]), 'Services');
  XLSX.utils.book_append_sheet(wb, sheet(r.agents.map((a) => ({ Agent: a.agent, Calls: a.calls, 'Avg talk (s)': a.avg_talk, 'QA %': a.qa })), [16, 8, 12, 8]), 'Agents');
  XLSX.utils.book_append_sheet(wb, sheet(r.daily.map((d) => ({ Day: d.day, Calls: d.calls, Enquiries: d.enquiries, Bookings: d.bookings, Collections: d.collections })), [12, 8, 10, 10, 12]), 'Daily');
  XLSX.utils.book_append_sheet(wb, sheet(r.cancellations.map((x) => ({ Reason: x.reason, Cases: x.n })), [44, 8]), 'Cancellations');
  XLSX.writeFile(wb, `HHCS-MIS-${mode}-${from}${from === to ? '' : '_' + to}.xlsx`);
}
